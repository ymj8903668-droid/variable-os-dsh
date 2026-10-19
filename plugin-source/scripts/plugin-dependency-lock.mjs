// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const PLUGIN_DEPENDENCY_LOCK = "plugin-dependencies.json";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const invalid = () => { throw Object.assign(Error("PLUGIN_DEPENDENCY_GRAPH_INVALID"),
  { code: "PLUGIN_DEPENDENCY_GRAPH_INVALID" }); };
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const relativeFile = name => typeof name === "string" && name.length <= 512 && /^[A-Za-z0-9_./-]+$/.test(name)
  && !name.split("/").some(part => !part || [".", "..", "node_modules"].includes(part));

export async function verifyPluginDependencyGraph({ pluginRoot, modulesRoot, lockBytes, readFile }) {
  try {
    const lock = JSON.parse(lockBytes);
    const hostOnly = lock.schema === 2;
    if (hostOnly) {
      if (Object.keys(lock).sort().join() !== "nodes,profile,schema" || lock.profile !== "host-peers-only"
        || !Array.isArray(lock.nodes) || lock.nodes.length) invalid();
    } else if (lock.schema !== 1 || lock.root !== "@deepseek-ai/cordis-plugin-hmr@1.0.16"
      || !Array.isArray(lock.nodes) || !lock.nodes.length || lock.nodes.length > 128) invalid();
    const nodes = new Map();
    let files = 0, bytes = 0;
    for (const node of lock.nodes) {
      if (!packageName.test(node.name) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(node.version)
        || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(node.integrity)
        || !node.dependencies || Array.isArray(node.dependencies) || typeof node.dependencies !== "object"
        || !Array.isArray(node.files) || !node.files.length) invalid();
      const id = node.name + "@" + node.version;
      if (nodes.has(id)) invalid();
      const names = new Set();
      for (const row of node.files) {
        if (!relativeFile(row.path) || names.has(row.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(row.sha256)
          || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 16 * 1024 * 1024) invalid();
        names.add(row.path.toLowerCase());
        files++; bytes += row.bytes;
      }
      if (!names.has("package.json") || files > 8192 || bytes > 128 * 1024 * 1024) invalid();
      nodes.set(id, node);
    }
    for (const node of nodes.values()) {
      for (const [name, id] of Object.entries(node.dependencies)) {
        if (!packageName.test(name) || nodes.get(id)?.name !== name) invalid();
      }
    }
    const modulesStat = await fs.lstat(modulesRoot);
    if (!path.isAbsolute(modulesRoot) || path.resolve(modulesRoot) !== modulesRoot
      || await fs.realpath(modulesRoot) !== modulesRoot || !modulesStat.isDirectory()
      || modulesStat.uid !== process.getuid() || modulesStat.mode & 0o022) invalid();
    const visited = new Set(), reached = new Set();
    async function exists(file) {
      try { await fs.lstat(file); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    if (!path.isAbsolute(pluginRoot) || path.resolve(pluginRoot) !== pluginRoot
      || await fs.realpath(pluginRoot) !== pluginRoot || !pluginRoot.startsWith(modulesRoot + path.sep)) invalid();
    const importerDirectory = path.join(pluginRoot, "packages/dsh-desk-ui/lib");
    // The wrapper has no nested package scope. An added scope can redirect ESM
    // self-imports while leaving the CommonJS verification target unchanged.
    for (let directory = importerDirectory; directory !== pluginRoot; directory = path.dirname(directory)) {
      if (await exists(path.join(directory, "package.json"))) invalid();
    }
    if (hostOnly) {
      // This manifest-bound mode verifies zero plugin-owned dependencies only.
      // Exact Host peer checks and Host transitive audits remain separate gates.
      const body = await readFile(path.join(pluginRoot, "package.json"), 64 * 1024);
      if (body.length > 64 * 1024) invalid();
      const metadata = JSON.parse(body);
      if (metadata.name !== "@variable-os/dsh-desk-ui" || !metadata.dependencies
        || typeof metadata.dependencies !== "object" || Array.isArray(metadata.dependencies)
        || Object.keys(metadata.dependencies).length
        || ["optionalDependencies", "bundledDependencies", "bundleDependencies"].some(key => key in metadata)) invalid();
      return { verifiedDependencyPackages: 0, dependencyLockSha256: hash(lockBytes) };
    }
    async function visit(id, parent) {
      const node = nodes.get(id);
      if (!node) invalid();
      const require = createRequire(path.join(parent, "__dependency_readback__.cjs"));
      let directory;
      for (const base of require.resolve.paths(node.name) ?? []) {
        const candidate = path.join(base, node.name);
        // Check on disk even if Node has cached a previous successful resolution.
        for (const extension of [".js", ".json", ".node"]) {
          if (await exists(candidate + extension)) invalid();
        }
        if (!await exists(candidate)) continue;
        directory = await fs.realpath(candidate);
        break;
      }
      if (!directory?.startsWith(modulesRoot + path.sep)) invalid();
      const entry = await fs.realpath(require.resolve(node.name));
      if (!entry.startsWith(directory + path.sep)
        || !node.files.some(row => row.path === path.relative(directory, entry).split(path.sep).join("/"))) invalid();
      const identity = id + "\0" + directory;
      if (visited.has(identity)) return;
      if (visited.size >= 256) invalid();
      visited.add(identity); reached.add(id);
      const actualNames = [];
      const directories = new Set([""]);
      for (const row of node.files) {
        for (let name = path.posix.dirname(row.path); name !== "."; name = path.posix.dirname(name)) {
          directories.add(name);
        }
      }
      async function list(relative = "") {
        const stream = await fs.opendir(path.join(directory, relative));
        for await (const entry of stream) {
          if (!relative && entry.name === "node_modules" && entry.isDirectory()) continue;
          const name = relative ? relative + "/" + entry.name : entry.name;
          if (!relativeFile(name)) invalid();
          if (entry.isDirectory()) {
            if (!directories.has(name)) invalid();
            await list(name);
          }
          else if (entry.isFile()) actualNames.push(name);
          else invalid();
          if (actualNames.length > node.files.length) invalid();
        }
      }
      await list();
      if (JSON.stringify(actualNames.sort()) !== JSON.stringify(node.files.map(row => row.path).sort())) invalid();
      let metadata;
      for (const row of node.files) {
        const body = await readFile(path.join(directory, row.path), row.bytes);
        if (body.length !== row.bytes || hash(body) !== row.sha256) invalid();
        if (row.path === "package.json") metadata = JSON.parse(body);
      }
      if (metadata.name !== node.name || metadata.version !== node.version
        || Object.keys(metadata.optionalDependencies ?? {}).length
        || JSON.stringify(Object.keys(metadata.dependencies ?? {}).sort())
          !== JSON.stringify(Object.keys(node.dependencies).sort())) invalid();
      for (const relative of directories) {
        for (const next of Object.values(node.dependencies)) await visit(next, path.join(directory, relative));
      }
    }
    await visit(lock.root, importerDirectory);
    if (reached.size !== nodes.size) invalid();
    return { verifiedDependencyPackages: nodes.size, dependencyLockSha256: hash(lockBytes) };
  } catch { invalid(); }
}
