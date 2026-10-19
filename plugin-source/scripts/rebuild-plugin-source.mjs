// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(Error(code), { code }); };
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function readInput(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.mode & 0o022
      || before.size > limit) fail("PUBLIC_PLUGIN_SOURCE_INPUT_CHANGED");
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(file);
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()
      || await fs.realpath(file) !== file) fail("PUBLIC_PLUGIN_SOURCE_INPUT_CHANGED");
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

export async function rebuildPluginSource({ sourceRoot = root, destRoot } = {}) {
  if (process.versions.node !== "24.19.0") fail("PUBLIC_PLUGIN_SOURCE_TOOLCHAIN_INVALID");
  sourceRoot = await fs.realpath(sourceRoot);
  try {
    if (!path.isAbsolute(destRoot)) throw Error("PATH");
    const stat = await fs.lstat(destRoot);
    if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()
      || (await fs.readdir(destRoot)).length) throw Error("DEST");
    destRoot = await fs.realpath(destRoot);
    if (sourceRoot === destRoot || sourceRoot.startsWith(destRoot + path.sep)) throw Error("OVERLAP");
  } catch { fail("PUBLIC_PLUGIN_DEST_INVALID"); }
  const manifest = JSON.parse(await readInput(path.join(sourceRoot, "source-manifest.json"), 1024 * 1024));
  if (manifest.schema !== 1 || manifest.profile !== "standalone-plugin-source"
    || manifest.publicReleaseQualified !== false || manifest.nodeVersion !== process.versions.node
    || !Array.isArray(manifest.files) || manifest.files.length > 2048) fail("PUBLIC_PLUGIN_SOURCE_MANIFEST_INVALID");
  const names = new Set(), contents = new Map();
  let totalBytes = 0;
  for (const row of manifest.files) {
    if (typeof row.path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(row.path)
      || row.path.split("/").some(part => !part || [".", "..", "node_modules", ".git"].includes(part))
      || names.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 16 * 1024 * 1024) {
      fail("PUBLIC_PLUGIN_SOURCE_MANIFEST_INVALID");
    }
    names.add(row.path);
    totalBytes += row.bytes;
    if (totalBytes > 32 * 1024 * 1024) fail("PUBLIC_PLUGIN_SOURCE_MANIFEST_INVALID");
    let target = sourceRoot;
    for (const part of row.path.split("/")) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink()) fail("PUBLIC_PLUGIN_SOURCE_INPUT_CHANGED");
    }
    const bytes = await readInput(target, row.bytes);
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail("PUBLIC_PLUGIN_SOURCE_INPUT_CHANGED");
    contents.set(row.path, bytes);
  }
  const expected = contents.get("expected-plugin-manifest.json");
  if (!expected || hash(expected) !== manifest.pluginManifestSha256) {
    fail("PUBLIC_PLUGIN_SOURCE_MANIFEST_INVALID");
  }
  // Build only verified inputs in an owned stage. Existing generated paths are never followed.
  const stage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vos-source-rebuild-")));
  try {
    for (const [file, bytes] of contents) {
      const target = path.join(stage, file);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
    }
    // Only the independently frozen build toolchain is installed. SDK manifests
    // remain bound source inputs; Host peers are external and are never executed.
    await fs.symlink(await fs.realpath(path.join(sourceRoot,
      "scripts/plugin-source-build-deps/node_modules")), path.join(stage, "node_modules"), "dir");
    const { buildClientBundles } = await import(new URL("packages/dsh-desk-ui/scripts/build-client.mjs",
      pathToFileURL(stage + path.sep)));
    await buildClientBundles({ root: stage });
    const { buildPublicPlugin } = await import(new URL("scripts/build-dsh-plugin.mjs", pathToFileURL(stage + path.sep)));
    const actual = await buildPublicPlugin({ sourceRoot: stage, destRoot });
    const actualBytes = await fs.readFile(path.join(destRoot, "build-manifest.json"));
    if (!actualBytes.equals(expected)) fail("PUBLIC_PLUGIN_SOURCE_OUTPUT_MISMATCH");
    return { status: "SOURCE_REBUILD_VERIFIED", fileCount: actual.files.length,
      pluginManifestSha256: hash(expected), publicReleaseQualified: false };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    const { values: { output } } = parseArgs({ options: { output: { type: "string" } }, strict: true });
    if (!output || !path.isAbsolute(output)) fail("PUBLIC_PLUGIN_ARGUMENTS_INVALID");
    console.log(JSON.stringify(await rebuildPluginSource({ destRoot: output })));
  } catch (error) {
    console.error(/^PUBLIC_PLUGIN_[A-Z_]+$/.test(error.code ?? "") ? error.code : "PUBLIC_PLUGIN_SOURCE_REBUILD_FAILED");
    process.exitCode = 1;
  }
}
