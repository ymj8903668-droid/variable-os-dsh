// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { QueryError } from "../http/errors.mjs";
import { openFreshProjectionDb } from "../research/projection.mjs";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { WATCH_CATALYST_ARCHETYPES } from "./schema.mjs";

const WATCH_STATUSES = new Set([
  "OPEN",
  "VERIFYING",
  "PROMOTED",
  "DISCARDED",
  "EXPIRED",
]);
const SOURCE_STATUSES = new Set([
  "UNREVIEWED",
  "FORMAL",
  "WATCH",
  "DISCARDED",
  "FAILED",
]);
const SOURCE_FRESHNESS_VALUES = new Set(["FRESH", "STALE"]);
const FRESHNESS_VALUES = new Set(["FRESH", "EXPIRING", "EXPIRED"]);
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SOURCE_FRESH_WINDOW_MS = 24 * 60 * 60 * 1_000;

function fail(code, message, details) {
  throw new QueryError(code, message, details);
}

function normalizedTime(now) {
  const value = typeof now === "function" ? now() : now;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("INVALID_PARAMS", "valid now required");
  return new Date(timestamp).toISOString();
}

function normalizedWatermark(value) {
  if (value === undefined || value === null || value === "") return "latest";
  if (value === "latest" || /^[0-9a-f]{64}$/.test(value)) return value;
  fail("INVALID_PARAMS", "asOfWatermark must be latest or a SHA-256 watermark");
}

function boundedOptional(value, name, max = 120) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("INVALID_PARAMS", `${name} is invalid`);
  }
  return value;
}

