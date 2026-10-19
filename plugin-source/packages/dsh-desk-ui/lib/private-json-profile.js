// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { validateWindowsPrivatePath, windowsPrivateDirectory, assertWindowsPrivateFile,
  createWindowsPrivateFile } from "./windows-private-state.js";
import { assertWindowsPrivateEntries } from "./windows-private-inspection.js";

const owned = stat => typeof process.getuid !== "function" || stat.uid === process.getuid();
function privateFile(stat, file) {
  if (!stat.isFile() || stat.nlink !== 1) return false;
  if (process.platform === "win32") {
    try { assertWindowsPrivateFile(file, stat); return true; } catch { return false; }
  }
  return owned(stat) && (stat.mode & 0o7777) === 0o600;
}
const identity = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs,
  stat.ctimeMs, stat.birthtimeMs, stat.mode, stat.nlink, stat.uid]);
const directoryIdentity = stat => `${stat.dev}:${stat.ino}`;

function privateDirectory(directory, create, invalid) {
  if (process.platform === "win32") {
    try {
      directory = validateWindowsPrivatePath(directory);
      const root = path.parse(directory).root;
      let current = root;
      for (const part of directory.slice(root.length).split(path.sep)) {
        current = path.join(current, part);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          stat = windowsPrivateDirectory(current, { create });
          if (!stat) return null;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(invalid);
      }
      return windowsPrivateDirectory(directory);
    } catch { throw Object.assign(Error(invalid), { code: invalid }); }
  }
  const root = path.parse(directory).root;
  let current = root, result;
  for (const part of ["", ...directory.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { result = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return null;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      result = fs.lstatSync(current);
    }
    if (!result.isDirectory() || result.isSymbolicLink()) throw Object.assign(Error(invalid), { code: invalid });
  }
  if (!owned(result) || (result.mode & 0o7777) !== 0o700) throw Object.assign(Error(invalid), { code: invalid });
  return result;
}

export function listPrivateJsonFiles(directory, { maxEntries = 1024, invalid, unavailable }) {
  let handle;
  try {
    const before = privateDirectory(directory, false, invalid);
    if (!before) return [];
    handle = fs.opendirSync(directory);
    const names = [];
    for (let entry; (entry = handle.readSync());) {
      names.push(entry.name);
      if (names.length > maxEntries) throw Object.assign(Error(unavailable), { code: unavailable });
    }
    const after = privateDirectory(directory, false, invalid);
    if (!after || directoryIdentity(before) !== directoryIdentity(after)) throw Object.assign(Error(invalid), { code: invalid });
    return names;
  } catch (error) {
    const code = error.code === invalid ? invalid : unavailable;
    throw Object.assign(Error(code), { code });
  } finally {
    if (handle) {
      try { handle.closeSync(); }
      catch { throw Object.assign(Error(unavailable), { code: unavailable }); }
    }
  }
}

// The caller supplies a Host-owned path and the record schema/error vocabulary.
// This is the shared filesystem mechanism, not a credential or authorization API.
export function createPrivateJsonProfile({ file, initial, validate, maxBytes, temporaryPrefix, errors }) {
  const fail = code => Object.assign(Error(code), { code });
  const known = new Set(Object.values(errors));
  let memory = initial(), empty = initial(), hadFile = false;
  function parent(create = false) {
    return privateDirectory(path.dirname(file), create, errors.invalid);
  }
  function load() {
    let fd;
    try {
      const windows = process.platform === "win32";
      if (windows) {
        try { validateWindowsPrivatePath(file); } catch { throw fail(errors.invalid); }
      }
      let directory;
      if (windows) {
        try { directory = fs.lstatSync(path.dirname(file)); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          // Missing paths still require the ordinary ancestor validation.
          directory = parent();
        }
      } else directory = parent();
      if (!directory) return null;
      let pathBefore, windowsBefore;
      const inspectReadPaths = (includeFile = true) => {
        try {
          return assertWindowsPrivateEntries([{ file: path.dirname(file), directory: true },
            ...(includeFile ? [{ file, directory: false }] : [])]);
        } catch { throw fail(errors.invalid); }
      };
      if (windows) {
        try { pathBefore = fs.lstatSync(file); }
        catch (error) {
          if (error.code === "ENOENT") inspectReadPaths(false);
          throw error;
        }
        if (!directory.isDirectory() || directory.isSymbolicLink() || !pathBefore.isFile()
          || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1 || pathBefore.size > maxBytes) throw fail(errors.invalid);
        // Reuse the process for this batch, never its ACL result. Both the
        // private parent and file (including ancestors) are checked each time.
        windowsBefore = inspectReadPaths();
      }
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(fd);
      if (windows && directoryIdentity(fs.fstatSync(fd, { bigint: true })) !== directoryIdentity(windowsBefore[1])) {
        throw fail(errors.invalid);
      }
      if ((pathBefore ? identity(before) !== identity(pathBefore) : !privateFile(before, file))
        || before.size > maxBytes) throw fail(errors.invalid);
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
      }
      if (length > maxBytes) throw fail(errors.invalid);
      const after = fs.fstatSync(fd), current = fs.lstatSync(file);
      const latestParent = windows ? fs.lstatSync(path.dirname(file)) : parent();
      if (windows) {
        const checked = inspectReadPaths();
        if (checked.some((stat, index) => directoryIdentity(stat) !== directoryIdentity(windowsBefore[index]))
          || directoryIdentity(checked[1]) !== directoryIdentity(fs.fstatSync(fd, { bigint: true }))) {
          throw fail(errors.invalid);
        }
      }
      if (!(windows ? after.isFile() && after.nlink === 1 : privateFile(after, file))
        || identity(before) !== identity(after) || identity(after) !== identity(current)
        || !latestParent || directoryIdentity(directory) !== directoryIdentity(latestParent)) {
        throw fail(errors.invalid);
      }
      let record;
      try { record = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
      catch { throw fail(errors.invalid); }
      if (!validate(record)) throw fail(errors.invalid);
      return { record, stamp: `${directoryIdentity(directory)}:${identity(after)}:${
        createHash("sha256").update(buffer.subarray(0, length)).digest("hex")}` };
    } catch (error) {
      if (fd === undefined && error.code === "ENOENT") return null;
      if (known.has(error.code)) throw error;
      throw fail(["ELOOP", "ENOTDIR"].includes(error.code) ? errors.invalid : errors.unavailable);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { throw fail(errors.unavailable); }
      }
    }
  }
  function current() {
    if (!file) return { record: memory, stamp: `memory:${memory.revision}` };
    const value = load();
    if (value) { hadFile = true; return value; }
    if (hadFile) { empty = initial(); hadFile = false; }
    return { record: empty, stamp: `absent:${empty.revision}` };
  }
  function write(record, selected) {
    if (!file) { memory = record; return record; }
    const lock = path.join(path.dirname(file), `.${path.basename(file)}.lock`);
    let fd, temporary, temporaryStat, lockFd, lockStat, directory, lockCreated = false, creationUncertain = false;
    const assertLock = () => {
      const latestParent = parent(), latest = fs.lstatSync(lock);
      if (!directory || !lockStat || !latestParent ||
        directoryIdentity(directory) !== directoryIdentity(latestParent) ||
        !privateFile(latest, lock) || directoryIdentity(lockStat) !== directoryIdentity(latest)) {
        throw fail(errors.write);
      }
    };
    const assertTemporary = () => {
      const latestParent = parent(), latest = fs.lstatSync(temporary);
      if (!directory || !temporaryStat || !latestParent
        || directoryIdentity(directory) !== directoryIdentity(latestParent)
        || !privateFile(latest, temporary) || directoryIdentity(temporaryStat) !== directoryIdentity(latest)) {
        throw fail(errors.write);
      }
    };
    try {
      directory = parent(true);
      try {
        if (process.platform === "win32") {
          createWindowsPrivateFile(lock);
          lockCreated = true;
          lockStat = fs.lstatSync(lock);
          lockFd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        } else {
          lockFd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          lockCreated = true;
          lockStat = fs.fstatSync(lockFd);
        }
      } catch (error) {
        if (error.code === "EEXIST") throw fail(errors.busy);
        throw error;
      }
      const openedLock = fs.fstatSync(lockFd);
      if (!privateFile(openedLock, lock) || directoryIdentity(lockStat) !== directoryIdentity(openedLock)) throw fail(errors.write);
      assertLock();
      if (current().stamp !== selected.stamp) throw fail(errors.changed);
      const candidate = path.join(path.dirname(file), `${temporaryPrefix}${randomBytes(16).toString("hex")}`);
      if (process.platform === "win32") {
        creationUncertain = true;
        try { createWindowsPrivateFile(candidate); }
        catch (error) {
          if (error.code === "EEXIST") creationUncertain = false;
          throw error;
        }
        creationUncertain = false;
        temporary = candidate;
        temporaryStat = fs.lstatSync(candidate);
        fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd);
        if (!privateFile(opened, candidate) || directoryIdentity(temporaryStat) !== directoryIdentity(opened)) throw fail(errors.write);
      } else {
        temporary = candidate;
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
          | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      }
      fs.writeFileSync(fd, JSON.stringify(record) + "\n");
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      const latestParent = parent();
      if (!latestParent || directoryIdentity(directory) !== directoryIdentity(latestParent)
        || current().stamp !== selected.stamp) throw fail(errors.changed);
      assertLock();
      if (process.platform === "win32") assertTemporary();
      fs.renameSync(temporary, file); temporary = undefined;
      // Windows qualifies flushed content + atomic replacement/readback for
      // process restart, not POSIX directory-fsync or power-loss durability.
      if (process.platform !== "win32") {
        fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
      }
      const saved = current();
      if (saved.record.revision !== record.revision) throw fail(errors.changed);
      return saved.record;
    } catch (error) {
      if (known.has(error.code)) throw error;
      throw fail(errors.write);
    } finally {
      let cleanupFailed = creationUncertain;
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { cleanupFailed = true; }
      }
      if (temporary) {
        try {
          if (process.platform === "win32") assertTemporary();
          fs.unlinkSync(temporary);
        } catch (error) { if (error.code !== "ENOENT") cleanupFailed = true; }
      }
      if (lockCreated) {
        try {
          if (cleanupFailed) throw fail(errors.write);
          assertLock();
          fs.unlinkSync(lock);
        } catch { cleanupFailed = true; }
        if (lockFd !== undefined) {
          try { fs.closeSync(lockFd); } catch { cleanupFailed = true; }
        }
      }
      if (cleanupFailed) throw fail(errors.write);
    }
  }
  return Object.freeze({ current, write });
}
