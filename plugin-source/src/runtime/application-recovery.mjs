// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const validOwner = owner => typeof owner === "string" && owner.length === 73 && /^recovery_[a-f0-9]{64}$/.test(owner);
const error = code => Object.assign(new Error("application recovery coordination failed"), {code});
const untouchedErrors = new Set(["RECOVERY_PAUSE_BUSY", "RECOVERY_OWNER_RETIRED", "RECOVERY_OWNER_HISTORY_FULL",
  "RECOVERY_CONTROLLER_DISPOSED", "RECOVERY_OWNER_INVALID"]);

/** Counts whole admitted promises, not HTTP connections or a guessed mutator
 * allowlist. Pause never aborts the operation. No async-context inheritance:
 * callers must close outer request/model admission before the shared services.
 */
export function createRecoveryActivityGate() {
  let inFlight = 0, paused = null, disposed = false;
  const retired = new Set();
  const recoveryStatus = () => Object.freeze({state: disposed ? "DISPOSED" : paused ?
    inFlight ? "DRAINING" : "PAUSED" : "ACTIVE", inFlight});
  const settle = () => {if (paused && !inFlight) paused.resolve(recoveryStatus());};
  return Object.freeze({
    recoveryStatus,
    async run(operation) {
      if (disposed) throw error("RECOVERY_CONTROLLER_DISPOSED");
      if (paused) throw error("PAUSED_FOR_RECOVERY");
      if (typeof operation !== "function") throw error("RECOVERY_OPERATION_INVALID");
      inFlight++;
      try {return await operation();} finally {inFlight--; settle();}
    },
    pauseForRecovery(owner) {
      if (!validOwner(owner)) return Promise.reject(error("RECOVERY_OWNER_INVALID"));
      if (disposed) return Promise.reject(error("RECOVERY_CONTROLLER_DISPOSED"));
      if (paused) return paused.owner === owner ? paused.promise : Promise.reject(error("RECOVERY_PAUSE_BUSY"));
      if (retired.has(owner)) return Promise.reject(error("RECOVERY_OWNER_RETIRED"));
      if (retired.size >= 1024) return Promise.reject(error("RECOVERY_OWNER_HISTORY_FULL"));
      const pending = {owner, ...Promise.withResolvers()};
      pending.promise.catch(() => {}); paused = pending; settle();
      return pending.promise;
    },
    resumeAfterRecovery(owner) {
      if (!validOwner(owner)) throw error("RECOVERY_OWNER_INVALID");
      if (disposed) throw error("RECOVERY_CONTROLLER_DISPOSED");
      if (!paused && retired.has(owner)) return recoveryStatus();
      if (!paused || paused.owner !== owner) throw error("RECOVERY_PAUSE_OWNER_MISMATCH");
      paused.reject(error("RECOVERY_PAUSE_RELEASED"));
      paused = null; retired.add(owner); return recoveryStatus();
    },
    dispose() {
      disposed = true; paused?.reject(error("RECOVERY_CONTROLLER_DISPOSED")); paused = null;
    },
  });
}

// One module instance is shared by the Host's broker and every DeskService
// (including DSH tools). Never dispose this process-level gate with one Host.
export const applicationServiceGate = createRecoveryActivityGate();

/** Internal coordinator; no network endpoint, authentication, database lock or
 * durable receipt. Stop new RPC/model requests, await their descendants, finish
 * the live round, pause the source worker, then close/drain shared services.
 * This ordering lets an admitted model/round finish its ordinary tool calls.
 * Existing explicit Agent approve/cancel controls remain outside admission.
 * A parent must still prove cross-process quiet/authority and use the PG/SQLite
 * boundary. Its finally block must resume this owner after capture or failure.
 */
