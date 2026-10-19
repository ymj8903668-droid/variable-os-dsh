// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createDuplexCallService } from "../../../src/http/research-host-duplex.mjs";
import { personalResearchPlan } from "./personal-research-plan.js";
import { VOICE_CREDENTIAL_REF } from "./voice-service-settings.js";

const fail = code => Object.assign(Error(code), { code });
const identity = value => value?.[Symbol.for("cordis.original")] ?? value;
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
async function readUntilAbort(operation, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(fail("DUPLEX_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (signal.aborted) throw fail("DUPLEX_CANCELLED");
      return operation();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
function scopeOf(value) {
  const keys = ["card", "cardSource", "sourceRevision", "imaEvidenceId", "wikiSourceRevision",
    "voiceRevision", "researchPlan", "modelUseAllowed", "audioUseAllowed", "summaryUseAllowed"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))
    || ["modelUseAllowed", "audioUseAllowed", "summaryUseAllowed"].some(key => value[key] !== true)
    || typeof value.card !== "string" || !value.card || value.card.length > 200
    || !["api", "ima"].includes(value.cardSource) || !revision(value.sourceRevision)
    || !revision(value.voiceRevision) || (value.cardSource === "api"
      ? value.imaEvidenceId !== null || value.wikiSourceRevision !== null
      : typeof value.imaEvidenceId !== "string" || !value.imaEvidenceId || !revision(value.wikiSourceRevision))) {
    throw fail("DUPLEX_CONTEXT_INVALID");
  }
  try { return Object.freeze({ ...value, researchPlan: personalResearchPlan(value.researchPlan) }); }
  catch { throw fail("DUPLEX_CONTEXT_INVALID"); }
}

/** Personal calls never accept a browser dossier. Only references and explicit
 * consent cross ingress; proof and native research stay in the owning Host. */
export function createPersonalDuplex({ voiceSettings, credentials, createProvider,
  currentSelection, admit, validate, prove, runResearch, retireResearch }) {
  let active = null, closed = false;
  const used = new Set();
  const configured = () => typeof createProvider === "function" && typeof credentials()?.resolve === "function";
  const status = signal => voiceSettings.call("voiceServiceStatus", {}, { signal });
  const selection = () => {
    const value = currentSelection();
    if (!value || typeof value.provider !== "string" || !value.provider
      || typeof value.model !== "string" || !value.model) throw fail("DUPLEX_CONTEXT_INVALID");
    return JSON.stringify([value.provider, value.model, value.reasoningEffort ?? null]);
  };
  const assertScope = record => {
    validate(record.scope);
    if (record.selection !== selection()) throw fail("DUPLEX_CONTEXT_CHANGED");
  };
  async function check(record) {
    if (closed || record.controller.signal.aborted || active !== record) throw fail("DUPLEX_CANCELLED");
    assertScope(record);
    const state = await status(record.controller.signal);
    if (!configured() || !state.configured || state.revision !== record.scope.voiceRevision
      || identity(credentials()) !== record.credentialIdentity) throw fail("DUPLEX_CONTEXT_CHANGED");
    if (closed || record.controller.signal.aborted || active !== record) throw fail("DUPLEX_CANCELLED");
    assertScope(record);
  }
  async function proof(record) {
    await check(record);
    const value = await prove(record.scope, { signal: record.controller.signal });
    await check(record);
    if (typeof value !== "string" || !revision(value)
      || record.proof !== undefined && record.proof !== value) throw fail("DUPLEX_CONTEXT_CHANGED");
    record.proof = value;
  }
  function retire(record = active) {
    if (!record) return Promise.resolve();
    if (record.retirement) return record.retirement;
    record.controller.abort();
    clearInterval(record.timer);
    record.retirement = (async () => {
      // Stop cloud output immediately, then wait for admission, native work
      // and the owned transport before allowing another call.
      const transport = record.service?.close();
      await record.startup.promise;
      await transport;
      await retireResearch(record.sessionId, record.scope);
      if (active === record) active = null;
    })();
    return record.retirement;
  }
  return Object.freeze({
    async availability() {
      const state = await status();
      return { configured: configured() && state.configured, active: active !== null,
        revision: state.revision };
    },
    retire,
    isActive: () => active !== null,
    ownsSession: sessionId => used.has(sessionId),
    async close() { closed = true; await retire(); },
    async start(input, { emit, signal } = {}) {
      if (closed || signal?.aborted) throw fail("DUPLEX_CANCELLED");
      if (active) throw fail("DUPLEX_BUSY");
      if (!/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(input?.sessionId ?? "")) throw fail("DUPLEX_CONTEXT_INVALID");
      const scope = scopeOf(input.context);
      if (!configured()) throw fail("DUPLEX_KEY_UNAVAILABLE");
      if (used.has(input.sessionId) || used.size >= 256) throw fail("DUPLEX_CONTEXT_CHANGED");
      try { admit(input.sessionId, scope); } catch { throw fail("DUPLEX_CONTEXT_CHANGED"); }
      const record = { sessionId: input.sessionId, scope, controller: new AbortController(),
        credentialIdentity: identity(credentials()), selection: selection(), startup: Promise.withResolvers() };
      active = record;
      used.add(record.sessionId);
      const abort = () => { void retire(record).catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      record.service = createDuplexCallService({
        hasKey: async () => (await status()).configured,
        loadKey: async () => {
          await check(record);
          const key = await readUntilAbort(() => credentials().resolve(VOICE_CREDENTIAL_REF), record.controller.signal);
          await check(record);
          if (typeof key?.value !== "string" || !/^[A-Za-z0-9._~-]{1,512}$/.test(key.value)) {
            throw fail("DUPLEX_KEY_UNAVAILABLE");
          }
          return key.value;
        },
        beforeStart: () => proof(record),
        createProvider,
        runResearch: async ({ question }, options) => {
          try {
            await proof(record);
            const events = [];
            const result = await runResearch(record.sessionId, question, scope, {
              signal: AbortSignal.any([record.controller.signal, options.signal]),
              onEvent: event => events.push(event),
            });
            await proof(record);
            for (const event of events) options.onEvent(event);
            // Even a successful turn covers a selected source, not all facts.
            return { sessionId: record.sessionId, presentation: result.presentation,
              stepLimitHit: result.stepLimitHit, researchStatus: "partial" };
          } catch {
            abort();
            throw fail("DUPLEX_RESEARCH_FAILED");
          }
        },
      });
      try {
        const handle = await record.service.start({ sessionId: record.sessionId, context: {} }, {
          signal: record.controller.signal,
          emit: async value => {
            if (value.type !== "closed" && record.controller.signal.aborted) return;
            await emit(value);
            if (value.type === "closed") abort();
          },
        });
        record.startup.resolve();
        await check(record);
        let inspecting = false;
        record.timer = setInterval(() => {
          if (inspecting) return;
          inspecting = true;
          void check(record).catch(abort).finally(() => { inspecting = false; });
        }, 1000);
        record.timer.unref();
        return { id: handle.id, close: () => retire(record) };
      } catch (error) {
        record.startup.resolve();
        await retire(record);
        throw fail(error?.message === "DUPLEX_KEY_UNAVAILABLE" ? error.message : "DUPLEX_CONTEXT_CHANGED");
      } finally {
        // Keep the transport abort listener until the call's own signal ends.
        record.controller.signal.addEventListener("abort", () => signal?.removeEventListener("abort", abort), { once: true });
        if (record.controller.signal.aborted) signal?.removeEventListener("abort", abort);
      }
    },
    async control(input) {
      const record = active;
      if (!record) throw fail("DUPLEX_CALL_NOT_FOUND");
      if (input.action === "hangup") {
        await record.service.control(input);
        await retire(record);
        return { ok: true };
      }
      try { await check(record); }
      catch { await retire(record); throw fail("DUPLEX_CONTEXT_CHANGED"); }
      return record.service.control(input);
    },
  });
}
