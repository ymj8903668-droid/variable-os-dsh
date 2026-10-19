// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs, { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateWindowsPrivatePath, windowsPrivateDirectory, assertWindowsPrivateFile,
  createWindowsPrivateFile } from "./windows-private-state.js";

const INVALID = "PUBLIC_ONBOARDING_INVALID";
const MAX_BYTES = 1024;
const fail = code => Object.assign(Error(code), { code });
const choiceAllowed = choice => choice === "configure" || choice === "later";
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const privateOwner = stat => typeof process.getuid === "function"
  && stat.uid === process.getuid() && !(stat.mode & 0o7077);

function record(input, fields, code = "INVALID_REQUEST") {
  if (!input || typeof input !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)
    || !Object.hasOwn(descriptors[key], "value"))) throw fail(code);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function rootDirectory(root, create = false) {
  if (process.platform === "win32") return windowsPrivateDirectory(root, { create });
  let current = path.parse(root).root;
  const parts = root.slice(current.length).split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const last = index === parts.length - 1;
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT" || !last) throw error;
      if (!create) return null;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory()) throw fail(INVALID);
    if (last) {
      if (!privateOwner(stat)) throw fail(INVALID);
      return stat;
    }
    // System-owned sticky temp directories are safe parents of a private root.
    if (![0, process.getuid?.()].includes(stat.uid)
      || (stat.mode & 0o022) && !(stat.uid === 0 && stat.mode & 0o1000)) throw fail(INVALID);
  }
}

function privateFile(stat, file) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw fail(INVALID);
  if (process.platform === "win32") {
    try { assertWindowsPrivateFile(file, stat); } catch { throw fail(INVALID); }
  } else if (!privateOwner(stat)) throw fail(INVALID);
}

function readChoice(file) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  privateFile(before, file);
  const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    privateFile(opened, file);
    if (!sameFile(before, opened)) throw fail(INVALID);
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, length))) {
      length += count;
    }
    if (length > MAX_BYTES) throw fail(INVALID);
    privateFile(fs.fstatSync(fd), file);
    const value = record(JSON.parse(bytes.subarray(0, length).toString("utf8")), ["version", "choice"], INVALID);
    if (value.version !== 1 || !choiceAllowed(value.choice)) throw fail(INVALID);
    return value.choice;
  } finally { fs.closeSync(fd); }
}

/** Navigation metadata only, never service readiness or permission to activate.
 * The private workspace is not isolation from a hostile process with the same uid. */
export function createPublicOnboarding(options) {
  const fields = Object.hasOwn(options ?? {}, "root") ? ["enabled", "root"] : ["enabled"];
  const { enabled, root: supplied } = record(options, fields);
  if (typeof enabled !== "boolean" || enabled && (typeof supplied !== "string" || !path.isAbsolute(supplied)
    || supplied.includes("\0"))) throw fail("INVALID_REQUEST");
  if (enabled && process.platform === "win32") {
    try { validateWindowsPrivatePath(supplied); } catch { throw fail("INVALID_REQUEST"); }
  }
  const root = enabled ? path.resolve(supplied) : null;
  if (enabled && root === path.parse(root).root) throw fail("INVALID_REQUEST");
  const file = enabled ? path.join(root, "public-onboarding.json") : null;
  const result = choice => ({ enabled, version: 1, choice });
  function read() {
    try { return rootDirectory(root) ? readChoice(file) : null; }
    catch { throw fail(INVALID); }
  }
  return Object.freeze({
    async status(params) {
      if (params !== undefined) record(params, []);
      return result(enabled ? read() : null);
    },
    async complete(params) {
      if (!enabled) throw fail("METHOD_NOT_ALLOWED");
      const { choice } = record(params, ["choice"]);
      if (!choiceAllowed(choice)) throw fail("INVALID_REQUEST");
      if (read() === choice) return result(choice);
      let fd, temporary;
      try {
        const directory = rootDirectory(root, true);
        const candidate = path.join(root, `.public-onboarding-${randomUUID()}.tmp`);
        if (process.platform === "win32") {
          createWindowsPrivateFile(candidate);
          temporary = candidate;
          fd = fs.openSync(candidate, constants.O_WRONLY | constants.O_NOFOLLOW);
        } else {
          fd = fs.openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          temporary = candidate;
        }
        privateFile(fs.fstatSync(fd), candidate);
        fs.writeFileSync(fd, JSON.stringify({ version: 1, choice }) + "\n");
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        if (!sameFile(directory, rootDirectory(root))) throw fail(INVALID);
        readChoice(file);
        // A bounded synchronous operation serializes Host calls; unique temp
        // files and atomic rename also prevent partial reads by other processes.
        fs.renameSync(temporary, file); temporary = undefined;
        return result(choice);
      } catch (error) {
        throw fail(error.code === INVALID ? INVALID : "PUBLIC_ONBOARDING_WRITE_FAILED");
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
        if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
      }
    },
  });
}
