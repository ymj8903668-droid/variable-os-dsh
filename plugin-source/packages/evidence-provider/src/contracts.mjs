// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { compareRfc3339 } from "../../storage-contracts/src/time.mjs";
import { providerError } from "./errors.mjs";

export const CONTRACT_VERSION = "evidence-provider-v1";
export const CAPABILITY_KEYS = Object.freeze([
  "search", "readFull", "changes", "cancel", "asOf",
  "getEvidence", "getCard", "listWiki", "readWiki",
]);

export function requireString(value, code = "SOURCE_UNAVAILABLE") {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw providerError(code, "INVALID_ARGUMENT");
  }
  return value;
}

export function compareInstants(left, right) {
  try {
    return compareRfc3339(left, right);
  } catch {
    throw providerError("TIME_BOUNDARY", "INVALID_TIME");
  }
}

function timestamp(value) {
  compareInstants(value, value);
  return value;
}

export function normalizeBoundary(query = {}) {
  const asOf = query.asOf === undefined ? undefined : timestamp(query.asOf);
  const knownAt = query.knownAt === undefined ? undefined : timestamp(query.knownAt);
  return Object.freeze({
    asOf: asOf ?? knownAt ?? null,
    knownAt: knownAt ?? asOf ?? null,
  });
}

export function normalizeScope(scope) {
  if (!Array.isArray(scope?.datasetIds) || !scope.datasetIds.length) {
    throw providerError("FORBIDDEN_SCOPE", "EXPLICIT_SCOPE_REQUIRED");
  }
  const datasetIds = [...new Set(scope.datasetIds.map((id) =>
    requireString(id, "FORBIDDEN_SCOPE")))].sort();
  return Object.freeze({ datasetIds: Object.freeze(datasetIds) });
}

export function normalizeLimit(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_LIMIT");
  }
  return limit;
}

export function wikiEvidenceIdentity(value) {
  if (!value || !["ima", "local"].includes(value.provider)) {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_ORIGIN");
  }
  const parts = ["libraryId", "documentId"].map((field) => {
    const id = requireString(value[field]);
    if (id.length > 512 || id !== id.trim() || !id.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(id)) {
      throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_ID");
    }
    return Buffer.from(id).toString("base64url");
  });
  const datasetId = `wiki:${value.provider}:${parts[0]}`;
  return Object.freeze({ datasetId, evidenceId: `${datasetId}:${parts[1]}` });
}

export function decodeWikiContent(bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) throw new TypeError();
    // Only UTF-8 BOM and line endings normalize; no trimming or Unicode rewrite.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
    return Object.freeze({
      text,
      originalByteHash: createHash("sha256").update(bytes).digest("hex"),
      normalizedTextHash: createHash("sha256").update(text).digest("hex"),
      downloadedBytes: bytes.byteLength,
    });
  } catch {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_CONTENT");
  }
}

function normalizeWikiOrigin(value, record) {
  const allowed = new Set(["provider", "libraryId", "documentId", "title", "observedAt",
    "versionId", "permission", "completeness", "originalByteHash", "normalizedTextHash",
    "metadataSize", "downloadedBytes"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !allowed.has(field))) {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_ORIGIN");
  }
  const identity = wikiEvidenceIdentity(value);
  if (record.datasetId !== identity.datasetId || record.evidenceId !== identity.evidenceId) {
    throw providerError("FORBIDDEN_SCOPE", "WIKI_IDENTITY_MISMATCH");
  }
  const origin = {
    provider: value.provider, libraryId: value.libraryId, documentId: value.documentId,
    title: requireString(value.title),
    observedAt: value.observedAt == null ? null : timestamp(value.observedAt),
    versionId: value.versionId == null ? null : requireString(value.versionId),
    permission: value.permission ?? "UNKNOWN",
    completeness: value.completeness ?? "UNKNOWN",
  };
  if (!["GRANTED", "DENIED", "UNKNOWN"].includes(origin.permission)
    || !["COMPLETE", "PARTIAL", "PENDING", "UNKNOWN"].includes(origin.completeness)
    || record.sourceFamily !== "wiki") {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_ORIGIN");
  }
  for (const field of ["originalByteHash", "normalizedTextHash"]) {
    origin[field] = value[field] ?? null;
    if (origin[field] !== null && (typeof origin[field] !== "string" || !/^[a-f0-9]{64}$/.test(origin[field]))) {
      throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_HASH");
    }
  }
  for (const field of ["metadataSize", "downloadedBytes"]) {
    origin[field] = value[field] ?? null;
    if (origin[field] !== null && (!Number.isSafeInteger(origin[field]) || origin[field] < 0)) {
      throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_SIZE");
    }
  }
  if ((origin.provider === "ima" && record.exportAllowed)
    || (origin.permission !== "GRANTED" && (record.content !== undefined || record.excerpt !== ""
      || record.modelUseAllowed || record.exportAllowed))) {
    throw providerError("FORBIDDEN_SCOPE", "WIKI_PERMISSION_REQUIRED");
  }
  if ((record.content !== undefined && origin.completeness !== "COMPLETE")
    || (origin.completeness === "COMPLETE" && [origin.originalByteHash, origin.normalizedTextHash,
      origin.downloadedBytes, origin.observedAt].some((field) => field === null))
    || (origin.normalizedTextHash !== null && origin.normalizedTextHash !== record.contentHash)
    || record.datasetVersion !== (origin.versionId ?? "UNKNOWN")) {
    throw providerError("SOURCE_UNAVAILABLE", "WIKI_CONTENT_INCONSISTENT");
  }
  if (origin.observedAt !== null) {
    for (const field of ["recordedAt", "knownAt"]) {
      if (record[field] !== null && compareInstants(record[field], origin.observedAt) < 0) {
        throw providerError("TIME_BOUNDARY", "WIKI_OBSERVED_AFTER_KNOWLEDGE");
      }
    }
  }
  if (record.locator && record.locator.sourceRef !== identity.evidenceId) {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_WIKI_LOCATOR");
  }
  record.locator ??= Object.freeze({ sourceRef: identity.evidenceId, lineStart: null, lineEnd: null });
  return Object.freeze(origin);
}

