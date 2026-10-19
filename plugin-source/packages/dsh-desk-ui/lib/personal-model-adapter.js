// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { LlmAdapter, LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { DeepSeekAdapter, resolveAdapterOptions, catalogModelInfo, PUBLIC_BASE_URL } from "@deepseek-ai/dsh-llm-deepseek";
import { randomUUID } from "node:crypto";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { CUSTOM_MODEL_PROVIDER, customModelProfile } from "./custom-model-route.js";
import { NATIVE_MODEL_CREDENTIAL_REF } from "./personal-model-profile.js";

const provider = CUSTOM_MODEL_PROVIDER;
export const NATIVE_MODEL_PROVIDER = "variable-os-deepseek";
const nativeConnection = () => resolveAdapterOptions({
  baseURL: PUBLIC_BASE_URL, retryPolicy: { mode: "normal", maxRetries: 0 },
  // Preserve the bounded output budget unless the caller explicitly requests thinking.
  reasoningEffort: "off",
});
export const nativeModelCatalog = () => nativeConnection().models.map(({ id, name }) => ({ id, name: name ?? id }));
const fail = code => new LlmError(code, code);
const identity = value => value?.[Symbol.for("cordis.original")] ?? value;
const retryPolicy = resolveRetryPolicy({ mode: "normal", maxRetries: 0 }, provider);
const protocols = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi };
const safeCodes = new Set(["ABORTED", "AUTH", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT",
  "INVALID_REQUEST", "CONTEXT_WINDOW_EXCEEDED", "EMPTY_RESPONSE", "UNSUPPORTED_OPTION",
  "UNSUPPORTED_CONTENT", "UNSUPPORTED_REASONING_EFFORT", "MODEL_CREDENTIAL_REQUIRED",
  "MODEL_SETTINGS_CHANGED", "MODEL_SETTINGS_INVALID", "MODEL_SETTINGS_UNAVAILABLE",
  "MODEL_SELECTION_REQUIRED", "MODEL_REQUEST_FAILED"]);
