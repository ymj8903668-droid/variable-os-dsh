// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only

/** Encode only non-ASCII bytes; stored spelling and slash hierarchy stay exact. */
export function encodeWikiPath(value) {
  if (typeof value !== "string" || !value || !value.isWellFormed() || Buffer.byteLength(value) > 1024
    || /[\s\\%?#:\p{Cc}\p{Cf}]/u.test(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || /^raw$/i.test(part))) return null;
  const encoded = value.replace(/[^\x00-\x7f]+/gu, encodeURIComponent);
  const route = `/v1/wiki/${encoded}`;
  return new URL(route, "https://wiki.invalid").pathname === route ? encoded : null;
}

/** One strict UTF-8 decode, followed by exact canonical transport comparison. */
export function decodeWikiPath(value) {
  if (typeof value !== "string" || value.length > 3072) return null;
  try {
    const decoded = decodeURIComponent(value);
    return encodeWikiPath(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}
