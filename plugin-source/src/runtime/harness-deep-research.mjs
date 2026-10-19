// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";

import { createDeepResearchProcessEngine } from "./deep-research-process.mjs";
import { wikiResearchMode } from "./wiki-research-source.mjs";

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_REASONING_EFFORT = "max";
const REASONING_EFFORTS = new Set(["off", "low", "high", "max"]);
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_CHARS = 40_000;
const MAX_CACHE_ENTRIES = 12;
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export { harnessResearchInputCharacters } from "../research/protocol.mjs";
import { researchSystem } from "../research/protocol.mjs";

function deepResearchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepResearchAbortError() {
  const error = deepResearchError(
    "DEEP_RESEARCH_ABORTED",
    "Deep Research was cancelled by the user",
  );
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw deepResearchAbortError();
}

function combinedAbortSignal(signals) {
  const active = signals.filter((signal) => signal && typeof signal.aborted === "boolean");
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function awaitResearch(signal, operation) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(deepResearchAbortError());
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { throwIfAborted(signal); return operation(); }).then(
      value => signal?.aborted ? abort() : resolve(value), reject,
    ).finally(() => signal?.removeEventListener("abort", abort));
  });
}

export function createAbortableTavilyProvider({
  apiKey,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  const credential = String(apiKey || "").trim();
  if (!credential) throw new TypeError("Tavily credential is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  return async function abortableTavilySearch({
    query,
    maxResults = 5,
    timeoutMs = 30_000,
  } = {}) {
    throwIfAborted(signal);
    const timeoutController = new AbortController();
    const providerSignal = combinedAbortSignal([signal, timeoutController.signal]);
    const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : 30_000;
    const boundedMaxResults = Number.isSafeInteger(maxResults)
      ? Math.min(20, Math.max(1, maxResults))
      : 5;
    const timer = setTimeout(() => timeoutController.abort(), boundedTimeoutMs);
    try {
      const response = await fetchImpl(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          api_key: credential,
          query: String(query || "").trim(),
          max_results: boundedMaxResults,
          search_depth: "advanced",
          include_answer: false,
        }),
        signal: providerSignal,
      });
      if (!response?.ok) {
        throw deepResearchError(
          "DEEP_RESEARCH_PROVIDER_FAILED",
          `Tavily request failed with HTTP ${Number(response?.status) || 0}`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };
}

async function loadDefaultTavilyProvider() {
  // The optional process owns its credentials. Custom in-process loaders remain injectable.
  return null;
}

function routeFrom(currentSelection, modelRouting = "deepseek") {
  const selected = currentSelection();
  if (modelRouting === "selected") {
    const valid = (value, max) => typeof value === "string" && value.trim() === value
      && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
    if (!valid(selected?.provider, 120) || !valid(selected?.model, 120)
      || (selected.reasoningEffort !== undefined && !valid(selected.reasoningEffort, 24))) {
      throw deepResearchError("MODEL_SELECTION_REQUIRED", "Select a model in the user's Host before research");
    }
    return Object.freeze({ provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort !== undefined ? { reasoningEffort: selected.reasoningEffort } : {}) });
  }
  if (
    selected?.provider === DEFAULT_PROVIDER &&
    typeof selected.model === "string" &&
    selected.model.trim()
  ) {
    return Object.freeze({
      provider: DEFAULT_PROVIDER,
      model: selected.model.trim().slice(0, 120),
      reasoningEffort: REASONING_EFFORTS.has(selected.reasoningEffort)
        ? selected.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
    });
  }
  return Object.freeze({
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  });
}

function terminalText(assembler) {
  const blocks = assembler.blocks();
  if (
    assembler.finish?.kind === "tool-calls" ||
    blocks.some((block) => block?.type === "tool-call")
  ) {
    throw deepResearchError(
      "DEEP_RESEARCH_TOOL_CALL_FORBIDDEN",
      "Deep Research synthesis must not invoke tools",
    );
  }
  const kind = assembler.finish?.kind || "stop";
  if (kind === "max-tokens") {
    throw deepResearchError(
      "DEEP_RESEARCH_OUTPUT_TRUNCATED",
      "Deep Research synthesis was truncated",
    );
  }
  if (kind === "aborted") {
    const error = deepResearchError(
      "DEEP_RESEARCH_TIMEOUT",
      "Deep Research synthesis timed out",
    );
    error.name = "AbortError";
    throw error;
  }
  if (kind !== "stop") {
    throw deepResearchError(
      "DEEP_RESEARCH_MODEL_FAILED",
      "Deep Research synthesis did not complete",
    );
  }
  const text = blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("")
    .trim();
  if (!text) {
    throw deepResearchError(
      "DEEP_RESEARCH_OUTPUT_INVALID",
      "Deep Research synthesis returned no text",
    );
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    throw deepResearchError(
      "DEEP_RESEARCH_OUTPUT_TOO_LARGE",
      "Deep Research synthesis exceeded the output limit",
    );
  }
  return text;
}

