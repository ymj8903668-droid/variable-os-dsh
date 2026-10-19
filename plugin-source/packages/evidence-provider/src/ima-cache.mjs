// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { EvidenceProviderError, providerError } from "./errors.mjs";

const states = new WeakMap();

export function createImaEvidenceCache({ budget } = {}) {
  if (!(budget?.signal instanceof AbortSignal) || typeof budget.snapshot !== "function") {
    throw providerError("SOURCE_UNAVAILABLE", "IMA_CACHE_INVALID");
  }
  const cache = Object.freeze({}), state = { budget, transports: new WeakMap() };
  states.set(cache, state);
  budget.signal.addEventListener("abort", () => { state.transports = new WeakMap(); }, { once: true });
  return cache;
}

export function bindImaEvidenceCache(cache, { budget, transport, datasetId }) {
  const state = states.get(cache);
  if (!state || state.budget !== budget) {
    throw providerError("SOURCE_UNAVAILABLE", "IMA_CACHE_SESSION_MISMATCH");
  }
  function library() {
    let datasets = state.transports.get(transport);
    if (!datasets) state.transports.set(transport, datasets = new Map());
    let rows = datasets.get(datasetId);
    if (!rows) datasets.set(datasetId, rows = new Map());
    return rows;
  }
  return {
    revoke() {
      const rows = state.transports.get(transport)?.get(datasetId);
      if (rows) for (const row of rows.values()) row.bodies.clear();
    },
    accept(record, selectedHash) {
      const rows = library(), key = JSON.stringify([record.evidenceId, record.datasetVersion]);
      let entry = rows.get(key);
      if (!entry) rows.set(key, entry = { observed: new Map(), bodies: new Map() });
      const contentHash = record.contentHash;
      entry.observed.set(contentHash, Object.freeze({
        normalizedTextHash: contentHash, versionId: record.wikiOrigin.versionId,
        observedAt: record.wikiOrigin.observedAt,
      }));
      const candidates = [...entry.observed.values()];
      if (selectedHash !== undefined && selectedHash !== contentHash) {
        throw new EvidenceProviderError("SOURCE_UNAVAILABLE", {
          reason: "IMA_SELECTED_CONTENT_UNAVAILABLE", candidates,
        });
      }
      if (entry.observed.size > 1 && selectedHash === undefined) {
        throw new EvidenceProviderError("SOURCE_UNAVAILABLE", { reason: "IMA_VERSION_AMBIGUOUS", candidates });
      }
      // The caller has just rechecked access and downloaded these exact bytes.
      // A hash match deduplicates text, never permissions or measured metadata.
      if (!entry.bodies.has(contentHash)) entry.bodies.set(contentHash, record.content);
      return Object.freeze({ ...record, content: entry.bodies.get(contentHash) });
    },
  };
}
