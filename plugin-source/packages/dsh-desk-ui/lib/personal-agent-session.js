// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createPersonalAgentRuntime } from "./personal-agent-runtime.js";
import { createXiaomeiAgentManager, normalizeXiaomeiAgentRequest } from "../../../src/runtime/harness-research-host-agent.mjs";
import { createPersonalTurnResearch } from "./personal-turn-research.js";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { readPersonalNativeCheckpoint } from "../../../src/runtime/personal-native-checkpoint.mjs";

function readCheckpoint(value, card, drafts) {
  try {
    if (!value || Object.keys(value).sort().join(",") !== "card,disclosures,drafts,native,schema" ||
      value.schema !== "personal-conversation-v1" || value.card !== card || value.drafts !== drafts ||
      !Array.isArray(value.disclosures) || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw Error();
    return { ...structuredClone(value), native: readPersonalNativeCheckpoint(value.native) };
  } catch { throw remoteError("RESEARCH_CHECKPOINT_INVALID"); }
}

/** One card and one isolated native conversation with optional proven history.
 * The browser cannot choose its desk, checkpoint, source inputs or context. */
export function createPersonalAgentSession({ desk, card, llm, currentSelection, createUserMessage, createBlockAssembler, publishedResearch, runJudgment, outputGuard = runJudgment, checkpoint }) {
  if (typeof desk?.withResearchTurn !== "function" || typeof card !== "string" || !card ||
    typeof currentSelection !== "function") throw new TypeError("private native conversation requires a proven desk and card");
  if (runJudgment && (typeof runJudgment.admitTurn !== "function" ||
    typeof runJudgment.withinTurn !== "function" || typeof runJudgment.validateOutput !== "function")) {
    throw new TypeError("personal drafts require the shared Host judgment service");
  }
  if (outputGuard && (typeof outputGuard.admitTurn !== "function" || typeof outputGuard.validateOutput !== "function")) {
    throw new TypeError("personal output requires the shared Host disclosure guard");
  }
  let runtime, manager, activeTurn, route, running, sessionId, closed = false, tainted = false, disposal, releasing;
  let saved = checkpoint === undefined ? null : readCheckpoint(checkpoint, card, Boolean(runJudgment));
  let restore = saved;
  sessionId = saved?.native.sessionId;
  const lifetime = new AbortController();
  const syntheses = new Set();
  let disclosures = saved?.disclosures ?? [];
  const synthesisLlm = {
    async *stream(options) {
      if (options.signal?.aborted) throw remoteError("CANCELLED");
      const completion = Promise.withResolvers();
      syntheses.add(completion.promise);
      try { yield* llm.stream(options); }
      finally { syntheses.delete(completion.promise); completion.resolve(); }
    },
  };
  const release = () => releasing ??= (async () => {
    await Promise.allSettled([...syntheses]);
    try { await manager?.dispose(); } finally { disclosures = []; await runtime?.dispose(); }
  })();
  const validateOutput = value => outputGuard
    ? outputGuard.validateOutput({ turn: activeTurn, value, history: disclosures })
    : activeTurn.validateOutput({ history: disclosures, value }).value;
  const ensureManager = async () => {
    if (manager) return;
    const created = await createPersonalAgentRuntime({ llm });
    if (closed || activeTurn.signal.aborted) {
      await created.dispose();
      throw remoteError("CANCELLED");
    }
    runtime = created;
    manager = createXiaomeiAgentManager({
      sourceScope: "personal", agents: runtime.agents, createUserMessage,
      readSessionEvents: runtime.readSessionEvents,
      personalDraftApproval: Boolean(runJudgment),
      currentSelection: () => route,
      proveSource: async () => {
        await publishedResearch?.prove({ signal: activeTurn.signal });
        return activeTurn.proveSource();
      },
      broker: async ({ toolId, args, context }) => {
        try {
          let result;
          if (toolId === "expandEvidence") {
            const id = args.evidenceId || context.evidence[0]?.id;
            result = { ok: true, summary: "已读取当前卡片的冻结证据。",
              data: await activeTurn.readEvidence(id) };
          } else if (toolId === "deepResearch") {
            const research = createPersonalTurnResearch(activeTurn, {
              llm: synthesisLlm, currentSelection: () => route, createUserMessage, createBlockAssembler,
            }, publishedResearch);
            result = { ok: true, summary: publishedResearch
              ? "已研究当前卡片与授权 API 补证；检索范围及联网状态见回执。"
              : "已研究当前卡片资料；未进行资料库或联网检索。",
              data: await research({ topic: args.topic || context.title, signal: activeTurn.signal }) };
          } else if (toolId === "draftJudgment" && runJudgment) {
            try {
              const draft = await runJudgment.withinTurn({
                turn: activeTurn, card, selection: route, history: disclosures,
              });
              result = { ok: true, summary: "研判草稿已生成；仍需人工确认后正式提交。",
                data: { ok: true, result: draft } };
            } catch (error) {
              if (!["AUTO_JUDGMENT_OUTPUT_INVALID", "AUTO_JUDGMENT_IN_PROGRESS", "AUTO_JUDGMENT_CAPACITY"].includes(error?.code)) throw error;
              result = { ok: false, summary: "研判草稿未生成，当前人工草稿没有变化。",
                data: { ok: false, error: { code: error.code } } };
            }
          } else throw remoteError("METHOD_NOT_ALLOWED");
          // Check cumulative disclosure before the new result enters the
          // native log; a later turn must not complete an earlier body fragment.
          const checked = await validateOutput(result);
          disclosures.push(checked);
          if (toolId === "draftJudgment" && checked.ok) running.drafts.add(JSON.stringify(checked.data));
          return checked;
        } catch (error) {
          if (!activeTurn.signal.aborted) {
            running.toolFailure = true;
            running.controller.abort();
          }
          throw remoteError("SOURCE_UNAVAILABLE");
        }
      },
    });
  };
  const execute = async (method, raw, { signal, onEvent, onApproval } = {}) => {
    if (raw?.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
    if (closed) throw remoteError("CANCELLED");
    if (tainted) throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
    if (running) throw remoteError("XIAOMEI_AGENT_BUSY");
    if (runJudgment && typeof onApproval !== "function") throw remoteError("XIAOMEI_APPROVAL_CHANNEL_REQUIRED");
    const input = normalizeXiaomeiAgentRequest({
      sessionId: raw.sessionId, question: method === "run" ? raw.question : "恢复当前会话。",
    });
    if (method === "resume" && !sessionId) throw remoteError("XIAOMEI_SESSION_NOT_FOUND");
    if (sessionId && input.sessionId !== sessionId) throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
    sessionId = input.sessionId;
    // Do not retain the caller's mutable selection or request objects.
    const selected = currentSelection();
    route = selected ? { provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) } : {};
    const controller = new AbortController(), completion = Promise.withResolvers();
    running = { controller, done: completion.promise, drafts: new Set() };
    const combined = AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    let work, admittedHistory, admissionRefused = false;
    try {
      const output = await desk.withResearchTurn({ card, modelUseAllowed: true }, turn => {
        activeTurn = turn;
        work = (async () => {
          if (outputGuard && !(await outputGuard.admitTurn(turn)).ok) {
            return { failure: "AUTO_JUDGMENT_CAPACITY" };
          }
          await ensureManager();
          if (restore) {
            await validateOutput(restore);
            await manager.restoreCheckpoint({ sessionId, modelUseAllowed: true, checkpoint: restore.native },
              { signal: turn.signal });
            restore = null;
          }
          const events = [];
          const result = await manager[method]({ ...input, modelUseAllowed: true }, {
            signal: turn.signal, onEvent: value => events.push(value), onApproval,
          });
          await publishedResearch?.prove({ signal: turn.signal });
          // Only this turn's validated broker output may populate an editable
          // draft. The native manager still forbids arbitrary personal actions.
          const delivered = events.map(event => event.type === "tool-result" &&
            event.toolId === "draftJudgment" && event.status === "success" &&
            running.drafts.has(event.dataJson)
            ? { ...event, uiAction: { type: "APPLY_JUDGMENT_DRAFT", cardId: card } } : event);
          const output = await validateOutput({ result, events: delivered });
          if (method === "run") disclosures.push(output);
          const history = readCheckpoint({ schema: "personal-conversation-v1", card,
            drafts: Boolean(runJudgment), disclosures, native: manager.checkpoint({ sessionId }) }, card, Boolean(runJudgment));
          admittedHistory = activeTurn.validateOutput({ history: disclosures, value: history }).value;
          return output;
        })();
        return work;
      }, { signal: combined });
      if (combined.aborted) throw remoteError("CANCELLED");
      if (output.failure === "AUTO_JUDGMENT_CAPACITY") {
        admissionRefused = true;
        throw remoteError(output.failure);
      }
      saved = admittedHistory;
      for (const event of output.events) {
        try { onEvent?.(event); } catch { /* A UI subscriber cannot alter a proven native turn. */ }
        if (combined.aborted) throw remoteError("CANCELLED");
      }
      return output.result;
    } catch (error) {
      if (admissionRefused) throw error;
      const toolFailure = running.toolFailure;
      tainted = true;
      saved = null;
      controller.abort();
      // Source proof can settle before a late native setup/model callback.
      // Drain that work before disposing or accepting any further request.
      await work?.catch(() => {});
      await release();
      throw toolFailure ? remoteError("SOURCE_UNAVAILABLE") : error;
    } finally {
      activeTurn = null;
      running = null;
      completion.resolve();
    }
  };
  return Object.freeze({
    checkpoint() {
      if (!saved || closed || tainted || running) throw remoteError("RESEARCH_CHECKPOINT_UNAVAILABLE");
      return structuredClone(saved);
    },
    run: (input, options) => execute("run", input, options),
    resume: (input, options) => execute("resume", input, options),
    async approve(input) {
      if (!runJudgment || closed || tainted || !running || running.controller.signal.aborted ||
        input?.sessionId !== sessionId || !manager) throw remoteError("XIAOMEI_APPROVAL_NOT_PENDING");
      return manager.approve({ sessionId, approvalId: input.approvalId, outcome: input.outcome });
    },
    async cancel(input) {
      if (input?.sessionId !== sessionId) throw remoteError("XIAOMEI_SESSION_NOT_FOUND");
      const active = running;
      active?.controller.abort();
      await active?.done;
      return { sessionId, cancelled: Boolean(active) };
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      lifetime.abort();
      disposal = (async () => { await running?.done; await release(); })();
      return disposal;
    },
  });
}
