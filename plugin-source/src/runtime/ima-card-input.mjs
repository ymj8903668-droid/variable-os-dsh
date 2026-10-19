// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { normalizeEvidenceRecord, wikiEvidenceIdentity, compareInstants } from "../../packages/evidence-provider/src/contracts.mjs";
import { providerError } from "../../packages/evidence-provider/src/errors.mjs";
import { IMA_SESSION_LIMITS } from "../../packages/evidence-provider/src/ima-budget.mjs";

export function imaCardIdentity(evidenceId) {
  try {
    if (typeof evidenceId !== "string") throw new Error();
    const parts = evidenceId.split(":");
    if (parts.length !== 4 || parts[0] !== "wiki" || parts[1] !== "ima") throw new Error();
    const decode = value => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url"));
    const identity = wikiEvidenceIdentity({ provider: "ima", libraryId: decode(parts[2]), documentId: decode(parts[3]) });
    if (identity.evidenceId !== evidenceId) throw new Error();
    return identity;
  } catch { throw providerError("FORBIDDEN_SCOPE"); }
}

/** Full input remains Host memory only; this is not a publication/export grant. */
export function normalizeImaCardInput(value, { evidenceId, modelUseAllowed = false, now } = {}) {
  const expected = imaCardIdentity(evidenceId), row = normalizeEvidenceRecord(value);
  if (row.datasetId !== expected.datasetId || row.evidenceId !== evidenceId ||
    row.wikiOrigin?.provider !== "ima" || row.wikiOrigin.permission !== "GRANTED" ||
    modelUseAllowed && row.modelUseAllowed !== true) throw providerError("FORBIDDEN_SCOPE");
  const origin = row.wikiOrigin;
  if (row.sourceFamily !== "wiki" || row.datasetVersion !== "UNKNOWN" || row.epistemicType !== "UNKNOWN" ||
    row.eventAt !== null || row.availableAt !== null || row.exportAllowed !== false ||
    origin.versionId !== null || origin.completeness !== "COMPLETE" ||
    row.recordedAt !== origin.observedAt || row.knownAt !== origin.observedAt ||
    typeof row.content !== "string" || !row.content.isWellFormed() || !row.content.trim() ||
    Buffer.byteLength(row.content) > IMA_SESSION_LIMITS.maxFileBytes ||
    origin.downloadedBytes > IMA_SESSION_LIMITS.maxFileBytes ||
    createHash("sha256").update(row.content).digest("hex") !== row.contentHash ||
    now !== undefined && compareInstants(origin.observedAt, now) > 0) {
    throw providerError("SOURCE_UNAVAILABLE", "IMA_CARD_INPUT_INVALID");
  }
  return row;
}

export function imaCardDependency(row) {
  return { identity: [row.datasetId, "wiki", row.evidenceId], contentHash: row.contentHash };
}
