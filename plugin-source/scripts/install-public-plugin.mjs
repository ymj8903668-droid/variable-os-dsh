// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runPluginCommand } from "./plugin-command.mjs";
import { parseArgs } from "node:util";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";
import { findExecutable, EXPECTED_DSH_VERSION, EXPECTED_PNPM_VERSION } from "./dsh-contract.mjs";
import { PUBLIC_PLUGIN_HOST_PEERS } from "../packages/dsh-desk-ui/lib/public-plugin-runtime.js";
import { PLUGIN_DEPENDENCY_LOCK, verifyPluginDependencyGraph } from "./plugin-dependency-lock.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(Error(code), { code }); };
const packageName = "@variable-os/dsh-desk-ui";
const maxBytes = 16 * 1024 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;

export { readBounded as readPluginInput, checkedArchive as readApprovedPluginArchive,
  readInstalled as readInstalledPlugin, checkComposition as checkPluginComposition };

async function readBounded(file, limit) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || await fs.realpath(file) !== file) throw Error("PATH");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.mode & 0o022
      || before.size > limit) throw Error("FILE");
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(file);
    if (used > limit || used !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev
      || current.isSymbolicLink() || await fs.realpath(file) !== file) throw Error("CHANGED");
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

async function checkedArchive(archive, descriptor) {
  try {
    if (!descriptor || ![Object.prototype, null].includes(Object.getPrototypeOf(descriptor))
      || typeof descriptor.version !== "string" || typeof descriptor.sha256 !== "string"
      || typeof descriptor.manifestSha256 !== "string"
      || descriptor.schema !== 1 || descriptor.dshVersion !== EXPECTED_DSH_VERSION
      || descriptor.publicReleaseQualified !== false || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(descriptor.version)
      || !hashPattern.test(descriptor.sha256) || !hashPattern.test(descriptor.manifestSha256)
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 10 || descriptor.bytes > maxBytes) throw Error("DESCRIPTOR");
    const bytes = await readBounded(archive, descriptor.bytes);
    if (bytes.length !== descriptor.bytes || digest(bytes) !== descriptor.sha256
      || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw Error("ARCHIVE");
    return bytes;
  } catch { fail("PLUGIN_ARTIFACT_INVALID"); }
}

async function readInstalled(root, descriptor) {
  try {
    const profile = path.join(root, "home/.dsh/profiles/web");
    const installed = await fs.realpath(path.join(profile, "node_modules", packageName));
    if (!installed.startsWith(root + path.sep)) throw Error("EXTERNAL");
    const manifestBytes = await readBounded(path.join(installed, "build-manifest.json"), 128 * 1024);
    if (digest(manifestBytes) !== descriptor.manifestSha256) throw Error("MANIFEST");
    const manifest = JSON.parse(manifestBytes);
    if (manifest.schema !== 1 || manifest.dshVersion !== EXPECTED_DSH_VERSION
      || manifest.publicReleaseQualified !== false || !Array.isArray(manifest.files)
      || manifest.files.length < 1 || manifest.files.length > 256) throw Error("MANIFEST");
    const names = new Set();
    let lockBytes;
    for (const row of manifest.files) {
      if (typeof row.path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(row.path)
        || path.isAbsolute(row.path) || row.path.split("/").some(part => !part || part === "." || part === "..")
        || names.has(row.path) || !hashPattern.test(row.sha256) || !Number.isSafeInteger(row.bytes)
        || row.bytes < 0 || row.bytes > maxBytes) throw Error("ENTRY");
      names.add(row.path);
      const bytes = await readBounded(path.join(installed, row.path), row.bytes);
      if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw Error("PAYLOAD");
      if (row.path === PLUGIN_DEPENDENCY_LOCK) lockBytes = bytes;
    }
    const main = "packages/dsh-desk-ui/lib/public-plugin.js";
    if (!names.has("package.json") || !names.has(main) || !names.has("cordis.patch.yml")) throw Error("MISSING");
    const pkg = JSON.parse(await readBounded(path.join(installed, "package.json"), 128 * 1024));
    if (pkg.name !== packageName || pkg.version !== descriptor.version || pkg.private !== true
      || pkg.scripts !== undefined || pkg.main !== "./" + main
      || !pkg.dependencies || Array.isArray(pkg.dependencies) || typeof pkg.dependencies !== "object"
      || Object.keys(pkg.dependencies).length) throw Error("PACKAGE");
    if (!pkg.peerDependencies || Array.isArray(pkg.peerDependencies)
      || Object.keys(pkg.peerDependencies).length !== Object.keys(PUBLIC_PLUGIN_HOST_PEERS).length
      || Object.entries(PUBLIC_PLUGIN_HOST_PEERS).some(([name, version]) => pkg.peerDependencies[name] !== version)) throw Error("PEERS");
    const lock = JSON.parse(lockBytes);
    if (lock.schema !== 2) fail("PLUGIN_DEPENDENCY_GRAPH_INVALID");
    const config = JSON.parse(await readBounded(path.join(profile, "package.json"), 128 * 1024));
    if (config.dsh?.profile?.bundles?.filter(name => name === packageName).length !== 1) throw Error("BUNDLE");
    const dependencies = await verifyPluginDependencyGraph({
      pluginRoot: installed, modulesRoot: path.join(profile, "node_modules"), lockBytes, readFile: readBounded,
    });
    return { installed, main, files: names.size, ...dependencies };
  } catch (error) {
    if (error.code === "PLUGIN_DEPENDENCY_GRAPH_INVALID") throw error;
    fail("PLUGIN_READBACK_INVALID");
  }
}

function checkComposition(bytes) {
  // This is an assertion on the pinned official renderer's canonical output,
  // not a YAML parser for user-authored configuration.
  const blocks = bytes.toString().replaceAll("\r\n", "\n").replace(/^#.*\n/gm, "").split(/(?=^- id: )/m);
  if (blocks.some(block => block.startsWith("- id: variable-os-config-hmr\n"))) fail("PLUGIN_COMPOSITION_INVALID");
  for (const id of ["webserver", "modules", "hmr", "variable-os-desk-ui"]) {
    if (blocks.filter(block => block.startsWith(`- id: ${id}\n`)).length !== 1) fail("PLUGIN_COMPOSITION_INVALID");
  }
  const plugin = blocks.find(block => block.startsWith("- id: variable-os-desk-ui\n"));
  if (plugin.trimEnd() !== "- id: variable-os-desk-ui\n  name: '@variable-os/dsh-desk-ui'") fail("PLUGIN_COMPOSITION_INVALID");
  const hmr = blocks.find(block => block.startsWith("- id: hmr\n"));
  if (hmr.trimEnd() !== "- id: hmr\n  name: '@deepseek-ai/dsh-hmr'\n  disabled: !!js '!ctx.get(''profileContext'')'\n  config:\n    root: []") {
    fail("PLUGIN_COMPOSITION_INVALID");
  }
}

// A new private namespace avoids modifying any existing DSH profile or copying
// user credentials. This is a plugin step, not a runtime installer or launcher.
export async function installPublicPlugin({ archive, descriptor, destination, confirm, signal, env = process.env, beforeCommand } = {}) {
  if (confirm !== true) fail("PLUGIN_INSTALL_CONFIRMATION_REQUIRED");
  if (signal?.aborted) fail("PLUGIN_INSTALL_CANCELLED");
  if (!["darwin", "linux"].includes(process.platform)) fail("PLUGIN_INSTALL_PLATFORM_UNQUALIFIED");
  if (process.versions.node.split(".")[0] !== "24") fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
  const bytes = await checkedArchive(archive, descriptor);
  let proxy;
  if (env.HTTPS_PROXY) {
    try {
      const url = new URL(env.HTTPS_PROXY);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== "/") throw Error("PROXY");
      proxy = url.href;
    } catch { fail("PLUGIN_INSTALL_PROXY_INVALID"); }
  }
  try {
    if (typeof destination !== "string" || !path.isAbsolute(destination) || path.resolve(destination) !== destination) throw Error("PATH");
    const parent = path.dirname(destination), stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077
      || await fs.realpath(parent) !== parent) throw Error("PARENT");
  } catch { fail("PLUGIN_DESTINATION_INVALID"); }
  if (signal?.aborted) fail("PLUGIN_INSTALL_CANCELLED");
  try { await fs.mkdir(destination, { mode: 0o700 }); }
  catch (error) { fail(error.code === "EEXIST" ? "PLUGIN_DESTINATION_EXISTS" : "PLUGIN_DESTINATION_INVALID"); }
  const receipt = { schema: 1, status: "INSTALLING", archiveSha256: descriptor.sha256,
    manifestSha256: descriptor.manifestSha256, version: descriptor.version,
    publicReleaseQualified: false, hostStarted: false, phases: [] };
  const save = async () => {
    const pending = path.join(destination, ".install-receipt.pending.json");
    const handle = await fs.open(pending, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(pending, path.join(destination, "install-receipt.json"));
    const directory = await fs.open(destination, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const childEnv = {
    PATH: String(env.PATH ?? "").split(path.delimiter).filter(folder => path.isAbsolute(folder)).join(path.delimiter),
    HOME: path.join(destination, "home"), DSH_HOME: path.join(destination, "home/.dsh"),
    XDG_CONFIG_HOME: path.join(destination, "config"), XDG_CACHE_HOME: path.join(destination, "cache"),
    TMPDIR: path.join(destination, "tmp"), SHELL: "/bin/sh", DSH_TELEMETRY_DISABLED: "1",
    COREPACK_ENABLE_NETWORK: "0", COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENV_FILE: "0",
    pnpm_config_ignore_scripts: "true", pnpm_config_manage_package_manager_versions: "false",
  };
  if (env.COREPACK_HOME && path.isAbsolute(env.COREPACK_HOME)) childEnv.COREPACK_HOME = env.COREPACK_HOME;
  async function run(phase, command, args, timeout = 20000) {
    if (signal?.aborted) fail("PLUGIN_INSTALL_CANCELLED");
    const logFile = path.join(destination, phase + ".log");
    const log = await fs.open(logFile, "wx", 0o600);
    let terminal;
    try {
      const scopedEnv = phase === "install" && proxy ? { ...childEnv, pnpm_config_https_proxy: proxy } : childEnv;
      terminal = await runPluginCommand({command,args,cwd:destination,env:scopedEnv,logFd:log.fd,
        signal,timeoutMs:timeout,beforeStart:beforeCommand?pid=>beforeCommand({phase,pid}):undefined});
    } finally { await log.close(); }
    const {timedOut}=terminal;
    receipt.phases.push({ phase, ...terminal, timedOut });
    let failure = signal?.aborted ? "PLUGIN_INSTALL_CANCELLED"
      : timedOut || terminal.spawnError || terminal.exitCode !== 0 ? "PLUGIN_INSTALL_COMMAND_FAILED" : null;
    if (failure === "PLUGIN_INSTALL_COMMAND_FAILED" && phase === "install" && !timedOut
      && Number.isInteger(terminal.exitCode) && terminal.exitCode !== 0) {
      try {
        // Diagnose only a bounded, intact private log; never forward its content.
        const output = await readBounded(logFile, 64 * 1024);
        if (/^\[ERR_PNPM_META_FETCH_FAIL\](?:[ \t]|\r?$)/m.test(output.toString())) {
          failure = "PLUGIN_INSTALL_REGISTRY_FETCH_FAILED";
        }
      } catch { /* Unreadable or changed logs retain the original generic failure. */ }
    }
    if (signal?.aborted) failure = "PLUGIN_INSTALL_CANCELLED";
    try { await save(); }
    catch (error) { if (failure) fail(failure); throw error; }
    if (failure) fail(failure);
    return logFile;
  }
  try {
    await save();
    for (const directory of ["home", "config", "cache", "tmp", "store"]) {
      await fs.mkdir(path.join(destination, directory), { mode: 0o700 });
    }
    const dsh = findExecutable("dsh", childEnv), pnpm = findExecutable("pnpm", childEnv);
    const node = findExecutable("node", childEnv);
    if (!dsh || !pnpm || !node || await fs.realpath(node) !== await fs.realpath(process.execPath)) fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
    for (const [phase, tool, expected] of [
      ["pnpm-version", pnpm, EXPECTED_PNPM_VERSION], ["dsh-version", dsh, EXPECTED_DSH_VERSION],
    ]) {
      const output = await readBounded(await run(phase, tool, ["--version"]), 16 * 1024);
      if (output.toString().trim() !== expected) fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
    }
    const staged = path.join(destination, "plugin.tgz");
    await fs.writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
    await run("install", dsh, ["plugin", "--profile", "web", "add", staged,
      "--ignore-scripts", "--store-dir", path.join(destination, "store"),
      "--cache-dir", path.join(destination, "cache"), "--registry=https://registry.npmjs.org/",
      "--fetch-retries=0", "--fetch-timeout=15000"], 120000);
    const installed = await readInstalled(destination, descriptor);
    // Composition only validates patch layers. Alpha resolves installation peers
    // in process through PluginPackages; it does not project package links here.
    const dump = await run("compose", dsh, ["--profile", "web", "--dump-config"]);
    checkComposition(await readBounded(dump, 1024 * 1024));
    const entry = pathToFileURL(path.join(installed.installed, installed.main)).href;
    await run("import", process.execPath, [fileURLToPath(new URL("./inspect-plugin-host.mjs", import.meta.url)),
      "--dsh", dsh, "--profile-root", path.join(destination, "home/.dsh/profiles/web"), "--entry", entry]);
    if (signal?.aborted) fail("PLUGIN_INSTALL_CANCELLED");
    receipt.status = "INSTALLED_NOT_STARTED";
    receipt.verifiedFiles = installed.files;
    receipt.verifiedHostPeers = Object.keys(PUBLIC_PLUGIN_HOST_PEERS).length;
    receipt.verifiedDependencyPackages = installed.verifiedDependencyPackages;
    receipt.dependencyLockSha256 = installed.dependencyLockSha256;
    await save();
    return receipt;
  } catch (error) {
    receipt.status = "FAILED";
    receipt.failure = /^PLUGIN_|^PUBLIC_PLUGIN_/.test(error.code ?? "") ? error.code : "PLUGIN_INSTALL_FAILED";
    let receiptPersisted = true;
    try { await save(); } catch { receiptPersisted = false; }
    throw Object.assign(Error(receipt.failure), { code: receipt.failure, receiptPersisted,
      ...(error.retainLock === true ? {retainLock: true} : {}) });
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT"), terminate = () => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    const { values } = parseArgs({ options: { archive: { type: "string" }, descriptor: { type: "string" },
      destination: { type: "string" }, install: { type: "boolean" } } });
    const descriptor = JSON.parse(await readBounded(values.descriptor, 16 * 1024));
    const receipt = await installPublicPlugin({ ...values, descriptor, confirm: values.install, signal: controller.signal });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(/^PLUGIN_|^PUBLIC_PLUGIN_/.test(error.code ?? "") ? error.code : "PLUGIN_INSTALL_ARGUMENTS_INVALID");
    process.exitCode = controller.signal.reason === "SIGINT" ? 130 : controller.signal.reason === "SIGTERM" ? 143 : 1;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}