export function createApplicationRecoveryController({ingress, liveSourceSync, sourceWorker, services = applicationServiceGate} = {}) {
  const layers = [ingress, liveSourceSync, ...(sourceWorker?.enabled === false ? [] : [sourceWorker]), services];
  if (layers.some(layer => !layer || ["pauseForRecovery", "resumeAfterRecovery", "recoveryStatus"]
    .some(name => typeof layer[name] !== "function"))) throw error("RECOVERY_PARTICIPANT_INVALID");
  let active = null, disposed = false;
  const retired = new Set();
  const allQuiet = () => layers.every(layer => {
    const state = layer.recoveryStatus();
    return state.state === "PAUSED" && state.inFlight === 0;
  });
  const status = () => Object.freeze({schema: "variable-os-application-recovery-status-v1",
    state: disposed ? "DISPOSED" : active?.state === "PAUSED" && !allQuiet() ? "INVALIDATED" : active?.state || "ACTIVE",
    inFlight: Object.freeze({requests: ingress.recoveryStatus().inFlight, services: services.recoveryStatus().inFlight,
      liveRounds: liveSourceSync.recoveryStatus().inFlight,
      workerRounds: sourceWorker?.enabled === false ? 0 : sourceWorker.recoveryStatus().inFlight})});
  const clearWait = record => {
    clearTimeout(record.timer); record.signal?.removeEventListener("abort", record.onAbort);
  };
  const release = record => {
    record.state = "RELEASING"; clearWait(record);
    let failed = false;
    for (const acquired of [...record.acquired].reverse()) {
      if (!acquired.held) continue;
      try {acquired.layer.resumeAfterRecovery(record.owner); acquired.held = false;}
      catch {failed = true;}
    }
    if (failed) {record.state = "RELEASE_FAILED"; throw error("RECOVERY_RESUME_FAILED");}
    active = null; retired.add(record.owner);
    return status();
  };
  const interrupt = (record, code) => {
    if (active !== record) return;
    try {release(record);} catch {code = "RECOVERY_RESUME_FAILED";}
    record.reject(error(code));
  };

  return Object.freeze({
    status,
    pauseForRecovery(owner, options = {}) {
      if (!validOwner(owner)) return Promise.reject(error("RECOVERY_OWNER_INVALID"));
      const timeoutMs = options?.timeoutMs === undefined ? 300000 : options.timeoutMs, signal = options?.signal;
      if (!options || typeof options !== "object" || Array.isArray(options) ||
          !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
          (signal !== undefined && !(signal instanceof AbortSignal))) return Promise.reject(error("RECOVERY_PAUSE_OPTIONS_INVALID"));
      if (signal?.aborted) return Promise.reject(error("RECOVERY_PAUSE_ABORTED"));
      if (disposed) return Promise.reject(error("RECOVERY_CONTROLLER_DISPOSED"));
      if (active) {
        if (active.owner !== owner) return Promise.reject(error("RECOVERY_PAUSE_BUSY"));
        if (active.state === "RELEASE_FAILED") return Promise.reject(error("RECOVERY_RESUME_FAILED"));
        if (active.state === "PAUSED" && !allQuiet()) return Promise.reject(error("RECOVERY_PARTICIPANT_NOT_QUIET"));
        return active.promise;
      }
      if (retired.has(owner)) return Promise.reject(error("RECOVERY_OWNER_RETIRED"));
      if (retired.size >= 1024) return Promise.reject(error("RECOVERY_OWNER_HISTORY_FULL"));
      const record = {owner, state: "DRAINING", acquired: [], signal, ...Promise.withResolvers()};
      record.promise.catch(() => {}); active = record;
      record.onAbort = () => interrupt(record, "RECOVERY_PAUSE_ABORTED");
      signal?.addEventListener("abort", record.onAbort, {once: true});
      record.timer = setTimeout(() => interrupt(record, "RECOVERY_PAUSE_TIMEOUT"), timeoutMs);
      // Starts synchronously so the first admission closes before returning.
      void (async () => {
        try {
          for (const layer of layers) {
            if (active !== record || record.state !== "DRAINING") return;
            const acquired = {layer, held: true};
            record.acquired.push(acquired);
            try {await layer.pauseForRecovery(owner);}
            catch (failure) {if (untouchedErrors.has(failure?.code)) acquired.held = false; throw failure;}
            if (active !== record || record.state !== "DRAINING") return;
            const state = layer.recoveryStatus();
            if (state.state !== "PAUSED" || state.inFlight !== 0) throw error("RECOVERY_PARTICIPANT_NOT_QUIET");
          }
          if (!allQuiet()) throw error("RECOVERY_PARTICIPANT_NOT_QUIET");
          record.state = "PAUSED"; clearWait(record); record.resolve(status());
        } catch (failure) {
          if (active === record) interrupt(record, untouchedErrors.has(failure?.code) ? failure.code : "RECOVERY_PAUSE_FAILED");
        }
      })();
      return record.promise;
    },
    resumeAfterRecovery(owner) {
      if (!validOwner(owner)) throw error("RECOVERY_OWNER_INVALID");
      if (disposed) throw error("RECOVERY_CONTROLLER_DISPOSED");
      if (!active && retired.has(owner)) return status();
      if (!active || active.owner !== owner) throw error("RECOVERY_PAUSE_OWNER_MISMATCH");
      const record = active;
      try {return release(record);}
      finally {record.reject(error(active ? "RECOVERY_RESUME_FAILED" : "RECOVERY_PAUSE_RELEASED"));}
    },
    dispose() {
      if (disposed) return;
      if (active) interrupt(active, "RECOVERY_CONTROLLER_DISPOSED");
      disposed = true; ingress.dispose();
      if (active) throw error("RECOVERY_RESUME_FAILED");
    },
  });
}

const hosts = new Set();
/** Process-local registry, NOT an authorization boundary or RPC method. A future
 * authenticated owner-control transport must resolve exactly one live Host.
 */
export function registerApplicationRecoveryHost(host) {
  if (!host || typeof host.status !== "function" || typeof host.pauseForRecovery !== "function" ||
      typeof host.resumeAfterRecovery !== "function" || hosts.has(host)) throw error("RECOVERY_PARTICIPANT_INVALID");
  hosts.add(host);
  return () => {hosts.delete(host);};
}
export function getApplicationRecoveryHost() {
  if (!hosts.size) throw error("RECOVERY_HOST_UNAVAILABLE");
  if (hosts.size !== 1) throw error("RECOVERY_HOST_AMBIGUOUS");
  const host = [...hosts][0];
  if (host.status().state === "DISPOSED") throw error("RECOVERY_HOST_UNAVAILABLE");
  return host;
}
