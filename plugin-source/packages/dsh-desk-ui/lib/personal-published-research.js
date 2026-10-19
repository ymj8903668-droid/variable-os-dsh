// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { projectReadResponse, projectResearchContext } from "../../dsh-tools/lib/remote/responses.js";
import { independentResearchSources } from "../../../src/runtime/wiki-research-source.mjs";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { canonicalHash } from "../../../src/schema/canonical-json.mjs";
import { compareInstants } from "../../evidence-provider/src/contracts.mjs";

const SCHEMA = "personal-published-proof-v1";
const SOURCES = independentResearchSources().split(",");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denseArray = (value, max) => Array.isArray(value) && value.length <= max
  && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
function readCheckpoint(input, scopeKey) {
  let value;
  try {
    value = structuredClone(input);
    if (!exact(value, ["schema", "scopeKey", "datasetIds", "publicationEpoch", "latestClock", "proofs"])
      || value.schema !== SCHEMA || !hash(value.scopeKey)
      || !denseArray(value.proofs, 8)
      || value.latestClock !== null && (!Number.isSafeInteger(value.latestClock)
        || value.latestClock < 0 || value.latestClock > 8.64e15)) throw Error();
    if (!value.proofs.length) {
      if (value.datasetIds !== null || value.publicationEpoch !== null) throw Error();
    } else {
      if (!denseArray(value.datasetIds, 100) || !value.datasetIds.length
        || value.datasetIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id))
        || new Set(value.datasetIds).size !== value.datasetIds.length || !hash(value.publicationEpoch)
        || value.latestClock === null) throw Error();
    }
    for (const proof of value.proofs) {
      if (!exact(proof, ["params", "hash"]) || !hash(proof.hash)
        || !exact(proof.params, ["topic", "sources", "maxResults", "proof", "tavily", "asOf"])) throw Error();
      const params = proof.params;
      if (typeof params.topic !== "string" || !params.topic.isWellFormed()
        || [...params.topic.trim()].length < 2 || [...params.topic].length > 200
        || Buffer.byteLength(params.topic) > 800 || /[\u0000-\u001f\u007f]/u.test(params.topic)
        || /(?:password|passwd|token|api[_ -]?key|secret)\s*[:=]\s*\S+/iu.test(params.topic)
        || !denseArray(params.sources, SOURCES.length)
        || JSON.stringify(params.sources) !== JSON.stringify(SOURCES)
        || params.maxResults !== 5 || params.proof !== true || params.tavily !== "off"
        || typeof params.asOf !== "string"
        || compareInstants(params.asOf, new Date(value.latestClock).toISOString()) > 0) throw Error();
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 32768) throw Error();
  } catch { throw remoteError("RESEARCH_CHECKPOINT_INVALID"); }
  if (!hash(scopeKey)) throw remoteError("RESEARCH_CHECKPOINT_INVALID");
  if (value.scopeKey !== scopeKey) throw remoteError("SOURCE_CHANGED");
  return value;
}

