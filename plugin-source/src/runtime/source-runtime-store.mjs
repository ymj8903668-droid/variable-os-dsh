// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { canonicalHash } from "../schema/canonical-json.mjs";
import { openWindowsPrivateDatabase } from "./windows-private-database.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DERIVED_DIR = ".local-demo";
export const DEFAULT_ANALYSIS_FAILURE_THRESHOLD = 3;
export const DEFAULT_ANALYSIS_COOLDOWN_SECONDS = 300;
export const DEFAULT_ANALYSIS_DAILY_TOKEN_LIMIT = 50_000_000;
const CYCLE_TIMING_KEYS = ["discoveryMs", "analysisMs", "publishMs", "projectionMs", "totalMs"];
const SHANGHAI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const SOURCE_RUNTIME_SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS runtime_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  poll_interval_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cursor_json TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_documents (
  document_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  source_namespace TEXT NOT NULL,
  source_document_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  raw_uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  declared_published_at TEXT,
  first_retrieved_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  model_use_allowed INTEGER NOT NULL,
  export_allowed INTEGER NOT NULL,
  access_scope_json TEXT NOT NULL,
  UNIQUE(connector_id, source_document_key, content_hash)
);
CREATE INDEX IF NOT EXISTS source_documents_content
  ON source_documents(source_namespace, content_hash);
CREATE TABLE IF NOT EXISTS work_items (
  job_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES source_documents(document_id),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(stage, input_hash)
);
CREATE INDEX IF NOT EXISTS work_items_claim
  ON work_items(stage, status, available_at, lease_until);
CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  enqueued_count INTEGER NOT NULL DEFAULT 0,
  analyzed_count INTEGER NOT NULL DEFAULT 0,
  published_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  timings_json TEXT
);
CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES work_items(job_id),
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS analysis_candidates (
  candidate_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES source_documents(document_id),
  analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(run_id),
  decision TEXT NOT NULL,
  title TEXT,
  analysis_json TEXT NOT NULL,
  analysis_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  ledger_card_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, analysis_hash)
);
CREATE TABLE IF NOT EXISTS worker_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureDerivedPath(target, allowedRoot = path.join(appRoot, DERIVED_DIR)) {
  if (typeof target !== "string" || !target ||
    typeof allowedRoot !== "string" || !path.isAbsolute(allowedRoot) || allowedRoot.includes("\0")) {
    throw runtimeError("RUNTIME_PATH_FORBIDDEN", "runtime database path required");
  }
  const resolved = path.resolve(target);
  const relative = path.relative(allowedRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    resolved.includes("\0")
  ) {
    throw runtimeError(
      "RUNTIME_PATH_FORBIDDEN",
      "runtime database must stay inside application derived data",
    );
  }
  return resolved;
}

export function parseJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeCycleTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(CYCLE_TIMING_KEYS.map((key) => {
    if (value[key] === null || value[key] === undefined || value[key] === "") return [key, null];
    const number = Number(value[key]);
    return [key, Number.isFinite(number) && number >= 0 ? Math.round(number) : null];
  }));
}

export function isoAfter(now, seconds) {
  const millis = Date.parse(now);
  if (!Number.isFinite(millis)) {
    throw runtimeError("RUNTIME_TIME_INVALID", "valid RFC3339 time required");
  }
  return new Date(millis + seconds * 1000).toISOString();
}

export function shanghaiDate(now) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) {
    throw runtimeError("RUNTIME_TIME_INVALID", "valid RFC3339 time required");
  }
  const values = {};
  for (const part of SHANGHAI_DAY.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

export function rowWork(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    stage: row.stage,
    documentId: row.document_id,
    inputHash: row.input_hash,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastErrorCode: row.last_error_code,
    document: row.source_document_key
      ? {
          connectorId: row.connector_id,
          sourceNamespace: row.source_namespace,
          sourceDocumentKey: row.source_document_key,
          sourceKind: row.source_kind,
          rawUri: row.raw_uri,
          contentHash: row.content_hash,
          excerpt: row.excerpt,
          lineStart: row.line_start,
          lineEnd: row.line_end,
          declaredPublishedAt: row.declared_published_at,
          firstRetrievedAt: row.first_retrieved_at,
          sensitivity: row.sensitivity,
          modelUseAllowed: Boolean(row.model_use_allowed),
          exportAllowed: Boolean(row.export_allowed),
          accessScope: parseJson(row.access_scope_json, []),
        }
      : null,
  };
}

export function defaultSourceRuntimeRoot(root = appRoot) {
  return path.join(root, DERIVED_DIR, "runtime");
}

export function defaultSourceRuntimeDb(root = appRoot) {
  return path.join(defaultSourceRuntimeRoot(root), "runtime.sqlite");
}

export function sourceRuntimeFreezePath(dbPath = defaultSourceRuntimeDb()) {
  if (typeof dbPath !== "string" || !path.isAbsolute(dbPath)) {
    throw runtimeError("RUNTIME_PATH_INVALID", "absolute runtime path required");
  }
  return `${dbPath}.postgres-freeze`;
}

function assertSourceRuntimeWritable(dbPath) {
  try { fs.lstatSync(sourceRuntimeFreezePath(dbPath)); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw runtimeError("SOURCE_RUNTIME_AUTHORITY_UNAVAILABLE", "source runtime authority cannot be verified");
  }
  throw runtimeError("SOURCE_RUNTIME_FROZEN", "SQLite source authority is frozen");
}

export function validateConnectorDisable(id,now) {
  if(typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)||
    typeof now!=="string"||!Number.isFinite(Date.parse(now)))
    throw runtimeError("CONNECTOR_DISABLE_INVALID","connector disable request is invalid");
}

