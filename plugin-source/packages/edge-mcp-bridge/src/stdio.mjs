// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { EvidenceProviderError, providerError } from "../../evidence-provider/src/errors.mjs";
import { DOCUMENT_RPC_MAX_BYTES } from "../../evidence-provider/src/publication-limits.mjs";
import { TOOLS, planTool } from "./tools.mjs";
import { createTransport } from "./transport.mjs";
import { validateResult } from "./response.mjs";

const MAX_FRAME = 65536;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_ACTIVE = 8;
const MAX_IDS = 4096;
const request = createTransport(process.env);
const active = new Map();
const seen = new Set();
const decoder = new TextDecoder("utf-8", { fatal: true });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const idValid = (value) => Number.isSafeInteger(value)
  || (typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value));
const fields = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
let state = "new";
let buffer = Buffer.alloc(0);
let largeOutputPending = 0;

function close(code = 0) {
  if (state === "closed") return;
  state = "closed";
  buffer = Buffer.alloc(0);
  for (const controller of active.values()) controller.abort();
  active.clear();
  process.exitCode = code;
  process.stdin.destroy();
  process.stdout.end();
  setTimeout(() => process.exit(code), 1000).unref();
}

function reply(id, value, frameLimit = MAX_OUTPUT) {
  if (state === "closed") return;
  const frame = `${JSON.stringify({ jsonrpc: "2.0", id, ...value })}\n`;
  const bytes = Buffer.byteLength(frame);
  // Preserve the ordinary 4 MiB queue bound; extend it only while a validated
  // full-original frame needs the larger, still bounded MCP envelope.
  const large = bytes > MAX_OUTPUT;
  const queueLimit = large || largeOutputPending ? DOCUMENT_RPC_MAX_BYTES : MAX_OUTPUT;
  if (bytes > frameLimit || bytes + process.stdout.writableLength > queueLimit) {
    close(1); return;
  }
  if (large) largeOutputPending += 1;
  process.stdout.write(frame, () => { if (large) largeOutputPending -= 1; });
}

const messages = {
  "-32700": "Parse error", "-32600": "Invalid Request", "-32601": "Method not found",
  "-32602": "Invalid params", "-32002": "Server not initialized",
};
const rpcError = (id, code) => reply(id, { error: { code, message: messages[code] } });

function toolReply(id, value, error, frameLimit = MAX_OUTPUT) {
  const structuredContent = error ? { error: (error instanceof EvidenceProviderError
    ? error : providerError("SOURCE_UNAVAILABLE", "BRIDGE_FAILURE")).toJSON() } : value;
  reply(id, { result: {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent, isError: Boolean(error),
  } }, frameLimit);
}

function dispatch(message) {
  if (!fields(message, ["jsonrpc", "id", "method", "params"]) || message.jsonrpc !== "2.0"
    || typeof message.method !== "string" || message.method.length > 128
    || (Object.hasOwn(message, "id") && !idValid(message.id))
    || (Object.hasOwn(message, "params") && !object(message.params))) {
    rpcError(null, -32600);
    return;
  }
  const params = message.params ?? {};
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "notifications/initialized" && state === "initializing"
      && fields(params, ["_meta"])) state = "ready";
    if (message.method === "notifications/cancelled" && idValid(params.requestId)) {
      active.get(params.requestId)?.abort();
    }
    return;
  }
  const { id, method } = message;
  // Reusing IDs is a protocol violation, including after completion. The session
  // budget bounds this proof; reconnect rather than silently forget old IDs.
  if (seen.has(id)) { rpcError(id, -32600); return; }
  if (seen.size >= MAX_IDS) { close(1); return; }
  seen.add(id);
  if (Object.hasOwn(params, "_meta") && !object(params._meta)) { rpcError(id, -32602); return; }
  if (method === "ping") {
    if (!fields(params, ["_meta"])) rpcError(id, -32602);
    else reply(id, { result: {} });
    return;
  }
  if (method === "initialize") {
    if (state !== "new") { rpcError(id, -32600); return; }
    if (!fields(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"])
      || typeof params.protocolVersion !== "string" || params.protocolVersion.length > 64
      || !params.protocolVersion || !object(params.capabilities) || !object(params.clientInfo)
      || !["name", "version"].every((key) => typeof params.clientInfo[key] === "string"
        && params.clientInfo[key].length > 0 && params.clientInfo[key].length <= 256)) {
      rpcError(id, -32602);
      return;
    }
    state = "initializing";
    reply(id, { result: {
      protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "variable-os-edge-mcp-bridge", version: "0.1.0" },
    } });
    return;
  }
  if (state !== "ready") { rpcError(id, -32002); return; }
  if (method === "tools/list") {
    if (!fields(params, ["_meta"])) rpcError(id, -32602);
    else reply(id, { result: { tools: TOOLS } });
    return;
  }
  if (method !== "tools/call") { rpcError(id, -32601); return; }
  const args = Object.hasOwn(params, "arguments") ? params.arguments : {};
  const plan = fields(params, ["name", "arguments", "_meta"]) ? planTool(params.name, args) : null;
  if (!plan) { rpcError(id, -32602); return; }
  if (active.size >= MAX_ACTIVE) {
    const busy = providerError("SOURCE_UNAVAILABLE", "BRIDGE_BUSY");
    busy.details.retryAfterSeconds = 1;
    toolReply(id, null, busy);
    return;
  }
  const controller = new AbortController();
  // Full originals are represented twice by MCP, with escaping in the text form.
  const frameLimit = (params.name === "read_evidence" && args.includeDocument === true) || args.contextId
    ? DOCUMENT_RPC_MAX_BYTES : MAX_OUTPUT;
  active.set(id, controller);
  request(plan, controller.signal).then((value) => {
    if (controller.signal.aborted) throw providerError("CANCELLED", "REQUEST_CANCELLED");
    return validateResult(params.name, value, args);
  }).then(
    (value) => toolReply(id, value, undefined, frameLimit),
    (error) => toolReply(id, null, error),
  ).finally(() => active.delete(id));
}

function frame(bytes) {
  let message;
  try { message = JSON.parse(decoder.decode(bytes)); }
  catch { rpcError(null, -32700); return; }
  dispatch(message);
}

process.stdin.on("data", (chunk) => {
  if (state === "closed") return;
  let start = 0;
  let end;
  while ((end = chunk.indexOf(10, start)) !== -1) {
    const size = buffer.length + end - start;
    if (size > MAX_FRAME) { close(1); return; }
    frame(Buffer.concat([buffer, chunk.subarray(start, end)], size));
    buffer = Buffer.alloc(0);
    start = end + 1;
    if (state === "closed") return;
  }
  if (buffer.length + chunk.length - start > MAX_FRAME) { close(1); return; }
  buffer = Buffer.concat([buffer, chunk.subarray(start)]);
});
process.stdin.on("end", () => {
  if (buffer.length) rpcError(null, -32700);
  close();
});
process.stdin.on("error", () => close(1));
process.stdout.on("error", () => close(1));
process.on("SIGTERM", () => close());
process.on("SIGINT", () => close());
process.on("uncaughtException", () => close(1));
process.on("unhandledRejection", () => close(1));