function usageOf(value) {
  return Object.freeze({
    inputTokens: Number.isInteger(value?.inputTokens) ? value.inputTokens : null,
    outputTokens: Number.isInteger(value?.outputTokens) ? value.outputTokens : null,
  });
}

async function loadDefaultEngine({ env = process.env } = {}) {
  return createDeepResearchProcessEngine({ env });
}

/**
 * Bind retrieval to Harness' credentialed adapter. Legacy local mode retains
 * its DeepSeek route; personal clients can require the user's selected model.
 */
export function createHarnessDeepResearch({
  llm,
  currentSelection,
  createUserMessage,
  createBlockAssembler,
  runDeepResearch = null,
  loadEngine = loadDefaultEngine,
  loadTavilyProvider = loadDefaultTavilyProvider,
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTokens = 8192,
  nowMs = Date.now,
  createWikiSession = null,
  modelRouting = "deepseek",
} = {}) {
  if (!llm || typeof llm.stream !== "function") {
    throw new TypeError("Harness llm.stream is required");
  }
  if (typeof currentSelection !== "function") {
    throw new TypeError("Harness Deep Research model selection is required");
  }
  if (
    typeof createUserMessage !== "function" ||
    typeof createBlockAssembler !== "function"
  ) {
    throw new TypeError("Harness message and stream primitives are required");
  }
  if (runDeepResearch !== null && typeof runDeepResearch !== "function") {
    throw new TypeError("runDeepResearch must be a function");
  }
  if (typeof loadEngine !== "function" || typeof loadTavilyProvider !== "function") {
    throw new TypeError("Deep Research loaders must be functions");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    throw new TypeError("maxTokens must be within the reviewed output limit");
  }
  if (createWikiSession !== null && typeof createWikiSession !== "function") {
    throw new TypeError("createWikiSession must be a function");
  }
  if (!["deepseek", "selected"].includes(modelRouting)) throw new TypeError("Invalid model routing");

  async function researchWithHarness({ topic, signal, wikiSession, modelRoute } = {}) {
    const selectedTopic = String(topic || "").trim();
    if (selectedTopic.length < 2 || selectedTopic.length > 200) {
      throw deepResearchError(
        "DEEP_RESEARCH_INVALID_INPUT",
        "Deep Research topic must contain 2 to 200 characters",
      );
    }
    throwIfAborted(signal);
    let engine = runDeepResearch;
    let tavilyClient = null;
    if (!engine) {
      [engine, tavilyClient] = await Promise.all([
        loadEngine({ env }),
        loadTavilyProvider({ env, signal, fetchImpl }),
      ]);
    }
    throwIfAborted(signal);
    const route = modelRoute ?? routeFrom(currentSelection);
    const configuredProject = String(
      env.VARIABLE_OS_DEEP_RESEARCH_PROJECT_PATH || env.TRADING_WIKI_PROJECT_PATH || "",
    ).trim();
    const projectPath = configuredProject ? path.resolve(configuredProject) : null;
    const started = nowMs();
    const usageSamples = [];

    let proposal;
    try {
      proposal = await awaitResearch(signal, () => engine({
        projectPath,
        topic: selectedTopic,
        provider: modelRouting === "selected" ? "harness-user" : "harness-deepseek",
        noArtifacts: true,
        allowSynthesisTimeoutFallback: true,
        sources: "wiki,raw,graph,facts,brain",
        includeInvalidated: true,
        maxResults: 5,
        sourceK: 3,
        graphDepth: 1,
        graphNeighbors: 2,
        topBrain: 2,
        sqlLimit: 20,
        tavilyTimeoutMs: 30_000,
        signal,
        ...(wikiSession ? { wikiMode: wikiSession.mode, readWikiEvidence: wikiSession.readWikiEvidence } : {}),
        ...(tavilyClient ? { tavilyClient } : {}),
        requestText: async ({ prompt, instructions, format, signal: requestSignal }) => {
          const timeoutController = new AbortController();
          const providerSignal = combinedAbortSignal([
            signal,
            requestSignal,
            timeoutController.signal,
          ]);
          const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
          const assembler = createBlockAssembler();
          const message = createUserMessage({
            content: [{ type: "text", text: String(prompt || "") }],
            source: { kind: "plugin", plugin: "variable-os-desk-ui" },
          });
          try {
            throwIfAborted(providerSignal);
            const options = Object.freeze({
              ...route,
              messages: Object.freeze([message]),
              system: researchSystem(instructions, format),
              temperature: 0,
              maxTokens,
              signal: providerSignal,
            });
            for await (const chunk of llm.stream(options)) {
              assembler.push(chunk);
            }
            throwIfAborted(signal);
            if (timeoutController.signal.aborted) {
              const timeout = deepResearchError(
                "DEEP_RESEARCH_TIMEOUT",
                "Harness DeepSeek synthesis timed out",
              );
              timeout.name = "AbortError";
              throw timeout;
            }
            return terminalText(assembler);
          } catch (error) {
            if (signal?.aborted) throw deepResearchAbortError();
            if (timeoutController.signal.aborted && error?.code !== "DEEP_RESEARCH_TIMEOUT") {
              const timeout = deepResearchError(
                "DEEP_RESEARCH_TIMEOUT",
                "Harness DeepSeek synthesis timed out",
              );
              timeout.name = "AbortError";
              throw timeout;
            }
            throw error;
          } finally {
            usageSamples.push(usageOf(assembler.usage));
            clearTimeout(timer);
          }
        },
      }));
    } catch (error) {
      if (signal?.aborted) throw deepResearchAbortError();
      throw error;
    }
    throwIfAborted(signal);

    if (
      proposal?.schema !== "deep-research-proposal-v1" ||
      proposal?.authority !== "proposal" ||
      proposal?.writePolicy?.readOnly !== true ||
      proposal?.writePolicy?.wroteArtifacts !== false
    ) {
      throw deepResearchError(
        "DEEP_RESEARCH_CONTRACT_INVALID",
        "Trading Wiki Deep Research returned an unsafe contract",
      );
    }
    return Object.freeze({
      ...proposal,
      model: route,
      usage: Object.freeze(Object.fromEntries(["inputTokens", "outputTokens"].map(key => {
        const total = usageSamples.reduce((sum, row) => sum + (row[key] ?? 0), 0);
        return [key, usageSamples.length && usageSamples.every(row => Number.isSafeInteger(row[key]) && row[key] >= 0)
          && Number.isSafeInteger(total) ? total : null];
      }))),
      latencyMs: Math.max(0, nowMs() - started),
      ...(wikiSession ? { cacheable: false } : {}),
    });
  }
  const research = async (input = {}) => {
    let session;
    try {
      throwIfAborted(input.signal);
      const modelRoute = modelRouting === "selected" ? routeFrom(currentSelection, modelRouting) : undefined;
      session = createWikiSession ? await createWikiSession({ topic: input.topic, signal: input.signal }) : null;
      if (createWikiSession) {
        if (!session || !["local", "ima", "none"].includes(session.mode) || typeof session.close !== "function"
          || (session.signal !== undefined && !(session.signal instanceof AbortSignal))
          || (wikiResearchMode(session.mode) === "ima" && typeof session.readWikiEvidence !== "function")) {
          throw deepResearchError("DEEP_RESEARCH_CONTRACT_INVALID", "Invalid Wiki research session");
        }
      }
      return await researchWithHarness({
        ...input, signal: combinedAbortSignal([input.signal, session?.signal]), wikiSession: session, modelRoute,
      });
    } finally {
      if (typeof session?.close === "function") await session.close();
    }
  };
  Object.defineProperty(research, "cacheable", { value: createWikiSession === null });
  return research;
}

