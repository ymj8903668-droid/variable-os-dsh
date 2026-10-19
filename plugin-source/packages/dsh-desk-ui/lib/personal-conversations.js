// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { personalResearchPlan } from "./personal-research-plan.js";
import { canonicalHash } from "../../../src/schema/canonical-json.mjs";

// Durable retirement also survives Host replacement when a private history
// store is provided. Failed conversations never reuse the browser's old ID.
export function createPersonalConversations({ createSession, validate, history }) {
  const records = new Map();
  let closed = false, monitor = null;
  const retire = (record, preserve = false) => {
    if (record.retirement) return record.retirement;
    record.retired = true;
    record.active?.controller.abort();
    const active = record.active;
    return record.retirement = (async () => {
      try { if (!preserve || active) history?.retire(record.id, record.binding); }
      finally {
        await record.promise?.then(session => session.dispose(), () => {});
        await active?.done;
      }
    })();
  };
  const revalidate = () => {
    const pending = [];
    for (const record of records.values()) {
      if (!record.retired) {
        try { validate(record.scope); }
        catch { pending.push(retire(record)); }
      } else if (record.retirement) pending.push(record.retirement);
    }
    return Promise.all(pending);
  };
  return Object.freeze({
    has: sessionId => records.has(sessionId),
    revalidate,
    async retireIds(ids) {
      const targets = new Set(ids);
      await Promise.all([...records.values()].filter(record => targets.has(record.id)).map(record => retire(record)));
    },
    async reset(kind) {
      await Promise.all([...records.values()].filter(record => kind === undefined ||
        record.scope.cardSource === kind).map(record => retire(record)));
    },
    async close() {
      closed = true; clearInterval(monitor); monitor = null;
      await Promise.all([...records.values()].map(record => retire(record, true)));
    },
    async call(action, raw, options = {}) {
      if (closed || options.signal?.aborted) throw remoteError("CANCELLED");
      if (!["run", "resume", "cancel", "approve", "list"].includes(action)) throw remoteError("METHOD_NOT_ALLOWED");
      const listing = action === "list";
      if (options.personalDraftApproval !== undefined && typeof options.personalDraftApproval !== "boolean") {
        throw remoteError("INVALID_REQUEST");
      }
      const personalDraftApproval = options.personalDraftApproval === true;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        !listing && (typeof raw.sessionId !== "string" || !/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(raw.sessionId)) ||
        typeof raw.card !== "string" || !raw.card || raw.card.length > 200) throw remoteError("INVALID_REQUEST");
      const sessionId = raw.sessionId;
      const scope = Object.freeze({ card: raw.card, cardSource: options.cardSource ?? "api",
        sourceRevision: options.sourceRevision, imaEvidenceId: options.imaEvidenceId ?? null,
        wikiSourceRevision: options.wikiSourceRevision ?? null,
        ...(options.cardSource === "published" ? {publicationKey:action === "cancel"
          ? records.get(sessionId)?.scope.publicationKey ?? null : options.publicationKey} : {}),
        researchPlan: personalResearchPlan(raw.researchPlan) });
      const key = JSON.stringify(scope);
      const binding = canonicalHash({ scope, personalDraftApproval });
      if (listing) {
        if (!history) throw remoteError("METHOD_NOT_ALLOWED");
        if (Object.keys(raw).some(key => !["action", "card", "researchPlan", "cursor"].includes(key))) {
          throw remoteError("INVALID_REQUEST");
        }
        validate(scope);
        return history.list(binding, { cursor: raw.cursor });
      }
      let record = records.get(sessionId);
      if (record && (record.key !== key || record.personalDraftApproval !== personalDraftApproval)) {
        throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
      }
      if (action === "approve") {
        if (!personalDraftApproval) throw remoteError("METHOD_NOT_ALLOWED");
        if (!record || record.retired || !record.active) throw remoteError("XIAOMEI_APPROVAL_NOT_PENDING");
        if (typeof raw.approvalId !== "string" || !/^personal-approval-[a-f0-9-]{36}$/.test(raw.approvalId) ||
          !["allowed-once", "rejected"].includes(raw.outcome)) throw remoteError("INVALID_REQUEST");
        const input = Object.freeze({ sessionId, approvalId: raw.approvalId, outcome: raw.outcome });
        const active = record.active;
        const signal = AbortSignal.any([active.signal, ...(options.signal ? [options.signal] : [])]);
        const stop = () => {
          if (record.active === active && !record.retired) void retire(record).catch(() => {});
        };
        const assertCurrent = () => {
          if (signal.aborted) throw remoteError("CANCELLED");
          if (closed || record.retired || record.active !== active) throw remoteError("XIAOMEI_APPROVAL_NOT_PENDING");
          try { validate(record.scope); } catch (error) { stop(); throw error; }
        };
        // A lost control request must also stop a session adapter that does
        // not consume its approval signal, without touching a replacement run.
        signal.addEventListener("abort", stop, { once: true });
        try {
          assertCurrent();
          const session = await record.promise;
          assertCurrent();
          const result = await session.approve(input, { signal });
          assertCurrent();
          return result;
        } finally { signal.removeEventListener("abort", stop); }
      }
      if (action === "cancel") {
        // A cancelled HTTP run can arrive after its cancellation. Reserve the
        // ID now so that the delayed admission cannot start a fresh model.
        if (!record) {
          history?.retire(sessionId, binding);
          record = { id: sessionId, binding, scope, key, retired: true, active: null, retirement: Promise.resolve() };
          Object.defineProperty(record, "personalDraftApproval", { value: personalDraftApproval });
          records.set(sessionId, record);
        }
        const active = record.active;
        await retire(record);
        return { sessionId, retired: true, cancelled: Boolean(active), receipt: {
          receiptId: typeof raw.receiptId === "string" && /^cancel-[a-z0-9-]{16,112}$/.test(raw.receiptId)
            ? raw.receiptId : `cancel-${sessionId.slice(14)}`,
          status: active ? "cancelled" : "not-active", turnEndSeq: null,
          components: { model: "UNKNOWN", tool: "UNKNOWN", approval: "not-active" },
        } };
      }
      if (raw.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
      if (record?.retired) throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
      if (record?.active) throw remoteError("XIAOMEI_AGENT_BUSY");
      if (!record && action === "resume" && !history) throw remoteError("XIAOMEI_SESSION_NOT_FOUND");
      try { validate(scope); }
      catch (error) {
        if (record) {
          await retire(record);
          throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
        }
        throw error;
      }
      const lease = history?.begin(sessionId, binding, { resume: action === "resume", revision: record?.revision });
      if (!record) {
        const sessionOptions = Object.freeze({ personalDraftApproval,
          ...(lease ? { checkpoint: lease.checkpoint } : {}) });
        record = { id: sessionId, binding, scope, key, retired: false, active: null,
          promise: Promise.resolve().then(() => createSession(scope, sessionOptions)) };
        Object.defineProperty(record, "personalDraftApproval", { value: personalDraftApproval });
        records.set(sessionId, record);
        if (!monitor) {
          // Another Host can replace the shared profile without a browser
          // connection. Observe only local configuration, never paid sources.
          monitor = setInterval(() => {
            void revalidate().catch(() => {
              // The retired record retains a rejected disposal for subsequent
              // calls/close; it cannot return to an executable state.
            });
          }, 1000);
          monitor.unref();
        }
      }
      const controller = new AbortController(), completion = Promise.withResolvers();
      const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
      record.active = { controller, signal, done: completion.promise };
      // Capture only the user question. Context and routing are Host-owned.
      const input = { sessionId, question: raw.question, modelUseAllowed: true };
      try {
        const session = await record.promise;
        if (record.retired || signal.aborted) throw remoteError("CANCELLED");
        validate(scope);
        const buffered = [];
        const result = await session[action](input, { signal,
          onEvent: lease ? value => buffered.push(value) : options.onEvent, onApproval: options.onApproval });
        if (record.retired || signal.aborted) throw remoteError("CANCELLED");
        validate(scope);
        if (lease) {
          record.revision = lease.finish(session.checkpoint());
          for (const value of buffered) {
            if (record.retired || signal.aborted) throw remoteError("CANCELLED");
            try { options.onEvent?.(value); } catch { /* UI observers cannot alter a committed turn. */ }
          }
        }
        return result;
      } catch (error) {
        if (personalDraftApproval && error?.code === "AUTO_JUDGMENT_CAPACITY" && !record.retired && !signal.aborted) {
          // Capacity admission completed its final proof without starting a
          // native turn. Keep its history only while the Host scope still holds.
          try { validate(scope); } catch (changed) { error = changed; }
          if (error?.code === "AUTO_JUDGMENT_CAPACITY") {
            if (lease) record.revision = lease.release();
            throw error;
          }
        }
        record.retired = true;
        controller.abort();
        try { history?.retire(sessionId, binding); }
        finally { await record.promise.then(session => session.dispose(), () => {}); }
        throw error;
      } finally { record.active = null; completion.resolve(); }
    },
  });
}
