// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { canonicalHash } from "../../../src/schema/canonical-json.mjs";
import { PUBLISHED_DOCUMENT_MAX_BYTES } from "./publication-limits.mjs";
import { validateStockPriceSnapshot } from "./stock-price-snapshot.mjs";
import { compareRfc3339 } from "../../storage-contracts/src/time.mjs";

export const DOCUMENT_SCOPES = Object.freeze({
  raw: "evidence/", graph: "graph/", facts: "facts/", brain: "brain/",
});
// Structured prices retain their own scope and validator. Consumers opt in with
// the structured price context rather than treating this domain as plain text.
const PUBLISHED_SCOPES = Object.freeze({ ...DOCUMENT_SCOPES, "stock-price": "stock-price/" });
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail() {
  throw Object.assign(Error("Invalid reviewed publication document"), { code: "PUBLISHED_DOCUMENT_INVALID" });
}
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value, maximum) {
  if (typeof value !== "string" || !value.trim() || !value.isWellFormed()
    || Buffer.byteLength(value) > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || /(?:password|passwd|token|api[_ -]?key|secret)\s*["']?\s*[:=]\s*\S+/iu.test(value)) fail();
}
export const publishedDocumentHash = canonicalHash;

/** Full reviewed publication bytes. Origin is the publisher's provenance claim,
 * not permission to read any upstream file or database. */
export function validatePublishedDocument(value, { entityId, revision, scope, contentHash, tenantId, datasetId, availableAt, recordedAt, knownAt } = {}) {
  object(value, ["schema", "documentId", "domain", "revision", "title", "format", "content", "contentHash", "origin",
    ...(Object.hasOwn(value??{}, 'evidenceBindings') ? ['evidenceBindings'] : [])]);
  if (value.schema !== "published-document-v1" || !id(value.documentId)
    || !Object.hasOwn(PUBLISHED_SCOPES, value.domain)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || entityId !== undefined && value.documentId !== entityId
    || revision !== undefined && value.revision !== revision
    || scope !== undefined && PUBLISHED_SCOPES[value.domain] !== scope) fail();
  text(value.title, 512);
  if (/[\r\n\t]/u.test(value.title)) fail();
  text(value.content, PUBLISHED_DOCUMENT_MAX_BYTES);
  if (!["text/plain", "text/markdown", "application/json"].includes(value.format)) fail();
  if (value.format === "application/json") {
    try { JSON.parse(value.content); } catch { fail(); }
  }
  if (!hash(value.contentHash)
    || createHash("sha256").update(value.content).digest("hex") !== value.contentHash) fail();
  object(value.origin, ["sourceId", "recordId", "version", "contentHash"]);
  if (!id(value.origin.sourceId) || !id(value.origin.recordId) || !hash(value.origin.contentHash)) fail();
  text(value.origin.version, 256);
  // Explicit publisher-reviewed provenance links. Never infer these from titles,
  // matching excerpts or local filesystem paths. Older documents remain valid.
  if (Object.hasOwn(value, 'evidenceBindings')) {
    if (value.domain !== 'raw' || !Array.isArray(value.evidenceBindings)
      || !value.evidenceBindings.length || value.evidenceBindings.length > 64) fail();
    const seen = new Set();
    for (const binding of value.evidenceBindings) {
      object(binding, ['sourceItemId', 'sourceRecordHash', 'contentHash', 'retrievalRef']);
      if (!id(binding.sourceItemId) || !hash(binding.sourceRecordHash) || !hash(binding.contentHash)
        || binding.retrievalRef !== null && !id(binding.retrievalRef)) fail();
      const identity = JSON.stringify([binding.sourceItemId, binding.sourceRecordHash, binding.contentHash, binding.retrievalRef]);
      if (seen.has(identity)) fail();
      seen.add(identity);
    }
  }
  if (value.domain === "stock-price") {
    if (value.format !== "application/json") fail();
    const snapshot = validateStockPriceSnapshot(JSON.parse(value.content), { tenantId, datasetId });
    if (!snapshot.source.modelUseAllowed || value.origin.sourceId !== snapshot.source.id
      || value.origin.recordId !== 'capture-' + snapshot.contentHash || value.origin.version !== snapshot.source.version
      || value.origin.contentHash !== value.contentHash
      || [availableAt, recordedAt, knownAt].some(x => x !== undefined
        && (!Number.isFinite(Date.parse(x)) || Date.parse(x) < Date.parse(snapshot.capturedAt)))
      || knownAt !== undefined && [availableAt, recordedAt].some(x => x !== undefined && compareRfc3339(x, knownAt) > 0)) fail();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > PUBLISHED_DOCUMENT_MAX_BYTES
    || contentHash !== undefined && publishedDocumentHash(value) !== contentHash) fail();
  return structuredClone(value);
}
