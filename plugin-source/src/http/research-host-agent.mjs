// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;

function isLoopback(address) {
  const normalized = String(address || "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function sameOrigin(request) {
  const host = String(request.headers?.host || "").toLowerCase();
  const origin = request.headers?.origin;
  if (!host || typeof origin !== "string") return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function sendJsonError(response, status, code, message) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
  });
  response.end(JSON.stringify({ ok: false, error: { code, message } }));
}

async function readBody(request, maxBodyBytes, timeoutMs) {
  let total = 0;
  const chunks = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => {
      const error = new Error("request body timed out");
      error.code = "BODY_TIMEOUT";
      request.destroy?.(error);
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBodyBytes) {
        const error = new Error("request body is too large");
        error.code = "BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(buffer);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("request body must be an object");
      }
      return value;
    } catch (error) {
      if (error?.code) throw error;
      const invalid = new Error("request body must be valid JSON");
      invalid.code = "INVALID_JSON";
      throw invalid;
    }
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  }
}

function validateRequest(request, response, csrfToken) {
  if (request.method !== "POST") {
    sendJsonError(response, 405, "METHOD_NOT_ALLOWED", "POST required");
    return false;
  }
  if (!isLoopback(request.socket?.remoteAddress)) {
    sendJsonError(response, 403, "LOOPBACK_REQUIRED", "loopback only");
    return false;
  }
  const contentType = String(request.headers?.["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    sendJsonError(response, 415, "UNSUPPORTED_MEDIA_TYPE", "application/json required");
    return false;
  }
  if (!sameOrigin(request) || request.headers?.["x-variable-os-csrf"] !== csrfToken) {
    sendJsonError(response, 403, "CSRF_INVALID", "same-origin process token required");
    return false;
  }
  return true;
}

function safeAgentError(error) {
  const code = typeof error?.code === "string" ? error.code : "XIAOMEI_AGENT_FAILED";
  const messages = {
    PAUSED_FOR_RECOVERY: "应用正在进行一致性备份，请稍后再试。",
    RECOVERY_CONTROLLER_DISPOSED: "应用服务正在停止，请稍后再试。",
    XIAOMEI_AGENT_INVALID_INPUT: "当前问题或卷宗上下文不完整。",
    XIAOMEI_AGENT_INVALID_SESSION: "小美会话标识无效。",
    XIAOMEI_AGENT_BUSY: "小美正在处理上一条请求，请先打断或等待完成。",
    XIAOMEI_AGENT_INTERRUPTED: "本次小美回答已停止。",
    XIAOMEI_TOOL_INTERRUPTED: "在途受控工具已停止。",
    XIAOMEI_AGENT_NO_FINAL_ANSWER: "小美没有生成完整最终回答。",
    XIAOMEI_SESSION_NOT_FOUND: "没有找到可恢复的小美会话。",
    XIAOMEI_SESSION_OWNERSHIP_CONFLICT: "该会话未通过小美作用域所有权校验。",
    XIAOMEI_APPROVAL_NOT_PENDING: "当前没有等待确认的小美工具。",
    XIAOMEI_TOOL_SCOPE_DRIFT: "小美工具作用域发生变化，本轮已终止。",
  };
  return Object.freeze({
    code,
    message: messages[code] || "小美暂时无法继续，当前卷宗没有变化。",
  });
}

export function createResearchHostAgentHandler({
  manager,
  csrfToken,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
} = {}) {
  if (!manager || ["run", "resume", "approve", "cancel"].some((name) => typeof manager[name] !== "function")) {
    throw new TypeError("research host agent manager is required");
  }
  if (typeof csrfToken !== "string" || csrfToken.length < 8) {
    throw new TypeError("research host agent route requires a CSRF token");
  }
  return async function handleResearchHostAgent(request, response) {
    if (!validateRequest(request, response, csrfToken)) return;
    let body;
    try {
      body = await readBody(request, maxBodyBytes, bodyTimeoutMs);
    } catch (error) {
      sendJsonError(
        response,
        error?.code === "BODY_TOO_LARGE" ? 413 : error?.code === "BODY_TIMEOUT" ? 408 : 422,
        error?.code || "INVALID_JSON",
        error?.message || "invalid request body",
      );
      return;
    }
    // Admission can reject before the first event. Do not commit HTTP 200 until
    // real output starts; already-started streams retain their NDJSON contract.
    let streamStarted = false;
    const startStream = () => {
      if (streamStarted) return;
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
      });
      streamStarted = true;
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.on("close", abort);
    const emit = (value) => {
      if (!response.destroyed && !response.writableEnded) {
        startStream();
        response.write(`${JSON.stringify(value)}\n`);
      }
    };
    try {
      if (body.action === "run") {
        await manager.run(body, { signal: controller.signal, onEvent: emit, onApproval: emit });
      } else if (body.action === "resume") {
        await manager.resume(body, { signal: controller.signal, onEvent: emit, onApproval: emit });
      } else if (body.action === "approve") {
        emit({ type: "done", ...await manager.approve(body, { signal: controller.signal }) });
      } else if (body.action === "cancel") {
        emit({ type: "cancellation", ...await manager.cancel(body) });
      } else if (body.action === "list" && typeof manager.list === "function") {
        emit({ type: "history", ...await manager.list(body, { signal: controller.signal }) });
      } else {
        const error = new Error("unsupported Xiaomei agent action");
        error.code = "XIAOMEI_AGENT_INVALID_ACTION";
        throw error;
      }
    } catch (error) {
      const safe = safeAgentError(error);
      if (!streamStarted && ["PAUSED_FOR_RECOVERY", "RECOVERY_CONTROLLER_DISPOSED"].includes(safe.code)) {
        if (!response.destroyed && !response.writableEnded) sendJsonError(response, 503, safe.code, safe.message);
      } else emit({ type: "error", error: safe });
    } finally {
      response.off("close", abort);
      if (!response.destroyed && !response.writableEnded) {startStream(); response.end();}
    }
  };
}
