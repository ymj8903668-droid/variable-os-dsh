// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { performance } from "node:perf_hooks";
import { providerError, runCancellable, sourceError } from "./errors.mjs";

export const IMA_SESSION_LIMITS = Object.freeze({
  apiRequests: 20, downloads: 3, maxFileBytes: 4 * 1024 * 1024,
  requestTimeoutMs: 30000, totalTimeoutMs: 90000,
});

// The Host must obtain approval for the complete allowance before opening this
// profile. These are hard ceilings, not an allowance silently granted per round.
export const IMA_RESEARCH_LIMITS = Object.freeze({
  ...IMA_SESSION_LIMITS, apiRequests: 80, downloads: 8, totalTimeoutMs: 1800000,
});

export function createImaSessionBudget(options = {}) {
  return createBudget(options, IMA_SESSION_LIMITS, "session");
}

export function createImaResearchBudget(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["limits", "signal", "nowMs"].includes(key))
    || !["apiRequests", "downloads", "totalTimeoutMs"].every(key => Object.hasOwn(options.limits ?? {}, key))) {
    throw providerError("SOURCE_UNAVAILABLE", "IMA_BUDGET_INVALID");
  }
  return createBudget(options, IMA_RESEARCH_LIMITS, "research");
}

function createBudget({
  limits: configured = {}, signal: callerSignal, nowMs = () => performance.now(),
} = {}, ceilings, profile) {
  if (!configured || typeof configured !== "object" || Array.isArray(configured)
    || Object.keys(configured).some((key) => !Object.hasOwn(IMA_SESSION_LIMITS, key))
    || typeof nowMs !== "function"
    || (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))) {
    throw providerError("SOURCE_UNAVAILABLE", "IMA_BUDGET_INVALID");
  }
  const limits = Object.freeze({ ...ceilings, ...configured });
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) {
      throw providerError("SOURCE_UNAVAILABLE", "IMA_BUDGET_INVALID");
    }
  }
  let started;
  try { started = nowMs(); } catch { /* Refuse an unusable caller-supplied clock. */ }
  if (!Number.isFinite(started)) throw providerError("SOURCE_UNAVAILABLE", "IMA_CLOCK_INVALID");
  let lastNow = started, status = "ACTIVE", deadlineTimer, pending = 0;
  const counts = { apiRequests: 0, downloads: 0 }, controller = new AbortController();
  const cancel = () => terminate("CANCELLED");
  function terminate(next) {
    if (status !== "ACTIVE") return;
    status = next;
    clearTimeout(deadlineTimer);
    callerSignal?.removeEventListener("abort", cancel);
    controller.abort();
  }
  function terminalError() {
    if (status === "EXPIRED") return providerError("SOURCE_UNAVAILABLE", "IMA_SESSION_TIMEOUT");
    if (status === "FAILED") return providerError("SOURCE_UNAVAILABLE", "IMA_CLOCK_INVALID");
    return providerError("CANCELLED");
  }
  function clock() {
    let value;
    try { value = nowMs(); } catch { /* Clock errors cannot expose caller data. */ }
    if (!Number.isFinite(value) || value < lastNow) {
      terminate("FAILED");
      throw providerError("SOURCE_UNAVAILABLE", "IMA_CLOCK_INVALID");
    }
    lastNow = value;
    return value;
  }
  function assertActive() {
    if (status !== "ACTIVE") throw terminalError();
    if (callerSignal?.aborted) { terminate("CANCELLED"); throw terminalError(); }
    const at = clock();
    if (at - started >= limits.totalTimeoutMs) { terminate("EXPIRED"); throw terminalError(); }
    return at;
  }
  if (callerSignal?.aborted) cancel();
  else {
    callerSignal?.addEventListener("abort", cancel, { once: true });
    deadlineTimer = setTimeout(() => terminate("EXPIRED"), limits.totalTimeoutMs);
    deadlineTimer.unref();
  }

  return Object.freeze({
    limits, profile, signal: controller.signal,
    close() { terminate("CLOSED"); },
    snapshot() {
      let elapsedMs = null;
      try {
        elapsedMs = clock() - started;
        if (status === "ACTIVE" && elapsedMs >= limits.totalTimeoutMs) terminate("EXPIRED");
      } catch { /* Missing elapsed time stays null; counters remain inspectable. */ }
      return Object.freeze({ ...counts, pending, status, elapsedMs });
    },
    async run(kind, operation) {
      if (!["api", "download"].includes(kind) || typeof operation !== "function") {
        throw providerError("SOURCE_UNAVAILABLE", "IMA_OPERATION_INVALID");
      }
      const requestedAt = assertActive(), field = kind === "api" ? "apiRequests" : "downloads";
      if (counts[field] >= limits[field]) {
        throw providerError("SOURCE_UNAVAILABLE", kind === "api"
          ? "IMA_API_BUDGET_EXHAUSTED" : "IMA_DOWNLOAD_BUDGET_EXHAUSTED");
      }
      // Reserve before yielding so parallel readers cannot overdraw the session.
      counts[field]++;
      pending++;
      const timeout = new AbortController();
      const requestSignal = AbortSignal.any([controller.signal, timeout.signal]);
      const remainingMs = limits.totalTimeoutMs - (requestedAt - started);
      const sessionLimited = remainingMs <= limits.requestTimeoutMs;
      const checkpoint = () => {
        if (assertActive() - requestedAt >= limits.requestTimeoutMs || timeout.signal.aborted) {
          timeout.abort();
          throw providerError("SOURCE_UNAVAILABLE", "IMA_REQUEST_TIMEOUT");
        }
      };
      const timer = setTimeout(() => sessionLimited ? terminate("EXPIRED") : timeout.abort(),
        Math.ceil(Math.min(limits.requestTimeoutMs, remainingMs)));
      try {
        const value = await runCancellable(requestSignal, () => {
          checkpoint();
          return operation(requestSignal, checkpoint);
        });
        checkpoint();
        return value;
      } catch (error) {
        if (status !== "ACTIVE") throw terminalError();
        // A late callback cannot win because timer delivery was briefly delayed.
        checkpoint();
        throw sourceError(error);
      } finally {
        clearTimeout(timer);
        pending--;
      }
    },
  });
}