function inputFrom(params = {}) {
  const card = String(params.card || "").replace(/\s+/gu, " ").trim();
  const topic = String(params.topic || "").replace(/\s+/gu, " ").trim();
  if (
    card.length < 1 ||
    card.length > 200 ||
    topic.length < 2 ||
    topic.length > 200 ||
    /[\p{Cf}\u0000]/u.test(`${card}${topic}`)
  ) {
    throw deepResearchError(
      "DEEP_RESEARCH_INVALID_INPUT",
      "A valid card and bounded research topic are required",
    );
  }
  return { card, topic };
}

function failure(error) {
  const code =
    typeof error?.code === "string"
      ? error.code
      : "DEEP_RESEARCH_FAILED";
  const messages = {
    DEEP_RESEARCH_INVALID_INPUT: "联网补证的卷宗或检索主题不完整。",
    DEEP_RESEARCH_IN_PROGRESS: "另一条联网补证正在进行，请稍后再试。",
    DEEP_RESEARCH_UNAVAILABLE: "Trading Wiki Deep Research 当前不可用。",
    SOURCE_UNAVAILABLE: "研究来源未配置或当前不可用。",
    DEEP_RESEARCH_TIMEOUT: "联网补证超时，未改动当前证据链。",
    DEEP_RESEARCH_ABORTED: "联网补证已取消，当前证据链保持不变。",
  };
  return {
    ok: false,
    ...(code === "SOURCE_UNAVAILABLE" ? { status: "UNAVAILABLE" } : {}),
    error: {
      code,
      message: messages[code] || "联网补证未完成，当前证据链保持不变。",
    },
    projectionStatus: "UNCHANGED",
  };
}

