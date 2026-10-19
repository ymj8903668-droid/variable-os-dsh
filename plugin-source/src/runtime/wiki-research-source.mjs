// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import {
  normalizeEvidenceRecord, normalizeScope, providerError, runCancellable, wikiEvidenceIdentity,
} from "../../packages/evidence-provider/src/index.mjs";
import { researchProcessError } from "./deep-research-stdio.mjs";
import { normalizeImaCandidates } from "../../packages/evidence-provider/src/ima-candidates.mjs";
import { imaCardIdentity, normalizeImaCardInput } from "./ima-card-input.mjs";
import { createWikiResearchRun } from "./wiki-research-run.mjs";

const SCHEMA = "wiki-research-context-v1";
const invalid = () => researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const secret = /(?:password|passwd|pwd|token|api[_ -]?key|secret|密码|口令|密钥|令牌)\s*[:=：]\s*[^\s,，;；]+/iu;
const safeText = (value, max) => typeof value === "string" && value.trim().length > 0
  && value.isWellFormed() && [...value].length <= max && !/[\p{Cf}\u0000]/u.test(value) && !secret.test(value);

export function wikiResearchMode(mode = "local") {
  if (!["local", "ima", "none"].includes(mode)) throw invalid();
  return mode;
}

export function independentResearchSources(sources = "wiki,raw,graph,facts,brain") {
  const values = Array.isArray(sources) ? sources : String(sources).split(",");
  return values.map(value => {
    if (typeof value !== "string") throw invalid();
    return value.trim().toLowerCase();
  }).filter(value => value && !["wiki", "graph", "navigation"].includes(value)).join(",");
}

/** Only bounded authorized excerpts cross this callback, never full records or credentials. */
export function projectWikiResearchContext(value) {
  if (value?.schema !== SCHEMA || value.mode !== "ima"
    || !["done", "partial", "empty", "model-use-denied"].includes(value.status)
    || typeof value.complete !== "boolean" || !Number.isSafeInteger(value.matched) || value.matched < 0
    || !Array.isArray(value.items) || value.items.length > 3 || value.items.length > value.matched) throw invalid();
  const seen = new Set();
  const items = value.items.map((row, index) => {
    if (row?.ref !== `W${index + 1}` || row.modelUseAllowed !== true || row.exportAllowed !== false
      || !safeText(row.title, 300) || !safeText(row.snippet, 1200)
      || typeof row.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(row.contentHash)
      || row.versionId !== null || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))
      || typeof row.evidenceId !== "string" || row.path !== row.evidenceId || seen.has(row.evidenceId)) throw invalid();
    const parts = row.evidenceId.split(":");
    if (parts.length !== 4 || parts[0] !== "wiki" || parts[1] !== "ima") throw invalid();
    let identity;
    try {
      const decode = part => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(part, "base64url"));
      identity = wikiEvidenceIdentity({ provider: "ima", libraryId: decode(parts[2]), documentId: decode(parts[3]) });
    } catch { throw invalid(); }
    if (identity.datasetId !== row.datasetId || identity.evidenceId !== row.evidenceId) throw invalid();
    seen.add(row.evidenceId);
    return Object.freeze({
      ref: row.ref, ...identity, path: row.path, title: row.title, snippet: row.snippet,
      contentHash: row.contentHash, versionId: null, observedAt: row.observedAt,
      exportAllowed: false, modelUseAllowed: true,
    });
  });
  if ((value.status === "empty" && (value.matched !== 0 || !value.complete))
    || (["empty", "model-use-denied"].includes(value.status) && items.length)
    || (value.status === "done" && (!items.length || !value.complete))) throw invalid();
  return Object.freeze({ schema: SCHEMA, mode: "ima", status: value.status, complete: value.complete,
    matched: value.matched, items: Object.freeze(items) });
}

export function wikiResearchPublicState(context) {
  return Object.freeze({ mode: context.mode, status: context.status, complete: context.complete,
    matched: context.matched, included: context.items?.length ?? 0 });
}

export function wikiResearchReference(item) {
  return Object.freeze({
    sourceType: "wiki", ref: item.ref, datasetId: item.datasetId, evidenceId: item.evidenceId,
    path: item.path, title: item.title, contentHash: item.contentHash, versionId: item.versionId,
    observedAt: item.observedAt, exportAllowed: false,
  });
}

