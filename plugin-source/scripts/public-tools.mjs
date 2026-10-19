// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";
import { EXPECTED_DSH_VERSION, EXPECTED_PNPM_VERSION } from "./dsh-contract.mjs";

const definitions = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
const markerName = ".variable-os-tools.json";
const pnpmIntegrity = "XN6SW08HX3Jetx+64YpC/+eEUkeJ8ZthxzHLhyHsKKruFg4BqNWvT+2ypCzb8wDv4j2zVrDUoXtNY+EfirfJVg==";
const entries = {
  pnpm: "pnpm/bin/pnpm.mjs",
  dsh: "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
};
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = contents => createHash("sha256").update(contents).digest("hex");
const wrapper = (name, finalRoot) => `#!/bin/sh\n${name === "dsh" ? `# cmd-shim-target=${path.join(finalRoot, entries[name])}\n` : ""}exec node "$(dirname "$0")/../${entries[name]}" "$@"\n`;

function owned(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o077) !== 0) fail("PUBLIC_TOOLS_UNSAFE");
}

function fileInside(root, rel, limit = 8 * 1024 * 1024) {
  const file = path.join(root, rel), real = fs.realpathSync(file);
  if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) fail("PUBLIC_TOOLS_UNSAFE");
  const stat = fs.lstatSync(real);
  if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o022) !== 0
    || stat.size > limit) fail("PUBLIC_TOOLS_UNSAFE");
  return fs.readFileSync(real);
}

function definitionHash(sourceRoot) {
  const root = path.join(sourceRoot, "profiles/public-tools");
  try {
    return hash(Buffer.concat(definitions.flatMap(name => [Buffer.from(`${name}\0`), fileInside(root, name)])));
  } catch { fail("PUBLIC_TOOLS_DEFINITION_INVALID"); }
}

function packageVersion(root, name) {
  const rel = name === "pnpm" ? "pnpm/package.json" : "dsh/node_modules/@deepseek-ai/dsh/package.json";
  const contents = fileInside(root, rel);
  const pkg = JSON.parse(contents);
  if (pkg.name !== (name === "pnpm" ? "pnpm" : "@deepseek-ai/dsh")
    || pkg.version !== (name === "pnpm" ? EXPECTED_PNPM_VERSION : EXPECTED_DSH_VERSION)) {
    fail("PUBLIC_TOOLS_VERSION_MISMATCH");
  }
  return hash(contents);
}

function inspectTools(root, sourceRoot, finalRoot = root) {
  try {
    privateDirectory(root);
    const marker = path.join(root, markerName), stat = fs.lstatSync(marker);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail("PUBLIC_TOOLS_UNSAFE");
    const record = JSON.parse(fileInside(root, markerName, 4096));
    if (record.version !== 1 || Object.keys(record).sort().join() !== "definitionHash,files,version"
      || !record.files || Object.keys(record.files).sort().join() !== "dsh,dshPackage,pnpm,pnpmPackage") {
      fail("PUBLIC_TOOLS_UNSAFE");
    }
    if (record.definitionHash !== definitionHash(sourceRoot)) fail("PUBLIC_TOOLS_REINSTALL_REQUIRED");
    for (const name of Object.keys(entries)) {
      const launcher = fs.lstatSync(path.join(root, "bin", name));
      if (!launcher.isFile() || (launcher.mode & 0o777) !== 0o700) fail("PUBLIC_TOOLS_UNSAFE");
      if (fileInside(root, `bin/${name}`).toString() !== wrapper(name, finalRoot)
        || record.files[name] !== hash(fileInside(root, entries[name]))
        || record.files[`${name}Package`] !== packageVersion(root, name)) fail("PUBLIC_TOOLS_UNSAFE");
    }
  } catch (error) {
    if (error.code === "PUBLIC_TOOLS_REINSTALL_REQUIRED") throw error;
    fail("PUBLIC_TOOLS_UNSAFE");
  }
}

export function selectPublicTools(plan) {
  const root = path.join(plan.root, "tools");
  try { fs.lstatSync(root); }
  catch (error) { if (error.code === "ENOENT") return false; fail("PUBLIC_TOOLS_UNSAFE"); }
  inspectTools(root, plan.sourceRoot);
  const parts = [path.join(root, "bin"), path.dirname(process.execPath), ...plan.env.PATH.split(path.delimiter)];
  plan.env.PATH = [...new Set(parts)].join(path.delimiter);
  return true;
}

