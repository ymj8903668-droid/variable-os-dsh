// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import ApprovalService from "@deepseek-ai/dsh-user-approval";

// Compose the pinned native loop in a separate root, never host.extend/isolate:
// scoped services alone do not exclude the host's global session subscribers.
export async function createPersonalAgentRuntime({ llm } = {}) {
  if (typeof llm?.prepareCall !== "function" || typeof llm?.stream !== "function") {
    throw new TypeError("personal native runtime requires the selected Host LLM service");
  }
  const ctx = new Context();
  const fibers = [];
  const lifetime = new AbortController();
  const creations = new Set();
  let closed = false;
  let disposal;
  const closedError = () => Object.assign(new Error("personal native runtime is closed"),
    { code: "PERSONAL_AGENT_RUNTIME_CLOSED" });
  const assertOpen = () => {
    if (closed) throw closedError();
  };
  const dispose = () => {
    if (disposal) return disposal;
    closed = true;
    const completion = Promise.withResolvers();
    disposal = completion.promise;
    void (async () => {
      const errors = [];
      lifetime.abort();
      const active = ctx.get("agents")?.list() ?? [];
      for (const agent of active) agent.cancel({ kind: "disposed" });
      await Promise.allSettled([...creations]);
      for (const agent of active) {
        try { await agent.whenIdle(); } catch (error) { errors.push(error); }
      }
      // The loop drains its agents before their registries and tools disappear.
      for (const fiber of [...fibers].reverse()) {
        try { await fiber.dispose(); } catch (error) { errors.push(error); }
      }
      try { await ctx.fiber.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "personal native runtime teardown failed");
    })().then(completion.resolve, completion.reject);
    return disposal;
  };
  try {
    // This explicit capability still uses the user's configured model adapter
    // and its LLM policies. No host Context or session services are inherited.
    ctx.provide("llm", Object.freeze({
      prepareCall: (config, signal) => llm.prepareCall(config, signal),
      stream: options => llm.stream(options),
    }));
    for (const [plugin, config] of [
      [SessionStore], [AgentRegistry], [SessionProjectionRegistry],
      [SystemPrompt, { includeRuntimeContext: false }],
      [ToolRuntime, { mode: "native" }],
      [ApprovalService, { policy: "ask" }],
      [AgentLoop, { agents: [], maxParallelToolCalls: 1 }],
    ]) {
      const fiber = ctx.plugin(plugin, config);
      fibers.push(fiber);
      await fiber.await();
    }
    const projectionKey = "variableOsPrivateEvents";
    ctx.sessionProjections.register({ key: projectionKey, stateVersion: 1,
      stateSchema: z.array(z.unknown()), init: () => [],
      apply: (events, event) => [...events, event] });
    const readSessionEvents = session => {
      assertOpen();
      if (!session || ctx.agents.get(session.id)?.session !== session) {
        throw Object.assign(Error("private session is not owned"), { code: "PRIVATE_SESSION_NOT_OWNED" });
      }
      const events = ctx.sessionProjections.stateOf(session, projectionKey);
      if (!Array.isArray(events)) throw Error("PRIVATE_SESSION_PROJECTION_MISSING");
      return structuredClone(events);
    };
    const agents = Object.freeze({
      get: id => closed ? undefined : ctx.agents.get(id),
      async create(options) {
        assertOpen();
        const creation = Promise.resolve().then(async () => {
          assertOpen();
          const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
          const nativeAbort = new AbortController();
          let settingUp = false;
          const abortNative = () => {
            if (signal.aborted && !settingUp) nativeAbort.abort(signal.reason);
          };
          signal.addEventListener("abort", abortNative);
          abortNative();
          try {
            const handle = await ctx.agents.create({ ...options,
              async setup(agentCtx, agent) {
                settingUp = true;
                try {
                  signal.throwIfAborted();
                  // DSH races setup against abort and rolls its scope back.
                  // Notify the callback first; release its resources only
                  // after all returned setup work settles.
                  const result = await options.setup?.(agentCtx, signal, agent);
                  signal.throwIfAborted();
                  return result;
                } finally { settingUp = false; abortNative(); }
              },
              signal: nativeAbort.signal });
            if (signal.aborted) { await handle.dispose(); signal.throwIfAborted(); }
            return handle;
          } catch (error) {
            if (closed) throw closedError();
            throw error;
          } finally { signal.removeEventListener("abort", abortNative); }
        });
        creations.add(creation);
        try { return await creation; } finally { creations.delete(creation); }
      },
      async resume(options) { assertOpen(); return ctx.agents.resume(options); },
    });
    return Object.freeze({ agents, readSessionEvents, dispose });
  } catch (error) {
    await dispose();
    throw error;
  }
}
