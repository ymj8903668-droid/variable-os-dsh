// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const PERSONAL_NARRATION_CODES = new Set([
  "NARRATION_INVALID_INPUT", "NARRATION_CONSENT_REQUIRED", "NARRATION_UNAVAILABLE",
  "NARRATION_NOT_OWNER", "NARRATION_BUSY", "NARRATION_CONTROL_FAILED",
  "NARRATION_START_FAILED", "NARRATION_CANCELLED", "DUPLEX_VOICE_OWNED",
]);
export const LOCAL_AUDITION_TEXT = "这是本机语音试听。你可以随时点打断停止播放。";
const fail = code => Object.assign(Error(code), { code });
const object = value => value && typeof value === "object" && !Array.isArray(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// One Host output device, with explicit ownership and source-bound admission.
// This service does not fetch a model, upload text or accept an executable.
export function createPersonalNarration({ device, validate, prove, blocked = () => false,
  now = () => performance.now() }) {
  let active = null, closed = false;
  const available = () => !closed && device?.status().result?.available === true;
  const snapshot = () => ({ available: available(), backend: "macos-say",
    state: active?.retirement ? "stopping" : active?.pending ? "starting"
      : device?.status().result?.state ?? "idle" });
  function reap() {
    if (active && !active.pending && !active.retirement && device.status().result.state === "idle") {
      clearInterval(active.timer); active = null;
    }
  }
  function assertCurrent(record) {
    if (closed || active !== record || record.controller.signal.aborted) throw fail("NARRATION_CANCELLED");
    if (blocked()) throw fail("DUPLEX_VOICE_OWNED");
    if (record.context) validate(record.context);
  }
  async function retire(record = active) {
    if (!record) return;
    if (record.retirement) return record.retirement;
    if (active !== record) return;
    record.controller.abort(); clearInterval(record.timer);
    record.retirement = (async () => {
      await record.ready.promise;
      const result = await device.call({ action: "stop" });
      if (!result.ok || result.result?.state !== "idle") throw fail("NARRATION_CONTROL_FAILED");
      if (active === record) active = null;
    })();
    try { await record.retirement; }
    finally { record.retirement = null; }
  }
  async function revalidate() {
    reap();
    if (!active || active.retirement) return;
    const record = active;
    try {
      assertCurrent(record);
      if (now() < record.lastSeen || now() - record.lastSeen > 5000) throw fail("NARRATION_CANCELLED");
    } catch { await retire(record); }
  }
  return Object.freeze({
    availability: () => ({ available: available(), backend: "macos-say" }),
    retire, revalidate,
    async close() {
      closed = true;
      try { await retire(); } finally { await device?.dispose(); }
    },
    async call(input, { signal } = {}) {
      if (!object(input) || !["start", "preview", "status", "pause", "resume", "stop"].includes(input.action)
        || typeof input.playbackId !== "string" || !/^[a-f0-9-]{36}$/.test(input.playbackId)) {
        throw fail("NARRATION_INVALID_INPUT");
      }
      const starting = ["start", "preview"].includes(input.action);
      const keys = starting ? ["action", "playbackId", "audioUseAllowed", "rate",
        ...(input.action === "start" ? ["text", "context"] : [])] : ["action", "playbackId"];
      if (Object.keys(input).some(key => !keys.includes(key))) throw fail("NARRATION_INVALID_INPUT");
      if (starting && input.audioUseAllowed !== true) throw fail("NARRATION_CONSENT_REQUIRED");
      if (starting && ![0.8, 1, 1.2].includes(input.rate)) throw fail("NARRATION_INVALID_INPUT");
      if (closed || signal?.aborted) throw fail("NARRATION_CANCELLED");
      if (!available()) throw fail("NARRATION_UNAVAILABLE");
      reap();
      if (!starting) {
        if (!active) {
          if (["stop", "status"].includes(input.action)) return snapshot();
          throw fail("NARRATION_NOT_OWNER");
        }
        if (active.id !== input.playbackId) throw fail("NARRATION_NOT_OWNER");
        if (input.action === "stop") { await retire(); return snapshot(); }
        await revalidate();
        if (!active) {
          if (input.action === "status") return snapshot();
          throw fail("NARRATION_CANCELLED");
        }
        active.lastSeen = now();
        if (input.action === "status") return snapshot();
        const record = active;
        if (record.pending || record.retirement) throw fail("NARRATION_BUSY");
        try {
          assertCurrent(record);
          if (input.action === "resume" && record.context) {
            await prove(record.context, { signal: signal
              ? AbortSignal.any([signal, record.controller.signal]) : record.controller.signal });
            assertCurrent(record);
            if (signal?.aborted) throw fail("NARRATION_CANCELLED");
          }
          const result = await device.call({ action: input.action });
          if (!result.ok) throw fail("NARRATION_CONTROL_FAILED");
          return snapshot();
        } catch (error) { await retire(record); throw error; }
      }
      if (active) throw fail("NARRATION_BUSY");
      let context = null;
      if (input.action === "start") {
        const value = input.context;
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 900
          || !object(value) || Object.keys(value).some(key =>
            !["card", "cardSource", "sourceRevision", "imaEvidenceId"].includes(key))
          || typeof value.card !== "string" || !value.card || value.card.length > 200
          || !["api", "ima"].includes(value.cardSource) || !revision(value.sourceRevision)
          || (value.cardSource === "api" ? value.imaEvidenceId !== null
            : typeof value.imaEvidenceId !== "string" || !/^wiki:ima:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value.imaEvidenceId))) {
          throw fail("NARRATION_INVALID_INPUT");
        }
        context = Object.freeze({ ...value }); validate(context);
      }
      if (blocked()) throw fail("DUPLEX_VOICE_OWNED");
      const record = { id: input.playbackId, context, pending: true, lastSeen: now(),
        controller: new AbortController(), ready: Promise.withResolvers() };
      active = record;
      const abort = () => record.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let error;
      try {
        assertCurrent(record);
        if (context) await prove(context, { signal: record.controller.signal });
        assertCurrent(record);
        const result = await device.call({ action: "start", rate: input.rate,
          text: context ? input.text : LOCAL_AUDITION_TEXT });
        if (!result.ok) throw fail("NARRATION_START_FAILED");
        assertCurrent(record);
      } catch (caught) { error = caught; }
      finally {
        signal?.removeEventListener("abort", abort);
        record.pending = false; record.ready.resolve();
      }
      if (error) { await retire(record); throw error; }
      record.lastSeen = now();
      record.timer = setInterval(() => { void revalidate().catch(() => {}); }, 1000);
      record.timer.unref();
      return snapshot();
    },
  });
}
