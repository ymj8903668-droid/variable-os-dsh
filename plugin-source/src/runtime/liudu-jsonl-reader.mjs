// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { constants } from "node:fs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LIUDU_READ_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 ** 3,
  lineBytes: 1024 ** 2,
  lines: 100_000,
  chunkBytes: 64 * 1024,
  elapsedMs: 30_000,
  bootstrapBytes: 32 * 1024 ** 2,
  itemBytes: 64 * 1024 ** 2,
  items: 10_000,
});

export function liuduReadError(code) {
  return Object.assign(new Error("Liudu source read refused"), { code });
}

export function liuduReadBudget() {
  const deadline = performance.now() + LIUDU_READ_LIMITS.elapsedMs;
  return () => {
    if (performance.now() > deadline) throw liuduReadError("SOURCE_SCAN_TIMEOUT");
  };
}

const sameVersion = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "uid", "mode", "nlink"]
  .every(key => a[key] === b[key]);
const changed = () => { throw liuduReadError("SOURCE_CHANGED"); };
const SAFE_CODES = new Set(["SOURCE_CHANGED", "SOURCE_SYMLINK_FORBIDDEN", "SOURCE_TOO_LARGE",
  "SOURCE_CONTENT_TOO_LARGE", "SOURCE_SCAN_LIMIT", "SOURCE_SCAN_TIMEOUT",
  "SOURCE_SELECTION_TOO_LARGE", "SOURCE_CONTENT_INVALID"]);

/** Internal reducer, not an async generator: callers collect tentative values
 * without writes, and publish nothing until descriptor/path validation succeeds.
 * Line buffers are borrowed; a retained bootstrap candidate must copy its bytes.
 */
export async function readStableLiuduJsonl(file, visit, checkBudget, finish = () => {}, validateStat = () => {}) {
  let handle;
  try {
    checkBudget();
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file)
      throw liuduReadError("SOURCE_READ_FAILED");
    const before = await fs.lstat(file, { bigint: true });
    validateStat(before);
    if (before.isSymbolicLink()) throw liuduReadError("SOURCE_SYMLINK_FORBIDDEN");
    if (!before.isFile() || await fs.realpath(file) !== file) changed();
    if (before.size > BigInt(LIUDU_READ_LIMITS.fileBytes)) throw liuduReadError("SOURCE_TOO_LARGE");
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameVersion(before, await handle.stat({ bigint: true }))) changed();
    // Keep the original public watermark's Number-Stats Date rounding. BigInt
    // Stats truncates sub-millisecond times; it is used only for race detection.
    const publicStat = await handle.stat();

    const buffer = Buffer.allocUnsafe(LIUDU_READ_LIMITS.chunkBytes);
    const digest = crypto.createHash("sha256");
    let position = 0, parts = [], lineBytes = 0, lines = 0;
    const consume = (segment, terminated) => {
      checkBudget();
      lineBytes += segment.length;
      if (lineBytes > LIUDU_READ_LIMITS.lineBytes) throw liuduReadError("SOURCE_CONTENT_TOO_LARGE");
      if (!terminated) {
        if (segment.length) parts.push(Buffer.from(segment));
        return;
      }
      if (++lines > LIUDU_READ_LIMITS.lines) throw liuduReadError("SOURCE_SCAN_LIMIT");
      const raw = parts.length ? Buffer.concat([...parts, segment], lineBytes) : segment;
      visit(raw, true);
      parts = []; lineBytes = 0;
      checkBudget();
    };
    while (position < Number(before.size)) {
      checkBudget();
      const { bytesRead } = await handle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - position), position);
      if (bytesRead === 0) changed();
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      let start = 0, newline;
      while ((newline = buffer.indexOf(10, start)) !== -1 && newline < bytesRead) {
        consume(buffer.subarray(start, newline), true);
        start = newline + 1;
      }
      consume(buffer.subarray(start, bytesRead), false);
    }
    if (lineBytes) {
      if (++lines > LIUDU_READ_LIMITS.lines) throw liuduReadError("SOURCE_SCAN_LIMIT");
      visit(Buffer.concat(parts, lineBytes), false);
    }
    checkBudget();
    finish();
    checkBudget();
    const after = await handle.stat({ bigint: true }), located = await fs.lstat(file, { bigint: true });
    if (!sameVersion(before, after) || !sameVersion(before, located) ||
        located.isSymbolicLink() || await fs.realpath(file) !== file) changed();
    checkBudget();
    return Object.freeze({ size: Number(before.size), mtime: publicStat.mtime,
      sha256: digest.digest("hex"), physicalLines: lines });
  } catch (error) {
    throw liuduReadError(error?.code === "ELOOP" ? "SOURCE_SYMLINK_FORBIDDEN" :
      SAFE_CODES.has(error?.code) ? error.code : "SOURCE_READ_FAILED");
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { throw liuduReadError("SOURCE_READ_FAILED"); }
    }
  }
}