export function connectorPolicyRestrictions(connector) {
  // Metadata-only registration remains compatible; declared policy can only revoke.
  const denyModel = Object.hasOwn(connector, "modelUseAllowed") && connector.modelUseAllowed !== true;
  const denyExport = denyModel ||
    Object.hasOwn(connector, "exportAllowed") && connector.exportAllowed !== true ||
    Object.hasOwn(connector, "sensitivity") && connector.sensitivity !== "PUBLIC" ||
    Object.hasOwn(connector, "accessScope") && (!Array.isArray(connector.accessScope) ||
      connector.accessScope.length !== 1 || connector.accessScope[0] !== "public");
  return { denyModel, denyExport };
}

export class SourceRuntimeStore {
  constructor({ dbPath = defaultSourceRuntimeDb(), derivedRoot, privateWindows = false } = {}) {
    if (typeof privateWindows !== "boolean") {
      throw runtimeError("RUNTIME_PRIVATE_MODE_INVALID", "privateWindows must be an explicit boolean");
    }
    this.dbPath = ensureDerivedPath(dbPath, derivedRoot);
    assertSourceRuntimeWritable(this.dbPath);
    if (!privateWindows) fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = privateWindows ? openWindowsPrivateDatabase(this.dbPath) : new DatabaseSync(this.dbPath);
    try {
      if (!privateWindows) this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec(SOURCE_RUNTIME_SQLITE_SCHEMA);
      const ingestColumns = this.db.prepare("PRAGMA table_info(ingest_runs)").all();
      if (!ingestColumns.some((column) => column.name === "timings_json")) {
        this.db.exec("ALTER TABLE ingest_runs ADD COLUMN timings_json TEXT");
      }
      this.db
        .prepare("INSERT OR REPLACE INTO runtime_meta(key, value) VALUES (?, ?)")
        .run("schemaVersion", JSON.stringify("source-runtime-v1"));
    } catch (error) {
      try { this.db.close(); } finally { throw error; }
    }
  }

  close() {
    this.db.close();
  }

