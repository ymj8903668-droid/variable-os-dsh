// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { validateWindowsPrivatePath, windowsPrivateDirectory } from "./windows-private-state.js";

const fail = () => { throw Object.assign(Error("PUBLIC_PLUGIN_STATE_INVALID"), { code: "PUBLIC_PLUGIN_STATE_INVALID" }); };
const absolute = value => typeof value === "string" && path.isAbsolute(value)
  && !value.includes("\0") && path.resolve(value) !== path.parse(value).root;

function privateDirectory(directory) {
  if (process.platform === "win32") {
    windowsPrivateDirectory(directory, { create: true });
    return;
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) { if (error.code !== "EEXIST") fail(); }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o7077) fail();
}

export function createPublicPluginEnvironment({ dshHome, appRoot } = {}) {
  if (!absolute(dshHome) || !absolute(appRoot)
    || process.platform !== "win32" && typeof process.getuid !== "function") fail();
  try {
    if (process.platform === "win32") {
      validateWindowsPrivatePath(appRoot);
      if (!windowsPrivateDirectory(dshHome)) fail();
    } else {
      const home = fs.lstatSync(dshHome);
      if (!home.isDirectory() || home.uid !== process.getuid() || home.mode & 0o022) fail();
    }
    dshHome = fs.realpathSync(dshHome);
    const root = path.join(dshHome, "variable-os"), connections = path.join(root, "connections");
    privateDirectory(root);
    privateDirectory(connections);
    return Object.freeze({
      DSH_HOME: dshHome,
      VARIABLE_OS_PROVIDER: "remote", VARIABLE_OS_WIKI_PROVIDER: "none", VARIABLE_OS_PUBLIC_DESK: "1",
      VARIABLE_OS_APP_ROOT: path.resolve(appRoot),
      VARIABLE_OS_PERSONAL_DESK_ROOT: path.join(root, "personal"),
      VARIABLE_OS_SOURCE_SETTINGS_FILE: path.join(connections, "source.json"),
      VARIABLE_OS_IMA_SETTINGS_FILE: path.join(connections, "ima.json"),
      VARIABLE_OS_WEB_SETTINGS_FILE: path.join(connections, "web.json"),
      VARIABLE_OS_MODEL_SETTINGS_FILE: path.join(connections, "model.json"),
    });
  } catch { fail(); }
}
