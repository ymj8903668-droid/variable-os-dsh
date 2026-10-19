// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { remoteError } from "../../dsh-tools/lib/remote/config.js";

export function createWebResearchSettings({ sources, provider, now = Date.now }) {
  let observation = null, pending = null;
  let lastTime = -Infinity;
  function sampleTime() {
    try {
      const time = now();
      if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()) || time < lastTime) throw Error();
      lastTime = time;
      return time;
    } catch { observation = null; return null; }
  }
  const describe = (sourceRevision, status, reason) => Object.freeze({
    provider: "tavily", status, reason, connection: "NOT_CHECKED",
    ready: status === "READY", sourceRevision,
  });
  function snapshot() {
    const source = sources.snapshot();
    if (!source.ready) return describe(source.revision, "NOT_CONFIGURED", "SOURCE_UNAVAILABLE");
    const time = sampleTime();
    if (time === null) return describe(source.revision, "UNKNOWN", "NOT_CHECKED");
    if (pending?.revision === source.revision) return describe(source.revision, "CHECKING", "CHECKING");
    return observation?.value.sourceRevision === source.revision && time - observation.at < 60_000 ? observation.value
      : describe(source.revision, "UNKNOWN", "NOT_CHECKED");
  }
  function reset() { pending?.controller.abort(); pending = null; observation = null; }
  return Object.freeze({
    snapshot, reset,
    async call(method, params = {}, { signal } = {}) {
      if (!params || typeof params !== "object" || Array.isArray(params)) throw remoteError("INVALID_REQUEST");
      if (method === "webResearchStatus") {
        if (Object.keys(params).length) throw remoteError("INVALID_REQUEST");
        return snapshot();
      }
      if (method !== "webResearchCheck") throw remoteError("METHOD_NOT_ALLOWED");
      if (Object.keys(params).length !== 1 || !/^[a-f0-9]{64}$/.test(params.revision ?? "")) {
        throw remoteError("INVALID_REQUEST");
      }
      const revision = sources.revision();
      if (params.revision !== revision) throw remoteError("SOURCE_CHANGED");
      if (signal?.aborted) throw remoteError("CANCELLED");
      if (!provider.settings().ready) throw remoteError("SOURCE_UNAVAILABLE");
      if (pending?.revision === revision) throw remoteError("CLIENT_BUSY");
      if (sampleTime() === null) throw remoteError("SOURCE_UNAVAILABLE");
      reset();
      const operation = { revision, controller: new AbortController() };
      pending = operation;
      const combined = signal ? AbortSignal.any([signal, operation.controller.signal]) : operation.controller.signal;
      try {
        const value = await provider.call("researchStatus", {}, { signal: combined });
        if (combined.aborted || pending !== operation) throw remoteError("CANCELLED");
        if (sources.revision() !== revision) throw remoteError("SOURCE_CHANGED");
        const at = sampleTime();
        if (at === null) throw remoteError("SOURCE_UNAVAILABLE");
        observation = { value: describe(revision, value.status, value.reason), at };
        return observation.value;
      } catch (error) {
        if (pending === operation && sources.revision() === revision) {
          const at = sampleTime();
          if (at !== null) observation = { value: describe(revision, "FAILED", "CHECK_FAILED"), at };
        }
        throw error;
      } finally { if (pending === operation) pending = null; }
    },
  });
}
