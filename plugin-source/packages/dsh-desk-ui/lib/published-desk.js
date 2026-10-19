// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../../../src/schema/canonical-json.mjs";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { createPublishedResearchTurn } from "./published-research-turn.js";
import { publicationOf as publication, toPublishedDeskCard as toCard, toPublishedDeskCasefile } from "./published-desk-card.js";
import { setTimeout as wait } from 'node:timers/promises';

const methods = new Set(["bootstrap", "health", "inbox", "casefile", "sourceSync", "sourceHealth"]);
const capabilities = Object.freeze({
  stateAuthority: "PUBLISHED_READ_MODEL", personalReads: true, sourceIntake: true,
  personalWrites: false, cardGeneration: false, autoJudgment: false, deepResearch: false,
  researchConversation: false, narration: false, realtimeVoice: false,
  publishedCardContent: "REVIEWED_CARD_OR_EXCERPT",
});
const versionHash = rows => canonicalHash([...rows].sort((a, b) => a.datasetId.localeCompare(b.datasetId)));
const membership = rows => new Map(rows.map(row => [JSON.stringify([row.datasetId, row.cardId]),
  canonicalHash({ ...row, title: null, datasetVersion: null })]));

// This is a live view of authorized publications, not a second personal ledger.
// No model, workspace, inferred labels or generated card identity participates.
export function createPublishedDesk({ provider, sources }) {
  let summaryCache = null;
  // Metadata of at most two completed downloads, never bodies or authority.
  let completedSnapshots = [];
  let retirement = 0;
  const retire = error => {
    summaryCache = null;
    // A genuine denial or untrusted response invalidates other buffered reads.
    // A normal version race, missing withdrawn card or cancelled caller must
    // not invalidate a different request proving the current authorized view.
    if (["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "TLS_REJECTED", "SPKI_MISMATCH",
      "RESPONSE_INVALID", "INVALID_EDGE_RESPONSE"].includes(error?.code)) {
      retirement++;
      completedSnapshots = [];
    }
  };
  const desk = {
    async call(method, params = {}, { sourceRevision, signal, onMembership } = {}) {
      try {
        const admitted = retirement;
        if (!methods.has(method)) throw remoteError("METHOD_NOT_ALLOWED");
        if (!params || typeof params !== "object" || Array.isArray(params) ||
          Object.keys(params).some(key => !(method === "casefile" ? ["card", "asOfWatermark"]
            : method === "bootstrap" || method === "inbox" ? ["asOfWatermark"] : []).includes(key)) ||
          params.asOfWatermark !== undefined && params.asOfWatermark !== "latest") {
          throw remoteError("INVALID_REQUEST");
        }
        const source = sources.snapshot(), revision = source.revision;
        completedSnapshots = completedSnapshots.filter(snapshot => snapshot.revision === revision);
        const assertCurrent = () => {
          if (signal?.aborted) throw remoteError("CANCELLED");
          if (sources.revision() !== revision || retirement !== admitted) throw remoteError("SOURCE_CHANGED");
        };
        if (method !== "bootstrap" && sourceRevision !== revision) throw remoteError("SOURCE_CHANGED");
        if (source.ready === false) {
          summaryCache = null;
          completedSnapshots = [];
          assertCurrent();
          if (!["bootstrap", "health", "inbox", "sourceHealth"].includes(method)) throw remoteError("AUTH_REQUIRED");
          // This is local configuration state, never a successful remote read.
          // A configured source's denial/outage must still propagate below.
          const watermark = canonicalHash({ sourceRevision: revision, configuration: "UNCONFIGURED" });
          const publicationIntake = { status: "NOT_CONFIGURED", recordCount: 0, coverage: "UNCONFIGURED" };
          const sourceRuntime = { status: "NOT_CONFIGURED", publicationIntake };
          const health = { projectionStatus: "COMPLETE", projectionStale: false, watermarksConsistent: true,
            ledgerWatermark: watermark, projectionLedgerWatermark: watermark, projectionDigest: watermark,
            stateAuthority: capabilities.stateAuthority, sourceRuntime };
          const inbox = { stateAuthority: capabilities.stateAuthority, urgent: [], mustReview: [], candidatePool: [] };
          const result = method === "health" ? health : method === "inbox" ? inbox
            : method === "sourceHealth" ? sourceRuntime
              : { inbox, health, source, capabilities: { ...capabilities, sourceIntake: false },
                publicationIntake, snapshots: [], featureFlags: {}, diagnostics: {}, bootstrapError: null,
                readScope: { coverage: "UNCONFIGURED", fullCard: false } };
          return { ok: true, sourceRevision: revision, projectionStatus: "COMPLETE", result };
        }
        const records = [], fullRecords = [], ids = new Set(), cursors = new Set();
        const includeCard = ["bootstrap", "inbox"].includes(method);
        let cursor, versions, totalHits, cached = false, readSnapshot = 'start', bytes = 0;
        const read = async (method, params) => {
          for (let retry = 0; ; retry++) {
            assertCurrent();
            try { return await provider.call(method, params, { signal, snapshotRead: true }); }
            catch (error) {
              // Only a server-declared read throttle is retried, on the same
              // immutable membership. Ordinary errors never silently restart it.
              if (error.localReadFence || retry >= 2 || error.code !== 'SOURCE_UNAVAILABLE'
                || !Number.isFinite(error.retryAfter) || error.retryAfter <= 0 || error.retryAfter > 60) throw error;
              await wait(error.retryAfter * 1000, undefined, { signal });
            }
          }
        };
        if (method === 'casefile') {
          if (typeof params.card !== 'string' || !params.card) throw remoteError('INVALID_REQUEST');
          // Resolve only this ID across the live authorized datasets. A library
          // append must not cause a new all-card download just to open one card.
          // Do not infer uniqueness from a previously downloaded list.
          const before = await read('datasets', {});
          assertCurrent();
          let selected = null;
          for (const dataset of before.datasets) {
            try {
              const detail = await read('casefile', { card: params.card, datasetId: dataset.datasetId });
              assertCurrent();
              if (detail.item.cardId !== params.card || detail.item.datasetId !== dataset.datasetId)
                throw remoteError('INVALID_EDGE_RESPONSE');
              if (detail.item.datasetVersion !== dataset.version) throw remoteError('SOURCE_CHANGED');
              if (selected) throw remoteError('INVALID_EDGE_RESPONSE');
              selected = detail;
            } catch (error) {
              if (error.code !== 'NO_RESULT') throw error;
            }
          }
          // Fence changes during the scoped reads, including withdrawal, new
          // cross-dataset ambiguity, visibility clocks, grants and owner focus.
          const after = await read('datasets', {});
          assertCurrent();
          if (versionHash(before.datasets) !== versionHash(after.datasets)) throw remoteError('SOURCE_CHANGED');
          if (!selected) throw remoteError('NO_RESULT');
          return { ok: true, sourceRevision: revision, projectionStatus: 'COMPLETE',
            result: toPublishedDeskCasefile(selected.item, selected.receipt) };
        }
        const retained = summaryCache;
        if (!includeCard && retained?.revision === revision) {
          // Reuse only the list, never an authorization decision or full card.
          // The live version includes current visibility, grants and time fences.
          const grants = await read("datasets", {});
          assertCurrent();
          if (summaryCache === retained && versionHash(grants.datasets) === retained.versions) {
            records.push(...structuredClone(retained.records));
            versions = retained.versions; cached = true;
          } else if (summaryCache === retained) summaryCache = null;
        } else if (retained?.revision !== revision) summaryCache = null;
        if (!cached) {
          for (;;) {
            assertCurrent();
            const result = await read("inbox", { limit: 500, readSnapshot,
              ...(includeCard ? { include: "publishedCard" } : {}), ...(cursor ? { cursor } : {}) });
            assertCurrent();
            const handle = result.receipt.readSnapshot;
            if (typeof handle !== 'string' || !/^[a-f0-9]{32}$/.test(handle)
              || readSnapshot !== 'start' && handle !== readSnapshot) throw remoteError('RESPONSE_INVALID');
            readSnapshot = handle;
            const current = versionHash(result.receipt.datasetVersions);
            if (versions && versions !== current) throw remoteError("SOURCE_CHANGED");
            versions = current;
            {
              const total = result.receipt.totalHits;
              if (!Number.isSafeInteger(total) || total < 0 || total > 20000 || totalHits !== undefined && totalHits !== total
                || result.items.length !== result.receipt.hitCount) throw remoteError("RESPONSE_INVALID");
              totalHits = total;
            }
            bytes += Buffer.byteLength(JSON.stringify(result.items));
            if (bytes > 256 * 1024 * 1024) throw remoteError('SOURCE_UNAVAILABLE');
            for (const row of result.items) {
              // Ambiguous upstream identities cannot select a different card.
              if (ids.has(row.cardId)) throw remoteError("INVALID_EDGE_RESPONSE");
              ids.add(row.cardId);
              if (includeCard) {
                fullRecords.push(row);
                const { publishedCard, ...summary } = row;
                records.push({ ...summary, title: null });
              } else records.push(row);
            }
            cursor = result.nextCursor;
            if (cursor ? !result.items.length || records.length >= totalHits
              : records.length !== totalHits) throw remoteError("RESPONSE_INVALID");
            if (!cursor) break;
            if (cursors.has(cursor)) throw remoteError("SOURCE_UNAVAILABLE");
            cursors.add(cursor);
          }
          const grants = await read("datasets", { readSnapshot });
          assertCurrent();
          if (versionHash(grants.datasets) !== versions) throw remoteError("SOURCE_CHANGED");
          // One bounded metadata list, large enough for a normal 5,000-card
          // library. Keep it during independent full downloads so SSE checks
          // do not repeatedly rescan the same library and exhaust read limits.
          // Every reuse still checks live authority/version; originals stay live.
          summaryCache = Buffer.byteLength(JSON.stringify(records)) <= 16 * 1024 * 1024
            ? { revision, versions, records: structuredClone(records) } : null;
        }
        let result;
        const fullCard = fullRecords.length > 0 && fullRecords.every(row => row.publishedCard);
        const intake = { status: "SYNCED", recordCount: records.length,
          coverage: fullCard ? "REVIEWED_PUBLISHED_CARDS" : "PUBLISHED_CARD_EXCERPTS" };
        const sourceRuntime = { status: "CONNECTED", publicationIntake: intake };
        const projectionDigest = canonicalHash(records);
        const health = {
          projectionStatus: "COMPLETE", projectionStale: false, watermarksConsistent: true,
          ledgerWatermark: versions, projectionLedgerWatermark: versions, projectionDigest,
          stateAuthority: capabilities.stateAuthority, sourceRuntime,
        };
        const inbox = { stateAuthority: capabilities.stateAuthority,
          urgent: [], mustReview: [], candidatePool: fullRecords.map(toCard) };
        if (method === "bootstrap") result = {
          inbox, health, source, capabilities, publicationIntake: intake, snapshots: [],
          featureFlags: {}, diagnostics: {}, bootstrapError: null,
          readScope: { coverage: intake.coverage, fullCard },
        };
        else if (method === "inbox") result = inbox;
        else if (method === "health") result = health;
        else if (method === "sourceSync") result = intake;
        else if (method === "sourceHealth") result = sourceRuntime;
        assertCurrent();
        if (method === "bootstrap") {
          completedSnapshots = completedSnapshots.filter(snapshot => snapshot.ledgerWatermark !== versions
            || snapshot.projectionDigest !== projectionDigest);
          completedSnapshots.push({ revision, ledgerWatermark: versions, projectionDigest, members: membership(records) });
          completedSnapshots = completedSnapshots.slice(-2);
        } else if (method === "health") {
          // Fresh authorized metadata must contain every downloaded identity with
          // its exact content, visibility and focus. Additions do not invalidate
          // those originals; any changed/removed member does. Keep the frozen
          // version separate so the client still catches up with new cards.
          const current = membership(records);
          completedSnapshots = completedSnapshots.filter(snapshot =>
            [...snapshot.members].every(([id, hash]) => current.get(id) === hash));
          health.readablePublicationSnapshots = completedSnapshots.map(({ ledgerWatermark, projectionDigest }) =>
            ({ ledgerWatermark, projectionDigest }));
        }
        // Internal notification proof only. Exclude the collection version,
        // which changes for additions; preserve every existing row's content,
        // visibility and owner-focus metadata. Never send originals in SSE.
        if (onMembership && method === "health") onMembership(records.map(row => ({
          identity: JSON.stringify([row.datasetId, row.cardId]),
          hash: canonicalHash({ ...row, datasetVersion: null }),
        })));
        return { ok: true, sourceRevision: revision, projectionStatus: "COMPLETE", result };
      } catch (error) {
        retire(error);
        throw error;
      }
    },
  };
  return Object.freeze({...desk,withResearchTurn:createPublishedResearchTurn({
    call:desk.call,currentSourceRevision:()=>sources.revision(),
    readOriginal:async(params,options)=>{
      try{
        const {item}=await provider.call("casefile",params,options);
        return {publication:publication(item),publishedCard:item.publishedCard};
      }catch(error){retire(error);throw error;}
    },
  })});
}
