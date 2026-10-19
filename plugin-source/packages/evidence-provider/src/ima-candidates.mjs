// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { compareInstants, normalizeScope, wikiEvidenceIdentity } from "./contracts.mjs";
import { providerError } from "./errors.mjs";

const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const invalid = () => { throw providerError("SOURCE_UNAVAILABLE", "IMA_CANDIDATES_INVALID"); };

/** Metadata is an intake candidate, never proof of downloaded content or model consent. */
export function normalizeImaCandidates(value, now) {
  try {
    if (!keys(value, ["schema", "coverage", "scope", "observedAt", "complete", "asOf", "knownAt",
      "version", "modelUseAllowed", "exportAllowed", "records"]) ||
      value.schema !== "ima-candidate-intake-v1" || !["CURRENT_IMA_METADATA", "SELECTED_IMA_METADATA"].includes(value.coverage) ||
      value.complete !== true || value.asOf !== null || value.knownAt !== null || value.version !== null ||
      value.modelUseAllowed !== false || value.exportAllowed !== false ||
      !Array.isArray(value.records) || value.records.length > 5000 ||
      Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) invalid();
    if (value.coverage === "SELECTED_IMA_METADATA" && (value.records.length < 1 || value.records.length > 3)) invalid();
    compareInstants(value.observedAt, value.observedAt);
    if (now !== undefined && compareInstants(value.observedAt, now) > 0) invalid();
    const scope = normalizeScope(value.scope), seen = new Set();
    if (scope.datasetIds.length !== 1 || JSON.stringify(scope) !== JSON.stringify(value.scope)) invalid();
    const records = value.records.map(row => {
      if (!keys(row, ["datasetId", "evidenceId", "title"]) || row.datasetId !== scope.datasetIds[0] ||
        typeof row.title !== "string" || !row.title.trim() || !row.title.isWellFormed() ||
        [...row.title].length > 300 || /[\p{Cc}\p{Cf}]/u.test(row.title) ||
        typeof row.evidenceId !== "string" || seen.has(row.evidenceId)) invalid();
      const parts = row.evidenceId.split(":");
      if (parts.length !== 4 || parts[0] !== "wiki" || parts[1] !== "ima") invalid();
      const decode = part => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(part, "base64url"));
      const identity = wikiEvidenceIdentity({ provider: "ima", libraryId: decode(parts[2]), documentId: decode(parts[3]) });
      if (identity.datasetId !== row.datasetId || identity.evidenceId !== row.evidenceId) invalid();
      seen.add(row.evidenceId);
      return Object.freeze({ ...identity, title: row.title });
    });
    // Also validate a zero-hit scope; no unverified empty library is accepted.
    const parts = scope.datasetIds[0].split(":");
    if (parts.length !== 3 || parts[0] !== "wiki" || parts[1] !== "ima") invalid();
    const libraryId = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[2], "base64url"));
    if (wikiEvidenceIdentity({ provider: "ima", libraryId, documentId: "scope" }).datasetId !== scope.datasetIds[0]) invalid();
    return Object.freeze({ ...value, scope, records: Object.freeze(records) });
  } catch { invalid(); }
}
