// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";

const SCHEMA = "personal-native-history-v1";
const TYPES = new Set(["user/message", "turn/start", "step/start", "assistant/message",
  "tool/call", "tool/result", "step/end", "turn/end"]);
const TOOLS = new Set(["expandEvidence", "deepResearch", "draftJudgment"]);
const fail = () => { throw Object.assign(Error("RESEARCH_CHECKPOINT_INVALID"), { code: "RESEARCH_CHECKPOINT_INVALID" }); };
const text = (value, max = 256 * 1024) => {
  if (typeof value !== "string" || value.length > max || !value.isWellFormed()) fail();
  return value;
};
const id = value => { if (!text(value, 160)) fail(); return value; };
const number = value => { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };
const tool = value => { if (!TOOLS.has(value)) fail(); return value; };
const route = value => ({ provider: id(value.provider), model: id(value.model),
  ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: id(value.reasoningEffort) }) });
function toolMeta(meta) {
  if (meta.schema !== "xiaomei-tool-result-v1" || typeof meta.ok !== "boolean" || meta.uiActionJson !== "") fail();
  return { schema: meta.schema, toolId: tool(meta.toolId), ok: meta.ok,
    summary: text(meta.summary, 1200), dataJson: text(meta.dataJson), uiActionJson: "" };
}
function blocks(content, kind) {
  if (!Array.isArray(content) || content.length > 64) fail();
  return content.flatMap(block => {
    if (block.type === "text") {
      if (kind === "result") {
        let value;
        try { value = JSON.parse(block.text); } catch { /* Plain failure text remains text. */ }
        if (value?.schema === "xiaomei-tool-result-v1") return [{ type: "json", value: toolMeta(value) }];
      }
      return [{ type: "text", text: text(block.text) }];
    }
    if (kind === "result" && block.type === "json") return [{ type: "json", value: toolMeta(block.value) }];
    if (kind === "assistant" && ["thinking", "reasoning"].includes(block.type)) return [];
    if (kind === "assistant" && block.type === "tool-call") return [{
      type: "tool-call", id: id(block.id), name: tool(block.name), arguments: text(block.arguments),
    }];
    if (kind === "tool" && block.type === "tool-result") return [{
      type: "tool-result", toolCallId: id(block.toolCallId),
      ...(block.isError === undefined ? {} : { isError: block.isError === true }),
      content: blocks(block.content, "result"),
    }];
    fail();
  });
}
function message(value, kind) {
  // Preserve the established private storage schema across native Host versions.
  if (kind === "plugin" && value.source?.kind === "variable-os-desk-ui") {
    value = { ...value, source: { kind: "plugin", plugin: "variable-os-desk-ui" } };
  }
  if (kind === "tool" && value.role === "tool") {
    if (value.toolCallId !== value.source?.callId) fail();
    value = { ...value, role: "user", content: [{ type: "tool-result",
      toolCallId: value.toolCallId, ...(value.isError === undefined ? {} : { isError: value.isError }),
      content: value.content }] };
  }
  const role = kind === "assistant" ? "assistant" : "user";
  if (value.role !== role || value.source?.kind !== (kind === "assistant" ? "model" : kind)) fail();
  if (kind === "plugin" && value.source.plugin !== "variable-os-desk-ui") fail();
  return { id: id(value.id), role, content: blocks(value.content, kind),
    source: kind === "assistant" ? { kind: "model", ...route(value.source) }
      : kind === "tool" ? { kind: "tool", callId: id(value.source.callId) }
        : { kind: "plugin", plugin: "variable-os-desk-ui" } };
}
function projectEvents(events) {
  if (!Array.isArray(events)) fail();
  const out = [];
  let turn = null, step = null, nextTurn = 1, nextStep = 1, hasAssistant = false;
  const pending = new Map();
  for (const event of events) {
    if (!TYPES.has(event.type)) continue;
    const value = event.data;
    let data, surface = false;
    if (event.type === "user/message") { data = message(value, "plugin"); surface = true; }
    else if (event.type === "turn/start") {
      if (turn !== null || value.turn !== nextTurn) fail();
      turn = value.turn; nextStep = 1; hasAssistant = false; data = { turn };
    } else if (event.type === "turn/end") {
      if (turn === null || step !== null || value.turn !== turn || nextStep === 1 || !hasAssistant ||
        !["completed", "max-tokens"].includes(value.reason?.kind)) fail();
      data = { turn, reason: { kind: value.reason.kind } }; turn = null; nextTurn++;
    } else {
      if (turn === null || value.turn !== turn) fail();
      if (event.type === "step/start") {
        if (step !== null || value.step !== nextStep) fail();
        step = value.step; data = { turn, step };
      } else {
        if (step === null || value.step !== step) fail();
        if (event.type === "step/end") {
          if (pending.size) fail();
          data = { turn, step }; step = null; nextStep++;
        } else if (event.type === "assistant/message") {
          if (value.interrupted) fail();
          data = { turn, step, message: message(value.message, "assistant") }; surface = true; hasAssistant = true;
        } else if (event.type === "tool/call") {
          const callId = id(value.callId);
          if (pending.has(callId)) fail();
          pending.set(callId, tool(value.name));
          data = { turn, step, callId, name: tool(value.name), arguments: text(value.arguments) };
        } else {
          const result = message(value.message, "tool");
          const name = pending.get(result.source.callId);
          if (!name || !pending.delete(result.source.callId) || result.content.length !== 1 ||
            result.content[0].toolCallId !== result.source.callId) fail();
          if (result.content[0].content.some(block => block.type === "json" && block.value.toolId !== name)) fail();
          data = { turn, step, message: result };
          if (value.error) data.error = { name: id(value.error.name), code: id(value.error.code) };
          if (value.meta) {
            data.meta = toolMeta(value.meta);
            if (data.meta.toolId !== name) fail();
          }
          surface = true;
        }
      }
    }
    if (surface && event.surfaceOp !== "append") fail();
    out.push({ type: event.type, seq: out.length, time: number(event.time), data,
      ...(surface ? { surfaceOp: "append" } : {}) });
    if (out.length > 2048) fail();
  }
  if (!out.length || turn !== null || step !== null || out.at(-1).type !== "turn/end") fail();
  return out;
}

