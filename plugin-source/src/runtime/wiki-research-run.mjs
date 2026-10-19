// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { providerError, runCancellable, sourceError } from "../../packages/evidence-provider/src/index.mjs";
import { imaCardIdentity, normalizeImaCardInput } from "./ima-card-input.mjs";

const unavailable = reason => providerError("SOURCE_UNAVAILABLE", reason);
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const secret = /(?:password|passwd|pwd|token|api[_ -]?key|secret|密码|口令|密钥|令牌)\s*[:=：]\s*[^\s,，;；]+/iu;
const validQuery = value => typeof value === "string" && value === value.trim() && value.length >= 2
  && [...value].length <= 200 && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value) && !secret.test(value);
const freezeRecord = row => Object.freeze({ ...row, wikiOrigin: Object.freeze({ ...row.wikiOrigin }) });

/** Host-only full inputs for a single approved run. Never creates a fresh
 * allowance between rounds. Every admitted original is re-read before delivery. */
export function createWikiResearchRun({ requested, provider, budget, assertActive }) {
  let consumed = false;
  return async function withWikiResearchRun(params, operation) {
    if (consumed) throw unavailable("IMA_RESEARCH_RUN_CONSUMED");
    if (budget.profile !== "research") throw unavailable("IMA_RESEARCH_BUDGET_REQUIRED");
    if (!plain(params) || Object.keys(params).some(key => !["maxQueries", "maxDocuments", "signal"].includes(key))
      || !Number.isSafeInteger(params.maxQueries) || params.maxQueries < 1 || params.maxQueries > 4
      || !Number.isSafeInteger(params.maxDocuments) || params.maxDocuments < 1 || params.maxDocuments > 4
      || params.signal !== undefined && !(params.signal instanceof AbortSignal)
      || typeof operation !== "function") throw unavailable("IMA_RESEARCH_INPUT_INVALID");
    consumed = true;
    const signal = params.signal ? AbortSignal.any([params.signal, budget.signal]) : budget.signal;
    const rows = new Map(), queries = [], searched = new Set();
    let active = true, searching = false, failure = null, proofCalls = 0;
    const poison = error => { failure ??= sourceError(error); return failure; };
    const check = () => {
      if (!active) throw unavailable("IMA_RESEARCH_RUN_CLOSED");
      if (failure) throw failure;
      assertActive();
      if (signal.aborted) throw providerError("CANCELLED");
    };
    const proofCapacity = () => {
      const counts = budget.snapshot();
      if (budget.limits.apiRequests - counts.apiRequests < proofCalls
        || budget.limits.downloads - counts.downloads < rows.size) throw unavailable("IMA_RESEARCH_PROOF_BUDGET");
    };
    const receipt = (proof = "PENDING") => Object.freeze({ coverage: "IMA_LIBRARY_MULTI_QUERY",
      datasetId: requested.datasetIds[0], matched: null, included: rows.size, complete: false,
      historyComplete: false, version: null, proof, queries: Object.freeze([...queries]) });
    const read = async identity => {
      check();
      const row = normalizeImaCardInput(await provider.read(identity, undefined, signal),
        { evidenceId: identity.evidenceId, modelUseAllowed: true });
      check();
      return freezeRecord(row);
    };
    const search = input => {
      const pending = (async () => {
        let ownsSearch = false;
        try {
          check();
          if (searching) throw unavailable("IMA_RESEARCH_CONCURRENT_QUERY");
          if (!plain(input) || Object.keys(input).join(",") !== "query" || !validQuery(input.query)) {
            throw unavailable("IMA_RESEARCH_INPUT_INVALID");
          }
          if (searched.has(input.query)) throw unavailable("IMA_RESEARCH_DUPLICATE_QUERY");
          if (searched.size >= params.maxQueries) throw unavailable("IMA_RESEARCH_QUERY_LIMIT");
          searched.add(input.query);
          searching = ownsSearch = true;
          let found;
          try { found = await provider.search({ query: input.query, scope: requested, limit: params.maxDocuments }, signal); }
          catch (error) {
            if (error.code !== "NO_RESULT") throw error;
            found = { hits: [], receipt: error.details?.receipt };
          }
          check();
          const proof = found?.receipt;
          if (!Array.isArray(found?.hits) || found.hits.length > params.maxDocuments
            || proof?.schema !== "evidence-provider-v1" || proof.provider !== "ima" || typeof proof.complete !== "boolean"
            || JSON.stringify(proof.scope) !== JSON.stringify(requested) || proof.query !== input.query
            || !Number.isSafeInteger(proof.totalHits) || proof.totalHits < found.hits.length
            || proof.hitCount !== found.hits.length || !found.hits.length && proof.totalHits !== 0) {
            throw unavailable("IMA_RETRIEVAL_INVALID");
          }
          proofCapacity();
          const identities = new Set();
          for (const hit of found.hits) {
            if (hit.datasetId !== requested.datasetIds[0] || hit.wikiOrigin?.provider !== "ima"
              || hit.modelUseAllowed !== true || imaCardIdentity(hit.evidenceId).datasetId !== hit.datasetId) {
              throw providerError("FORBIDDEN_SCOPE");
            }
            if (identities.has(hit.evidenceId)) throw unavailable("IMA_RETRIEVAL_INVALID");
            identities.add(hit.evidenceId);
          }
          const records = [], omittedFor = new Set();
          for (const hit of found.hits) {
            check();
            let row = rows.get(hit.evidenceId);
            if (!row) {
              if (rows.size >= params.maxDocuments) { omittedFor.add("DOCUMENT_LIMIT"); continue; }
              const before = budget.snapshot();
              // Keep one download per admitted original for the final proof.
              if (budget.limits.downloads - before.downloads < rows.size + 2) {
                omittedFor.add("DOWNLOAD_ALLOWANCE"); continue;
              }
              row = await read({ datasetId: hit.datasetId, evidenceId: hit.evidenceId });
              const used = budget.snapshot().apiRequests - before.apiRequests;
              if (used < 1) throw unavailable("IMA_RETRIEVAL_INVALID");
              proofCalls += used;
              rows.set(row.evidenceId, row);
              // Estimate from actual catalog/read work. A larger catalog during
              // proof can still exhaust the hard cap; that fails closed.
              proofCapacity();
            }
            records.push(row);
          }
          if (found.nextCursor) omittedFor.add("SEARCH_PAGE_LIMIT");
          if (!proof.complete) omittedFor.add("SOURCE_COVERAGE_UNKNOWN");
          const queryReceipt = Object.freeze({ query: input.query, matched: proof.totalHits,
            included: records.length, omitted: proof.totalHits - records.length,
            complete: proof.complete && !found.nextCursor && proof.totalHits === records.length,
            evidenceIds: Object.freeze(records.map(row => row.evidenceId)),
            omittedFor: Object.freeze([...omittedFor]) });
          queries.push(queryReceipt);
          check();
          proofCapacity();
          return Object.freeze({ records: Object.freeze(records), receipt: queryReceipt });
        } catch (error) { throw poison(error); }
        finally { if (ownsSearch) searching = false; }
      })();
      // A caller must await each round. An abandoned promise still poisons the
      // run and cannot create an unhandled rejection or escape final cleanup.
      pending.catch(() => {});
      return pending;
    };
    try {
      return await runCancellable(signal, async () => {
        check();
        const value = await operation(Object.freeze({ signal, search, snapshot() {
          check();
          if (searching) throw poison(unavailable("IMA_RESEARCH_CONCURRENT_QUERY"));
          return Object.freeze({ records: Object.freeze([...rows.values()]), receipt: receipt() });
        } }));
        check();
        if (searching) throw unavailable("IMA_RESEARCH_UNAWAITED_QUERY");
        if (!queries.length) throw unavailable("IMA_RESEARCH_QUERY_REQUIRED");
        proofCapacity();
        for (const row of rows.values()) {
          const current = await read({ datasetId: row.datasetId, evidenceId: row.evidenceId });
          if (current.contentHash !== row.contentHash || current.wikiOrigin.title !== row.wikiOrigin.title) {
            throw unavailable("IMA_RESEARCH_INPUT_CHANGED");
          }
        }
        check();
        return Object.freeze({ value, receipt: receipt("REVALIDATED") });
      });
    } finally {
      active = false;
      budget.close();
    }
  };
}
