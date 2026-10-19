// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { remoteError } from "./config.js";
import { projectReadResponse } from "./responses.js";
import { compareInstants } from "../../../evidence-provider/src/contracts.mjs";
import { differenceRfc3339Micros } from "../../../storage-contracts/src/time.mjs";
import timers from "node:timers/promises";

const MAX_HISTORY = 5000, MAX_BYTES = 16 * 1024 * 1024;
const binding = page => JSON.stringify({
  scope: page.receipt.scope, versions: page.receipt.datasetVersions,
  asOf: page.receipt.asOf, knownAt: page.receipt.knownAt, total: page.receipt.totalHits,
});
const firstPage = page => JSON.stringify({ binding: binding(page), items: page.items, nextCursor: page.nextCursor });

export function createLivePublishedEvidenceReader({ provider }) {
  let snapshot = null;
  const read = async (options, retained) => {
    try {
      const result = await collectLive({ ...options, provider }, retained);
      snapshot = structuredClone(result);
      return result;
    } catch (error) { snapshot = null; throw error; }
  };
  return Object.freeze({
    read: options => read(options, null),
    prove: options => read(options, snapshot),
  });
}

/** Let a slightly slower source reach the Host's fixed cutoff. This is not a
 * tolerance on evidence time: the original cutoff and every proof stay strict. */
export function collectLivePublishedEvidence(options = {}) {
  return collectLive(options);
}

async function collectLive({ provider, asOf, signal }, snapshot) {
  const active = () => { if (signal?.aborted) throw remoteError("CANCELLED"); };
  active();
  compareInstants(asOf, asOf);
  const clock = async () => {
    const { provider: _provider, ...body } = await provider.call("datasets", {}, { signal }) ?? {};
    active();
    return projectReadResponse("datasets", body).receipt;
  };
  const receipt = await clock();
  let drift;
  try {
    const available = differenceRfc3339Micros(asOf, receipt.asOf);
    const known = differenceRfc3339Micros(asOf, receipt.knownAt);
    drift = available > known ? available : known;
  } catch { throw remoteError("RESPONSE_INVALID"); }
  if (drift > 5_000_000n) throw remoteError("TIME_BOUNDARY");
  if (drift > 0n) {
    try { await timers.setTimeout(Number((drift + 999n) / 1000n), undefined, { signal }); }
    catch (error) { active(); throw error; }
  }
  active();
  const matches = receipt => snapshot
    && compareInstants(snapshot.asOf, asOf) <= 0 && compareInstants(snapshot.knownAt, asOf) <= 0
    && compareInstants(asOf, receipt.asOf) <= 0 && compareInstants(asOf, receipt.knownAt) <= 0
    && JSON.stringify(snapshot.datasetVersions) === JSON.stringify(receipt.datasetVersions);
  if (drift <= 0n && matches(receipt) && matches(await clock())) {
    // The edge recomputes these versions from current scoped rows and deny
    // controls. Retain bytes, never permission: both witnesses are live.
    return { ...structuredClone(snapshot), asOf, knownAt: asOf };
  }
  return collectPublishedEvidence({ provider, asOf, signal });
}

/** One bounded snapshot through the existing validated, pinned read provider.
 * Nothing is committed until all pages and a final policy recheck succeed. */
export async function collectPublishedEvidence({ provider, asOf, signal } = {}) {
  const active = () => { if (signal?.aborted) throw remoteError("CANCELLED"); };
  const params = { asOf, knownAt: asOf, limit: 100 };
  const read = async cursor => {
    active();
    const page = await provider.call("timeline", { ...params, ...(cursor ? { cursor } : {}) }, { signal });
    active();
    if (page.receipt.hitCount !== page.items.length || page.receipt.totalHits < page.items.length) {
      throw remoteError("INTAKE_INCOMPLETE");
    }
    if (page.receipt.totalHits > MAX_HISTORY) throw remoteError("INTAKE_LIMIT");
    return page;
  };
  const first = await read();
  const expected = binding(first), cursors = new Set(), revisions = new Set(), current = new Map();
  let page = first, historyCount = 0, pageCount = 0, bytes = 0;
  while (true) {
    if (binding(page) !== expected) throw remoteError("SOURCE_CHANGED");
    pageCount++;
    if (pageCount > 50) throw remoteError("INTAKE_LIMIT");
    for (const item of page.items) {
      const identity = JSON.stringify([item.datasetId, item.sourceFamily, item.evidenceId]);
      const version = JSON.stringify([identity, item.revision]);
      if (revisions.has(version)) throw remoteError("INTAKE_INCOMPLETE");
      revisions.add(version);
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > MAX_BYTES) throw remoteError("INTAKE_LIMIT");
      const previous = current.get(identity);
      if (previous && item.revision > previous.revision && compareInstants(item.knownAt, previous.knownAt) < 0) {
        throw remoteError("RESPONSE_INVALID");
      }
      if (!previous || item.revision > previous.revision) current.set(identity, item);
    }
    historyCount += page.items.length;
    if (historyCount > first.receipt.totalHits) throw remoteError("INTAKE_INCOMPLETE");
    if (!page.nextCursor) break;
    if (!page.items.length || historyCount >= first.receipt.totalHits || cursors.has(page.nextCursor)) {
      throw remoteError("INTAKE_INCOMPLETE");
    }
    cursors.add(page.nextCursor);
    page = await read(page.nextCursor);
  }
  if (historyCount !== first.receipt.totalHits) throw remoteError("INTAKE_INCOMPLETE");
  // Deny controls apply even at the frozen evidence time. A cursor response
  // from before withdrawal must not activate a stale local snapshot.
  if (firstPage(await read()) !== firstPage(first)) throw remoteError("SOURCE_CHANGED");
  return {
    schema: "publication-intake-v1", coverage: "AUTHORIZED_TIMELINE_EXCERPTS",
    asOf: first.receipt.asOf, knownAt: first.receipt.knownAt,
    datasetVersions: first.receipt.datasetVersions,
    records: [...current.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row),
    historyCount, pageCount,
  };
}