/** Dependency metadata only; a restored checkpoint is never authorization or a context cache. */
export function createPersonalPublishedResearch({
  provider, assertSource, webSearchAllowed, ownWeb, now = Date.now, checkpointScope, checkpoint,
}) {
  if (checkpointScope !== undefined && !hash(checkpointScope)) throw remoteError("RESEARCH_CHECKPOINT_INVALID");
  const restored = checkpoint === undefined ? null : readCheckpoint(checkpoint, checkpointScope);
  let datasetIds, epoch = restored?.publicationEpoch ?? undefined, latestClock = restored?.latestClock ?? -Infinity;
  let active = 0, retired = false, verified = !restored?.proofs.length;
  const proofs = restored?.proofs ?? [];
  const assertLive = () => {
    if (retired) throw remoteError("SOURCE_CHANGED");
    try { assertSource(); }
    catch (error) { retired = true; throw error; }
  };
  const operate = async work => {
    assertLive();
    active++;
    try { return await work(); }
    catch (error) { retired = true; throw error; }
    finally { active--; }
  };
  const check = signal => {
    assertLive();
    if (signal?.aborted) throw remoteError("CANCELLED");
    const value = now();
    if (!Number.isFinite(value) || value < latestClock) throw remoteError("TIME_BOUNDARY");
    latestClock = value;
    return new Date(value).toISOString();
  };
  const read = async (params, signal) => {
    check(signal);
    if (!datasetIds) {
      const { provider: _provider, ...body } = await provider.call("datasets", {}, { signal });
      datasetIds = projectReadResponse("datasets", body).datasets.map(row => row.datasetId);
      check(signal);
      if (restored?.datasetIds && canonicalHash([...datasetIds].sort())
        !== canonicalHash([...restored.datasetIds].sort())) throw remoteError("SOURCE_CHANGED");
    }
    // The pinned provider checks live grants on every context request. The
    // context epoch covers that grant scope and every publication row.
    const result = projectResearchContext(await provider.call("researchContext", params, { signal }),
      datasetIds, params);
    check(signal);
    if (epoch && epoch !== result.receipt.publicationEpoch) throw remoteError("SOURCE_CHANGED");
    epoch ??= result.receipt.publicationEpoch;
    if (params.tavily === "off" && (result.web.status !== "off" || result.web.results.length)) {
      throw remoteError("SOURCE_UNAVAILABLE");
    }
    return result;
  };
  const fingerprint = context => canonicalHash({ local: context.local,
    refs: context.refs.filter(row => row.sourceType !== "web"), receipt: context.receipt });
  const prove = async ({ signal } = {}) => {
    check(signal);
    // One live witness proves the entire pinned publication snapshot, not
    // just this query. Replaying every query would exhaust the edge limiter.
    const proof = proofs.at(-1);
    if (proof) {
      const context = await read(proof.params, signal);
      if (fingerprint(context) !== proof.hash) throw remoteError("SOURCE_CHANGED");
    }
    check(signal);
    verified = true;
  };
  return Object.freeze({
    prove: options => operate(() => prove(options)),
    checkpoint() {
      if (!checkpointScope) throw remoteError("RESEARCH_CHECKPOINT_UNAVAILABLE");
      if (active) throw remoteError("RESEARCH_CHECKPOINT_BUSY");
      assertLive();
      if (!verified) throw remoteError("RESEARCH_CHECKPOINT_UNPROVEN");
      try {
        if (latestClock !== -Infinity) {
          const current = now();
          if (!Number.isFinite(current) || current < latestClock) throw remoteError("TIME_BOUNDARY");
        }
        return readCheckpoint({ schema: SCHEMA, scopeKey: checkpointScope,
          datasetIds: proofs.length ? datasetIds ?? restored?.datasetIds : null,
          publicationEpoch: epoch ?? null, latestClock: latestClock === -Infinity ? null : latestClock,
          proofs }, checkpointScope);
      } catch (error) { retired = true; throw error; }
    },
    async context(topic, { signal } = {}) {
      assertLive();
      if (proofs.length >= 8) throw remoteError("RESEARCH_SCOPE_LIMIT");
      return operate(async () => {
        await prove({ signal });
        const params = { topic, sources: [...SOURCES], maxResults: 5, proof: true,
          tavily: webSearchAllowed && !ownWeb ? "edge" : "off" };
        const result = await read(params, signal);
        const observedAt = check(signal);
        proofs.push({ params: { ...params, asOf: result.receipt.asOf, tavily: "off" }, hash: fingerprint(result) });
        const own = ownWeb ? await ownWeb(topic, { signal }) : null;
        await prove({ signal });
        return { ...result, ...(own ? { web: own.web, refs: [...result.refs, ...own.refs], webService: own.webService } : {}),
          webObservation: own?.webObservation ?? {
            observedAt, historicalAvailability: "UNKNOWN", revalidated: false,
          } };
      });
    },
  });
}
