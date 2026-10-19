// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createPrivateJsonProfile } from "./private-json-profile.js";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";

const unavailable = "RESEARCH_DISCLOSURE_UNAVAILABLE";
const maxBytes = 4 * 1024 * 1024, maxHistoryBytes = 256 * 1024;
const revision = () => randomBytes(32).toString("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value)) + 1;
export const imaDisclosureKey = record => JSON.stringify([record.evidenceId, record.contentHash]);
function valid(record) {
  try {
    return plain(record) && Object.keys(record).sort().join(",") === "entries,revision,schema"
      && record.schema === "personal-disclosures-v1" && hash(record.revision)
      && Array.isArray(record.entries) && record.entries.length <= 128 && bytes(record) <= maxBytes
      && new Set(record.entries.map(entry => entry.key)).size === record.entries.length
      && record.entries.every(entry => plain(entry) && Object.keys(entry).sort().join(",") === "key,outputs"
        && hash(entry.key) && Array.isArray(entry.outputs) && bytes(entry.outputs) <= maxHistoryBytes
        && new Set(entry.outputs).size === entry.outputs.length
        && entry.outputs.every(output => typeof output === "string" && plain(JSON.parse(output))));
  } catch { return false; }
}

// Only already-validated derived output is retained, never source input.
// The compare-and-swap write finishes before the caller can deliver output.
export function createPersonalDisclosureStore({ file } = {}) {
  if (file !== undefined && (typeof file !== "string" || !path.isAbsolute(file))) throw remoteError(unavailable);
  const profile = createPrivateJsonProfile({
    file, initial: () => ({ schema: "personal-disclosures-v1", revision: revision(), entries: [] }),
    validate: valid, maxBytes, temporaryPrefix: ".disclosure-",
    errors: { invalid: unavailable, unavailable, changed: unavailable, busy: unavailable, write: unavailable },
  });
  let observed = false;
  const read = () => {
    const selected = profile.current();
    if (file && selected.stamp.startsWith("absent:")) {
      if (observed) throw remoteError(unavailable);
    } else observed = true;
    return selected;
  };
  const digest = key => {
    if (typeof key !== "string" || !key || key.length > 4096) throw remoteError(unavailable);
    return createHash("sha256").update(key).digest("hex");
  };
  const write = (selected, entries) => {
    const next = { ...selected.record, revision: revision(), entries };
    if (bytes(next) > maxBytes || entries.some(entry => bytes(entry.outputs) > maxHistoryBytes)) {
      throw remoteError("AUTO_JUDGMENT_CAPACITY");
    }
    if (!valid(next)) throw remoteError(unavailable);
    profile.write(next, selected);
    observed = true;
  };
  const select = key => {
    const id = digest(key), selected = read();
    const entries = structuredClone(selected.record.entries);
    let entry = entries.find(value => value.key === id);
    if (!entry && entries.length >= 128) return null;
    if (!entry) { entry = { key: id, outputs: [] }; entries.push(entry); }
    return { selected, entries, entry };
  };
  return Object.freeze({
    inspect(key, operation) {
      if (key === null) return operation([]);
      const value = select(key);
      if (!value) throw remoteError("AUTO_JUDGMENT_CAPACITY");
      return operation(value.entry.outputs.map(text => JSON.parse(text)));
    },
    reserve(key) {
      if (key === null) return true;
      const value = select(key);
      if (!value) return false;
      // Also claim existing entries: a held lock must deny before model work.
      write(value.selected, value.entries);
      return true;
    },
    check(key, operation) {
      if (key === null) return operation([]);
      const value = select(key);
      if (!value) throw remoteError("AUTO_JUDGMENT_CAPACITY");
      const output = operation(value.entry.outputs.map(text => JSON.parse(text)));
      if (!plain(output) || typeof output.then === "function") throw remoteError(unavailable);
      const text = JSON.stringify(output);
      if (!value.entry.outputs.includes(text)) value.entry.outputs.push(text);
      write(value.selected, value.entries);
      return output;
    },
  });
}
