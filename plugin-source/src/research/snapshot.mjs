// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId } from "../schema/canonical-json.mjs";
import { BUILDER_VERSION, RESEARCH_CASES } from "./cases.mjs";
import { createUnavailableDailyBarAdapter } from "./daily-bar.mjs";
import { createEvidenceRegistry } from "./evidence-registry.mjs";
import { fail } from "./errors.mjs";
import { loadBoundedResearchCorpus } from "./source-adapter.mjs";

export { BUILDER_VERSION };

const MAX_NODES = 9;

function compareNodes(left, right) {
  if (left.eventAt !== right.eventAt) {
    return left.eventAt < right.eventAt ? -1 : 1;
  }
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt < right.recordedAt ? -1 : 1;
  }
  return left.evidenceId < right.evidenceId
    ? -1
    : left.evidenceId > right.evidenceId
      ? 1
      : 0;
}

function selectNodes(nodes) {
  const unique = [];
  const seen = new Set();
  const sorted = [...nodes].sort(compareNodes);
  for (const node of sorted) {
    if (seen.has(node.evidenceId)) {
      continue;
    }
    seen.add(node.evidenceId);
    unique.push(Object.freeze({ ...node }));
  }
  return unique.length > MAX_NODES ? unique.slice(-MAX_NODES) : unique;
}

async function freezeMarket(dailyBarAdapter) {
  if (!dailyBarAdapter || dailyBarAdapter.availability === "UNAVAILABLE") {
    return Object.freeze({
      status: "UNKNOWN",
      cutoff: null,
      reasonCode: "PROVIDER_UNAVAILABLE",
      observations: Object.freeze([]),
    });
  }
  const queries = Array.isArray(dailyBarAdapter.observationQueries)
    ? dailyBarAdapter.observationQueries
    : [];
  const observations = [];
  for (const query of queries) {
    observations.push(await dailyBarAdapter.getDailyBar(query));
  }
  const cutoff = dailyBarAdapter.cutoff || null;
  if (!cutoff) {
    return Object.freeze({
      status: "UNKNOWN",
      cutoff: null,
      reasonCode: "CUTOFF_UNAVAILABLE",
      observations: Object.freeze(observations),
    });
  }
  const completeCount = observations.filter(
    (row) => row.status === "COMPLETE",
  ).length;
  if (observations.length > 0 && completeCount === observations.length) {
    return Object.freeze({
      status: "COMPLETE",
      cutoff,
      reasonCode: null,
      observations: Object.freeze(observations),
    });
  }
  if (completeCount > 0) {
    return Object.freeze({
      status: "PARTIAL",
      cutoff,
      reasonCode: "PARTIAL_COVERAGE",
      observations: Object.freeze(observations),
    });
  }
  return Object.freeze({
    status: "UNKNOWN",
    cutoff,
    reasonCode: "BAR_MISSING",
    observations: Object.freeze(observations),
  });
}

/** Stable identity shared by the builder and read-only recovery verification. */
export function researchSnapshotId({ schema, builderVersion, cases, sources, market }) {
  return brandedId("rsnap_", {
    schema, builderVersion, caseIds: cases.map(row => row.caseId),
    sources: sources.map(row => ({ path: row.path, sha256: row.sha256, kind: row.kind })),
    market: {
      status: market.status, cutoff: market.cutoff, reasonCode: market.reasonCode || null,
      observations: (market.observations || []).map(row => ({
        securityCode: row.securityCode, sessionDate: row.sessionDate, status: row.status,
        reasonCode: row.reasonCode || null,
        bar: row.bar ? {
          open: row.bar.open ?? null, high: row.bar.high ?? null, low: row.bar.low ?? null,
          close: row.bar.close ?? null, volume: row.bar.volume ?? null, turnover: row.bar.turnover ?? null,
        } : null,
      })),
    },
  });
}

export async function buildResearchSnapshotV1({
  sourceRoot,
  now,
  dailyBarAdapter = createUnavailableDailyBarAdapter(),
} = {}) {
  if (typeof now !== "string" || now.length === 0) {
    fail("NOW_REQUIRED", "snapshot now is required");
  }
  const registry = createEvidenceRegistry();
  const corpus = await loadBoundedResearchCorpus({
    sourceRoot,
    now,
    registry,
  });
  const cases = RESEARCH_CASES.map((caseDef) => {
    const nodes = selectNodes(corpus.caseNodes.get(caseDef.caseId) || []);
    return Object.freeze({
      caseId: caseDef.caseId,
      title: caseDef.title,
      kind: caseDef.kind,
      evidenceIds: nodes.map((node) => node.evidenceId),
      nodes,
    });
  });
  const market = await freezeMarket(dailyBarAdapter);
  const snapshot = Object.freeze({
    schema: "research-snapshot-v1",
    id: researchSnapshotId({ schema: "research-snapshot-v1", builderVersion: BUILDER_VERSION,
      cases, sources: corpus.sources, market }),
    builderVersion: BUILDER_VERSION,
    status: "COMPLETE",
    createdAt: now,
    cases,
    sources: corpus.sources,
    watermarks: corpus.watermarks,
    market,
    evidenceCount: registry.list().length,
  });
  return {
    snapshot,
    evidenceRecords: registry.list(),
    registry,
  };
}