// A newly numbered native seed, not a raw log: request headers, chunks,
// provider replay state, reasoning and approval grants never enter storage.
export function personalNativeCheckpoint({ sessionId, contextKey, selection, events }) {
  try {
    if (!/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(contextKey)) fail();
    const value = { schema: SCHEMA, sessionId, contextKey, selection: route(selection), events: projectEvents(events) };
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail();
    return value;
  } catch { fail(); }
}

export function readPersonalNativeCheckpoint(input) {
  try {
    if (!input || input.schema !== SCHEMA || Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) fail();
    const value = personalNativeCheckpoint(input);
    if (canonicalHash(value) !== canonicalHash(input)) fail();
    return value;
  } catch { fail(); }
}

export function personalNativeSeed(checkpoint) {
  const { events } = readPersonalNativeCheckpoint(checkpoint);
  for (const event of events) {
    if (event.type === "user/message") event.data.source = { kind: "variable-os-desk-ui" };
    // A sanitized replay seed is not an original provider transcript. No raw
    // stream/reasoning exists here. Empty also represents an uncaptured stream
    // in the official v1-to-v2 migration; never reconstruct fabricated chunks.
    if (event.type === "assistant/message") event.data.stream = [];
    if (event.type !== "tool/result") continue;
    for (const block of event.data.message.content) {
      block.content = block.content.map(item => item.type === "json"
        ? { type: "text", text: JSON.stringify(item.value) } : item);
    }
    const legacy = event.data.message, block = legacy.content[0];
    event.data.message = { id: legacy.id, role: "tool", source: legacy.source,
      toolCallId: block.toolCallId, ...(block.isError === undefined ? {} : { isError: block.isError }),
      content: block.content };
  }
  return events;
}
