// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeLedgerWatermark } from "../http/query.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { JsonlStore } from "../ledger/jsonl-store.mjs";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { assertWindowsPrivateTree, validatePrivateWindowsMode, writeWindowsPrivateJson,
  invalidWindowsPrivateState, windowsPrivateDirectory } from "../runtime/windows-private-files.mjs";
import { projectCatalystWatch } from "../watch/projection.mjs";
import { fail, ResearchError } from "./errors.mjs";
import { readActiveManifest } from "./snapshot-store.mjs";
import { buildCaseTimelines } from "./timeline.mjs";

export const PROJECTION_SCHEMA_VERSION = "research-projection-v4";
export const PROJECTION_BUILDER_VERSION = "research-projection-v4";

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE projection_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE cases (
  case_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  mapping_review TEXT NOT NULL,
  watch_state TEXT,
  search_text TEXT NOT NULL
);
CREATE TABLE timeline_nodes (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  time_precision TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_channel TEXT,
  result_visibility TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  horizon TEXT,
  state TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);
CREATE INDEX timeline_case_ordinal ON timeline_nodes(case_id, ordinal);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  access_level TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE mapping_review (
  id INTEGER PRIMARY KEY,
  case_id TEXT,
  card_revision_id TEXT,
  target_id TEXT,
  target_type TEXT,
  review TEXT NOT NULL,
  security_code TEXT
);
CREATE TABLE watch_state (
  id INTEGER PRIMARY KEY,
  case_id TEXT,
  card_revision_id TEXT,
  task_id TEXT,
  state TEXT,
  review_due_at TEXT,
  horizon TEXT
);
CREATE TABLE source_items (
  source_item_id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  source_document_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  declared_published_at TEXT,
  first_retrieved_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  source_time_confidence TEXT NOT NULL,
  screening_status TEXT NOT NULL,
  screening_decision TEXT,
  reject_disposition TEXT,
  screening_decision_id TEXT,
  card_revision_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX source_items_order ON source_items(available_at DESC, source_item_id ASC);
CREATE INDEX source_items_filters ON source_items(source_namespace, source_type, screening_status);
CREATE TABLE catalyst_watch (
  watch_id TEXT PRIMARY KEY,
  screening_attempt_id TEXT NOT NULL,
  screening_decision_id TEXT NOT NULL,
  exposure_id TEXT NOT NULL,
  decision_context_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  event_time TEXT NOT NULL,
  source_available_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  source_cutoff TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  catalyst_archetype TEXT NOT NULL,
  expected_horizon TEXT NOT NULL,
  importance_json TEXT NOT NULL,
  importance_total REAL NOT NULL,
  evidence_maturity_json TEXT NOT NULL,
  evidence_maturity_total REAL NOT NULL,
  missing_evidence_json TEXT NOT NULL,
  verification_plan_json TEXT NOT NULL,
  invalidation_conditions_json TEXT NOT NULL,
  status TEXT NOT NULL,
  state_head_id TEXT NOT NULL,
  state_sequence INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX catalyst_watch_priority ON catalyst_watch(
  importance_total DESC,
  evidence_maturity_total ASC,
  expires_at ASC,
  analyzed_at DESC,
  watch_id ASC
);
CREATE INDEX catalyst_watch_filters ON catalyst_watch(
  status,
  source_namespace,
  catalyst_archetype,
  expires_at
);
CREATE TABLE catalyst_watch_events (
  event_id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  state_sequence INTEGER NOT NULL,
  transitioned_at TEXT NOT NULL,
  formal_screening_decision_id TEXT,
  FOREIGN KEY (watch_id) REFERENCES catalyst_watch(watch_id)
);
CREATE INDEX catalyst_watch_event_sequence ON catalyst_watch_events(
  watch_id,
  state_sequence
);
CREATE TABLE catalyst_audit_metrics (
  metric TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE market_observations (
  security_code TEXT NOT NULL,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  open_px REAL,
  high_px REAL,
  low_px REAL,
  close_px REAL,
  volume REAL,
  turnover REAL,
  PRIMARY KEY (security_code, session_date)
);
CREATE VIRTUAL TABLE search_fts USING fts5(
  case_id,
  title,
  summary,
  evidence_summary,
  tokenize = 'unicode61'
);
`;

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function writeJsonAtomic(file, value, privateWindows) {
  if (privateWindows) return writeWindowsPrivateJson(file, value, { atomic: true });
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function crashIf(crashAfter, label) {
  if (crashAfter === label) {
    fail("INJECTED_CRASH", `injected crash after ${label}`);
  }
}

function projectionRootOf(derivedRoot) {
  return path.join(derivedRoot, "projection");
}

export function logicalProjectionPayload({
  snapshot,
  timelines,
  evidenceRecords,
  ledgerWatermark,
  sourceItems,
  catalystWatch,
}) {
  return {
    schema: PROJECTION_SCHEMA_VERSION,
    builderVersion: PROJECTION_BUILDER_VERSION,
    snapshotId: snapshot.id,
    ledgerWatermark,
    sourceWatermarks: snapshot.watermarks || {},
    market: {
      status: snapshot.market?.status || "UNKNOWN",
      cutoff: snapshot.market?.cutoff || null,
      reasonCode: snapshot.market?.reasonCode || null,
      observations: (snapshot.market?.observations || []).map((row) => ({
        securityCode: row.securityCode,
        sessionDate: row.sessionDate,
        status: row.status,
        reasonCode: row.reasonCode || null,
        close: row.bar?.close ?? null,
      })),
    },
    cases: timelines.map((row) => ({
      caseId: row.caseId,
      title: row.title,
      kind: row.kind,
      mappingReview: row.mappingReview,
      watch: row.watch,
      nodes: row.nodes,
    })),
    evidence: [...(evidenceRecords || [])]
      .map((row) => ({
        id: row.id,
        sourcePath: row.sourcePath,
        sha256: row.sha256,
        lineNumber: row.lineNumber,
        accessLevel: row.accessLevel,
        summary: row.summary,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    sourceItems: [...(sourceItems || [])]
      .map((row) => ({
        id: row.id,
        sourceNamespace: row.sourceNamespace,
        sourceDocumentKey: row.sourceDocumentKey,
        sourceKind: row.sourceKind,
        contentHash: row.contentHash,
        declaredPublishedAt: row.declaredPublishedAt || null,
        firstRetrievedAt: row.firstRetrievedAt,
        availableAt: row.availableAt,
        sourceTimeConfidence: row.sourceTimeConfidence,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    catalystWatch: catalystWatch || { rows: [], metrics: {} },
  };
}

function indexSourceOutcomes(events) {
  const index = {
    exposure: new Map(), decision: new Map(), watch: new Map(),
    opportunity: new Map(), card: new Map(),
  };
  const kinds = new Map([
    ["scan-exposure-v1", [index.exposure, "sourceItemId"]],
    ["screening-decision-v1", [index.decision, "scanExposureId"]],
    ["catalyst-watch-v1", [index.watch, "exposureId"]],
    ["opportunity-v1", [index.opportunity, "triggerScanExposureId"]],
    ["variable-card-revision-v1", [index.card, "opportunityId"]],
  ]);
  for (const row of events) {
    const kind = kinds.get(row?.schema);
    if (!kind) continue;
    const [latest, field] = kind, key = row[field], previous = latest.get(key);
    // Exactly the original localeCompare ordering. Equal-time replacement
    // preserves stable sort(...).at(-1): last occurrence in ledger order wins.
    if (!previous || String(row.createdAt || "").localeCompare(String(previous.createdAt || "")) >= 0) {
      latest.set(key, row);
    }
  }
  return index;
}

function sourceOutcome(source, index) {
  const exposure = index.exposure.get(source.id) || null;
  const decision = exposure ? index.decision.get(exposure.id) || null : null;
  const watch = exposure ? index.watch.get(exposure.id) || null : null;
  const opportunity = exposure ? index.opportunity.get(exposure.id) || null : null;
  const card = opportunity ? index.card.get(opportunity.id) || null : null;
  let screeningStatus = "UNREVIEWED";
  if (
    decision?.decision === "LINK_TO_EXISTING" ||
    (decision?.decision === "CREATE_CARD" && card)
  ) screeningStatus = "FORMAL";
  else if (decision?.decision === "REJECT" && (watch || decision.rejectDisposition === "WATCH_CATALYST")) screeningStatus = "WATCH";
  else if (decision?.decision === "REJECT" && decision.rejectDisposition === "DISCARD") screeningStatus = "DISCARDED";
  else if (decision) screeningStatus = "FAILED";
  return {
    screeningStatus,
    screeningDecision: decision?.decision || null,
    rejectDisposition: decision?.rejectDisposition || null,
    screeningDecisionId: decision?.id || null,
    cardRevisionId: card?.id || null,
  };
}

/** Internal deterministic projection transform, also used by parity/performance tests. */
export function sourceRows(sourceItems, events) {
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) return [];
  const index = indexSourceOutcomes(events);
  return sourceItems.map((source) => ({
    ...source,
    ...sourceOutcome(source, index),
  }));
}

export function searchProjection(db, query) {
  const rows = db
    .prepare(
      "SELECT DISTINCT case_id FROM search_fts WHERE search_fts MATCH ? ORDER BY case_id",
    )
    .all(query);
  return rows.map((row) => row.case_id);
}

function integrityOk(db) {
  const row = db.prepare("PRAGMA integrity_check").get();
  const value = row ? row.integrity_check || row.Integrity_check : null;
  return value === "ok";
}

function writeMeta(db, meta) {
  const stmt = db.prepare(
    "INSERT INTO projection_meta(key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(meta)) {
    stmt.run(key, JSON.stringify(value));
  }
}

export function readProjectionMeta(db) {
  const rows = db.prepare("SELECT key, value FROM projection_meta").all();
  const meta = {};
  for (const row of rows) {
    meta[row.key] = JSON.parse(row.value);
  }
  return meta;
}

function populate(db, {
  snapshot,
  timelines,
  evidenceRecords,
  ledgerWatermark,
  sourceItems,
  events,
  catalystWatch,
  digest,
  now,
}) {
  db.exec(SCHEMA_SQL);
  const insertCase = db.prepare(
    `INSERT INTO cases(case_id, title, kind, node_count, mapping_review, watch_state, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNode = db.prepare(
    `INSERT INTO timeline_nodes(
       id, case_id, node_type, title, summary, event_at, available_at, recorded_at,
       time_precision, evidence_level, source_type, source_channel, result_visibility,
       evidence_ids_json, horizon, state, ordinal
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvidence = db.prepare(
    `INSERT INTO evidence(id, source_path, sha256, line_number, access_level, summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMapping = db.prepare(
    `INSERT INTO mapping_review(case_id, card_revision_id, target_id, target_type, review, security_code)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertWatch = db.prepare(
    `INSERT INTO watch_state(case_id, card_revision_id, task_id, state, review_due_at, horizon)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO source_items(
       source_item_id, source_namespace, source_document_key, source_type,
       content_hash, declared_published_at, first_retrieved_at, available_at,
       source_time_confidence, screening_status, screening_decision,
       reject_disposition, screening_decision_id, card_revision_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertObs = db.prepare(
    `INSERT INTO market_observations(
       security_code, session_date, status, reason_code, open_px, high_px, low_px, close_px, volume, turnover
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCatalystWatch = db.prepare(
    `INSERT INTO catalyst_watch(
       watch_id, screening_attempt_id, screening_decision_id, exposure_id,
       decision_context_id, source_item_id, source_namespace, source_type,
       source_refs_json, evidence_refs_json, event_time, source_available_at,
       ingested_at, analyzed_at, source_cutoff, expires_at, catalyst_archetype,
       expected_horizon, importance_json, importance_total,
       evidence_maturity_json, evidence_maturity_total, missing_evidence_json,
       verification_plan_json, invalidation_conditions_json, status,
       state_head_id, state_sequence, policy_version, prompt_version,
       model_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCatalystWatchEvent = db.prepare(
    `INSERT INTO catalyst_watch_events(
       event_id, watch_id, from_state, to_state, reason_code, state_sequence,
       transitioned_at, formal_screening_decision_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCatalystMetric = db.prepare(
    "INSERT INTO catalyst_audit_metrics(metric, value) VALUES (?, ?)",
  );
  const insertFts = db.prepare(
    `INSERT INTO search_fts(case_id, title, summary, evidence_summary) VALUES (?, ?, ?, ?)`,
  );

  const evidenceById = new Map((evidenceRecords || []).map((row) => [row.id, row]));
  for (const row of evidenceRecords || []) {
    insertEvidence.run(
      row.id,
      row.sourcePath,
      row.sha256,
      row.lineNumber,
      row.accessLevel,
      row.summary,
    );
  }

  for (const row of sourceRows(sourceItems, events || [])) {
    insertSource.run(
      row.id,
      row.sourceNamespace,
      row.sourceDocumentKey,
      row.sourceKind,
      row.contentHash,
      row.declaredPublishedAt || null,
      row.firstRetrievedAt,
      row.availableAt,
      row.sourceTimeConfidence,
      row.screeningStatus,
      row.screeningDecision,
      row.rejectDisposition,
      row.screeningDecisionId,
      row.cardRevisionId,
      row.createdAt,
    );
  }

  for (const timeline of timelines) {
    const searchText = [
      timeline.title,
      timeline.caseId,
      ...timeline.nodes.map((node) => `${node.title} ${node.summary}`),
    ].join(" ");
    insertCase.run(
      timeline.caseId,
      timeline.title,
      timeline.kind,
      timeline.nodes.length,
      timeline.mappingReview,
      timeline.watch ? timeline.watch.state : null,
      searchText,
    );
    timeline.nodes.forEach((node, ordinal) => {
      insertNode.run(
        node.id,
        node.caseId,
        node.nodeType,
        node.title,
        node.summary,
        node.eventAt,
        node.availableAt,
        node.recordedAt,
        node.timePrecision,
        node.evidenceLevel,
        node.sourceType,
        node.sourceChannel,
        node.resultVisibility,
        JSON.stringify(node.evidenceIds),
        node.horizon,
        node.state,
        ordinal,
      );
    });
    const evidenceSummaries = [];
    for (const node of timeline.nodes) {
      for (const evidenceId of node.evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        if (evidence) {
          evidenceSummaries.push(evidence.summary);
        }
      }
    }
    insertFts.run(
      timeline.caseId,
      timeline.title,
      timeline.nodes.map((node) => node.summary).join("\n"),
      evidenceSummaries.join("\n"),
    );
    for (const row of timeline.mappingRows || []) {
      insertMapping.run(
        row.caseId,
        row.cardRevisionId,
        row.targetId,
        row.targetType,
        row.review,
        row.securityCode,
      );
    }
    for (const row of timeline.watchRows || []) {
      insertWatch.run(
        row.caseId,
        row.cardRevisionId,
        row.taskId,
        row.state,
        row.reviewDueAt,
        row.horizon,
      );
    }
  }

  for (const row of snapshot.market?.observations || []) {
    insertObs.run(
      row.securityCode,
      row.sessionDate,
      row.status,
      row.reasonCode || null,
      row.bar?.open ?? null,
      row.bar?.high ?? null,
      row.bar?.low ?? null,
      row.bar?.close ?? null,
      row.bar?.volume ?? null,
      row.bar?.turnover ?? null,
    );
  }

  for (const row of catalystWatch?.rows || []) {
    insertCatalystWatch.run(
      row.watchId,
      row.screeningAttemptId,
      row.screeningDecisionId,
      row.exposureId,
      row.decisionContextId,
      row.sourceItemId,
      row.sourceNamespace,
      row.sourceType,
      JSON.stringify(row.sourceRefs),
      JSON.stringify(row.evidenceRefs),
      row.eventTime,
      row.sourceAvailableAt,
      row.ingestedAt,
      row.analyzedAt,
      row.sourceCutoff,
      row.expiresAt,
      row.catalystArchetype,
      row.expectedHorizon,
      JSON.stringify(row.importance),
      row.importance.totalScore,
      JSON.stringify(row.evidenceMaturity),
      row.evidenceMaturity.totalScore,
      JSON.stringify(row.missingEvidence),
      JSON.stringify(row.verificationPlan),
      JSON.stringify(row.invalidationConditions),
      row.status,
      row.stateHeadId,
      row.stateSequence,
      row.policyVersion,
      row.promptVersion,
      row.modelVersion,
      row.createdAt,
    );
    for (const event of row.stateEvents) {
      insertCatalystWatchEvent.run(
        event.eventId,
        row.watchId,
        event.fromState,
        event.toState,
        event.reasonCode,
        event.stateSequence,
        event.transitionedAt,
        event.formalScreeningDecisionId,
      );
    }
  }
  for (const [metric, value] of Object.entries(catalystWatch?.metrics || {})) {
    insertCatalystMetric.run(metric, value);
  }

  writeMeta(db, {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    builderVersion: PROJECTION_BUILDER_VERSION,
    snapshotId: snapshot.id,
    snapshotSchema: snapshot.schema,
    snapshotBuilderVersion: snapshot.builderVersion,
    snapshotCreatedAt: snapshot.createdAt,
    sourceWatermarks: snapshot.watermarks || {},
    ledgerWatermark,
    marketCutoff: snapshot.market?.cutoff || null,
    marketStatus: snapshot.market?.status || "UNKNOWN",
    marketReasonCode: snapshot.market?.reasonCode || null,
    projectionDigest: digest,
    buildStatus: "COMPLETE",
    builtAt: now,
  });
}

export async function readActiveProjectionManifest(derivedRoot) {
  try {
    const raw = await fs.readFile(
      path.join(projectionRootOf(derivedRoot), "active.json"),
      "utf8",
    );
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function loadActiveSnapshot(derivedRoot, privateWindows) {
  const manifest = await readActiveManifest(derivedRoot);
  if (!manifest || manifest.status !== "COMPLETE") {
    fail("SNAPSHOT_NOT_COMPLETE", "no complete research snapshot is active");
  }
  if (privateWindows && (!/^rsnap_[a-f0-9]{64}$/.test(manifest.snapshotId) ||
    manifest.snapshotPath !== path.join(derivedRoot, "snapshots", manifest.snapshotId, "snapshot.json"))) {
    invalidWindowsPrivateState();
  }
  const snapshotPath = manifest.snapshotPath;
  const evidencePath = path.join(path.dirname(snapshotPath), "evidence.json");
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const evidenceRecords = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  return { manifest, snapshot, evidenceRecords };
}

async function projectLedger({ ledgerRoot, store, now }) {
  const selectedStore = store || new JsonlStore({ root: ledgerRoot });
  const runtime = new CommandRuntime({ store: selectedStore, now: () => now });
  return runtime.project();
}

export async function rebuildResearchProjection({
  derivedRoot,
  ledgerRoot,
  store,
  now,
  crashAfter = null,
  privateWindows = false,
} = {}) {
  let previous = privateWindows === false ? await readActiveProjectionManifest(derivedRoot) : null;
  try {
    validatePrivateWindowsMode(privateWindows);
    if (!derivedRoot) {
      fail("DERIVED_ROOT_MISSING", "derivedRoot required");
    }
    if (!store && !ledgerRoot) {
      fail("LEDGER_ROOT_MISSING", "ledgerRoot required");
    }
    if (privateWindows) {
      await assertWindowsPrivateTree(derivedRoot);
      previous = await readActiveProjectionManifest(derivedRoot);
    }
    const { snapshot, evidenceRecords } = await loadActiveSnapshot(derivedRoot, privateWindows);
    const projected = await projectLedger({ ledgerRoot, store, now });
    const ledgerWatermark = computeLedgerWatermark(projected);
    const catalystWatch = projectCatalystWatch(projected);
    const timelines = await buildCaseTimelines({
      snapshot,
      evidenceRecords,
      now,
      projected,
    });
    const payload = logicalProjectionPayload({
      snapshot,
      timelines,
      evidenceRecords,
      ledgerWatermark,
      sourceItems: projected.sourceItems,
      catalystWatch,
    });
    const digest = canonicalHash(payload);
    const root = projectionRootOf(derivedRoot);
    const completeDir = path.join(root, "complete");
    const finalDb = path.join(completeDir, `${digest}.sqlite`);
    if (privateWindows) {
      for (const directory of [root, completeDir, path.join(root, "tmp")]) await windowsPrivateDirectory(directory, { create: true });
    } else {
      await fs.mkdir(completeDir, { recursive: true });
      await fs.mkdir(path.join(root, "tmp"), { recursive: true });
    }

    if (!crashAfter && (await pathExists(finalDb))) {
      const existing = new DatabaseSync(privateWindows ? path.toNamespacedPath(finalDb) : finalDb, { readOnly: true });
      try {
        if (!integrityOk(existing)) {
          fail("PROJECTION_CORRUPT", "existing projection failed integrity_check");
        }
      } finally {
        existing.close();
      }
      const active = Object.freeze({
        schema: "research-projection-active-v1",
        snapshotId: snapshot.id,
        digest,
        dbPath: finalDb,
        status: "COMPLETE",
        activatedAt: now,
        ledgerWatermark,
      });
      await writeJsonAtomic(path.join(root, "active.json"), active, privateWindows);
      return {
        ok: true,
        status: "COMPLETE",
        digest,
        dbPath: finalDb,
        snapshotId: snapshot.id,
        ledgerWatermark,
        market: snapshot.market,
        active,
      };
    }

    const tmpDb = path.join(
      root,
      "tmp",
      `build-${process.pid}-${crypto.randomBytes(6).toString("hex")}.sqlite`,
    );
    const db = privateWindows
      ? (await import("../runtime/windows-private-database.mjs")).openWindowsPrivateDatabase(tmpDb)
      : new DatabaseSync(tmpDb);
    try {
      populate(db, {
        snapshot,
        timelines,
        evidenceRecords,
        ledgerWatermark,
        sourceItems: projected.sourceItems,
        events: projected.events,
        catalystWatch,
        digest,
        now,
      });
      if (!integrityOk(db)) {
        fail("PROJECTION_CORRUPT", "built projection failed integrity_check");
      }
      db.close();
    } catch (err) {
      try {
        db.close();
      } catch {
        // ignore close after failed populate
      }
      await fs.rm(tmpDb, { force: true });
      if (privateWindows) await fs.rm(`${tmpDb}-journal`, { force: true });
      throw err;
    }
    // An immutable projection has no writers after close. Its private PERSIST
    // journal must not be left under the temporary name when the DB is promoted.
    if (privateWindows) await fs.rm(`${tmpDb}-journal`, { force: true });
    crashIf(crashAfter, "checked");
    if (await pathExists(finalDb)) {
      await fs.rm(tmpDb, { force: true });
    } else {
      await fs.rename(tmpDb, finalDb);
    }
    crashIf(crashAfter, "promoted");
    const active = Object.freeze({
      schema: "research-projection-active-v1",
      snapshotId: snapshot.id,
      digest,
      dbPath: finalDb,
      status: "COMPLETE",
      activatedAt: now,
      ledgerWatermark,
    });
    await writeJsonAtomic(path.join(root, "active.json"), active, privateWindows);
    return {
      ok: true,
      status: "COMPLETE",
      digest,
      dbPath: finalDb,
      snapshotId: snapshot.id,
      ledgerWatermark,
      market: snapshot.market,
      active,
    };
  } catch (error) {
    return { ok: false, active: previous, error };
  }
}

function stale(message, details) {
  throw new ResearchError("PROJECTION_STALE", message, details);
}

export async function liveLedgerWatermark(store, now) {
  const runtime = new CommandRuntime({ store, now: () => now });
  const projected = await runtime.project();
  return {
    watermark: computeLedgerWatermark(projected),
    projected,
  };
}

function assertManifestMatchesSqlite(manifest, meta) {
  if (
    meta.schemaVersion !== PROJECTION_SCHEMA_VERSION ||
    meta.buildStatus !== "COMPLETE" ||
    !manifest ||
    manifest.status !== "COMPLETE" ||
    manifest.status !== meta.buildStatus ||
    manifest.snapshotId !== meta.snapshotId ||
    manifest.digest !== meta.projectionDigest
  ) {
    stale("projection manifest does not match sqlite metadata", {
      reason: "MANIFEST_MISMATCH",
    });
  }
}

function assertSnapshotMatchesProjection(snapshotManifest, meta) {
  if (
    !snapshotManifest ||
    snapshotManifest.status !== "COMPLETE" ||
    snapshotManifest.snapshotId !== meta.snapshotId
  ) {
    stale("projection snapshot does not match active research snapshot", {
      reason: "SNAPSHOT_MISMATCH",
    });
  }
}

export async function openFreshProjectionDb({ derivedRoot, store, now, live: suppliedLive }) {
  const manifest = await readActiveProjectionManifest(derivedRoot);
  if (!manifest || manifest.status !== "COMPLETE" || !manifest.dbPath) {
    stale("active projection is missing", { reason: "MISSING" });
  }
  if (!(await pathExists(manifest.dbPath))) {
    stale("active projection database is missing", {
      reason: "MISSING_DB",
    });
  }
  let db;
  try {
    db = new DatabaseSync(store?.privateWindows === true ? path.toNamespacedPath(manifest.dbPath) : manifest.dbPath,
      { readOnly: true });
  } catch (err) {
    stale("active projection database could not be opened", {
      reason: "CORRUPT",
    });
  }
  if (!integrityOk(db)) {
    db.close();
    stale("active projection failed integrity_check", {
      reason: "CORRUPT",
    });
  }
  const meta = readProjectionMeta(db);
  try {
    assertManifestMatchesSqlite(manifest, meta);
    const snapshotManifest = await readActiveManifest(derivedRoot);
    assertSnapshotMatchesProjection(snapshotManifest, meta);
    const live = suppliedLive || (await liveLedgerWatermark(store, now));
    if (live.watermark !== meta.ledgerWatermark) {
      stale("projection ledger watermark does not match the canonical ledger", {
        reason: "LEDGER_WATERMARK_MISMATCH",
      });
    }
    return { db, manifest, meta, live, projected: live.projected };
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function readProjectionHealth({
  researchRoot,
  ledgerRoot,
  store,
  now,
  live: suppliedLive,
}) {
  const empty = {
    snapshotId: null,
    projectionStatus: "MISSING",
    ledgerWatermark: null,
    projectionLedgerWatermark: null,
    watermarksConsistent: false,
    marketCutoff: null,
    marketStatus: null,
    projectionStale: true,
    projectionDigest: null,
  };
  try {
    if (!researchRoot || (!store && !ledgerRoot)) {
      return empty;
    }
    const selectedStore = store || new JsonlStore({ root: ledgerRoot });
    let live = suppliedLive;
    try {
      if (!live) {
        live = await liveLedgerWatermark(
          selectedStore,
          now || "1970-01-01T00:00:00+08:00",
        );
      }
    } catch {
      return {
        ...empty,
        projectionStatus: "PROJECTION_STALE",
      };
    }
    const manifest = await readActiveProjectionManifest(researchRoot);
    if (!manifest || !(await pathExists(manifest.dbPath))) {
      return {
        ...empty,
        ledgerWatermark: live.watermark,
        snapshotId: manifest ? manifest.snapshotId : null,
        projectionStatus: manifest ? "PROJECTION_STALE" : "MISSING",
      };
    }
    const db = new DatabaseSync(selectedStore.privateWindows === true ? path.toNamespacedPath(manifest.dbPath) : manifest.dbPath,
      { readOnly: true });
    try {
      if (!integrityOk(db)) {
        return {
          ...empty,
          ledgerWatermark: live.watermark,
          snapshotId: manifest.snapshotId,
          projectionStatus: "CORRUPT",
        };
      }
      const meta = readProjectionMeta(db);
      const snapshotManifest = await readActiveManifest(researchRoot);
      const metaOk =
        meta.schemaVersion === PROJECTION_SCHEMA_VERSION &&
        meta.buildStatus === "COMPLETE" &&
        manifest.status === "COMPLETE" &&
        manifest.status === meta.buildStatus &&
        manifest.snapshotId === meta.snapshotId &&
        manifest.digest === meta.projectionDigest;
      const snapshotOk =
        Boolean(snapshotManifest) &&
        snapshotManifest.status === "COMPLETE" &&
        snapshotManifest.snapshotId === meta.snapshotId;
      const ledgerOk = meta.ledgerWatermark === live.watermark;
      const consistent = metaOk && snapshotOk && ledgerOk;
      return {
        snapshotId: snapshotManifest?.snapshotId || meta.snapshotId || manifest.snapshotId,
        projectionStatus: consistent ? "COMPLETE" : "PROJECTION_STALE",
        ledgerWatermark: live.watermark,
        projectionLedgerWatermark: meta.ledgerWatermark,
        watermarksConsistent: consistent,
        marketCutoff: meta.marketCutoff ?? null,
        marketStatus: meta.marketStatus ?? null,
        projectionStale: !consistent,
        projectionDigest: meta.projectionDigest || manifest.digest,
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}