export function createWikiResearchSession({ mode = "local", provider, scope, budget } = {}) {
  wikiResearchMode(mode);
  if (mode !== "ima") return Object.freeze({ mode, close() {} });
  const requested = normalizeScope(scope);
  if (requested.datasetIds.length !== 1 || typeof provider?.search !== "function"
    || typeof provider.read !== "function" || !(budget?.signal instanceof AbortSignal)
    || typeof budget.snapshot !== "function" || typeof budget.close !== "function") throw invalid();
  const modelPreflight = new Set();
  function assertActive() {
    const status = budget.snapshot().status;
    if (status === "EXPIRED") throw providerError("SOURCE_UNAVAILABLE", "IMA_SESSION_TIMEOUT");
    if (status !== "ACTIVE" || budget.signal.aborted) throw providerError("CANCELLED");
  }
  return Object.freeze({
    mode, signal: budget.signal, assertActive, close: () => budget.close(),
    withWikiResearchRun: createWikiResearchRun({ requested, provider, budget, assertActive }),
    async prepareResearchReferences(params = {}) {
      assertActive();
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some(key => !["queries", "signal"].includes(key))
        || budget.profile !== "research" || !Array.isArray(params.queries) || !params.queries.length || params.queries.length > 4
        || new Set(params.queries).size !== params.queries.length
        || params.queries.some(query => !safeText(query, 200) || query !== query.trim() || query.length < 2 || /[\p{Cc}\p{Cf}]/u.test(query))
        || params.signal !== undefined && !(params.signal instanceof AbortSignal)) {
        throw providerError("SOURCE_UNAVAILABLE", "IMA_RESEARCH_INPUT_INVALID");
      }
      const queries = [...params.queries];
      const combined = params.signal ? AbortSignal.any([params.signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        for (const query of queries) {
          let found;
          try { found = await provider.search({ query, scope: requested, limit: 100 }, combined); }
          catch (error) {
            if (error.code !== "NO_RESULT") throw error;
            found = { hits: [], receipt: error.details?.receipt };
          }
          assertActive();
          const proof = found?.receipt;
          if (!Array.isArray(found?.hits) || found.hits.length > 100 || proof?.schema !== "evidence-provider-v1"
            || proof.provider !== "ima" || !same(proof.scope, requested) || proof.query !== query
            || typeof proof.complete !== "boolean" || proof.hitCount !== found.hits.length
            || !Number.isSafeInteger(proof.totalHits) || proof.totalHits < found.hits.length
            || !found.hits.length && proof.totalHits !== 0) throw providerError("SOURCE_UNAVAILABLE", "IMA_RETRIEVAL_INVALID");
          for (const hit of found.hits) {
            if (hit.datasetId !== requested.datasetIds[0] || hit.wikiOrigin?.provider !== "ima"
              || imaCardIdentity(hit.evidenceId).datasetId !== hit.datasetId) throw providerError("FORBIDDEN_SCOPE");
          }
        }
        // Search results only provide navigation hints. Every original must
        // still pass a fresh scoped directory and full body read before use.
        return Object.freeze({ queries: queries.length, complete: false });
      });
    },
    async checkLibraryAccess(params = {}) {
      assertActive();
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some(key => key !== "signal")
        || params.signal !== undefined && !(params.signal instanceof AbortSignal)
        || typeof provider.checkLibraryAccess !== "function") throw providerError("SOURCE_UNAVAILABLE");
      const combined = params.signal ? AbortSignal.any([params.signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        const result = await provider.checkLibraryAccess({ scope: requested }, combined);
        assertActive();
        if (!result || Object.keys(result).join(",") !== "datasetId") throw providerError("SOURCE_UNAVAILABLE");
        if (result.datasetId !== requested.datasetIds[0]) throw providerError("FORBIDDEN_SCOPE");
        return Object.freeze({ datasetId: result.datasetId });
      });
    },
    async browseDirectory({ location, signal } = {}) {
      assertActive();
      if (typeof provider.browseDirectory !== "function") throw providerError("SOURCE_UNAVAILABLE");
      const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        const result = await provider.browseDirectory({ scope: requested, location }, combined);
        assertActive();
        return result;
      });
    },
    async checkCardAccess({ evidenceId, signal } = {}) {
      assertActive();
      const identity = imaCardIdentity(evidenceId);
      if (identity.datasetId !== requested.datasetIds[0]) throw providerError("FORBIDDEN_SCOPE");
      if (typeof provider.checkReadAccess !== "function") throw providerError("SOURCE_UNAVAILABLE");
      const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        const result = await provider.checkReadAccess({
          datasetId: identity.datasetId, evidenceId: identity.evidenceId,
        }, combined);
        assertActive();
        if (!result || Object.keys(result).sort().join(",") !== "contentVerified,datasetId,evidenceId,status" ||
          result.datasetId !== identity.datasetId || result.evidenceId !== evidenceId ||
          result.status !== "METADATA_VISIBLE" || result.contentVerified !== false) {
          throw providerError("SOURCE_UNAVAILABLE");
        }
        return Object.freeze({ datasetId: identity.datasetId, evidenceId,
          status: "METADATA_VISIBLE", contentVerified: false });
      });
    },
    async withWikiResearchInputs({ query, signal, asOf, knownAt, version } = {}, operation) {
      assertActive();
      if (asOf !== undefined || knownAt !== undefined || version !== undefined) throw providerError("TIME_BOUNDARY");
      if (!safeText(query, 200) || query !== query.trim() || query.length < 2 ||
        typeof operation !== "function") throw providerError("SOURCE_UNAVAILABLE", "IMA_RESEARCH_INPUT_INVALID");
      const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        let found;
        try { found = await provider.search({ query, scope: requested, limit: 1 }, combined); }
        catch (error) {
          if (error.code !== "NO_RESULT") throw error;
          found = { hits: [], receipt: error.details?.receipt };
        }
        const proof = found?.receipt;
        if (!Array.isArray(found?.hits) || found.hits.length > 1 ||
          proof?.schema !== "evidence-provider-v1" || proof.provider !== "ima" ||
          !same(proof.scope, requested) || typeof proof.complete !== "boolean" ||
          !Number.isSafeInteger(proof.totalHits) || proof.totalHits < found.hits.length ||
          proof.hitCount !== found.hits.length || proof.query !== query ||
          found.hits.length === 0 && proof.totalHits !== 0) {
          throw providerError("SOURCE_UNAVAILABLE", "IMA_RETRIEVAL_INVALID");
        }
        assertActive();
        const hit = found.hits[0];
        if (hit && (hit.datasetId !== requested.datasetIds[0] || hit.wikiOrigin?.provider !== "ima" ||
          hit.modelUseAllowed !== true)) throw providerError("FORBIDDEN_SCOPE");
        const read = async () => {
          const row = normalizeImaCardInput(await provider.read({
            datasetId: hit.datasetId, evidenceId: hit.evidenceId,
          }, undefined, combined), { evidenceId: hit.evidenceId, modelUseAllowed: true });
          assertActive();
          return row;
        };
        // The fixed download budget reserves a second full read for proof.
        // More hits remain explicitly omitted, never silently retried.
        const beforeRead = budget.snapshot();
        const row = hit ? await read() : null;
        if (row) {
          const afterRead = budget.snapshot();
          const proofCalls = afterRead.apiRequests - beforeRead.apiRequests;
          if (!Number.isSafeInteger(budget.limits?.apiRequests) || !Number.isSafeInteger(budget.limits?.downloads) ||
            proofCalls < 1 || budget.limits.apiRequests - afterRead.apiRequests < proofCalls ||
            budget.limits.downloads - afterRead.downloads < 1) {
            throw providerError("SOURCE_UNAVAILABLE", "IMA_RESEARCH_PROOF_BUDGET");
          }
        }
        const expected = row ? { hash: row.contentHash, title: row.wikiOrigin.title } : null;
        const receipt = Object.freeze({ coverage: "IMA_LIBRARY_SEARCH", datasetId: requested.datasetIds[0],
          matched: proof.totalHits, included: row ? 1 : 0, omitted: proof.totalHits - (row ? 1 : 0),
          complete: proof.complete && !found.nextCursor && proof.totalHits === (row ? 1 : 0),
          historyComplete: false, version: null });
        const result = await operation({ records: row ? [row] : [], receipt, signal: combined });
        assertActive();
        if (row) {
          const current = await read();
          if (current.contentHash !== expected.hash || current.wikiOrigin.title !== expected.title) {
            throw providerError("SOURCE_UNAVAILABLE", "IMA_RESEARCH_INPUT_CHANGED");
          }
        }
        assertActive();
        return result;
      });
    },
    async readCardInput({ evidenceId, modelUseAllowed = false, signal, asOf, knownAt, version } = {}) {
      assertActive();
      if (asOf !== undefined || knownAt !== undefined || version !== undefined) throw providerError("TIME_BOUNDARY");
      if (typeof modelUseAllowed !== "boolean") throw providerError("FORBIDDEN_SCOPE");
      const identity = imaCardIdentity(evidenceId);
      if (identity.datasetId !== requested.datasetIds[0]) throw providerError("FORBIDDEN_SCOPE");
      const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        // Catalog metadata is sufficient only to deny model use before downloading.
        // Current read permission and content are established by the full read below.
        if (modelUseAllowed && !modelPreflight.has(evidenceId)) {
          if (typeof provider.getEvidence !== "function") throw providerError("SOURCE_UNAVAILABLE");
          const metadata = normalizeEvidenceRecord(await provider.getEvidence(identity, combined));
          assertActive();
          if (metadata.datasetId !== identity.datasetId || metadata.evidenceId !== evidenceId ||
            metadata.modelUseAllowed !== true) throw providerError("FORBIDDEN_SCOPE");
          modelPreflight.add(evidenceId);
        }
        const result = normalizeImaCardInput(await provider.read(identity, undefined, combined),
          { evidenceId, modelUseAllowed });
        assertActive();
        return result;
      });
    },
    async readCardCandidates({ signal } = {}) {
      assertActive();
      if (typeof provider.listCardCandidates !== "function") throw providerError("SOURCE_UNAVAILABLE");
      const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        const result = normalizeImaCandidates(await provider.listCardCandidates({ scope: requested }, combined));
        assertActive();
        if (!same(result.scope, requested)) throw providerError("FORBIDDEN_SCOPE");
        return result;
      });
    },
    async readWikiEvidence({ query, signal, asOf, knownAt } = {}) {
      assertActive();
      if (asOf !== undefined || knownAt !== undefined) throw providerError("TIME_BOUNDARY");
      const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
      return runCancellable(combined, async () => {
        let result;
        try { result = await provider.search({ query, scope: requested, limit: 3 }, combined); }
        catch (error) {
          const receipt = error.details?.receipt;
          if (error.code !== "NO_RESULT") throw error;
          if (receipt?.schema !== "evidence-provider-v1" || receipt.provider !== "ima"
            || !same(receipt.scope, requested) || typeof receipt.complete !== "boolean"
            || receipt.totalHits !== 0 || receipt.hitCount !== 0) throw providerError("SOURCE_UNAVAILABLE");
          assertActive();
          return projectWikiResearchContext({ schema: SCHEMA, mode, status: receipt.complete ? "empty" : "partial",
            complete: receipt.complete, matched: 0, items: [] });
        }
        const receipt = result?.receipt;
        if (!Array.isArray(result?.hits) || result.hits.length > 3 || receipt?.provider !== "ima"
          || !same(receipt.scope, requested) || typeof receipt.complete !== "boolean"
          || !Number.isSafeInteger(receipt.totalHits) || receipt.totalHits < result.hits.length) {
          throw providerError("SOURCE_UNAVAILABLE", "IMA_RETRIEVAL_INVALID");
        }
        const items = [], hashes = new Set();
        let denied = 0;
        for (const hit of result.hits) {
          assertActive();
          if (combined.aborted) throw providerError("CANCELLED");
          if (hit.datasetId !== requested.datasetIds[0] || hit.wikiOrigin?.provider !== "ima") {
            throw providerError("FORBIDDEN_SCOPE");
          }
          if (hit.modelUseAllowed !== true) { denied++; continue; }
          const record = normalizeEvidenceRecord(await provider.read(
            { datasetId: hit.datasetId, evidenceId: hit.evidenceId }, undefined, combined));
          assertActive();
          if (combined.aborted) throw providerError("CANCELLED");
          if (record.datasetId !== hit.datasetId || record.evidenceId !== hit.evidenceId
            || record.modelUseAllowed !== true || record.wikiOrigin?.permission !== "GRANTED"
            || record.wikiOrigin.provider !== "ima") throw providerError("FORBIDDEN_SCOPE");
          if (record.wikiOrigin.completeness !== "COMPLETE" || typeof record.content !== "string") throw invalid();
          if (hashes.has(record.contentHash)) continue;
          hashes.add(record.contentHash);
          items.push({
            ref: `W${items.length + 1}`, datasetId: record.datasetId, evidenceId: record.evidenceId,
            path: record.evidenceId, title: record.wikiOrigin.title,
            snippet: [...record.content.normalize("NFC").replace(/\s+/gu, " ").trim()].slice(0, 1200).join(""),
            contentHash: record.contentHash, versionId: null, observedAt: record.wikiOrigin.observedAt,
            exportAllowed: false, modelUseAllowed: true,
          });
        }
        const complete = receipt.complete && !result.nextCursor && denied === 0;
        const status = denied && !items.length ? "model-use-denied" : complete && items.length ? "done" : "partial";
        return projectWikiResearchContext({ schema: SCHEMA, mode, status, complete, matched: receipt.totalHits, items });
      });
    },
  });
}
