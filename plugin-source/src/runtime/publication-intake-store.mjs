// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from "node:crypto";
import { normalizeEvidenceRecord, compareInstants } from "../../packages/evidence-provider/src/contracts.mjs";

const LEASE = "personal-publication-intake";
const fail = code => { throw Object.assign(Error(code), { code }); };
const keys = (value, required, optional = []) => value && typeof value === "object" && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const RECORD_KEYS = ["evidenceId", "datasetId", "datasetVersion", "sourceFamily", "eventAt", "availableAt",
  "recordedAt", "knownAt", "epistemicType", "excerpt", "contentHash", "exportAllowed", "modelUseAllowed",
  "license", "mirrors", "revision"];

export function validatePublicationBatch(batch, now) {
  try {
    if (!keys(batch, ["schema", "coverage", "asOf", "knownAt", "datasetVersions", "records", "historyCount", "pageCount"])
      || batch.schema !== "publication-intake-v1" || batch.coverage !== "AUTHORIZED_TIMELINE_EXCERPTS"
      || compareInstants(batch.asOf, now) > 0 || compareInstants(batch.knownAt, now) > 0
      || !Array.isArray(batch.records) || batch.records.length > 5000
      || !Number.isSafeInteger(batch.historyCount) || batch.historyCount < batch.records.length || batch.historyCount > 5000
      || !Number.isSafeInteger(batch.pageCount) || batch.pageCount < 1 || batch.pageCount > 50
      || !Array.isArray(batch.datasetVersions) || !batch.datasetVersions.length || batch.datasetVersions.length > 100
      || Buffer.byteLength(JSON.stringify(batch)) > 16 * 1024 * 1024) fail("RESPONSE_INVALID");
    const versions = new Map(), identities = new Set();
    for (const row of batch.datasetVersions) {
      if (!keys(row, ["datasetId", "version"]) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.datasetId)
        || !/^[a-f0-9]{64}$/.test(row.version) || versions.has(row.datasetId)) fail("RESPONSE_INVALID");
      versions.set(row.datasetId, row.version);
    }
    for (const row of batch.records) {
      if (!keys(row, RECORD_KEYS, ["cardId", "title", "nodes", "path", "excerptOnly"])
        || row.datasetVersion !== versions.get(row.datasetId)
        || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.evidenceId)
        || !["cards", "evidence", "wiki", "graph", "facts", "brain"].includes(row.sourceFamily)
        || row.exportAllowed !== true || row.modelUseAllowed !== true
        || !Number.isSafeInteger(row.revision) || row.revision < 1
        || !Array.isArray(row.mirrors) || row.mirrors.length
        || row.sourceFamily === "wiki" && row.excerptOnly !== true
        || typeof row.excerpt !== "string" || Buffer.byteLength(row.excerpt) > 4096
        || row.eventAt !== null && compareInstants(row.eventAt, batch.asOf) > 0
        || compareInstants(row.availableAt, batch.asOf) > 0
        || compareInstants(row.recordedAt, batch.knownAt) > 0
        || compareInstants(row.knownAt, batch.knownAt) > 0
        || compareInstants(row.availableAt, row.knownAt) > 0
        || compareInstants(row.recordedAt, row.knownAt) > 0) fail("RESPONSE_INVALID");
      normalizeEvidenceRecord(row);
      const key = JSON.stringify([row.datasetId, row.sourceFamily, row.evidenceId]);
      if (identities.has(key)) fail("RESPONSE_INVALID");
      identities.add(key);
    }
  } catch { fail("RESPONSE_INVALID"); }
}

/** Private intake cache, deliberately separate from local raw documents and
 * analysis work. Receipt of published bytes never grants model consent. */