function normalizeListParams(params = {}) {
  const status = boundedOptional(params.status, "status", 24);
  if (status && !WATCH_STATUSES.has(status)) {
    fail("INVALID_PARAMS", "status is invalid");
  }
  const source = boundedOptional(params.source, "source");
  const archetype = boundedOptional(params.archetype, "archetype", 40);
  if (archetype && !WATCH_CATALYST_ARCHETYPES.includes(archetype)) {
    fail("INVALID_PARAMS", "archetype is invalid");
  }
  const freshness = boundedOptional(params.freshness, "freshness", 16);
  if (freshness && !FRESHNESS_VALUES.has(freshness)) {
    fail("INVALID_PARAMS", "freshness is invalid");
  }
  const limit = params.limit === undefined ? DEFAULT_LIMIT : params.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    fail("INVALID_PARAMS", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return {
    status,
    source,
    archetype,
    freshness,
    limit,
    asOfWatermark: normalizedWatermark(params.asOfWatermark),
  };
}

function parseJson(value, field) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) && (field.endsWith("Refs") || field.endsWith("Evidence") || field.endsWith("Plan") || field.endsWith("Conditions"))) {
      fail("PROJECTION_STALE", `invalid catalyst watch ${field}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    fail("PROJECTION_STALE", `invalid catalyst watch ${field}`);
  }
}

function freshnessOf(expiresAt, nowIso) {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(nowIso);
  if (!Number.isFinite(expires)) fail("PROJECTION_STALE", "invalid watch expiry");
  if (expires <= current) return "EXPIRED";
  if (expires - current <= EXPIRING_WINDOW_MS) return "EXPIRING";
  return "FRESH";
}

function listRow(row, nowIso) {
  return {
    watchId: row.watch_id,
    sourceNamespace: row.source_namespace,
    sourceType: row.source_type,
    eventTime: row.event_time,
    sourceAvailableAt: row.source_available_at,
    analyzedAt: row.analyzed_at,
    sourceCutoff: row.source_cutoff,
    expiresAt: row.expires_at,
    catalystArchetype: row.catalyst_archetype,
    expectedHorizon: row.expected_horizon,
    importance: parseJson(row.importance_json, "importance"),
    evidenceMaturity: parseJson(row.evidence_maturity_json, "evidenceMaturity"),
    missingEvidence: parseJson(row.missing_evidence_json, "missingEvidence"),
    verificationPlan: parseJson(row.verification_plan_json, "verificationPlan"),
    invalidationConditions: parseJson(
      row.invalidation_conditions_json,
      "invalidationConditions",
    ),
    status: row.status,
    freshness: freshnessOf(row.expires_at, nowIso),
  };
}

function sourceFreshness(availableAt, nowIso) {
  const available = Date.parse(availableAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(available) || !Number.isFinite(now)) return "STALE";
  return now >= available && now - available <= SOURCE_FRESH_WINDOW_MS
    ? "FRESH"
    : "STALE";
}

function sourceListRow(row, nowIso) {
  return {
    sourceItemId: row.source_item_id,
    sourceNamespace: row.source_namespace,
    sourceType: row.source_type,
    sourceDocumentKey: row.source_document_key,
    contentHash: row.content_hash,
    declaredPublishedAt: row.declared_published_at,
    firstRetrievedAt: row.first_retrieved_at,
    availableAt: row.available_at,
    sourceTimeConfidence: row.source_time_confidence,
    screeningStatus: row.screening_status,
    screeningDecision: row.screening_decision,
    rejectDisposition: row.reject_disposition,
    screeningDecisionId: row.screening_decision_id,
    cardRevisionId: row.card_revision_id,
    freshness: sourceFreshness(row.available_at, nowIso),
  };
}

function normalizeSourceListParams(params = {}) {
  const source = boundedOptional(params.source, "source");
  const archetype = boundedOptional(params.archetype, "archetype", 40);
  if (archetype && !WATCH_CATALYST_ARCHETYPES.includes(archetype)) {
    fail("INVALID_PARAMS", "archetype is invalid");
  }
  const status = boundedOptional(params.status, "status", 24);
  if (status && !SOURCE_STATUSES.has(status)) {
    fail("INVALID_PARAMS", "status is invalid");
  }
  const freshness = boundedOptional(params.freshness, "freshness", 16);
  if (freshness && !SOURCE_FRESHNESS_VALUES.has(freshness)) {
    fail("INVALID_PARAMS", "freshness is invalid");
  }
  const limit = params.limit === undefined ? DEFAULT_LIMIT : params.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    fail("INVALID_PARAMS", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return {
    source,
    archetype,
    status,
    freshness,
    limit,
    asOfWatermark: normalizedWatermark(params.asOfWatermark),
  };
}

function decodeSourceCursor(value, filterHash, watermark) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) {
    fail("INVALID_PARAMS", "cursor is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail("INVALID_PARAMS", "cursor is invalid");
  }
  const tuple = parsed?.tuple;
  if (
    parsed?.version !== 1 ||
    parsed?.filterHash !== filterHash ||
    parsed?.watermark !== watermark ||
    !Array.isArray(tuple) ||
    tuple.length !== 2 ||
    tuple.some((entry) => typeof entry !== "string")
  ) {
    fail("INVALID_PARAMS", "cursor does not match this query");
  }
  return tuple;
}

function encodeSourceCursor(row, filterHash, watermark) {
  return Buffer.from(JSON.stringify({
    version: 1,
    filterHash,
    watermark,
    tuple: [row.available_at, row.source_item_id],
  })).toString("base64url");
}

async function openMatchingProjection({ derivedRoot, store, now, asOfWatermark, live }) {
  const opened = await openFreshProjectionDb({ derivedRoot, store, now, live });
  if (
    asOfWatermark !== "latest" &&
    asOfWatermark !== opened.live.watermark
  ) {
    opened.db.close();
    fail("PROJECTION_STALE", "asOfWatermark does not match frozen ledger");
  }
  return opened;
}

function decodeCursor(value, filterHash, watermark) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) {
    fail("INVALID_PARAMS", "cursor is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    fail("INVALID_PARAMS", "cursor is invalid");
  }
  const tuple = parsed?.tuple;
  if (
    parsed?.version !== 1 ||
    parsed?.filterHash !== filterHash ||
    parsed?.watermark !== watermark ||
    !Array.isArray(tuple) ||
    tuple.length !== 5 ||
    !Number.isFinite(tuple[0]) ||
    !Number.isFinite(tuple[1]) ||
    tuple.slice(2).some((entry) => typeof entry !== "string")
  ) {
    fail("INVALID_PARAMS", "cursor does not match this query");
  }
  return tuple;
}

function encodeCursor(row, filterHash, watermark) {
  return Buffer.from(JSON.stringify({
    version: 1,
    filterHash,
    watermark,
    tuple: [
      row.importance_total,
      row.evidence_maturity_total,
      row.expires_at,
      row.analyzed_at,
      row.watch_id,
    ],
  })).toString("base64url");
}

export async function queryCatalystWatchList(params = {}) {
  const normalized = normalizeListParams(params);
  const nowIso = normalizedTime(params.now);
  const opened = await openMatchingProjection({
    derivedRoot: params.derivedRoot,
    store: params.store,
    now: params.now,
    asOfWatermark: normalized.asOfWatermark,
  });
  try {
    const filterHash = canonicalHash({
      status: normalized.status,
      source: normalized.source,
      archetype: normalized.archetype,
      freshness: normalized.freshness,
    });
    const cursor = decodeCursor(
      params.cursor,
      filterHash,
      opened.live.watermark,
    );
    const where = [];
    const bindings = [];
    if (normalized.status) {
      where.push("status = ?");
      bindings.push(normalized.status);
    }
    if (normalized.source) {
      where.push("(source_namespace = ? OR source_type = ?)");
      bindings.push(normalized.source, normalized.source);
    }
    if (normalized.archetype) {
      where.push("catalyst_archetype = ?");
      bindings.push(normalized.archetype);
    }
    if (normalized.freshness === "FRESH") {
      where.push("expires_at > ?");
      bindings.push(new Date(Date.parse(nowIso) + EXPIRING_WINDOW_MS).toISOString());
    } else if (normalized.freshness === "EXPIRING") {
      where.push("expires_at > ? AND expires_at <= ?");
      bindings.push(
        nowIso,
        new Date(Date.parse(nowIso) + EXPIRING_WINDOW_MS).toISOString(),
      );
    } else if (normalized.freshness === "EXPIRED") {
      where.push("expires_at <= ?");
      bindings.push(nowIso);
    }
    if (cursor) {
      const [importance, maturity, expiresAt, analyzedAt, watchId] = cursor;
      where.push(`(
        importance_total < ? OR
        (importance_total = ? AND evidence_maturity_total > ?) OR
        (importance_total = ? AND evidence_maturity_total = ? AND expires_at > ?) OR
        (importance_total = ? AND evidence_maturity_total = ? AND expires_at = ? AND analyzed_at < ?) OR
        (importance_total = ? AND evidence_maturity_total = ? AND expires_at = ? AND analyzed_at = ? AND watch_id > ?)
      )`);
      bindings.push(
        importance,
        importance, maturity,
        importance, maturity, expiresAt,
        importance, maturity, expiresAt, analyzedAt,
        importance, maturity, expiresAt, analyzedAt, watchId,
      );
    }
    const sql = `SELECT * FROM catalyst_watch
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY importance_total DESC, evidence_maturity_total ASC,
               expires_at ASC, analyzed_at DESC, watch_id ASC
      LIMIT ?`;
    const rows = opened.db.prepare(sql).all(...bindings, normalized.limit + 1);
    const hasMore = rows.length > normalized.limit;
    const page = hasMore ? rows.slice(0, normalized.limit) : rows;
    return {
      items: page.map((row) => listRow(row, nowIso)),
      nextCursor: hasMore
        ? encodeCursor(page.at(-1), filterHash, opened.live.watermark)
        : null,
      limit: normalized.limit,
      asOfWatermark: opened.live.watermark,
      projectionStatus: "COMPLETE",
    };
  } finally {
    opened.db.close();
  }
}

function detailRow(row, stateHistory, nowIso) {
  return {
    ...listRow(row, nowIso),
    screeningAttemptId: row.screening_attempt_id,
    screeningDecisionId: row.screening_decision_id,
    exposureId: row.exposure_id,
    decisionContextId: row.decision_context_id,
    sourceItemId: row.source_item_id,
    sourceRefs: parseJson(row.source_refs_json, "sourceRefs"),
    evidenceRefs: parseJson(row.evidence_refs_json, "evidenceRefs"),
    ingestedAt: row.ingested_at,
    stateHeadId: row.state_head_id,
    policyVersion: row.policy_version,
    promptVersion: row.prompt_version,
    modelVersion: row.model_version,
    createdAt: row.created_at,
    stateHistory,
  };
}

export async function queryCatalystWatchDetail(params = {}) {
  const watchId = boundedOptional(params.watchId, "watchId", 100);
  if (!watchId || !/^cwt_[0-9a-f]{64}$/.test(watchId)) {
    fail("INVALID_PARAMS", "watchId is invalid");
  }
  const asOfWatermark = normalizedWatermark(params.asOfWatermark);
  const nowIso = normalizedTime(params.now);
  const opened = await openMatchingProjection({
    derivedRoot: params.derivedRoot,
    store: params.store,
    now: params.now,
    asOfWatermark,
  });
  try {
    const row = opened.db
      .prepare("SELECT * FROM catalyst_watch WHERE watch_id = ?")
      .get(watchId);
    if (!row) fail("NOT_FOUND", "catalyst watch not found");
    const stateHistory = opened.db
      .prepare(
        `SELECT event_id, from_state, to_state, reason_code, state_sequence,
                transitioned_at, formal_screening_decision_id
         FROM catalyst_watch_events
         WHERE watch_id = ?
         ORDER BY state_sequence ASC`,
      )
      .all(watchId)
      .map((event) => ({
        eventId: event.event_id,
        fromState: event.from_state,
        toState: event.to_state,
        reasonCode: event.reason_code,
        stateSequence: event.state_sequence,
        transitionedAt: event.transitioned_at,
        formalScreeningDecisionId: event.formal_screening_decision_id,
      }));
    return {
      ...detailRow(row, stateHistory, nowIso),
      asOfWatermark: opened.live.watermark,
      projectionStatus: "COMPLETE",
    };
  } finally {
    opened.db.close();
  }
}

export async function queryCatalystAuditOverview(params = {}) {
  const asOfWatermark = normalizedWatermark(params.asOfWatermark);
  const opened = await openMatchingProjection({
    derivedRoot: params.derivedRoot,
    store: params.store,
    now: params.now,
    asOfWatermark,
    // An internal caller may share its verified snapshot, never a caller-supplied
    // RPC value. openFreshProjectionDb still checks all frozen projection gates.
    live: params.live,
  });
  try {
    const metrics = Object.fromEntries(
      opened.db
        .prepare("SELECT metric, value FROM catalyst_audit_metrics ORDER BY metric")
        .all()
        .map((row) => [row.metric, row.value]),
    );
    const required = [
      "sourceItems",
      "screeningCompleted",
      "rejected",
      "watchCatalysts",
      "discarded",
      "unknownRejectDisposition",
      "formalPublished",
      "linkedExisting",
      "deduplicatedVariables",
      "formalCards",
    ];
    if (required.some((key) => !Number.isSafeInteger(metrics[key]))) {
      fail("PROJECTION_STALE", "catalyst audit projection is incomplete");
    }
    return {
      funnel: {
        allSources: metrics.sourceItems,
        formalCards: metrics.formalCards,
        watchCatalysts: metrics.watchCatalysts,
        discarded: metrics.discarded,
      },
      screening: {
        completed: metrics.screeningCompleted,
        rejected: metrics.rejected,
        formalPublished: metrics.formalPublished,
        linkedExisting: metrics.linkedExisting,
        deduplicatedVariables: metrics.deduplicatedVariables,
        unknownRejectDisposition: metrics.unknownRejectDisposition,
      },
      asOfWatermark: opened.live.watermark,
      projectionStatus: "COMPLETE",
    };
  } finally {
    opened.db.close();
  }
}

export async function queryCatalystSourceList(params = {}) {
  const normalized = normalizeSourceListParams(params);
  const nowIso = normalizedTime(params.now);
  const opened = await openMatchingProjection({
    derivedRoot: params.derivedRoot,
    store: params.store,
    now: params.now,
    asOfWatermark: normalized.asOfWatermark,
  });
  try {
    const filterHash = canonicalHash({
      source: normalized.source,
      archetype: normalized.archetype,
      status: normalized.status,
      freshness: normalized.freshness,
    });
    const cursor = decodeSourceCursor(
      params.cursor,
      filterHash,
      opened.live.watermark,
    );
    const where = [];
    const bindings = [];
    if (normalized.source) {
      where.push("(source_namespace = ? OR source_type = ?)");
      bindings.push(normalized.source, normalized.source);
    }
    if (normalized.status) {
      where.push("screening_status = ?");
      bindings.push(normalized.status);
    }
    if (normalized.archetype) {
      where.push(
        "EXISTS (SELECT 1 FROM catalyst_watch cw WHERE cw.source_item_id = source_items.source_item_id AND cw.catalyst_archetype = ?)",
      );
      bindings.push(normalized.archetype);
    }
    if (normalized.freshness === "FRESH") {
      where.push("available_at >= ? AND available_at <= ?");
      bindings.push(
        new Date(Date.parse(nowIso) - SOURCE_FRESH_WINDOW_MS).toISOString(),
        nowIso,
      );
    } else if (normalized.freshness === "STALE") {
      where.push("available_at < ?");
      bindings.push(new Date(Date.parse(nowIso) - SOURCE_FRESH_WINDOW_MS).toISOString());
    }
    if (cursor) {
      const [availableAt, sourceItemId] = cursor;
      where.push("(available_at < ? OR (available_at = ? AND source_item_id > ?))");
      bindings.push(availableAt, availableAt, sourceItemId);
    }
    const rows = opened.db.prepare(`
      SELECT * FROM source_items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY available_at DESC, source_item_id ASC
      LIMIT ?
    `).all(...bindings, normalized.limit + 1);
    const hasMore = rows.length > normalized.limit;
    const page = hasMore ? rows.slice(0, normalized.limit) : rows;
    return {
      items: page.map((row) => sourceListRow(row, nowIso)),
      nextCursor: hasMore
        ? encodeSourceCursor(page.at(-1), filterHash, opened.live.watermark)
        : null,
      limit: normalized.limit,
      asOfWatermark: opened.live.watermark,
      projectionStatus: "COMPLETE",
    };
  } finally {
    opened.db.close();
  }
}
