// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function invalidWindowsPrivateState() {
  throw Object.assign(Error("WINDOWS_PRIVATE_STATE_INVALID"), { code: "WINDOWS_PRIVATE_STATE_INVALID" });
}

export function validatePrivateWindowsMode(value) {
  if (typeof value !== "boolean") {
    throw Object.assign(Error("WINDOWS_PRIVATE_MODE_INVALID"), { code: "WINDOWS_PRIVATE_MODE_INVALID" });
  }
  if (value && process.platform !== "win32") invalidWindowsPrivateState();
}

// The zero-install CLI ships src/ without the plugin. Load its policy only
// when an opt-in Windows writer runs.
export async function windowsPrivateDirectory(directory, options) {
  const policy = await import("../../packages/dsh-desk-ui/lib/windows-private-state.js");
  return policy.windowsPrivateDirectory(directory, options);
}

/** Preflight an existing personal tree before creating or replacing anything. */
export async function assertWindowsPrivateTree(root) {
  const { assertWindowsPrivateEntries } = await import(
    "../../packages/dsh-desk-ui/lib/windows-private-inspection.js");
  let level = [{ file: root, directory: true }];
  while (level.length) {
    assertWindowsPrivateEntries(level);
    const next = [];
    for (const entry of level) if (entry.directory) {
      for (const name of fs.readdirSync(entry.file)) {
        const file = path.join(entry.file, name), stat = fs.lstatSync(file);
        next.push({ file, directory: stat.isDirectory() });
      }
    }
    level = next;
  }
}

async function inspectExistingFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const { assertWindowsPrivateFile } = await import("../../packages/dsh-desk-ui/lib/windows-private-state.js");
  assertWindowsPrivateFile(file, stat);
}

export async function writeWindowsPrivateJson(file, value, options) {
  return writeWindowsPrivateFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeWindowsPrivateFile(file, value, { atomic = false } = {}) {
  const { createWindowsPrivateFile, assertWindowsPrivateFile } = await import(
    "../../packages/dsh-desk-ui/lib/windows-private-state.js");
  if (atomic) await inspectExistingFile(file);
  const target = atomic ? `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp` : file;
  createWindowsPrivateFile(target);
  try {
    const handle = await fsp.open(target, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      assertWindowsPrivateFile(target, await handle.stat());
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    if (atomic) {
      await inspectExistingFile(file);
      await fsp.rename(target, file);
    }
  } catch (error) {
    await fsp.rm(target, { force: true });
    throw error;
  }
}
