// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from "node:crypto";
import { normalizeImaCandidates } from "../../packages/evidence-provider/src/ima-candidates.mjs";

const LEASE = "personal-ima-candidate-intake";
const fail = code => { throw Object.assign(Error(code), { code }); };
const validate = (batch, now) => {
  try { return normalizeImaCandidates(batch, now); } catch { fail("RESPONSE_INVALID"); }
};

/** Separate metadata cache: no full bodies, excerpts, signed URLs or publication assertions. */
export function createImaCandidateIntakeStore(runtime) {
  const db = runtime.db;
  db.exec(`CREATE TABLE IF NOT EXISTS ima_candidate_intake_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), run_id TEXT NOT NULL,
    status TEXT NOT NULL, attempted_at TEXT NOT NULL, completed_at TEXT,
    receipt_json TEXT, error_code TEXT
  );
  CREATE TABLE IF NOT EXISTS ima_candidate_intake_records (
    evidence_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, title TEXT NOT NULL
  );`);
  const read = now => {
    const state = db.prepare("SELECT * FROM ima_candidate_intake_state WHERE singleton=1").get();
    if (state?.status !== "RECEIVED") fail("INTAKE_REQUIRED");
    const { recordCount, ...receipt } = JSON.parse(state.receipt_json);
    const records = db.prepare(`SELECT dataset_id AS datasetId, evidence_id AS evidenceId, title
      FROM ima_candidate_intake_records ORDER BY evidence_id`).all().map(row => ({ ...row }));
    if (recordCount !== records.length) fail("RESPONSE_INVALID");
    return { runId: state.run_id, batch: validate({ ...receipt, records }, now) };
  };
  const status = now => {
    const state = db.prepare("SELECT * FROM ima_candidate_intake_state WHERE singleton=1").get();
    const batch = state?.status === "RECEIVED" ? read(now).batch : null;
    return { status: state?.status ?? "NOT_STARTED", attemptedAt: state?.attempted_at ?? null,
      completedAt: state?.completed_at ?? null, observedAt: batch?.observedAt ?? null,
      recordCount: batch?.records.length ?? null, candidates: batch?.records ?? [],
      coverage: batch?.coverage ?? null, asOf: null, knownAt: null, version: null,
      exportAllowed: false, modelUseAllowed: false, errorCode: state?.error_code ?? null };
  };
  return {
    status, readSnapshot: read,
    begin(now) {
      const runId = randomUUID();
      if (!runtime.acquireWorkerLease({ name: LEASE, owner: runId, now, leaseSeconds: 120 })) fail("CLIENT_BUSY");
      try {
        db.prepare(`INSERT INTO ima_candidate_intake_state(singleton,run_id,status,attempted_at)
          VALUES(1,?,'SYNCING',?) ON CONFLICT(singleton) DO UPDATE SET
          run_id=excluded.run_id,status='SYNCING',attempted_at=excluded.attempted_at,error_code=NULL`).run(runId, now);
      } catch (error) { runtime.releaseWorkerLease({ name: LEASE, owner: runId }); throw error; }
      return runId;
    },
    commit(runId, value, now) {
      const batch = validate(value, now);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!runtime.ownsWorkerLease({ name: LEASE, owner: runId, now }) ||
          db.prepare("SELECT run_id FROM ima_candidate_intake_state WHERE singleton=1").get()?.run_id !== runId) {
          fail("INTAKE_LEASE_EXPIRED");
        }
        db.exec("DELETE FROM ima_candidate_intake_records");
        const insert = db.prepare("INSERT INTO ima_candidate_intake_records(evidence_id,dataset_id,title) VALUES(?,?,?)");
        for (const row of batch.records) insert.run(row.evidenceId, row.datasetId, row.title);
        const { records, ...receipt } = batch;
        db.prepare(`UPDATE ima_candidate_intake_state SET status='RECEIVED',completed_at=?,receipt_json=?,error_code=NULL
          WHERE singleton=1 AND run_id=?`).run(now, JSON.stringify({ ...receipt, recordCount: records.length }), runId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return status(now);
    },
    failed(runId, code, now) {
      db.prepare(`UPDATE ima_candidate_intake_state SET status='FAILED',completed_at=?,error_code=?
        WHERE singleton=1 AND run_id=? AND status='SYNCING'`).run(now, code, runId);
    },
    release(runId) { runtime.releaseWorkerLease({ name: LEASE, owner: runId }); },
  };
}