const safeCode = error => safeCodes.has(error?.code) ? error.code : "MODEL_REQUEST_FAILED";
function untilAborted(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(fail("ABORTED")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function personalModelCredentialKey(ref) {
  if (ref === NATIVE_MODEL_CREDENTIAL_REF) return credentialKey("variable-os-desk-ui", "model-native-deepseek");
  if (typeof ref !== "string" || !/^VARIABLE_OS_MODEL_[A-F0-9]{32}$/.test(ref)) {
    throw fail("MODEL_SETTINGS_INVALID");
  }
  return credentialKey("variable-os-desk-ui", `model-${ref.slice("VARIABLE_OS_MODEL_".length).toLowerCase()}`);
}

export const isPersonalModelCredential = record => Boolean(record?.kind === "api-key"
  && Object.keys(record).length === 2 && typeof record.key === "string" && /^[\x21-\x7e]{1,8192}$/.test(record.key));

function nativeProfile(route) {
  const displayName = customModelProfile(route).displayName;
  // Required pi-ai construction defaults, not measured endpoint capabilities.
  // The outer adapter deliberately does not advertise these capacities.
  const model = { id: route.model, name: route.model, provider, api: route.protocol,
    baseUrl: route.endpoint, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 32768 };
  const piProvider = createProvider({
    id: provider, name: displayName, baseUrl: route.endpoint, models: [model], api: protocols[route.protocol](),
    auth: { apiKey: { name: displayName, async resolve({ credential }) {
      if (!credential?.key) throw fail("MODEL_CREDENTIAL_REQUIRED");
      return { auth: { apiKey: credential.key }, source: "variable-os-private-record" };
    } } },
  });
  return { provider, displayName, piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), retryPolicy,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576, transport: "sse" };
}

// API-key only. Neither native reference/env lookup nor pi-ai ambient login is
// a fallback for a missing plugin-owned record.
const noAmbientAuth = {
  credentials: {
    async read() { return undefined; }, async list() { return []; },
    async modify() { throw fail("MODEL_CREDENTIAL_REQUIRED"); },
    async delete() { throw fail("MODEL_CREDENTIAL_REQUIRED"); },
  },
  authContext: { async env() { return undefined; }, async fileExists() { return false; } },
};

export function registerPersonalModelAdapter(ctx, { profile }) {
  let closed = false, generation = 0, anonymousUserId, retiredNativeRevision, nativeSelectionRevision;
  const nativeAdapter = resolveApiKey => new DeepSeekAdapter({
    options: nativeConnection,
    // The official Messages adapter resolves request-local headers. Keep the
    // private, cancellable credential lookup and never consult ambient auth.
    resolveAuth: async () => ({ headers: { "x-api-key": await resolveApiKey() } }),
    discoverModels: async id => nativeConnection().models.map(model => catalogModelInfo(id, model)),
    // Private research adds no global Host request-extension fields.
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    // This plugin session does not read or create the user's global DSH identity.
    resolveUserId: () => anonymousUserId ??= randomUUID(),
    resolveAttachments: () => ctx.get("attachments"),
  });
  const active = new Map();
  const selection = () => {
    if (closed) return null;
    const value = profile.snapshot();
    if (value.nativeModel && value.revision !== retiredNativeRevision
      && nativeModelCatalog().some(row => row.id === value.nativeModel)) {
      nativeSelectionRevision = value.revision;
      return { provider: NATIVE_MODEL_PROVIDER, model: value.nativeModel };
    }
    return value.route && value.selectedModel === value.route.model
      ? { provider, model: value.selectedModel } : null;
  };
  const checkOpen = signal => {
    if (closed || signal?.aborted) throw fail("ABORTED");
  };
  function capture(requestedProvider, model, signal) {
    checkOpen(signal);
    const value = profile.snapshot(), proof = profile.capture(value.revision);
    const native = requestedProvider === NATIVE_MODEL_PROVIDER;
    if (native ? value.revision === retiredNativeRevision || value.nativeModel !== model
      || !nativeModelCatalog().some(row => row.id === model)
      : requestedProvider !== provider || !value.route || value.route.model !== model
        || value.selectedModel !== model) throw fail("MODEL_SELECTION_REQUIRED");
    const credentials = ctx.get("credentials");
    if (typeof credentials?.readRecord !== "function") throw fail("MODEL_SETTINGS_UNAVAILABLE");
    const address = personalModelCredentialKey(native ? value.nativeCredentialRef : value.credentialRef);
    const capturedGeneration = generation;
    if (native) nativeSelectionRevision = value.revision;
    return { native, model, route: proof.value.route, address, credentials, signal, assertCurrent() {
      checkOpen(signal);
      if (capturedGeneration !== generation) throw fail("MODEL_SETTINGS_CHANGED");
      proof.assertCurrent();
      if (identity(ctx.get("credentials")) !== identity(credentials)) throw fail("MODEL_SETTINGS_CHANGED");
    } };
  }
  async function* stream(selected, options) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...[selected.signal, options.signal].filter(Boolean)]);
    active.set(controller, selected.address);
    try {
      selected.assertCurrent(); checkOpen(signal);
      const resolveApiKey = async () => {
        selected.assertCurrent(); checkOpen(signal);
        const record = await untilAborted(selected.credentials.readRecord(selected.address), signal);
        selected.assertCurrent(); checkOpen(signal);
        if (!isPersonalModelCredential(record)) throw fail("MODEL_CREDENTIAL_REQUIRED");
        return record.key;
      };
      const adapter = selected.native ? nativeAdapter(resolveApiKey) : new PiAiAdapter({
        profiles: () => new Map([[provider, nativeProfile(selected.route)]]), auth: noAmbientAuth, resolveApiKey,
      });
      for await (const chunk of adapter.stream({ ...options, signal })) {
        selected.assertCurrent(); checkOpen(signal);
        if (chunk.type === "finish" && ["error", "aborted"].includes(chunk.reason.kind)) {
          const code = safeCode(chunk.reason.failure);
          yield { type: "finish", reason: { kind: chunk.reason.kind, failure: { code, message: code } } };
        } else yield chunk;
      }
    } catch (error) {
      const code = signal.aborted ? "ABORTED" : safeCode(error);
      yield { type: "finish", reason: { kind: code === "ABORTED" ? "aborted" : "error",
        failure: { code, message: code } } };
    } finally {
      controller.abort();
      active.delete(controller);
    }
  }
  const modelInfo = route => ({ provider, id: route.model, name: route.model, inputModalities: ["text"] });
  const capturedModel = selected => selected.native
    ? nativeAdapter().resolveModel(NATIVE_MODEL_PROVIDER, selected.model) : modelInfo(selected.route);
  class PersonalAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: id === NATIVE_MODEL_PROVIDER ? "DeepSeek (DSH)" : "Variable OS" }; }
    providerRetryPolicy() { return retryPolicy; }
    async listModels(id) {
      checkOpen();
      if (id === NATIVE_MODEL_PROVIDER) return nativeAdapter().listModels(id);
      const value = profile.snapshot();
      return value.route ? [modelInfo(value.route)] : [];
    }
    async resolveModel(requestedProvider, model, signal) {
      return capturedModel(capture(requestedProvider, model, signal));
    }
    async prepareCall(requestedProvider, model, signal) {
      const selected = capture(requestedProvider, model, signal);
      return { model: await capturedModel(selected), stream: options => stream(selected, options) };
    }
    stream(options) { return stream(capture(options.provider, options.model, options.signal), options); }
  }
  const registration = ctx.llm.registerAdapter([provider, NATIVE_MODEL_PROVIDER], new PersonalAdapter());
  const stop = address => {
    for (const [controller, key] of active) if (address === undefined || address === key) controller.abort();
  };
  const unsubscribe = ctx.on("credentials/record-updated", address => {
    if (typeof address !== "string" || !address.startsWith("variable-os-desk-ui/model-")) return;
    generation++;
    if (address === personalModelCredentialKey(NATIVE_MODEL_CREDENTIAL_REF)) {
      try {
        const value = profile.snapshot();
        retiredNativeRevision = value.revision;
        // Credential events also cover edits outside this settings controller.
        // Retire the persisted choice so a restart cannot revive it.
        if (value.nativeModel) profile.prepareNative({ revision: value.revision });
      }
      catch { retiredNativeRevision = nativeSelectionRevision; }
    }
    stop(address);
  });
  function close() {
    if (closed) return;
    closed = true; stop(); unsubscribe(); registration();
  }
  ctx.effect(() => close);
  return Object.freeze({ currentSelection: selection, invalidate() { generation += 1; stop(); }, close });
}
