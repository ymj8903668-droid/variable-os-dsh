// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { buildEvidenceCatalystPrompt, ANALYSIS_PROMPT_VERSION } from "../../../src/runtime/evidence-catalyst-analyzer.mjs";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { normalizeImaCardInput } from "../../../src/runtime/ima-card-input.mjs";

const invalidOutput = outputStage => Object.assign(remoteError("LLM_OUTPUT_INVALID"), { outputStage });
const incompleteOutput = terminalReason => Object.assign(invalidOutput("incomplete"), { terminalReason });
const terminalReasons = {
  "max-tokens": "max_tokens",
  "tool-calls": "tool_calls",
  aborted: "provider_aborted",
  error: "provider_error",
};

export function createPersonalCardAnalyzer({ llm, currentSelection, createUserMessage, createBlockAssembler }) {
  return async ({ record, signal }) => {
    if (signal?.aborted) throw remoteError("CANCELLED");
    const selected = currentSelection();
    const valid = (value, max) => typeof value === "string" && value.trim() === value &&
      value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
    if (!valid(selected?.provider, 120) || !valid(selected?.model, 120) ||
      selected.reasoningEffort !== undefined && !valid(selected.reasoningEffort, 24)) {
      throw remoteError("MODEL_SELECTION_REQUIRED");
    }
    const route = { provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
    const ima = record.wikiOrigin?.provider === "ima";
    if (ima) record = normalizeImaCardInput(record, { evidenceId: record.evidenceId, modelUseAllowed: true });
    const prompt = buildEvidenceCatalystPrompt({
      sourceNamespace: `${ima ? "ima" : "published"}.${record.datasetId}`,
      sourceDocumentKey: `${record.sourceFamily}:${record.evidenceId}:${ima ? record.contentHash : record.revision}`,
    }, ima ? record.content : record.excerpt);
    if (ima) {
      prompt.system += "\nIMA 输入仅证明当前观测到的正文。历史版本、源事件时间与首次可用时间未知；不得推断一手证据、发布确认或转授权。";
    }
    const message = createUserMessage({
      content: [{ type: "text", text: prompt.user }],
      source: { kind: "plugin", plugin: "variable-os-desk-ui" },
    });
    const assembler = createBlockAssembler();
    let bytes = 0;
    let terminalSeen = false;
    for await (const chunk of llm.stream({
      ...route, messages: [message], system: prompt.system,
      temperature: 0, maxTokens: 4096, signal,
    })) {
      if (signal?.aborted) throw remoteError("CANCELLED");
      if (terminalSeen) throw incompleteOutput("after_finish");
      if (chunk.type === "finish") {
        const reason = chunk.reason?.kind;
        if (reason !== "stop") {
          throw incompleteOutput(typeof reason === "string" && Object.hasOwn(terminalReasons, reason)
            ? terminalReasons[reason] : "invalid_finish");
        }
        terminalSeen = true;
      }
      bytes += Buffer.byteLength(JSON.stringify(chunk));
      if (bytes > 256 * 1024) throw invalidOutput("stream_limit");
      assembler.push(chunk);
    }
    if (signal?.aborted) throw remoteError("CANCELLED");
    const blocks = assembler.blocks();
    // The native assembler defaults to stop even when no finish chunk arrived.
    if (!terminalSeen) throw incompleteOutput("missing_finish");
    if (assembler.finish?.kind !== "stop") throw incompleteOutput("assembly_mismatch");
    if (blocks.some(block => block?.type === "tool-call")) throw invalidOutput("tool_call");
    const text = blocks.filter(block => block?.type === "text").map(block => block.text ?? "").join("");
    if (!text.trim()) throw invalidOutput("empty");
    if (Buffer.byteLength(text) > 64000) throw invalidOutput("text_limit");
    let analysis;
    try { analysis = JSON.parse(text); } catch { throw invalidOutput("json"); }
    return { analysis, provider: route.provider, modelVersion: route.model,
      promptVersion: `${ANALYSIS_PROMPT_VERSION}-${ima ? "ima" : "published"}.1` };
  };
}