export async function preparePublicTools(plan, run) {
  privateDirectory(plan.root);
  definitionHash(plan.sourceRoot);
  const stage = fs.mkdtempSync(path.join(plan.root, ".tools-"));
  let retain = false;
  try {
    const result = await run(process.execPath, [fileURLToPath(import.meta.url), stage, plan.sourceRoot]);
    if (result.status !== 0) {
      fail(/^(PUBLIC_TOOLS_[A-Z_]+)\n$/.exec(result.stderr)?.[1] || "PUBLIC_TOOLS_INSTALL_FAILED");
    }
    const payload = path.join(stage, "payload");
    const root = path.join(plan.root, "tools");
    inspectTools(payload, plan.sourceRoot, root);
    try { fs.lstatSync(root); fail("PUBLIC_TOOLS_UNSAFE"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.renameSync(payload, root);
    selectPublicTools(plan);
  } catch (error) {
    retain = error.retainLock === true;
    throw error;
  } finally {
    // The caller waits for the whole worker group, not merely its leader.
    // Never remove a working directory still owned by undrained processes.
    if (!retain) fs.rmSync(stage, { recursive: true, force: true });
  }
}

function invoke(command, args, env, cwd, code, { timeout = 180_000, output } = {}) {
  const result = spawnSync(command, args, {
    env, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024, timeout,
  });
  if (result.error || result.status !== 0) fail(code);
  if (output !== undefined && result.stdout.trim() !== output) fail("PUBLIC_TOOLS_VERSION_MISMATCH");
}

function prepareWorker(stage, sourceRoot) {
  process.umask(0o077);
  privateDirectory(stage);
  const fingerprint = definitionHash(sourceRoot), payload = path.join(stage, "payload");
  for (const rel of ["payload", "payload/bin", "home", "config", "cache"]) {
    fs.mkdirSync(path.join(stage, rel), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(stage, "empty.npmrc"), "", { mode: 0o600, flag: "wx" });
  const env = {
    HOME: path.join(stage, "home"), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: path.join(stage, "config"), XDG_CACHE_HOME: path.join(stage, "cache"),
    npm_config_userconfig: path.join(stage, "empty.npmrc"), npm_config_globalconfig: path.join(stage, "empty.npmrc"),
    npm_config_registry: "https://registry.npmjs.org",
    pnpm_config_pm_on_fail: "error", pnpm_config_runtime_on_fail: "error",
    COREPACK_ENABLE_NETWORK: "0", DSH_TELEMETRY_DISABLED: "1", CI: "1", NO_COLOR: "1",
  };
  const archive = path.join(stage, "pnpm.tgz");
  invoke("/usr/bin/curl", ["--disable", "--fail", "--silent", "--show-error", "--proto", "=https",
    "--noproxy", "*", "--connect-timeout", "10", "--max-time", "180", "--max-filesize", "33554432",
    "--output", archive, "https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz",
  ], env, stage, "PUBLIC_TOOLS_DOWNLOAD_FAILED", { timeout: 190_000 });
  if (createHash("sha512").update(fs.readFileSync(archive)).digest("base64") !== pnpmIntegrity) {
    fail("PUBLIC_TOOLS_INTEGRITY");
  }
  invoke("/usr/bin/tar", ["-xzf", archive, "-C", payload], env, stage, "PUBLIC_TOOLS_EXTRACT_FAILED");
  fs.renameSync(path.join(payload, "package"), path.join(payload, "pnpm"));
  packageVersion(payload, "pnpm");
  invoke(process.execPath, [path.join(payload, entries.pnpm), "--version"], env, stage,
    "PUBLIC_TOOLS_VERSION_MISMATCH", { timeout: 10_000, output: EXPECTED_PNPM_VERSION });
  const dsh = path.join(payload, "dsh");
  fs.mkdirSync(dsh, { mode: 0o700 });
  for (const name of definitions) fs.copyFileSync(path.join(sourceRoot, "profiles/public-tools", name), path.join(dsh, name));
  const finalRoot = path.join(path.dirname(stage), "tools");
  if (/[\r\n]/.test(finalRoot)) fail("PUBLIC_TOOLS_UNSAFE");
  for (const name of Object.keys(entries)) fs.writeFileSync(path.join(payload, "bin", name), wrapper(name, finalRoot), { mode: 0o700 });
  env.PATH = `${path.join(payload, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  invoke(process.execPath, [path.join(payload, entries.pnpm), "--dir", dsh, "install", "--frozen-lockfile", "--ignore-scripts",
    "--store-dir", path.join(stage, "store"), "--package-import-method=copy",
  ], env, stage, "PUBLIC_TOOLS_INSTALL_FAILED", { timeout: 900_000 });
  packageVersion(payload, "dsh");
  invoke(process.execPath, [path.join(payload, entries.dsh), "--version"], env, stage,
    "PUBLIC_TOOLS_VERSION_MISMATCH", { timeout: 10_000, output: EXPECTED_DSH_VERSION });
  const files = {};
  for (const name of Object.keys(entries)) {
    files[name] = hash(fileInside(payload, entries[name]));
    files[`${name}Package`] = packageVersion(payload, name);
  }
  fs.writeFileSync(path.join(payload, markerName), JSON.stringify({ version: 1, definitionHash: fingerprint, files }) + "\n",
    { mode: 0o600, flag: "wx" });
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv.slice(2).some(value => !path.isAbsolute(value))) {
      fail("PUBLIC_TOOLS_ARGUMENT_INVALID");
    }
    prepareWorker(...process.argv.slice(2));
  } catch (error) {
    const code = /^PUBLIC_TOOLS_[A-Z_]+$/.test(error?.code || "") ? error.code : "PUBLIC_TOOLS_INSTALL_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
