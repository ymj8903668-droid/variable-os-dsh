// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { projectWikiResearchContext, wikiResearchMode } from "./wiki-research-source.mjs";

import {
  isReadOnlyProposal,
  readResearchFrames,
  researchProcessError,
  writeResearchFrame,
} from "./deep-research-stdio.mjs";

const OPTION_KEYS = [
  "projectPath", "topic", "provider", "noArtifacts", "allowSynthesisTimeoutFallback",
  "sources", "includeInvalidated", "maxResults", "sourceK", "graphDepth",
  "graphNeighbors", "topBrain", "sqlLimit", "tavilyTimeoutMs", "generatedAt",
  "wikiMode",
];
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SystemRoot",
  "TRADING_WIKI_REPO_PATH", "TAVILY_API_KEY",
  "TRADING_WIKI_TAVILY_KEYCHAIN_SERVICE", "TRADING_WIKI_TAVILY_KEYCHAIN_ACCOUNT",
];

/** One explicit local plugin process per read-only request. No shell or retries. */
export function createDeepResearchProcessEngine({
  env = process.env,
  timeoutMs = 180_000,
  killGraceMs = 250,
} = {}) {
  const entryPath = String(env.VARIABLE_OS_DEEP_RESEARCH_PROVIDER || "").trim();
  if (!entryPath || !path.isAbsolute(entryPath) || process.platform === "win32") {
    throw researchProcessError("SOURCE_UNAVAILABLE");
  }
  for (const value of [timeoutMs, killGraceMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Process time limits must be positive integers");
  }
  const childEnv = Object.fromEntries(CHILD_ENV_KEYS
    .filter((key) => typeof env[key] === "string")
    .map((key) => [key, env[key]]));

  return async function runProcessResearch(options = {}) {
    if (options.signal?.aborted) throw researchProcessError("DEEP_RESEARCH_ABORTED");
    if (typeof options.projectPath !== "string" || !path.isAbsolute(options.projectPath)) {
      throw researchProcessError("SOURCE_UNAVAILABLE");
    }
    if (options.noArtifacts !== true || ["write", "ingest", "applyIngest", "showContext"].some((key) => options[key])
      || typeof options.requestText !== "function") {
      throw researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID");
    }
    const wikiMode = wikiResearchMode(options.wikiMode);
    if (wikiMode === "ima" && typeof options.readWikiEvidence !== "function") {
      throw researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID");
    }
    try { await access(entryPath); } catch { throw researchProcessError("SOURCE_UNAVAILABLE"); }
    if (options.signal?.aborted) throw researchProcessError("DEEP_RESEARCH_ABORTED");
    const wireOptions = Object.fromEntries(OPTION_KEYS
      .filter((key) => options[key] !== undefined)
      .map((key) => [key, options[key]]));
    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entryPath], {
        env: childEnv,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const callbackController = new AbortController();
      const calls = new Set();
      const seenCalls = new Set();
      const callCounts = { requestText: 0, tavilyClient: 0, readWikiEvidence: 0 };
      let result = null;
      let failure = null;
      let closed = false;
      let settled = false;
      let exitCode = null;
      let killTimer;
      let cleanupTimer;
      let pollTimer;
      let forcedCleanup = false;
      let stderrBytes = 0;
      let wikiAcknowledged = options.wikiMode === undefined;
      let wikiRetrieved = false;
      const timer = setTimeout(() => stop(researchProcessError("DEEP_RESEARCH_TIMEOUT")), timeoutMs);

      function signalGroup(signal) {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); } catch (error) {
          if (error.code !== "ESRCH") failure = researchProcessError("DEEP_RESEARCH_CLEANUP_FAILED");
        }
      }
      function groupAlive() {
        if (!child.pid) return false;
        try { process.kill(-child.pid, 0); return true; } catch (error) {
          return error.code !== "ESRCH";
        }
      }
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(cleanupTimer);
        clearTimeout(pollTimer);
        unsubscribe();
        options.signal?.removeEventListener("abort", abort);
        callbackController.abort();
        if (failure) reject(failure);
        else if (exitCode !== 0 || !result) reject(researchProcessError("SOURCE_UNAVAILABLE"));
        else resolve(result);
      }
      function maybeFinish() {
        if (settled || !closed) return;
        if (groupAlive()) {
          if (!failure) stop(researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID"));
          if (forcedCleanup) pollTimer = setTimeout(maybeFinish, 10);
          return;
        }
        finish();
      }
      function stop(error) {
        if (settled || failure) return;
        failure = error;
        callbackController.abort(error);
        child.stdin.destroy();
        signalGroup("SIGTERM");
        killTimer = setTimeout(() => {
          forcedCleanup = true;
          signalGroup("SIGKILL");
          maybeFinish();
        }, killGraceMs);
        // Pipes may outlive their leader. Never keep the controller single-flight forever.
        cleanupTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          failure = researchProcessError("DEEP_RESEARCH_CLEANUP_FAILED");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish();
        }, killGraceMs + 2_000);
      }
      function send(frame) {
        if (closed || failure) return;
        try {
          writeResearchFrame(child.stdin, { ...frame, id }, () => stop(researchProcessError("SOURCE_UNAVAILABLE")));
        } catch {
          stop(researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID"));
        }
      }
      function handle(frame) {
        if (failure || closed) return;
        if (frame.id !== id || result) throw new Error("Unexpected request or terminal frame");
        if (frame.type === "wiki.ready") {
          if (wikiAcknowledged || frame.mode !== wikiMode || frame.contract !== "wiki-source-v1") {
            throw new Error("Invalid Wiki source acknowledgement");
          }
          wikiAcknowledged = true;
          return;
        }
        if (frame.type === "result") {
          if (!wikiAcknowledged || calls.size || !isReadOnlyProposal(frame.result)
            || (wikiMode !== "local" && (frame.result.wiki?.mode !== wikiMode || frame.result.cacheable !== false))
            || (wikiMode === "ima" && (!wikiRetrieved || frame.result.writePolicy.exportAllowed !== false))) {
            throw new Error("Unsafe proposal");
          }
          result = frame.result;
          child.stdin.end();
          return;
        }
        if (frame.type === "error") {
          stop(researchProcessError(frame.error?.code));
          return;
        }
        if (frame.type === "progress") {
          if (typeof frame.message !== "string" || frame.message.length > 1_024) throw new Error("Invalid progress");
          options.onProgress?.(frame.message);
          return;
        }
        const method = frame.method;
        if (!wikiAcknowledged || frame.type !== "call" || typeof method !== "string" || !Object.hasOwn(callCounts, method)
          || typeof options[method] !== "function" || typeof frame.callId !== "string"
          || !/^[a-zA-Z0-9_-]{1,64}$/u.test(frame.callId) || seenCalls.has(frame.callId)
          || !frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) {
          throw new Error("Invalid callback");
        }
        callCounts[method] += 1;
        if (callCounts[method] > (method === "tavilyClient" ? 8 : 1)) throw new Error("Callback limit exceeded");
        if (method === "readWikiEvidence" && (wikiMode !== "ima" || frame.params.query !== options.topic
          || Object.keys(frame.params).some(key => key !== "query"))) throw new Error("Unexpected Wiki callback");
        if (method === "requestText" && wikiMode === "ima" && !wikiRetrieved) {
          throw new Error("Wiki evidence must precede synthesis");
        }
        seenCalls.add(frame.callId);
        calls.add(frame.callId);
        // Callback cancellation belongs to this invocation, never to JSON from the plugin.
        Promise.resolve().then(() => {
          if (callbackController.signal.aborted) throw researchProcessError("DEEP_RESEARCH_ABORTED");
          return options[method]({ ...frame.params, signal: callbackController.signal });
        }).then(value => method === "readWikiEvidence" ? projectWikiResearchContext(value) : value).then((value) => {
          if (method === "readWikiEvidence") wikiRetrieved = true;
          calls.delete(frame.callId);
          send({ type: "return", callId: frame.callId, result: value });
        }, (error) => {
          calls.delete(frame.callId);
          const safe = researchProcessError(error?.code);
          if (method === "requestText"
            && !(safe.code === "DEEP_RESEARCH_TIMEOUT" && options.allowSynthesisTimeoutFallback === true)) {
            stop(safe);
            return;
          }
          send({ type: "return", callId: frame.callId, error: { code: safe.code } });
        });
      }
      const unsubscribe = readResearchFrames(child.stdout, handle, stop);
      const abort = () => stop(researchProcessError("DEEP_RESEARCH_ABORTED"));
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => stop(researchProcessError("SOURCE_UNAVAILABLE")));
      child.on("error", () => stop(researchProcessError("SOURCE_UNAVAILABLE")));
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 1024 * 1024) stop(researchProcessError("DEEP_RESEARCH_CONTRACT_INVALID"));
      });
      child.on("close", (code) => {
        closed = true;
        exitCode = code;
        maybeFinish();
      });
      if (options.signal?.aborted) abort();
      else send({ type: "run", options: wireOptions, callbacks: {
        tavilyClient: typeof options.tavilyClient === "function", readWikiEvidence: wikiMode === "ima",
      } });
    });
  };
}
