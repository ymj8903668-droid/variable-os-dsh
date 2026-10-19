// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { independentResearchLimits } from "../src/independent-research-limits.mjs";

export const INDEPENDENT_RESEARCH_METHODS = new Set(["independentResearchPrepare", "independentResearchRun",
  "independentResearchHistoryList", "independentResearchHistoryRead", "independentResearchHistoryDelete"]);
export const INDEPENDENT_RESEARCH_CODES = new Set(["RESEARCH_PLAN_UNAVAILABLE", "RESEARCH_BUDGET_EXHAUSTED",
  "RESEARCH_INPUT_TOO_LARGE", "RESEARCH_SEGMENT_LIMIT",
  "RESEARCH_SEGMENT_JSON_INVALID", "RESEARCH_SEGMENT_FIELDS_INVALID", "RESEARCH_SEGMENT_LENGTH_EXCEEDED",
  "RESEARCH_SEGMENT_TEXT_INVALID", "RESEARCH_SEGMENT_EMPTY",
  "RESEARCH_DISCLOSURE_EXHAUSTED", "RESEARCH_REPORT_LENGTH_EXCEEDED",
  "RESEARCH_PLAN_INVALID", "RESEARCH_RESULT_INVALID", "MODEL_CONSENT_REQUIRED", "WIKI_SOURCE_CHANGED",
  "MODEL_SETTINGS_CHANGED", "MODEL_CREDENTIAL_REQUIRED", "MODEL_SELECTION_REQUIRED", "MODEL_SETTINGS_UNAVAILABLE",
  "RESEARCH_HISTORY_UNAVAILABLE", "RESEARCH_HISTORY_CHANGED", "RESEARCH_HISTORY_BUSY", "RESEARCH_HISTORY_CAPACITY", "RESEARCH_HISTORY_STALE"]);
export const researchError = code => Object.assign(Error(code), { code });
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
export { validResearchQuestion } from "../../../src/research/protocol.mjs";
import { validResearchQuestion } from "../../../src/research/protocol.mjs";

function cancellable(signal, operation) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(researchError("CANCELLED"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw researchError("CANCELLED");
      return operation();
    }).then(value => signal.aborted ? abort() : resolve(value), reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Approval lives only in this Host. Restart invalidates it; no run is replayed.
 * capture performs local configuration reads only, execute owns all paid work. */
export function createIndependentResearchController({ capture, execute, nowMs = () => performance.now() }) {
  const plans = new Map(), lifetime = new AbortController();
  let running = false, lastNow = -Infinity;
  const active = signal => {
    if (lifetime.signal.aborted || signal?.aborted) throw researchError("CANCELLED");
  };
  const clock = () => {
    const now = nowMs();
    if (!Number.isFinite(now) || now < lastNow) { plans.clear(); throw researchError("RESEARCH_PLAN_UNAVAILABLE"); }
    lastNow = now; return now;
  };
  return Object.freeze({
    async prepare(params, { signal } = {}) {
      active(signal);
      if (running) throw researchError("CLIENT_BUSY");
      const segmented = params?.inputMode === "segmented";
      if (!exact(params, segmented ? ["topic", "webSearchAllowed", "inputMode"] : ["topic", "webSearchAllowed"]) || !validResearchQuestion(params.topic)
        || typeof params.webSearchAllowed !== "boolean") throw researchError("INVALID_REQUEST");
      const binding = await capture(params, { signal });
      active(signal); binding.assertCurrent();
      const now = clock();
      for (const [id, value] of plans) if (value.expires <= now) plans.delete(id);
      while (plans.size >= 4) plans.delete(plans.keys().next().value);
      const plan = Object.freeze({ schema: segmented ? "independent-research-plan-v2" : "independent-research-plan-v1",
        ...(segmented ? { inputMode: "segmented" } : {}), planId: randomBytes(32).toString("hex"),
        topic: params.topic, libraryId: binding.public.libraryId,
        model: Object.freeze({ ...binding.public.model }), webSearchAllowed: params.webSearchAllowed,
        historyPersistence: binding.public.historyPersistence ?? "session",
        expiresInSeconds: 300, historyComplete: false, complete: false,
        limits: independentResearchLimits(params.webSearchAllowed, segmented) });
      plans.set(plan.planId, { plan, binding, expires: now + 300000 });
      return plan;
    },
    async run(params, { signal: callerSignal } = {}) {
      if (!exact(params, ["planId", "approved"]) || !/^[a-f0-9]{64}$/.test(params.planId ?? "")) {
        throw researchError("INVALID_REQUEST");
      }
      if (params.approved !== true) throw researchError("MODEL_CONSENT_REQUIRED");
      if (running) throw researchError("CLIENT_BUSY");
      const entry = plans.get(params.planId);
      plans.delete(params.planId); // Burn before any service, model or fallible preflight.
      if (!entry || entry.expires <= clock()) throw researchError("RESEARCH_PLAN_UNAVAILABLE");
      active(callerSignal); entry.binding.assertCurrent();
      running = true;
      const timeout = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, timeout.signal, ...(callerSignal ? [callerSignal] : [])]);
      const timer = setTimeout(() => timeout.abort(), entry.plan.limits.totalTimeoutMs);
      const execution = Promise.resolve().then(() => {
        active(signal); return execute({ ...entry, signal });
      }).finally(() => { running = false; });
      execution.catch(() => {});
      try {
        const result = await cancellable(signal, () => execution);
        active(signal); entry.binding.assertCurrent();
        return result;
      } finally { clearTimeout(timer); timeout.abort(); }
    },
    close() { plans.clear(); lifetime.abort(); },
  });
}
