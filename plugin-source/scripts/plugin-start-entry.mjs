// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";
import { readPluginInput, readApprovedPluginArchive } from "./install-public-plugin.mjs";
import { startInstalledPlugin, stopInstalledPlugin } from "./start-installed-plugin.mjs";
import { supervise, cancelled } from "./public-desk-lifecycle.mjs";
import { selectPublicTools } from "./public-tools.mjs";

const fail = code => { throw Object.assign(Error(code), { code }); };
const bundleRoot = fileURLToPath(new URL("../../", import.meta.url));
const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export async function launchInstalledBundle(args, { signal } = {}) {
  if (signal) cancelled(signal);
  if (!(args.length === 1 && ["start", "stop"].includes(args[0])
    || args.length === 2 && args[0] === "start" && args[1] === "--no-open")) fail("PLUGIN_START_ARGUMENTS_INVALID");
  if (!process.env.HOME || !path.isAbsolute(process.env.HOME)) fail("PLUGIN_BUNDLE_STATE_INVALID");
  const home = await fs.realpath(process.env.HOME), stat = await fs.lstat(home);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) fail("PLUGIN_BUNDLE_STATE_INVALID");
  const parent = path.join(home, ".variable-os-plugin"), destination = path.join(parent, "installation");
  try {
    const current = await fs.lstat(parent);
    if (!current.isDirectory() || current.uid !== process.getuid?.() || current.mode & 0o077
      || await fs.realpath(parent) !== parent) fail("PLUGIN_BUNDLE_STATE_INVALID");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (args[0] === "stop") {
    console.log(await stopInstalledPlugin({ destination }));
    return 0;
  }
  const env = { HOME: home, PATH: process.env.PATH ?? "", COREPACK_HOME: process.env.COREPACK_HOME ?? "" };
  if (typeof process.send !== "function") {
    return supervise({ entry: fileURLToPath(import.meta.url), args, env, cwd: bundleRoot, signal });
  }
  const stop = new AbortController(), lost = () => stop.abort("PUBLIC_PARENT_LOST");
  const message = value => {
    if (value?.type === "public-desk-stop" && Object.hasOwn(signals, value.signal)) stop.abort(value.signal);
  };
  const handlers = Object.keys(signals).map(name => [name, () => stop.abort(name)]);
  process.on("disconnect", lost); process.on("message", message);
  for (const [name, handler] of handlers) process.on(name, handler);
  if (!process.connected) lost();
  try {
    const descriptor = JSON.parse(await readPluginInput(path.join(bundleRoot, "descriptor.json"), 16384));
    await readApprovedPluginArchive(path.join(bundleRoot, "plugin.tgz"), descriptor);
    if (!selectPublicTools({ root: parent, sourceRoot: path.join(bundleRoot, "app"), env })) {
      fail("PLUGIN_TOOLS_INSTALL_REQUIRED");
    }
    await startInstalledPlugin({ destination, descriptor, env, signal: stop.signal, noOpen: args.includes("--no-open") });
    return 0;
  } finally {
    process.off("disconnect", lost); process.off("message", message);
    for (const [name, handler] of handlers) process.off(name, handler);
    if (process.connected) process.disconnect();
  }
}

if (isCliEntrypoint(import.meta.url)) {
  try { process.exitCode = await launchInstalledBundle(process.argv.slice(2)); }
  catch (error) {
    if (error.code === "PUBLIC_CANCELLED" && error.signal === "PUBLIC_STOP") {
      console.log("PUBLIC_DESK_STOPPED");
    } else {
      console.error(/^(?:PLUGIN_|PUBLIC_)[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "PLUGIN_START_FAILED");
      process.exitCode = error.code === "PUBLIC_CANCELLED" ? signals[error.signal] ?? 1 : 1;
    }
  }
}
