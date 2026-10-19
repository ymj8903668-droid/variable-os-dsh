// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { subscribeCards } from "../../dsh-tools/lib/remote/stream.js";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { createPrivateJsonProfile } from "./private-json-profile.js";
import timers from "node:timers/promises";

const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revoked = new Set(["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "TLS_REJECTED", "SPKI_MISMATCH", "RESPONSE_INVALID"]);
const empty = revision => ({ schema: 1, revision, cursor: null, projectionDigest: null });
const membershipMap = rows => {
  if (!Array.isArray(rows) || rows.length > 20000) return null;
  const members = new Map();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join(',') !== 'hash,identity'
      || typeof row.identity !== 'string' || !row.identity || row.identity.length > 1024
      || !hash(row.hash) || members.has(row.identity)) return null;
    members.set(row.identity, row.hash);
  }
  return members;
};

// A cursor is an acknowledgement of a fully read authorized projection. Only
// metadata is durable; a new Host must always read the live authorized cards.
export function createPublishedSync({ provider, sources, readSnapshot, file, reconnectDelayMs = 1000 }) {
  const profile = createPrivateJsonProfile({ file, initial: () => empty(sources.revision()),
    maxBytes: 1024, temporaryPrefix: ".published-sync-",
    errors: { invalid: "SOURCE_CONFIG_INVALID", unavailable: "SOURCE_UNAVAILABLE",
      write: "SOURCE_UNAVAILABLE", busy: "CLIENT_BUSY", changed: "SOURCE_CHANGED" },
    validate: value => value && Object.keys(value).sort().join(",") === "cursor,projectionDigest,revision,schema"
      && value.schema === 1 && hash(value.revision)
      && (value.cursor === null || typeof value.cursor === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value.cursor))
      && (value.projectionDigest === null || hash(value.projectionDigest)),
  });
  const listeners = new Set();
  let state = { status: "CONNECTING", projectionDigest: null };
  let owner = null, closed = false, cooldown = null, denial = null;
  const tasks = new Set();
  const snapshotSignals = new WeakSet();
  function emit(value) {
    state = Object.freeze(value);
    for (const listener of listeners) listener(state);
  }
  function stop() { owner?.abort.abort(); owner = null; cooldown = null; }
  function start() {
    if (closed || !listeners.size || owner) return;
    const run = { revision: sources.revision(), abort: new AbortController(), membership: null };
    if (cooldown && cooldown.revision !== run.revision) cooldown = null;
    if (denial && denial.revision !== run.revision) denial = null;
    snapshotSignals.add(run.abort.signal);
    owner = run;
    const current = () => owner === run && !run.abort.signal.aborted;
    const assertCurrent = () => {
      if (!current()) throw remoteError("CANCELLED");
      if (sources.revision() !== run.revision) throw remoteError("SOURCE_CHANGED");
    };
    const save = (cursor, projectionDigest) => {
      assertCurrent();
      const selected = profile.current();
      profile.write({ ...empty(run.revision), cursor, projectionDigest }, selected);
    };
    const reconcile = async cursor => {
      assertCurrent();
      const snapshot = await readSnapshot({ signal: run.abort.signal });
      assertCurrent();
      const digest = snapshot?.result?.health?.projectionDigest;
      if (snapshot?.ok !== true || snapshot.sourceRevision !== run.revision || !hash(digest)) {
        throw remoteError("RESPONSE_INVALID");
      }
      save(cursor, digest);
      denial = null;
      const membership = membershipMap(snapshot.result.membership);
      const append = state.status === 'SYNCED' && membership && run.membership
        && membership.size > run.membership.size
        && [...run.membership].every(([id, hash]) => membership.get(id) === hash);
      const appendFromDigest = append ? state.projectionDigest : null;
      run.membership = membership;
      emit({ status: "SYNCED", projectionDigest: digest,
        ...(appendFromDigest && appendFromDigest !== digest ? { appendFromDigest } : {}) });
    };
    const reauthorize = async () => {
      let backoff = reconnectDelayMs;
      for (;;) {
        assertCurrent();
        try { await reconcile(null); return; }
        catch (error) {
          assertCurrent();
          if (!["SOURCE_UNAVAILABLE", "EDGE_TIMEOUT"].includes(error?.code)) throw error;
          const retry = Number.isFinite(error.retryAfter) && error.retryAfter >= 0 && error.retryAfter <= 3600
            ? error.retryAfter * 1000 : 0;
          emit({ status: "DISCONNECTED", projectionDigest: null });
          await timers.setTimeout(Math.max(backoff, retry), undefined, { signal: run.abort.signal });
          backoff = Math.min(30000, backoff * 2);
        }
      }
    };
    const task = (async () => {
      try {
        const waiting = cooldown;
        if (waiting?.revision === run.revision) {
          await timers.setTimeout(Math.max(0, Math.ceil(waiting.until - performance.now())), undefined,
            { signal: run.abort.signal });
          assertCurrent();
          if (cooldown === waiting) cooldown = null;
        }
        let stored = profile.current().record;
        if (stored.revision !== run.revision) { save(null, null); stored = empty(run.revision); }
        if (sources.snapshot().ready === false) {
          save(null, null);
          emit({ status: "NOT_CONFIGURED", projectionDigest: null });
          return;
        }
        emit({ status: "CONNECTING", projectionDigest: null });
        let cursor = stored.cursor;
        if (denial?.revision === run.revision) {
          // Let the denied call retire its own buffered view before admitting a
          // fresh proof; otherwise that same rejection fences the recovery too.
          await timers.setImmediate(undefined, { signal: run.abort.signal });
          await reauthorize();
          cursor = null;
        }
        // A rejected cursor or an in-flight grant fence needs fresh authority.
        // Only an authorized connected snapshot resets the recovery budget.
        let recoveries = 0;
        while (current()) {
          let resync = false;
          const subscription = subscribeCards(provider, {
            lastEventId: cursor, signal: run.abort.signal, reconnectDelayMs, continuous: true,
            onEvents: async events => {
              const next = events.at(-1).id;
              await reconcile(next); cursor = next;
            },
            onState: async ({ code, error }) => {
              assertCurrent();
              if (code === "CONNECTED") { await reconcile(cursor); recoveries = 0; return; }
              // assertCurrent already excludes a replaced configuration. This
              // SOURCE_CHANGED can be a live grant/version fence in a read.
              if (code === "RESYNC_REQUIRED" || ["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "SOURCE_CHANGED"].includes(error)) resync = true;
              if (revoked.has(error)) save(null, null);
              emit({ status: "DISCONNECTED", projectionDigest: null });
            },
          });
          await subscription.done;
          if (!current() || !resync || recoveries >= 1) break;
          recoveries++;
          save(null, null); cursor = null;
          // A key revoked at the service still fails this fresh read. A grant
          // revision can fence the old request while allowing the same key to
          // read its new scope. Never reopen before that proof succeeds.
          await reauthorize();
        }
      } catch {
        if (current()) emit({ status: "DISCONNECTED", projectionDigest: null });
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  return Object.freeze({
    readDenied(error, { sourceRevision, signal } = {}) {
      if (closed || sourceRevision !== sources.revision() || snapshotSignals.has(signal)
        || !["AUTH_REQUIRED", "FORBIDDEN_SCOPE"].includes(error?.code)) return false;
      // Other original-card reads can discover revocation before the stream.
      // Fence outstanding snapshots before clearing their durable acknowledgement.
      // A stream's own read failure already follows its bounded recovery path.
      if (denial?.revision === sourceRevision && denial.cleared) return true;
      denial = { revision: sourceRevision, cleared: false };
      stop();
      try {
        const selected = profile.current();
        profile.write(empty(sourceRevision), selected);
      } catch {
        // An unsafe/unwritable profile stays disconnected. Preserve the caller's
        // authorization error so it still retires displayed and saved content.
        emit({ status: "DISCONNECTED", projectionDigest: null });
        return false;
      }
      denial.cleared = true;
      emit({ status: "DISCONNECTED", projectionDigest: null });
      start();
      return true;
    },
    assertReadable(revision) {
      if (cooldown?.revision === revision && cooldown.revision === sources.revision()) {
        const remaining = cooldown.until - performance.now();
        if (remaining > 0) throw remoteError("SOURCE_UNAVAILABLE", {
          retryAfter: Math.ceil(remaining / 1000), localReadFence: true,
        });
      }
    },
    readThrottled(error, { sourceRevision } = {}) {
      if (closed || !owner || !listeners.size || sourceRevision !== owner.revision
        || sourceRevision !== sources.revision() || error?.code !== "SOURCE_UNAVAILABLE"
        || !Number.isInteger(error.retryAfter) || error.retryAfter < 1 || error.retryAfter > 3600) return false;
      // Several consumers can observe the same exhausted window. Never extend
      // its deadline or replay their operation; only restore live read authority.
      if (cooldown) return true;
      stop();
      cooldown = { revision: sourceRevision, until: performance.now() + error.retryAfter * 1000 };
      emit({ status: "DISCONNECTED", projectionDigest: null });
      start();
      return true;
    },
    watch(listener) {
      if (closed) throw remoteError("CANCELLED");
      listeners.add(listener);
      if (owner) listener(state); else start();
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    refreshSource() {
      if (owner && owner.revision !== sources.revision()) { stop(); start(); }
    },
    async close() { closed = true; stop(); listeners.clear(); await Promise.all([...tasks]); },
  });
}
