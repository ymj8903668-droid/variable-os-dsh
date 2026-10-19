// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
const compact = value => value.normalize("NFC").replace(/\s+/gu, "");
export function disclosureFragment(text) {
  const value = compact(text);
  return { sha256: createHash("sha256").update(value).digest("hex"), characters: value.length };
}

/** Combine legacy readable guards with fingerprint-only guards. Keep the same
 * conservative UTF-16 character budget and deduplication across both forms. */
export function disclosureSize(fragments, history) {
  const sizes = new Map();
  const add = row => {
    if (!row || Object.keys(row).sort().join(",") !== "characters,sha256"
      || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.characters) || row.characters < 0 || row.characters > 4 * 1024 * 1024
      || sizes.has(row.sha256) && sizes.get(row.sha256) !== row.characters) throw new Error("Invalid disclosure fingerprint");
    sizes.set(row.sha256, row.characters);
  };
  for (const text of fragments.filter(Boolean)) add(disclosureFragment(text));
  const visit = (value, depth = 0, key = "") => {
    if (depth > 20) throw new Error("Invalid disclosure depth");
    if (key === "disclosureFragments") {
      if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid disclosure fingerprints");
      for (const row of value) add(row);
    } else if (key === "dataJson" && typeof value === "string" && value !== "") visit(JSON.parse(value), depth + 1);
    else if (value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) visit(child, depth + 1, name);
    }
  };
  visit(history);
  return [...sizes.values()].reduce((sum, size) => sum + size, 0);
}
