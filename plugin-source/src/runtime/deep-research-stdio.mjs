// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const DEEP_RESEARCH_STDIO_SCHEMA = "variable-os-deep-research-stdio-v1";
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const ERROR_MESSAGES = Object.freeze({
  SOURCE_UNAVAILABLE: "The configured research source is unavailable.",
  DEEP_RESEARCH_ABORTED: "Deep Research was cancelled.",
  DEEP_RESEARCH_TIMEOUT: "Deep Research exceeded its time limit.",
  DEEP_RESEARCH_CLEANUP_FAILED: "Research process cleanup could not be verified.",
  DEEP_RESEARCH_CONTRACT_INVALID: "The research process returned an invalid contract.",
  DEEP_RESEARCH_PROVIDER_FAILED: "The research provider failed.",
  DEEP_RESEARCH_OUTPUT_TRUNCATED: "The synthesis was truncated.",
  DEEP_RESEARCH_OUTPUT_INVALID: "The synthesis returned no valid text.",
  DEEP_RESEARCH_OUTPUT_TOO_LARGE: "The synthesis exceeded its output limit.",
  DEEP_RESEARCH_TOOL_CALL_FORBIDDEN: "Synthesis must not invoke tools.",
  DEEP_RESEARCH_MODEL_FAILED: "The synthesis did not complete.",
});

export function researchProcessError(code) {
  const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "SOURCE_UNAVAILABLE";
  const error = new Error(ERROR_MESSAGES[safeCode]);
  error.code = safeCode;
  if (safeCode === "DEEP_RESEARCH_ABORTED") error.name = "AbortError";
  if (safeCode === "DEEP_RESEARCH_TIMEOUT") error.name = "TimeoutError";
  if (safeCode === "SOURCE_UNAVAILABLE") error.status = "UNAVAILABLE";
  return error;
}

export function isReadOnlyProposal(proposal) {
  return proposal?.schema === "deep-research-proposal-v1"
    && proposal.authority === "proposal"
    && typeof proposal.answer === "string"
    && proposal.writePolicy?.readOnly === true
    && proposal.writePolicy.wroteArtifacts === false
    && proposal.writePolicy.wroteWiki === false
    && proposal.writePolicy.wroteRaw === false
    && Object.entries(proposal.writePolicy).every(([key, value]) => !key.startsWith("wrote") || value === false);
}

export function writeResearchFrame(stream, frame, onError = () => {}) {
  const bytes = Buffer.from(`${JSON.stringify({ ...frame, schema: DEEP_RESEARCH_STDIO_SCHEMA })}\n`);
  if (bytes.length > MAX_FRAME_BYTES) throw researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID");
  stream.write(bytes, (error) => { if (error) onError(error); });
}

export function readResearchFrames(stream, onFrame, onError) {
  let pending = Buffer.alloc(0);
  let totalBytes = 0;
  let stopped = false;
  function fail() {
    if (stopped) return;
    stopped = true;
    onError(researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID"));
  }
  function data(chunk) {
    if (stopped) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > 8 * MAX_FRAME_BYTES) return fail();
    pending = Buffer.concat([pending, bytes]);
    let end;
    while (!stopped && (end = pending.indexOf(10)) >= 0) {
      if (end >= MAX_FRAME_BYTES) return fail();
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!frame || Array.isArray(frame) || frame.schema !== DEEP_RESEARCH_STDIO_SCHEMA) return fail();
        onFrame(frame);
      } catch {
        return fail();
      }
    }
    if (pending.length >= MAX_FRAME_BYTES) fail();
  }
  function end() { if (pending.length) fail(); }
  stream.on("data", data);
  stream.on("end", end);
  stream.on("error", fail);
  return () => {
    stopped = true;
    stream.off("data", data);
    stream.off("end", end);
    stream.off("error", fail);
  };
}