export function createPublicationIntakeStore(runtime) {
  const db = runtime.db;
  db.exec(`CREATE TABLE IF NOT EXISTS publication_intake_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), run_id TEXT NOT NULL,
    status TEXT NOT NULL, attempted_at TEXT NOT NULL, completed_at TEXT,
    snapshot_json TEXT, error_code TEXT
  );
  CREATE TABLE IF NOT EXISTS publication_intake_records (
    identity TEXT PRIMARY KEY, record_json TEXT NOT NULL
  );`);
  const status = () => {
    const state = db.prepare("SELECT * FROM publication_intake_state WHERE singleton = 1").get();
    const snapshot = state?.status === "RECEIVED" ? JSON.parse(state.snapshot_json) : null;
    return { status: state?.status ?? "NOT_STARTED", attemptedAt: state?.attempted_at ?? null,
      completedAt: state?.completed_at ?? null, recordCount: snapshot?.recordCount ?? null,
      historyCount: snapshot?.historyCount ?? null, pageCount: snapshot?.pageCount ?? null,
      asOf: snapshot?.asOf ?? null, knownAt: snapshot?.knownAt ?? null,
      coverage: snapshot ? "AUTHORIZED_TIMELINE_EXCERPTS" : null,
      errorCode: state?.error_code ?? null, modelUseAllowed: false };
  };
  const transaction = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const active = (runId, now) => {
    if (!runtime.ownsWorkerLease({ name: LEASE, owner: runId, now })
      || db.prepare("SELECT run_id FROM publication_intake_state WHERE singleton = 1").get()?.run_id !== runId) {
      fail("INTAKE_LEASE_EXPIRED");
    }
  };
  return {
    status,
    readSnapshot(now) {
      const state = db.prepare("SELECT * FROM publication_intake_state WHERE singleton = 1").get();
      if (state?.status !== "RECEIVED") fail("INTAKE_REQUIRED");
      const { recordCount, ...receipt } = JSON.parse(state.snapshot_json);
      const records = db.prepare("SELECT record_json FROM publication_intake_records ORDER BY identity").all()
        .map(row => JSON.parse(row.record_json));
      if (recordCount !== records.length) fail("RESPONSE_INVALID");
      const batch = { ...receipt, records };
      validatePublicationBatch(batch, now);
      return { runId: state.run_id, batch };
    },
    begin(now) {
      const runId = randomUUID();
      if (!runtime.acquireWorkerLease({ name: LEASE, owner: runId, now, leaseSeconds: 120 })) fail("CLIENT_BUSY");
      try {
        db.prepare(`INSERT INTO publication_intake_state(singleton,run_id,status,attempted_at)
          VALUES(1,?,'SYNCING',?) ON CONFLICT(singleton) DO UPDATE SET
          run_id=excluded.run_id,status='SYNCING',attempted_at=excluded.attempted_at,error_code=NULL`).run(runId, now);
      } catch (error) { runtime.releaseWorkerLease({ name: LEASE, owner: runId }); throw error; }
      return runId;
    },
    commit(runId, batch, now) {
      validatePublicationBatch(batch, now);
      transaction(() => {
        active(runId, now);
        db.exec("DELETE FROM publication_intake_records");
        const insert = db.prepare("INSERT INTO publication_intake_records(identity,record_json) VALUES(?,?)");
        for (const row of batch.records) insert.run(JSON.stringify([row.datasetId, row.sourceFamily, row.evidenceId]), JSON.stringify(row));
        const { records, ...receipt } = batch;
        db.prepare(`UPDATE publication_intake_state SET status='RECEIVED',completed_at=?,snapshot_json=?,error_code=NULL
          WHERE singleton=1 AND run_id=?`).run(now, JSON.stringify({ ...receipt, recordCount: records.length }), runId);
      });
      return status();
    },
    failed(runId, code, now) {
      db.prepare(`UPDATE publication_intake_state SET status='FAILED',completed_at=?,error_code=?
        WHERE singleton=1 AND run_id=? AND status='SYNCING'`).run(now, code, runId);
    },
    release(runId) { runtime.releaseWorkerLease({ name: LEASE, owner: runId }); },
  };
}
