// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readInstalledPlugin, readPluginInput } from "./install-public-plugin.mjs";
import { findExecutable, EXPECTED_DSH_VERSION, EXPECTED_PNPM_VERSION } from "./dsh-contract.mjs";
import { PUBLIC_PLUGIN_HOST_PEERS } from "../packages/dsh-desk-ui/lib/public-plugin-runtime.js";
import { privateDirectory, writePatch, holdLaunchLock, stopPublicDesk, runChild, cancelled } from "./public-desk-lifecycle.mjs";
import { retirePluginBackupPublications } from "./retire-plugin-backup-publications.mjs";

const fail = code => { throw Object.assign(Error(code), { code }); };
export { approvedInstallation as readApprovedInstalledPlugin };
async function noInstallInProgress(destination) {
  try {
    await fs.lstat(path.join(path.dirname(destination), "install-entry.guard"));
    fail("PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function destinationExists(destination) {
  if (typeof destination !== "string" || !path.isAbsolute(destination) || path.resolve(destination) !== destination) {
    fail("PLUGIN_DESTINATION_INVALID");
  }
  let stat;
  try { stat = await fs.lstat(destination); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077
    || await fs.realpath(destination) !== destination) fail("PUBLIC_STATE_UNSAFE");
  return true;
}

async function approvedInstallation(destination, descriptor, {profileDestination=destination}={}) {
  let receipt;
  try {
    receipt = JSON.parse(await readPluginInput(path.join(destination, "install-receipt.json"), 16384));
    if (receipt.schema !== 1 || receipt.status !== "INSTALLED_NOT_STARTED" || receipt.hostStarted !== false
      || receipt.publicReleaseQualified !== false || descriptor?.schema !== 1
      || descriptor.publicReleaseQualified !== false || descriptor.dshVersion !== EXPECTED_DSH_VERSION
      || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || !/^[a-f0-9]{64}$/.test(descriptor.manifestSha256)
      || receipt.archiveSha256 !== descriptor.sha256 || receipt.manifestSha256 !== descriptor.manifestSha256
      || receipt.version !== descriptor.version) throw Error("RECEIPT");
    assert.deepEqual(receipt.phases, ["pnpm-version", "dsh-version", "install", "compose", "import"]
      .map(phase => ({ phase, exitCode: 0, signal: null, timedOut: false })));
  } catch { fail("PLUGIN_INSTALL_REQUIRED"); }
  const installed = await readInstalledPlugin(destination, descriptor);
  if (receipt.verifiedFiles !== installed.files || receipt.verifiedHostPeers !== Object.keys(PUBLIC_PLUGIN_HOST_PEERS).length
    || receipt.verifiedDependencyPackages !== installed.verifiedDependencyPackages
    || receipt.dependencyLockSha256 !== installed.dependencyLockSha256) {
    fail("PLUGIN_INSTALL_REQUIRED");
  }
  const profile = path.join(destination, "home/.dsh/profiles/web/package.json");
  try {
    assert.deepEqual(JSON.parse(await readPluginInput(profile, 128 * 1024)), {
      name: "dsh-profile-web", private: true,
      dependencies: { "@variable-os/dsh-desk-ui": `file:${path.join(profileDestination, "plugin.tgz")}` },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@variable-os/dsh-desk-ui"] } },
    });
  } catch { fail("PLUGIN_PROFILE_INVALID"); }
  return installed;
}

export async function startInstalledPlugin({ destination, descriptor, env = process.env, signal, noOpen = false } = {}) {
  if (!["darwin", "linux"].includes(process.platform)) fail("PLUGIN_INSTALL_PLATFORM_UNQUALIFIED");
  if (process.versions.node.split(".")[0] !== "24") fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
  if (typeof noOpen !== "boolean") fail("PLUGIN_START_ARGUMENTS_INVALID");
  const stop = new AbortController(), cancel = () => stop.abort(signal.reason);
  if (signal?.aborted) cancel();
  cancelled(stop.signal);
  if (!await destinationExists(destination)) fail("PLUGIN_INSTALL_REQUIRED");
  await noInstallInProgress(destination);
  const installed = await approvedInstallation(destination, descriptor);
  const plan = { root: path.join(destination, "launch"), cwd: path.join(destination, "workspace"), env: {
    HOME: path.join(destination, "home"), DSH_HOME: path.join(destination, "home/.dsh"),
    PATH: String(env.PATH ?? "").split(path.delimiter).filter(folder => path.isAbsolute(folder)).join(path.delimiter),
    XDG_CONFIG_HOME: path.join(destination, "config"), XDG_CACHE_HOME: path.join(destination, "cache"),
    TMPDIR: path.join(destination, "tmp"), SHELL: "/bin/sh", NO_COLOR: "1", DSH_TELEMETRY_DISABLED: "1",
    COREPACK_ENABLE_NETWORK: "0", COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENV_FILE: "0",
    pnpm_config_offline: "true", pnpm_config_ignore_scripts: "true", pnpm_config_manage_package_manager_versions: "false",
  } };
  if (env.COREPACK_HOME && path.isAbsolute(env.COREPACK_HOME)) plan.env.COREPACK_HOME = env.COREPACK_HOME;
  privateDirectory(plan.root);
  const release = holdLaunchLock(plan.root, () => stop.abort("PUBLIC_STOP"));
  let retainLock = false;
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await noInstallInProgress(destination);
    await retirePluginBackupPublications({ destination,
      launchIdentity: await fs.lstat(path.join(plan.root, "public-launch.lock")) });
    for (const directory of [plan.cwd, plan.env.HOME, plan.env.XDG_CONFIG_HOME, plan.env.XDG_CACHE_HOME, plan.env.TMPDIR]) {
      privateDirectory(directory);
    }
    const dsh = findExecutable("dsh", plan.env), pnpm = findExecutable("pnpm", plan.env), node = findExecutable("node", plan.env);
    if (!dsh || !pnpm || !node || await fs.realpath(node) !== await fs.realpath(process.execPath)) {
      fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
    }
    for (const [command, version] of [[pnpm, EXPECTED_PNPM_VERSION], [dsh, EXPECTED_DSH_VERSION]]) {
      const result = await runChild(command, ["--version"], plan, stop.signal, { capture: true, timeoutMs: 10000 });
      if (result.status !== 0 || result.stdout.trim() !== version) fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
    }
    const inspection = await runChild(process.execPath,
      [fileURLToPath(new URL("./inspect-plugin-host.mjs", import.meta.url)), "--dsh", dsh,
        "--profile-root", path.join(destination, "home/.dsh/profiles/web"),
        "--entry", pathToFileURL(path.join(installed.installed, installed.main)).href],
      plan, stop.signal, { capture: true, timeoutMs: 20000 });
    if (inspection.status !== 0) fail("PUBLIC_PLUGIN_RUNTIME_INCOMPATIBLE");
    const patch = writePatch(plan);
    const result = await runChild(dsh, ["--profile", "web", "--patch", patch,
      "--host", "127.0.0.1", "--port", "0", ...(noOpen ? ["--no-open"] : [])], plan, stop.signal);
    if (result.status !== 0) fail("PUBLIC_HOST_FAILED");
  } catch (error) {
    retainLock = error.retainLock === true;
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    release(retainLock);
  }
}

export async function stopInstalledPlugin({ destination } = {}) {
  if (!await destinationExists(destination)) return "PUBLIC_DESK_NOT_RUNNING";
  return stopPublicDesk(path.join(destination, "launch"));
}