export function normalizeEvidenceRecord(value) {
  if (!value || typeof value !== "object") {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_RECORD");
  }
  const record = {};
  for (const field of ["evidenceId", "datasetId", "datasetVersion", "sourceFamily"]) {
    record[field] = requireString(value[field]);
  }
  for (const field of ["eventAt", "availableAt", "recordedAt", "knownAt"]) {
    record[field] = value[field] == null ? null : timestamp(value[field]);
  }
  if (typeof value.excerpt !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) {
    throw providerError("SOURCE_UNAVAILABLE", "INVALID_RECORD");
  }
  Object.assign(record, {
    epistemicType: value.epistemicType == null ? "UNKNOWN" : requireString(value.epistemicType),
    excerpt: value.excerpt,
    contentHash: value.contentHash,
    exportAllowed: value.exportAllowed === true,
    modelUseAllowed: value.modelUseAllowed === true,
    license: value.license == null ? null : requireString(value.license),
  });
  for (const field of ["state", "timePrecision", "originalTimeText", "mirrorKey"]) {
    if (value[field] != null) record[field] = requireString(value[field]);
  }
  if (value.tombstone !== undefined) {
    if (typeof value.tombstone !== "boolean") throw providerError("SOURCE_UNAVAILABLE", "INVALID_RECORD");
    record.tombstone = value.tombstone;
  }
  if (value.content !== undefined) {
    if (typeof value.content !== "string") throw providerError("SOURCE_UNAVAILABLE", "INVALID_RECORD");
    if (createHash("sha256").update(value.content).digest("hex") !== value.contentHash) {
      throw providerError("SOURCE_UNAVAILABLE", "CONTENT_HASH_MISMATCH");
    }
    record.content = value.content;
  }
  if (value.locator != null) {
    const { sourceRef, lineStart = null, lineEnd = null } = value.locator;
    requireString(sourceRef);
    if ((lineStart !== null && (!Number.isInteger(lineStart) || lineStart < 1))
      || (lineEnd !== null && (!Number.isInteger(lineEnd) || lineEnd < (lineStart ?? 1)))) {
      throw providerError("SOURCE_UNAVAILABLE", "INVALID_LOCATOR");
    }
    record.locator = Object.freeze({ sourceRef, lineStart, lineEnd });
  }
  if (value.wikiOrigin !== undefined) record.wikiOrigin = normalizeWikiOrigin(value.wikiOrigin, record);
  return Object.freeze(record);
}

export function evidenceVisibility(record, query = {}) {
  const boundary = normalizeBoundary(query);
  if (!boundary.asOf) return { visible: true, reason: null };
  if (record.wikiOrigin) {
    if (record.wikiOrigin.observedAt == null) throw providerError("TIME_BOUNDARY", "MISSING_WIKI_OBSERVATION");
    if (compareInstants(record.wikiOrigin.observedAt, boundary.knownAt) > 0) {
      return { visible: false, reason: "WIKI_OBSERVED_AFTER_KNOWN_AT" };
    }
  }
  for (const field of ["availableAt", "recordedAt", "knownAt"]) {
    if (record[field] == null) throw providerError("TIME_BOUNDARY", "MISSING_TIME");
    timestamp(record[field]);
  }
  for (const [field, cutoff, reason] of [
    ["availableAt", boundary.asOf, "AVAILABLE_AFTER_ASOF"],
    ["recordedAt", boundary.knownAt, "RECORDED_AFTER_KNOWN_AT"],
    ["knownAt", boundary.knownAt, "KNOWN_AFTER_KNOWN_AT"],
  ]) {
    if (compareInstants(record[field], cutoff) > 0) return { visible: false, reason };
  }
  return { visible: true, reason: null };
}
