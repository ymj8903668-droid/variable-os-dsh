// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync,
  fsyncSync, renameSync, unlinkSync, lstatSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createPrivateJsonProfile } from "../../packages/dsh-desk-ui/lib/private-json-profile.js";

const fail = code => { throw Object.assign(Error(code), { code }); };
const owned = stat => typeof process.getuid !== "function" || stat.uid === process.getuid();

/** The Host supplies the optional file; no credential discovery or Keychain. */
export function createWikiSourceProfile(env) {
  const file = env.VARIABLE_OS_IMA_SETTINGS_FILE ?? null;
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0"))) {
    fail("WIKI_PROFILE_INVALID");
  }
  const absent = Object.freeze({ revision: randomBytes(32).toString("hex") });
  const native = file && process.platform === "win32" ? createPrivateJsonProfile({
    file, initial: () => absent,
    // The caller validates the existing IMA envelope, credentials and selection.
    validate: () => true, maxBytes: 65536, temporaryPrefix: ".ima-",
    errors: { invalid: "WIKI_PROFILE_INVALID", unavailable: "WIKI_PROFILE_INVALID",
      write: "WIKI_PROFILE_WRITE_FAILED", busy: "WIKI_PROFILE_WRITE_FAILED", changed: "WIKI_PROFILE_WRITE_FAILED" },
  }) : null;
  function parent() {
    const stat = lstatSync(path.dirname(file));
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o077)) fail("WIKI_PROFILE_INVALID");
  }
  const read = () => {
    if (!file) return null;
    if (native) {
      const { record } = native.current();
      return record === absent ? null : record;
    }
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      parent();
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || (stat.mode & 0o077) || stat.size > 65536) {
        fail("WIKI_PROFILE_INVALID");
      }
      const body = readFileSync(fd);
      if (body.length > 65536) fail("WIKI_PROFILE_INVALID");
      return JSON.parse(body.toString("utf8"));
    } catch (error) {
      if (fd === undefined && error.code === "ENOENT") return null;
      fail("WIKI_PROFILE_INVALID");
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  return {
    persistent: file !== null, read,
    write(value) {
      if (!file) return;
      if (native) {
        try { native.write(value, native.current()); return; }
        catch { fail("WIKI_PROFILE_WRITE_FAILED"); }
      }
      let fd, temporary;
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        parent(); read();
        temporary = path.join(path.dirname(file), `.ima-${randomBytes(16).toString("hex")}`);
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, JSON.stringify(value) + "\n");
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, file); temporary = undefined;
      } catch { fail("WIKI_PROFILE_WRITE_FAILED"); }
      finally {
        if (fd !== undefined) closeSync(fd);
        if (temporary) { try { unlinkSync(temporary); } catch {} }
      }
    },
  };
}