/** Session cache and cost guard for explicit user-triggered research. */
export function createHarnessDeepResearchController({
  research,
  maxCacheEntries = MAX_CACHE_ENTRIES,
} = {}) {
  if (typeof research !== "function") {
    throw new TypeError("Deep Research controller requires a research function");
  }
  if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1) {
    throw new TypeError("maxCacheEntries must be a positive integer");
  }
  const cache = new Map();
  let inFlight = null;
  let cacheRevision;
  const currentRevision = () => {
    try {
      const revision = research.cacheRevision;
      if (revision !== cacheRevision) { cache.clear(); cacheRevision = revision; }
      return revision;
    } catch (error) { cache.clear(); throw error; }
  };

  return Object.freeze({
    status(params) {
      try {
        const { card } = inputFrom({ ...params, topic: params?.topic || "状态读取" });
        currentRevision();
        return {
          ok: true,
          result: research.cacheable === false ? null : cache.get(card) || null,
          projectionStatus: "UNCHANGED",
        };
      } catch (error) {
        return failure(error);
      }
    },

    async run(params, options = {}) {
      let input, revision;
      try {
        input = inputFrom(params);
        revision = currentRevision();
      } catch (error) {
        return failure(error);
      }
      const signal = options?.signal;
      if (signal?.aborted) return failure(deepResearchAbortError());
      const existing = research.cacheable === false ? null : cache.get(input.card);
      if (existing && params?.force !== true) {
        return {
          ok: true,
          result: Object.freeze({ ...existing, cached: true }),
          projectionStatus: "UNCHANGED",
        };
      }
      if (inFlight) {
        return failure(
          deepResearchError(
            "DEEP_RESEARCH_IN_PROGRESS",
            "Another Deep Research request is already running",
          ),
        );
      }
      const promise = Promise.resolve().then(() => {
        if (currentRevision() !== revision) throw deepResearchAbortError();
        return research({ topic: input.topic, signal });
      });
      inFlight = promise;
      try {
        const proposal = await promise;
        throwIfAborted(signal);
        if (currentRevision() !== revision) throw deepResearchAbortError();
        const result = Object.freeze({
          ...proposal,
          card: input.card,
          cached: false,
        });
        cache.delete(input.card);
        if (research.cacheable !== false && proposal.cacheable !== false) cache.set(input.card, result);
        while (cache.size > maxCacheEntries) {
          cache.delete(cache.keys().next().value);
        }
        return { ok: true, result, projectionStatus: "UNCHANGED" };
      } catch (error) {
        if (signal?.aborted) return failure(deepResearchAbortError());
        return failure(error);
      } finally {
        if (inFlight === promise) inFlight = null;
      }
    },
  });
}
