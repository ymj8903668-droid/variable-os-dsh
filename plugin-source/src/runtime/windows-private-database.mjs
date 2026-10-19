// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateWindowsPrivatePath, windowsPrivateDirectory, createWindowsPrivateFile,
  assertWindowsPrivateFile } from "../../packages/dsh-desk-ui/lib/windows-private-state.js";

const invalid = () => { throw Object.assign(Error("WINDOWS_PRIVATE_STATE_INVALID"), { code: "WINDOWS_PRIVATE_STATE_INVALID" }); };

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function inspect(file) {
  const value = stat(file);
  if (value) assertWindowsPrivateFile(file, value);
  return value;
}

function ensure(file) {
  if (!inspect(file)) {
    try { createWindowsPrivateFile(file); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  assertWindowsPrivateFile(file, fs.lstatSync(file));
}

function inspectHeader(file, value) {
  if (!value?.size) return;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    assertWindowsPrivateFile(file, fs.fstatSync(fd));
    const header = Buffer.alloc(20);
    if (value.size < 100 || fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
      !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ||
      header[18] !== 1 || header[19] !== 1) invalid();
  } finally { fs.closeSync(fd); }
}

/** Opt-in personal state only. Existing WAL databases are never migrated here. */
export function openWindowsPrivateDatabase(file) {
  let db;
  try {
    if (process.platform !== "win32") invalid();
    file = validateWindowsPrivatePath(file);
    if (!windowsPrivateDirectory(path.dirname(file))) invalid();
    const main = inspect(file), journal = inspect(`${file}-journal`);
    if (stat(`${file}-wal`) || stat(`${file}-shm`) || !main?.size && journal?.size) invalid();
    inspectHeader(file, main);
    ensure(file);
    ensure(`${file}-journal`);
    db = new DatabaseSync(path.toNamespacedPath(file));
    db.exec("PRAGMA busy_timeout = 5000");
    if (db.prepare("PRAGMA journal_mode = PERSIST").get().journal_mode !== "persist") invalid();
    // Hot-journal recovery can remove its old journal before this connection's
    // mode is selected. Recreate only a missing file, never repair an existing one.
    ensure(`${file}-journal`);
    assertWindowsPrivateFile(file, fs.lstatSync(file));
    return db;
  } catch {
    try { db?.close(); } finally { invalid(); }
  }
}
