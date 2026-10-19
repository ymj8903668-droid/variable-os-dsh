// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { wikiEvidenceIdentity } from "./contracts.mjs";
import { providerError } from "./errors.mjs";

const keys = (value, expected) => value && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const opaque = (value, max, empty = false) => typeof value === "string"
  && (empty || value.length > 0) && value.length <= max && value.trim() === value
  && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value);

/** A location is an untrusted navigation hint, never a membership or body proof. */
export function normalizeImaDirectoryLocation(value = { folderPath: [], cursor: "" }) {
  if (!keys(value, ["folderPath", "cursor"]) || !Array.isArray(value.folderPath)
    || value.folderPath.length > 32 || value.folderPath.some(id => !opaque(id, 512))
    || new Set(value.folderPath).size !== value.folderPath.length || !opaque(value.cursor, 4096, true)) {
    throw providerError("SOURCE_UNAVAILABLE", "IMA_DIRECTORY_LOCATION_INVALID");
  }
  return Object.freeze({ folderPath: Object.freeze([...value.folderPath]), cursor: value.cursor });
}

export function normalizeImaDocumentSelections(value = [], libraryId) {
  try {
    if (!Array.isArray(value) || value.length > 3) throw new Error();
    const seen = new Set();
    return Object.freeze(value.map(row => {
      if (!keys(row, ["evidenceId", "location"]) || typeof row.evidenceId !== "string"
        || seen.has(row.evidenceId)) throw new Error();
      const parts = row.evidenceId.split(":");
      const documentId = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[3] ?? "", "base64url"));
      const identity = wikiEvidenceIdentity({ provider: "ima", libraryId, documentId });
      if (identity.evidenceId !== row.evidenceId) throw new Error();
      seen.add(row.evidenceId);
      return Object.freeze({ evidenceId: row.evidenceId, location: normalizeImaDirectoryLocation(row.location) });
    }));
  } catch { throw providerError("SOURCE_UNAVAILABLE", "IMA_DOCUMENT_SELECTION_INVALID"); }
}