  registerConnector(connector, now) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!connector || typeof connector.id !== "string" || !connector.id) {
      throw runtimeError("CONNECTOR_INVALID", "connector id required");
    }
    const { denyModel, denyExport } = connectorPolicyRestrictions(connector);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO connectors(
           id, source_namespace, source_kind, adapter_version,
           poll_interval_seconds, enabled, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_namespace = excluded.source_namespace,
           source_kind = excluded.source_kind,
           adapter_version = excluded.adapter_version,
           poll_interval_seconds = excluded.poll_interval_seconds,
           updated_at = excluded.updated_at`,
      )
      .run(
        connector.id,
        connector.sourceNamespace,
        connector.sourceKind,
        connector.adapterVersion,
        connector.pollIntervalSeconds,
        now,
      );
      if (denyExport) this.db.prepare(`UPDATE source_documents
        SET export_allowed=0,model_use_allowed=CASE WHEN ? THEN 0 ELSE model_use_allowed END
        WHERE connector_id=? AND (export_allowed<>0 OR (? AND model_use_allowed<>0))`)
        .run(denyModel ? 1 : 0, connector.id, denyModel ? 1 : 0);
      const enabled = this.db.prepare("SELECT enabled FROM connectors WHERE id=?").get(connector.id)?.enabled === 1;
      this.db.exec("COMMIT");
      return { enabled };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  disableConnector(id, {now} = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    validateConnectorDisable(id,now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed=this.db.prepare(`UPDATE connectors SET enabled=0,
        updated_at=CASE WHEN enabled=0 THEN updated_at ELSE ? END WHERE id=?`).run(now,id);
      if(changed.changes){
        this.db.prepare(`UPDATE source_documents SET model_use_allowed=0,export_allowed=0
          WHERE connector_id=? AND (model_use_allowed<>0 OR export_allowed<>0)`).run(id);
        this.db.prepare(`UPDATE work_items SET status='FAILED',lease_owner=NULL,lease_until=NULL,
          last_error_code='CONNECTOR_DISABLED',updated_at=? WHERE status IN ('PENDING','RETRY','RUNNING')
          AND document_id IN (SELECT document_id FROM source_documents WHERE connector_id=?)`).run(now,id);
      }
      this.db.exec("COMMIT");
      return {status:changed.changes?"DISABLED":"NOT_FOUND"};
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }

  beginIngestRun({ runId, startedAt }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!runId || !startedAt) {
      throw runtimeError("INGEST_RUN_INVALID", "run id and start time required");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ingest_runs(run_id, started_at, status)
         VALUES (?, ?, 'RUNNING')`,
      )
      .run(runId, startedAt);
    return { runId, status: "RUNNING" };
  }

  finishIngestRun({
    runId,
    completedAt,
    status,
    discoveredCount = 0,
    enqueuedCount = 0,
    analyzedCount = 0,
    publishedCount = 0,
    failedCount = 0,
    errorCode = null,
    timings = null,
  }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!runId || !completedAt || !["SUCCEEDED", "DEGRADED", "FAILED"].includes(status)) {
      throw runtimeError("INGEST_RUN_INVALID", "terminal ingest run fields invalid");
    }
    this.db
      .prepare(
        `UPDATE ingest_runs
         SET completed_at = ?, status = ?, discovered_count = ?,
             enqueued_count = ?, analyzed_count = ?, published_count = ?,
             failed_count = ?, error_code = ?, timings_json = ?
         WHERE run_id = ?`,
      )
      .run(
        completedAt,
        status,
        discoveredCount,
        enqueuedCount,
        analyzedCount,
        publishedCount,
        failedCount,
        errorCode,
        JSON.stringify(normalizeCycleTimings(timings)),
        runId,
      );
  }

  getConnectorCursor(id) {
    const row = this.db
      .prepare("SELECT cursor_json FROM connectors WHERE id = ?")
      .get(id);
    return parseJson(row?.cursor_json, null);
  }

  updateConnectorSuccess(id, { cursor, completedAt }) {
    assertSourceRuntimeWritable(this.dbPath);
    this.db
      .prepare(
        `UPDATE connectors
         SET cursor_json = ?, last_checked_at = ?, last_success_at = ?,
             last_error_code = NULL, last_error_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(cursor || null), completedAt, completedAt, completedAt, id);
  }

  updateConnectorError(id, { errorCode, completedAt }) {
    assertSourceRuntimeWritable(this.dbPath);
    this.db
      .prepare(
        `UPDATE connectors
         SET last_checked_at = ?, last_error_code = ?, last_error_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(completedAt, errorCode, completedAt, completedAt, id);
  }

  discoverDocument(document, { now, promptVersion, maxAttempts = 3 } = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    // Admission and policy writes must serialize with a concurrent disable.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result=this.#discoverDocument(document,{now,promptVersion,maxAttempts});
      this.db.exec("COMMIT");
      return result;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }

  #discoverDocument(document,{now,promptVersion,maxAttempts}) {
    if (!document || !/^[0-9a-f]{64}$/.test(document.contentHash || "")) {
      throw runtimeError("DOCUMENT_INVALID", "document contentHash must be SHA-256");
    }
    if(this.db.prepare("SELECT enabled FROM connectors WHERE id=?").get(document.connectorId)?.enabled!==1)
      throw runtimeError("CONNECTOR_DISABLED","connector is not active");
    // A parser correction is not new source material. Resolve only exact prior
    // identities from the same connector/file; preserve evidence and work history.
    for (const previous of document.previousIdentities || []) {
      const known = this.db.prepare(
        `SELECT document_id FROM source_documents
         WHERE connector_id = ? AND source_namespace = ? AND raw_uri = ?
           AND source_document_key = ? AND content_hash = ?`,
      ).get(document.connectorId, document.sourceNamespace, document.rawUri,
        previous.sourceDocumentKey, previous.contentHash);
      if (known) {
        this.db.prepare(`UPDATE source_documents
          SET sensitivity = ?, model_use_allowed = ?, export_allowed = ?, access_scope_json = ?
          WHERE document_id = ?`).run(
          document.sensitivity || "INTERNAL", document.modelUseAllowed ? 1 : 0,
          document.exportAllowed ? 1 : 0,
          JSON.stringify(Array.isArray(document.accessScope) ? document.accessScope : []),
          known.document_id,
        );
        return {
          documentId: known.document_id, isNewDocument: false, analysisEnqueued: false,
          jobId: null, inputHash: null,
        };
      }
    }
    const documentId = `sdoc_${canonicalHash({
      connectorId: document.connectorId,
      sourceDocumentKey: document.sourceDocumentKey,
      contentHash: document.contentHash,
    })}`;
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO source_documents(
           document_id, connector_id, source_namespace, source_document_key,
           source_kind, raw_uri, content_hash, excerpt, line_start, line_end,
           declared_published_at, first_retrieved_at, last_seen_at, sensitivity,
           model_use_allowed, export_allowed, access_scope_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        document.connectorId,
        document.sourceNamespace,
        document.sourceDocumentKey,
        document.sourceKind,
        document.rawUri,
        document.contentHash,
        String(document.excerpt || "").slice(0, 16_000),
        Number.isInteger(document.lineStart) ? document.lineStart : null,
        Number.isInteger(document.lineEnd) ? document.lineEnd : null,
        document.declaredPublishedAt || null,
        now,
        now,
        document.sensitivity || "INTERNAL",
        document.modelUseAllowed ? 1 : 0,
        document.exportAllowed ? 1 : 0,
        JSON.stringify(Array.isArray(document.accessScope) ? document.accessScope : []),
      ).changes;
    if (!inserted) {
      this.db
        .prepare(
          `UPDATE source_documents
           SET last_seen_at = ?, sensitivity = ?, model_use_allowed = ?,
               export_allowed = ?, access_scope_json = ?
           WHERE document_id = ?`,
        )
        .run(
          now,
          document.sensitivity || "INTERNAL",
          document.modelUseAllowed ? 1 : 0,
          document.exportAllowed ? 1 : 0,
          JSON.stringify(Array.isArray(document.accessScope) ? document.accessScope : []),
          documentId,
        );
    }
    const inputHash = canonicalHash({
      task: "EVIDENCE_CATALYST_ANALYSIS",
      sourceNamespace: document.sourceNamespace,
      contentHash: document.contentHash,
      promptVersion,
    });
    const jobId = `job_${canonicalHash({ stage: "ANALYZE", inputHash })}`;
    const alreadyAnalyzed = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM analysis_runs r
           JOIN work_items w ON w.job_id = r.job_id
           JOIN source_documents analyzed ON analyzed.document_id = w.document_id
           WHERE analyzed.source_namespace = ?
             AND analyzed.content_hash = ?
             AND r.status = 'SUCCEEDED'
           LIMIT 1`,
        )
        .get(document.sourceNamespace, document.contentHash),
    );
    const enqueued = alreadyAnalyzed
      ? 0
      : this.db
          .prepare(
            `INSERT OR IGNORE INTO work_items(
               job_id, stage, document_id, input_hash, status, attempts,
               max_attempts, available_at, created_at, updated_at
             ) VALUES (?, 'ANALYZE', ?, ?, 'PENDING', 0, ?, ?, ?, ?)`,
          )
          .run(jobId, documentId, inputHash, maxAttempts, now, now, now).changes;
    return {
      documentId,
      isNewDocument: Boolean(inserted),
      analysisEnqueued: Boolean(enqueued),
      jobId,
      inputHash,
    };
  }

  supersedeRedundantAnalysisWork({ now } = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    if (typeof now !== "string" || !now) {
      throw runtimeError("RUNTIME_TIME_INVALID", "supersede time required");
    }
    return this.db
      .prepare(
        `UPDATE work_items AS pending
         SET status = 'SUPERSEDED', lease_owner = NULL, lease_until = NULL,
             last_error_code = 'SUPERSEDED_BY_SUCCESS', updated_at = ?
         WHERE pending.stage = 'ANALYZE'
           AND pending.status IN ('PENDING', 'RETRY', 'FAILED')
           AND EXISTS (
             SELECT 1
             FROM analysis_runs r
             JOIN work_items completed ON completed.job_id = r.job_id
             WHERE completed.document_id = pending.document_id
               AND r.status = 'SUCCEEDED'
           )`,
      )
      .run(now).changes;
  }

  hasReadyWork({ stage, now }) {
    return Boolean(this.db.prepare(`SELECT 1 FROM work_items WHERE stage = ? AND attempts < max_attempts
      AND document_id IN (SELECT d.document_id FROM source_documents d JOIN connectors c ON c.id=d.connector_id WHERE c.enabled=1)
      AND julianday(available_at) <= julianday(?) AND (status IN ('PENDING','RETRY')
      OR (status = 'RUNNING' AND julianday(lease_until) <= julianday(?))) LIMIT 1`).get(stage, now, now));
  }

  ownsWork(job, now) {
    return Boolean(this.db.prepare(`SELECT 1 FROM work_items WHERE job_id = ? AND status = 'RUNNING'
      AND lease_owner = ? AND attempts = ? AND julianday(lease_until) > julianday(?)`)
      .get(job.jobId, job.leaseOwner, job.attempts, now));
  }

  ownsWorkerLease({ name, owner, now }) {
    return Boolean(this.db.prepare("SELECT 1 FROM worker_leases WHERE name = ? AND owner = ? AND julianday(lease_until) > julianday(?)")
      .get(name, owner, now));
  }

  claimWork({ stage, owner, now, leaseSeconds = 60, preferNewest = false, jobId = null } = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!stage || !owner) {
      throw runtimeError("WORK_CLAIM_INVALID", "stage and owner required");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Release expired ownership even when normal ordering does not select the
      // abandoned job. Preserve its attempt charge, retry time and prior error.
      this.db
        .prepare(
          `UPDATE work_items
           SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'RETRY' END,
               lease_owner = NULL, lease_until = NULL,
               last_error_code = COALESCE(last_error_code, 'WORK_LEASE_EXPIRED'),
               updated_at = ?
           WHERE stage = ?
             AND status = 'RUNNING'
             AND julianday(lease_until) <= julianday(?)`,
        )
        .run(now, stage, now);
      const order = preferNewest
        ? "created_at DESC, job_id DESC"
        : "created_at ASC, job_id ASC";
      const row = this.db
        .prepare(
          `SELECT * FROM work_items
           WHERE stage = ?
             AND document_id IN (SELECT d.document_id FROM source_documents d JOIN connectors c ON c.id=d.connector_id WHERE c.enabled=1)
             AND (? IS NULL OR job_id = ?)
             AND attempts < max_attempts
             AND julianday(available_at) <= julianday(?)
             AND (
               status IN ('PENDING', 'RETRY')
               OR (status = 'RUNNING' AND julianday(lease_until) <= julianday(?))
             )
           ORDER BY ${order}
           LIMIT 1`,
        )
        .get(stage, jobId, jobId, now, now);
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const leaseUntil = isoAfter(now, leaseSeconds);
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'RUNNING', attempts = attempts + 1,
               lease_owner = ?, lease_until = ?, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(owner, leaseUntil, now, row.job_id);
      const claimed = this.db
        .prepare(
          `SELECT w.*, d.*
           FROM work_items w JOIN source_documents d ON d.document_id = w.document_id
           WHERE w.job_id = ?`,
        )
        .get(row.job_id);
      this.db.exec("COMMIT");
      return rowWork(claimed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewPublicationLease(job, { now, workerName, leaseSeconds = 120 } = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!job || job.stage !== "PUBLISH" ||
      !["jobId", "documentId", "inputHash", "leaseOwner", "leaseUntil"].every(key => typeof job[key] === "string" && job[key].length > 0) ||
      !Number.isSafeInteger(job.attempts) || job.attempts < 1 || !Number.isFinite(Date.parse(job.leaseUntil)) ||
      typeof now !== "string" || !Number.isFinite(Date.parse(now)) ||
      typeof workerName !== "string" || !workerName ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 120) {
      throw runtimeError("WORK_RENEW_INVALID", "valid publication claim, worker and bounded duration required");
    }
    const entered = performance.now(), instant = Date.parse(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT lease_until FROM work_items
        WHERE job_id = ? AND status = 'RUNNING' AND lease_owner = ? AND attempts = ?
          AND lease_until = ? AND stage = ? AND document_id = ? AND input_hash = ?`)
        .get(job.jobId, job.leaseOwner, job.attempts, job.leaseUntil, job.stage, job.documentId, job.inputHash);
      const checkWork = () => {
        if (!row || !(Date.parse(row.lease_until) > instant + performance.now() - entered))
          throw runtimeError("WORK_LEASE_EXPIRED", "publication claim expired or replaced");
      };
      checkWork();
      const worker = this.db.prepare("SELECT lease_until FROM worker_leases WHERE name = ? AND owner = ?")
        .get(workerName, job.leaseOwner);
      const checkWorker = () => {
        if (!worker || !(Date.parse(worker.lease_until) > instant + performance.now() - entered))
          throw runtimeError("WORKER_LEASE_EXPIRED", "worker lease expired or replaced");
      };
      checkWorker();
      // Only extend a live exact token at a completed publication boundary.
      // Never extend the worker lease, reopen work or change its attempt charge.
      const until = Math.min(instant + leaseSeconds * 1000, Date.parse(worker.lease_until));
      const leaseUntil = until > Date.parse(row.lease_until) ? new Date(until).toISOString() : job.leaseUntil;
      if (leaseUntil !== job.leaseUntil) {
        this.db.prepare("UPDATE work_items SET lease_until = ?, updated_at = ? WHERE job_id = ?")
          .run(leaseUntil, now, job.jobId);
      }
      checkWork();
      checkWorker();
      this.db.exec("COMMIT");
      return { ...job, leaseUntil };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  abandonWorkAfterLeaseLoss(job, { now, reason } = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!job || !["WORK_LEASE_EXPIRED", "WORKER_LEASE_EXPIRED"].includes(reason) ||
      typeof now !== "string" || !Number.isFinite(Date.parse(now)) ||
      !["ANALYZE", "PUBLISH"].includes(job.stage) ||
      !["jobId", "documentId", "inputHash", "leaseOwner", "leaseUntil"].every(key => typeof job[key] === "string" && job[key].length > 0) ||
      !Number.isSafeInteger(job.attempts) || job.attempts < 1 || !Number.isFinite(Date.parse(job.leaseUntil))) {
      throw runtimeError("WORK_ABANDON_INVALID", "valid claim and lease-loss reason required");
    }
    // A single CAS can relinquish this exact attempt, never a late success or
    // a replacement claim. Worker ownership can expire before the job itself.
    const row = this.db.prepare(`UPDATE work_items
      SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'RETRY' END,
          available_at = ?, lease_owner = NULL, lease_until = NULL, last_error_code = ?, updated_at = ?
      WHERE job_id = ? AND status = 'RUNNING' AND lease_owner = ? AND attempts = ?
        AND lease_until = ? AND stage = ? AND document_id = ? AND input_hash = ?
      RETURNING status`).get(now, reason, now, job.jobId, job.leaseOwner, job.attempts,
        job.leaseUntil, job.stage, job.documentId, job.inputHash);
    return row ? { jobId: job.jobId, status: row.status } : null;
  }

  completeWork(jobId, { now }) {
    assertSourceRuntimeWritable(this.dbPath);
    this.db
      .prepare(
        `UPDATE work_items
         SET status = 'SUCCEEDED', lease_owner = NULL, lease_until = NULL,
             last_error_code = NULL, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(now, jobId);
    return { jobId, status: "SUCCEEDED" };
  }

  failWork(jobId, { now, errorCode, retryAt }) {
    assertSourceRuntimeWritable(this.dbPath);
    const row = this.db
      .prepare("SELECT attempts, max_attempts FROM work_items WHERE job_id = ?")
      .get(jobId);
    if (!row) throw runtimeError("WORK_NOT_FOUND", "work item not found");
    const terminal = row.attempts >= row.max_attempts;
    const status = terminal ? "FAILED" : "RETRY";
    this.db
      .prepare(
        `UPDATE work_items
         SET status = ?, available_at = ?, lease_owner = NULL,
             lease_until = NULL, last_error_code = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(status, terminal ? now : retryAt || now, errorCode, now, jobId);
    return { jobId, status };
  }

  recordAnalysisSuccess({
    job,
    provider,
    model,
    promptVersion,
    analysis,
    usage = {},
    latencyMs = null,
    startedAt,
    completedAt,
  }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!job || job.stage !== "ANALYZE" || !job.documentId) {
      throw runtimeError("WORK_STAGE_INVALID", "claimed ANALYZE work required");
    }
    const outputHash = canonicalHash(analysis);
    const runId = `arun_${canonicalHash({
      jobId: job.jobId,
      inputHash: job.inputHash,
      outputHash,
      promptVersion,
      model,
    })}`;
    const candidateId = `cand_${canonicalHash({
      documentId: job.documentId,
      outputHash,
    })}`;
    const publishInputHash = canonicalHash({ documentId: job.documentId, outputHash });
    const publishJobId = `job_${canonicalHash({
      stage: "PUBLISH",
      inputHash: publishInputHash,
    })}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO analysis_runs(
             run_id, job_id, task, provider, model, prompt_version,
             input_hash, output_hash, status, error_code, input_tokens,
             output_tokens, latency_ms, started_at, completed_at
           ) VALUES (?, ?, 'EVIDENCE_CATALYST_ANALYSIS', ?, ?, ?, ?, ?,
                     'SUCCEEDED', NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          job.jobId,
          provider,
          model,
          promptVersion,
          job.inputHash,
          outputHash,
          Number.isInteger(usage.inputTokens) ? usage.inputTokens : null,
          Number.isInteger(usage.outputTokens) ? usage.outputTokens : null,
          Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
          startedAt,
          completedAt,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO analysis_candidates(
             candidate_id, document_id, analysis_run_id, decision, title,
             analysis_json, analysis_hash, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?)`,
        )
        .run(
          candidateId,
          job.documentId,
          runId,
          analysis.decision,
          analysis.variableTitle || null,
          JSON.stringify(analysis),
          outputHash,
          completedAt,
          completedAt,
        );
      const publishEnqueued = this.db
        .prepare(
          `INSERT OR IGNORE INTO work_items(
             job_id, stage, document_id, input_hash, status, attempts,
             max_attempts, available_at, created_at, updated_at
           ) VALUES (?, 'PUBLISH', ?, ?, 'PENDING', 0, 3, ?, ?, ?)`,
        )
        .run(
          publishJobId,
          job.documentId,
          publishInputHash,
          completedAt,
          completedAt,
          completedAt,
        ).changes;
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'SUCCEEDED', lease_owner = NULL, lease_until = NULL,
               last_error_code = NULL, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(completedAt, job.jobId);
      this.db.exec("COMMIT");
      return {
        runId,
        candidateId,
        publishJobId,
        publishEnqueued: Boolean(publishEnqueued),
        analysisHash: outputHash,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordAnalysisFailure({
    job,
    provider,
    model,
    promptVersion,
    errorCode,
    startedAt,
    completedAt,
    usage = {},
    latencyMs = null,
    retryAt,
  }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!job || job.stage !== "ANALYZE") {
      throw runtimeError("WORK_STAGE_INVALID", "claimed ANALYZE work required");
    }
    const runId = `arun_${canonicalHash({
      jobId: job.jobId,
      attempt: job.attempts,
      errorCode,
      completedAt,
    })}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO analysis_runs(
           run_id, job_id, task, provider, model, prompt_version,
           input_hash, output_hash, status, error_code, input_tokens,
           output_tokens, latency_ms, started_at, completed_at
         ) VALUES (?, ?, 'EVIDENCE_CATALYST_ANALYSIS', ?, ?, ?, ?, NULL,
                   'FAILED', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        job.jobId,
        provider,
        model,
        promptVersion,
        job.inputHash,
        errorCode,
        Number.isInteger(usage.inputTokens) ? usage.inputTokens : null,
        Number.isInteger(usage.outputTokens) ? usage.outputTokens : null,
        Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
        startedAt,
        completedAt,
      );
    return this.failWork(job.jobId, {
      now: completedAt,
      errorCode,
      retryAt,
    });
  }

  readCandidateForPublish(job) {
    if (!job || job.stage !== "PUBLISH") {
      throw runtimeError("WORK_STAGE_INVALID", "claimed PUBLISH work required");
    }
    const rows = this.db
      .prepare(
        `SELECT c.*, d.*, r.provider AS analysis_provider,
                r.model AS analysis_model,
                r.prompt_version AS analysis_prompt_version,
                r.completed_at AS analysis_completed_at
         FROM analysis_candidates c
         JOIN source_documents d ON d.document_id = c.document_id
         JOIN analysis_runs r ON r.run_id = c.analysis_run_id
         WHERE c.document_id = ?
         ORDER BY c.created_at DESC, c.candidate_id DESC`,
      )
      .all(job.documentId);
    const row = rows.find(
      (candidate) =>
        candidate.analysis_hash === job.inputHash ||
        canonicalHash({
          documentId: job.documentId,
          outputHash: candidate.analysis_hash,
        }) === job.inputHash,
    );
    if (!row) {
      throw runtimeError("CANDIDATE_NOT_FOUND", "publish candidate not found");
    }
    return {
      candidateId: row.candidate_id,
      decision: row.decision,
      title: row.title,
      status: row.status,
      analysisHash: row.analysis_hash,
      analysis: parseJson(row.analysis_json, null),
      provider: row.analysis_provider,
      model: row.analysis_model,
      promptVersion: row.analysis_prompt_version,
      analyzedAt: row.analysis_completed_at,
      document: {
        connectorId: row.connector_id,
        sourceNamespace: row.source_namespace,
        sourceDocumentKey: row.source_document_key,
        sourceKind: row.source_kind,
        rawUri: row.raw_uri,
        contentHash: row.content_hash,
        excerpt: row.excerpt,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        declaredPublishedAt: row.declared_published_at,
        firstRetrievedAt: row.first_retrieved_at,
        sensitivity: row.sensitivity,
        modelUseAllowed: Boolean(row.model_use_allowed),
        exportAllowed: Boolean(row.export_allowed),
        accessScope: parseJson(row.access_scope_json, []),
      },
    };
  }

  enqueueReadyCandidates({ now }) {
    assertSourceRuntimeWritable(this.dbPath);
    const rows = this.db
      .prepare(
        `SELECT candidate_id, document_id, analysis_hash
         FROM analysis_candidates WHERE status = 'READY'
         ORDER BY created_at ASC, candidate_id ASC`,
      )
      .all();
    let enqueued = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO work_items(
         job_id, stage, document_id, input_hash, status, attempts,
         max_attempts, available_at, created_at, updated_at
       ) VALUES (?, 'PUBLISH', ?, ?, 'PENDING', 0, 3, ?, ?, ?)`,
    );
    for (const row of rows) {
      const inputHash = canonicalHash({
        documentId: row.document_id,
        outputHash: row.analysis_hash,
      });
      const jobId = `job_${canonicalHash({ stage: "PUBLISH", inputHash })}`;
      enqueued += Number(
        insert.run(jobId, row.document_id, inputHash, now, now, now).changes,
      );
    }
    return enqueued;
  }

  recordPublished({ job, candidateId, cardRevisionId, now }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!job || job.stage !== "PUBLISH") {
      throw runtimeError("WORK_STAGE_INVALID", "claimed PUBLISH work required");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE analysis_candidates
           SET status = 'PUBLISHED', ledger_card_revision_id = ?, updated_at = ?
           WHERE candidate_id = ?`,
        )
        .run(cardRevisionId || null, now, candidateId);
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'SUCCEEDED', lease_owner = NULL, lease_until = NULL,
               last_error_code = NULL, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(now, job.jobId);
      this.db.exec("COMMIT");
      return { candidateId, cardRevisionId: cardRevisionId || null, status: "PUBLISHED" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordPublicationBlocked({ job, candidateId, errorCode, now }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!job || job.stage !== "PUBLISH" || !candidateId || !errorCode) {
      throw runtimeError("WORK_STAGE_INVALID", "blocked PUBLISH work required");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE analysis_candidates
           SET status = 'BLOCKED', updated_at = ?
           WHERE candidate_id = ?`,
        )
        .run(now, candidateId);
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'SUCCEEDED', lease_owner = NULL, lease_until = NULL,
               last_error_code = ?, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(errorCode, now, job.jobId);
      this.db.exec("COMMIT");
      return { candidateId, status: "BLOCKED", errorCode };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readLatestCandidates({ limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.db
      .prepare(
        `SELECT candidate_id, document_id, decision, title, analysis_json,
                analysis_hash, status, ledger_card_revision_id, created_at, updated_at
         FROM analysis_candidates
         ORDER BY created_at DESC, candidate_id DESC
         LIMIT ?`,
      )
      .all(safeLimit)
      .map((row) => ({
        candidateId: row.candidate_id,
        documentId: row.document_id,
        decision: row.decision,
        title: row.title,
        analysis: parseJson(row.analysis_json, null),
        analysisHash: row.analysis_hash,
        status: row.status,
        cardRevisionId: row.ledger_card_revision_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  acquireWorkerLease({ name, owner, now, leaseSeconds = 90 }) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!name || !owner) {
      throw runtimeError("WORKER_LEASE_INVALID", "lease name and owner required");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT owner, lease_until FROM worker_leases WHERE name = ?")
        .get(name);
      if (
        row &&
        row.owner !== owner &&
        Number.isFinite(Date.parse(row.lease_until)) &&
        Date.parse(row.lease_until) > Date.parse(now)
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO worker_leases(name, owner, lease_until, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             owner = excluded.owner,
             lease_until = excluded.lease_until,
             updated_at = excluded.updated_at`,
        )
        .run(name, owner, isoAfter(now, leaseSeconds), now);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseWorkerLease({ name, owner }) {
    assertSourceRuntimeWritable(this.dbPath);
    this.db
      .prepare("DELETE FROM worker_leases WHERE name = ? AND owner = ?")
      .run(name, owner);
  }

  readAnalysisCircuit({
    now = new Date().toISOString(),
    failureThreshold = DEFAULT_ANALYSIS_FAILURE_THRESHOLD,
    cooldownSeconds = DEFAULT_ANALYSIS_COOLDOWN_SECONDS,
  } = {}) {
    const nowMs = Date.parse(now);
    if (
      !Number.isFinite(nowMs) ||
      !Number.isInteger(failureThreshold) ||
      failureThreshold < 1 ||
      !Number.isInteger(cooldownSeconds) ||
      cooldownSeconds < 1
    ) {
      throw runtimeError(
        "ANALYSIS_CIRCUIT_INVALID",
        "valid analysis circuit options required",
      );
    }
    const rows = this.db
      .prepare(
        `SELECT status, error_code, completed_at
         FROM analysis_runs
         WHERE completed_at IS NOT NULL
         ORDER BY rowid DESC
         LIMIT 100`,
      )
      .all();
    let consecutiveFailures = 0;
    let lastFailureAt = null;
    let lastErrorCode = null;
    for (const row of rows) {
      if (
        row.status !== "FAILED" ||
        typeof row.error_code !== "string" ||
        !row.error_code.startsWith("LLM_")
      ) {
        break;
      }
      if (consecutiveFailures === 0) {
        lastFailureAt = new Date(row.completed_at).toISOString();
        lastErrorCode = row.error_code;
      }
      consecutiveFailures += 1;
    }
    const retryAt =
      consecutiveFailures >= failureThreshold
        ? isoAfter(lastFailureAt, cooldownSeconds)
        : null;
    const status =
      consecutiveFailures < failureThreshold
        ? "CLOSED"
        : nowMs < Date.parse(retryAt)
          ? "OPEN"
          : "HALF_OPEN";
    return {
      status,
      consecutiveFailures,
      failureThreshold,
      cooldownSeconds,
      lastFailureAt,
      retryAt,
      lastErrorCode,
    };
  }

  setAnalysisDailyTokenLimit({
    limitTokens = DEFAULT_ANALYSIS_DAILY_TOKEN_LIMIT,
  } = {}) {
    assertSourceRuntimeWritable(this.dbPath);
    if (!Number.isSafeInteger(limitTokens) || limitTokens < 1) {
      throw runtimeError(
        "ANALYSIS_TOKEN_BUDGET_INVALID",
        "positive daily token budget required",
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO runtime_meta(key, value) VALUES (?, ?)")
      .run("analysis_daily_token_limit", String(limitTokens));
    return limitTokens;
  }

  readAnalysisTokenBudget({
    now = new Date().toISOString(),
    limitTokens = null,
  } = {}) {
    const configured = Number(
      this.db
        .prepare("SELECT value FROM runtime_meta WHERE key = ?")
        .get("analysis_daily_token_limit")?.value,
    );
    const limit =
      Number.isSafeInteger(limitTokens) && limitTokens > 0
        ? limitTokens
        : Number.isSafeInteger(configured) && configured > 0
          ? configured
          : DEFAULT_ANALYSIS_DAILY_TOKEN_LIMIT;
    const date = shanghaiDate(now);
    const start = new Date(`${date}T00:00:00+08:00`).toISOString();
    const end = isoAfter(start, 24 * 60 * 60);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM analysis_runs
         WHERE julianday(completed_at) >= julianday(?)
           AND julianday(completed_at) < julianday(?)`,
      )
      .get(start, end);
    const inputTokens = Number(row.input_tokens || 0);
    const outputTokens = Number(row.output_tokens || 0);
    const totalTokens = inputTokens + outputTokens;
    return {
      status: totalTokens >= limit ? "EXHAUSTED" : "AVAILABLE",
      shanghaiDate: date,
      limitTokens: limit,
      inputTokens,
      outputTokens,
      totalTokens,
      remainingTokens: Math.max(0, limit - totalTokens),
    };
  }

  readHealth({ now = new Date().toISOString() } = {}) {
    const connectors = this.db
      .prepare(
        `SELECT id, enabled, source_namespace, source_kind, adapter_version, cursor_json,
                poll_interval_seconds, last_checked_at, last_success_at,
                last_error_code, last_error_at
         FROM connectors ORDER BY id`,
      )
      .all()
      .map((row) => {
        const cursor = parseJson(row.cursor_json, null);
        return {
          id: row.id,
          enabled: row.enabled === 1,
          sourceNamespace: row.source_namespace,
          sourceKind: row.source_kind,
          adapterVersion: row.adapter_version,
          pollIntervalSeconds: row.poll_interval_seconds,
          lastCheckedAt: row.last_checked_at,
          lastSuccessAt: row.last_success_at,
          lastSourceAt:
            typeof cursor?.sourceWatermarkAt === "string"
              ? cursor.sourceWatermarkAt
              : null,
          lastErrorCode: row.last_error_code,
          lastErrorAt: row.last_error_at,
        };
      });
    const queueRows = this.db
      .prepare(
        `SELECT CASE
                  WHEN status = 'RUNNING'
                    AND (lease_until IS NULL OR julianday(lease_until) <= julianday(?))
                  THEN CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'RETRY' END
                  ELSE status
                END AS status,
                COUNT(*) AS count
         FROM work_items
         GROUP BY 1`,
      )
      .all(now);
    const queue = { pending: 0, running: 0, retry: 0, failed: 0, succeeded: 0, superseded: 0 };
    for (const row of queueRows) {
      const key = String(row.status).toLowerCase();
      if (Object.hasOwn(queue, key)) queue[key] = Number(row.count);
    }
    const documents = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM source_documents").get().count,
    );
    const candidateRows = this.db
      .prepare("SELECT decision, COUNT(*) AS count FROM analysis_candidates GROUP BY decision")
      .all();
    const candidates = { createCard: 0, reject: 0 };
    for (const row of candidateRows) {
      if (row.decision === "CREATE_CARD") candidates.createCard = Number(row.count);
      if (row.decision === "REJECT") candidates.reject = Number(row.count);
    }
    const latestRunRow = this.db
      .prepare(
        `SELECT run_id, started_at, completed_at, status, discovered_count,
                enqueued_count, analyzed_count, published_count, failed_count,
                error_code, timings_json
         FROM ingest_runs ORDER BY started_at DESC, run_id DESC LIMIT 1`,
      )
      .get();
    const latestRun = latestRunRow
      ? {
          runId: latestRunRow.run_id,
          startedAt: latestRunRow.started_at,
          completedAt: latestRunRow.completed_at,
          status: latestRunRow.status,
          discoveredCount: Number(latestRunRow.discovered_count),
          enqueuedCount: Number(latestRunRow.enqueued_count),
          analyzedCount: Number(latestRunRow.analyzed_count),
          publishedCount: Number(latestRunRow.published_count),
          failedCount: Number(latestRunRow.failed_count),
          errorCode: latestRunRow.error_code,
          timings: normalizeCycleTimings(parseJson(latestRunRow.timings_json, null)),
        }
      : null;
    const latestAnalysisRow = this.db
      .prepare(
        `SELECT provider, model, prompt_version, latency_ms, completed_at
         FROM analysis_runs
         WHERE status = 'SUCCEEDED'
         ORDER BY completed_at DESC, run_id DESC LIMIT 1`,
      )
      .get();
    const latestAnalysis = latestAnalysisRow
      ? {
          provider: latestAnalysisRow.provider,
          model: latestAnalysisRow.model,
          promptVersion: latestAnalysisRow.prompt_version,
          latencyMs: Number.isFinite(Number(latestAnalysisRow.latency_ms))
            ? Number(latestAnalysisRow.latency_ms)
            : null,
          completedAt: latestAnalysisRow.completed_at,
        }
      : null;
    return {
      schema: "source-runtime-health-v1",
      status:
        connectors.length > 0 && connectors.every((row) => !row.enabled)
          ? "DISABLED"
          : connectors.some((row) => row.lastErrorCode) || queue.failed > 0
          ? "DEGRADED"
          : connectors.length
            ? "RUNNING"
            : "NOT_STARTED",
      connectors,
      queue,
      documents,
      candidates,
      latestRun,
      latestAnalysis,
      analysisCircuit: this.readAnalysisCircuit({ now }),
      analysisTokenBudget: this.readAnalysisTokenBudget({ now }),
    };
  }
}
