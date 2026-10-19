// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { canonicalHash } from "../schema/canonical-json.mjs";

/** SQLite rollback cannot undo a filesystem rename. Retain uncertain candidates. */
export function activatePersonalGeneration({ db, temporaryPointer, pointer, expectedPointer, check, io = fs }) {
  let activated = false, renameAttempted = false, transaction = false;
  try {
    db.exec("BEGIN IMMEDIATE"); transaction = true;
    check();
    if (expectedPointer !== undefined) {
      let current = null;
      try { current = JSON.parse(io.readFileSync(pointer, {
        encoding: "utf8", flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      })); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (canonicalHash(current) !== canonicalHash(expectedPointer)) {
        throw Object.assign(Error("SOURCE_CHANGED"), { code: "SOURCE_CHANGED" });
      }
    }
    const windows = process.platform === "win32";
    let candidate;
    const flush = target => {
      const fd = io.openSync(target, windows
        ? fs.constants.O_RDWR | fs.constants.O_NOFOLLOW : fs.constants.O_RDONLY);
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    };
    if (windows) {
      candidate = io.readFileSync(temporaryPointer);
      flush(temporaryPointer);
    }
    renameAttempted = true;
    io.renameSync(temporaryPointer, pointer);
    activated = true;
    // Windows has no POSIX directory fsync. Qualify file flush and process
    // restart readback, not power-loss durability of the directory entry.
    if (windows) {
      flush(pointer);
      if (!candidate.equals(io.readFileSync(pointer))) throw Error("POINTER_READBACK_MISMATCH");
    } else flush(path.dirname(pointer));
    db.exec("COMMIT"); transaction = false;
    return { status: "ACTIVATED", activated: true, errorCode: null };
  } catch (error) {
    if (transaction) { try { db.exec("ROLLBACK"); } catch { /* The pointer remains independently authoritative. */ } }
    if (renameAttempted) return { status: "UNKNOWN", activated: activated ? true : null,
      errorCode: "GENERATION_ACTIVATION_UNKNOWN" };
    return { status: "NOT_ACTIVATED", activated: false,
      errorCode: /^[A-Z_]{2,64}$/.test(error?.code) ? error.code : "SOURCE_UNAVAILABLE" };
  }
}
