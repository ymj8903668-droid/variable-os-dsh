// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createImaSessionBudget, createImaResearchBudget } from "../../packages/evidence-provider/src/ima-budget.mjs";
import { providerError, runCancellable, wikiEvidenceIdentity } from "../../packages/evidence-provider/src/index.mjs";
import { createWikiResearchSession } from "./wiki-research-source.mjs";
import { createWikiSourceProfile } from "./wiki-source-profile.mjs";
import { randomBytes } from "node:crypto";
import { normalizeImaDocumentSelections } from "../../packages/evidence-provider/src/ima-directory.mjs";

const invalid = () => Object.assign(new Error("Invalid Wiki source settings"), { code: "INVALID_REQUEST" });
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const opaque = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && value.trim() === value && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value);
const credential = value => typeof value === "string" && /^[\x21-\x7e]{1,8192}$/.test(value);
const diagnosticReasons = new Set([
  "IMA_REQUEST_TIMEOUT", "IMA_SESSION_TIMEOUT", "IMA_TLS_OR_NETWORK_FAILURE", "IMA_DNS_REJECTED",
  "IMA_PAGINATION_INVALID", "IMA_RESPONSE_INVALID", "IMA_IDENTITY_AMBIGUOUS",
  "IMA_API_BUDGET_EXHAUSTED", "IMA_RATE_LIMITED",
]);
function checkDiagnostic(error) {
  if (["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "CANCELLED"].includes(error?.code)) return error.code;
  return error?.code === "SOURCE_UNAVAILABLE" && diagnosticReasons.has(error?.details?.reason)
    ? error.details.reason : "SOURCE_UNAVAILABLE";
}

function configuration(value) {
  if (!plain(value) || Object.keys(value).some(key => !["mode", "libraryId", "modelUseAllowed", "selectedContentHashes", "selectedDocuments"].includes(key))
    || !["local", "ima", "none"].includes(value.mode) || typeof value.modelUseAllowed !== "boolean"
    || (value.libraryId !== null && !opaque(value.libraryId))
    || (value.mode !== "ima" && (value.libraryId !== null || value.modelUseAllowed))) throw invalid();
  const selected = value.selectedContentHashes ?? {};
  if (!plain(selected) || Object.keys(selected).length > 3 || (value.mode !== "ima" && Object.keys(selected).length)) throw invalid();
  for (const [id, hash] of Object.entries(selected)) {
    try {
      const parts = id.split(":");
      const documentId = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[3] ?? "", "base64url"));
      const identity = wikiEvidenceIdentity({ provider: "ima", libraryId: value.libraryId, documentId });
      if (identity.evidenceId !== id || !/^[a-f0-9]{64}$/.test(hash)) throw invalid();
    } catch { throw invalid(); }
  }
  let documents;
  try {
    documents = normalizeImaDocumentSelections(value.selectedDocuments, value.libraryId);
    if (documents.length && value.mode !== "ima") throw invalid();
  } catch { throw invalid(); }
  return Object.freeze({ mode: value.mode, libraryId: value.libraryId, modelUseAllowed: value.modelUseAllowed,
    selectedContentHashes: Object.freeze({ ...selected }),
    ...(documents.length ? { selectedDocuments: documents } : {}) });
}

/** Host-owned settings; credential input is a separate revision-bound mutation. */
export function createWikiSourceSettings({
  env = {},
  loadIma = () => import("../../packages/evidence-provider/src/ima-transport.mjs"),
  createBudget = createImaSessionBudget,
  now = () => new Date().toISOString(),
} = {}) {
  let credentials = Object.freeze({
    clientId: env.VARIABLE_OS_IMA_CLIENT_ID, apiKey: env.VARIABLE_OS_IMA_API_KEY,
  });
  const credentialsConfigured = () => credential(credentials?.clientId) && credential(credentials?.apiKey);
  if (env.VARIABLE_OS_IMA_MODEL_USE !== undefined && !["true", "false"].includes(env.VARIABLE_OS_IMA_MODEL_USE)) throw invalid();
  let selected = configuration({
    mode: env.VARIABLE_OS_WIKI_PROVIDER ?? "local",
    libraryId: env.VARIABLE_OS_IMA_LIBRARY_ID || null,
    modelUseAllowed: env.VARIABLE_OS_IMA_MODEL_USE === "true",
  });
  let connection = "NOT_CHECKED", checkedAt = null, checkError = null, libraries = [], closed = false, checking = false;
  let generation = 0;
  const profile = createWikiSourceProfile(env);
  let profileRevision = randomBytes(32).toString("hex"), diskState = null, managedCredentials = profile.persistent;
  const budgets = new Set(), researchControllers = new Set();
  function assertOpen() { if (closed) throw providerError("CANCELLED"); }
  function snapshot() {
    refresh();
    return Object.freeze({ ...selected, credentialsConfigured: credentialsConfigured(), connection, checkedAt, checkError,
      persistence: profile.persistent ? "HOST_FILE" : "SESSION_ONLY", profileRevision,
      libraries: Object.freeze(libraries.map(row => Object.freeze({ id: row.id, name: row.name }))) });
  }
  function closeBudget(budget) { budget.close(); budgets.delete(budget); }
  function cancel() {
    for (const budget of budgets) closeBudget(budget);
    for (const controller of researchControllers) controller.abort();
  }
  function adopt(value) {
    cancel(); generation++;
    credentials = value?.credentials ?? null;
    selected = value?.selected ?? configuration({ mode: "none", libraryId: null, modelUseAllowed: false });
    profileRevision = value?.revision ?? randomBytes(32).toString("hex");
    connection = "NOT_CHECKED"; checkedAt = null; checkError = null; libraries = [];
  }
  function refresh(initial = false) {
    if (!profile.persistent) return;
    try {
      const value = profile.read();
      if (value !== null) {
        if (!plain(value) || Object.keys(value).sort().join(",") !== "credentials,revision,schema,selected" ||
          value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.revision) ||
          value.credentials !== null && (!plain(value.credentials) ||
            Object.keys(value.credentials).sort().join(",") !== "apiKey,clientId" ||
            !credential(value.credentials.clientId) || !credential(value.credentials.apiKey))) throw invalid();
        value.selected = configuration(value.selected);
      }
      const serialized = JSON.stringify(value);
      if (initial || serialized !== diskState) { adopt(value); diskState = serialized; }
    } catch {
      cancel();
      throw Object.assign(Error("WIKI_PROFILE_INVALID"), { code: "WIKI_PROFILE_INVALID" });
    }
  }
  function save(nextSelected, nextCredentials = credentials) {
    const value = { schema: 1, revision: randomBytes(32).toString("hex"),
      selected: nextSelected, credentials: credential(nextCredentials?.clientId) && credential(nextCredentials?.apiKey)
        ? { ...nextCredentials } : null };
    profile.write(value);
    diskState = JSON.stringify(value);
    adopt(value);
  }
  refresh(true);
  function openBudget(signal, factory = createBudget) {
    assertOpen();
    if (!credentialsConfigured()) throw providerError("AUTH_REQUIRED");
    const budget = factory({ signal });
    budgets.add(budget);
    return budget;
  }
  async function access(budget) {
    return runCancellable(budget.signal, async () => {
      const ima = await loadIma();
      if (budget.signal.aborted) throw providerError("CANCELLED");
      return { ima, transport: ima.createImaTransport({ credentials, budget }) };
    });
  }
  async function openSession({ signal } = {}, factory = createBudget) {
    assertOpen();
    refresh();
    const current = generation, choice = selected;
    if (choice.mode !== "ima") return createWikiResearchSession({ mode: choice.mode });
    if (!credentialsConfigured()) throw providerError("AUTH_REQUIRED");
    if (!choice.libraryId) throw providerError("SOURCE_UNAVAILABLE", "IMA_LIBRARY_REQUIRED");
    const budget = openBudget(signal, factory);
    try {
      const { ima, transport } = await access(budget);
      refresh();
      if (generation !== current || budget.signal.aborted) throw providerError("CANCELLED");
      const provider = ima.createImaEvidenceProvider({
        libraryId: choice.libraryId, modelUseAllowed: choice.modelUseAllowed,
        selectedContentHashes: choice.selectedContentHashes, selectedDocuments: choice.selectedDocuments, transport, budget,
      });
      const { datasetId } = wikiEvidenceIdentity({ provider: "ima", libraryId: choice.libraryId, documentId: "scope" });
      const session = createWikiResearchSession({ mode: "ima", provider, scope: { datasetIds: [datasetId] }, budget });
      return Object.freeze({ ...session, close() { session.close(); budgets.delete(budget); } });
    } catch (error) { closeBudget(budget); throw error; }
  }
  const settings = {
    snapshot,
    assertRevision(expected) {
      assertOpen();
      refresh();
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || expected !== profileRevision) {
        throw Object.assign(Error("WIKI_SOURCE_CHANGED"), { code: "WIKI_SOURCE_CHANGED" });
      }
    },
    configure(value) {
      assertOpen();
      refresh();
      const next = configuration(value);
      const retainedLibraries = next.mode === "ima" && selected.mode === "ima" ? libraries : [];
      save(next);
      libraries = retainedLibraries;
      return snapshot();
    },
    async call(method, params = {}, options = {}) {
      assertOpen();
      if (options.signal?.aborted) throw providerError("CANCELLED");
      refresh();
      if (method === "wikiSourceBrowse") {
        if (!plain(params) || Object.keys(params).some(key => !["profileRevision", "location"].includes(key))) throw invalid();
        settings.assertRevision(params.profileRevision);
        const session = await settings.createSession(options);
        try {
          if (session.mode !== "ima") throw providerError("SOURCE_UNAVAILABLE", "IMA_LIBRARY_REQUIRED");
          const result = await session.browseDirectory({ location: params.location, signal: options.signal });
          settings.assertRevision(params.profileRevision);
          return result;
        } finally { session.close(); }
      }
      if (["wikiSourceConfigure", "wikiSourceCredentials"].includes(method)) {
        if (!plain(params)) throw invalid();
        const { profileRevision: expected, ...value } = params;
        if ((managedCredentials || method === "wikiSourceCredentials" || expected !== undefined) && expected !== profileRevision) {
          throw Object.assign(Error("WIKI_SOURCE_CHANGED"), { code: "WIKI_SOURCE_CHANGED" });
        }
        if (method === "wikiSourceConfigure") return settings.configure(value);
        if (Object.keys(value).sort().join(",") !== "apiKey,clientId" ||
          !(value.clientId === null && value.apiKey === null) &&
          !(credential(value.clientId) && credential(value.apiKey))) throw invalid();
        save(configuration({ mode: selected.mode, libraryId: null, modelUseAllowed: false }),
          value.clientId === null ? null : value);
        managedCredentials = true;
        return snapshot();
      }
      if (!plain(params) || Object.keys(params).length) throw invalid();
      if (method === "wikiSourceStatus") return snapshot();
      if (method === "wikiSourceCheck") return settings.check(options);
      throw invalid();
    },
    async check({ signal } = {}) {
      assertOpen();
      refresh();
      if (selected.mode !== "ima") { connection = "NOT_APPLICABLE"; return snapshot(); }
      if (checking) throw Object.assign(new Error("Wiki check is active"), { code: "CLIENT_BUSY" });
      const current = generation;
      let budget;
      checking = true; connection = "CHECKING"; checkError = null;
      try {
        budget = openBudget(signal);
        const { ima, transport } = await access(budget);
        const result = await runCancellable(budget.signal, () => ima.listImaKnowledgeBases({ transport, budget }, budget.signal));
        refresh();
        if (generation !== current || closed) throw providerError("CANCELLED");
        libraries = result.map(({ id, name }) => ({ id, name }));
        checkedAt = now();
        connection = !selected.libraryId ? "LIBRARY_REQUIRED"
          : libraries.some(row => row.id === selected.libraryId) ? "LIBRARY_LISTED" : "LIBRARY_NOT_LISTED";
        return snapshot();
      } catch (error) {
        if (generation === current && !closed) {
          connection = "FAILED"; checkedAt = null; libraries = []; checkError = checkDiagnostic(error);
        }
        throw error;
      } finally { checking = false; if (budget) closeBudget(budget); }
    },
    createSession(options) { return openSession(options); },
    // Host-only entry. The research controller owns the one-use approval; the
    // settings RPC cannot increase an allowance or execute this method directly.
    async createResearchSession(params = {}) {
      if (!plain(params) || Object.keys(params).some(key => !["profileRevision", "limits", "signal"].includes(key))) throw invalid();
      settings.assertRevision(params.profileRevision);
      if (selected.mode !== "ima" || !selected.modelUseAllowed) throw providerError("FORBIDDEN_SCOPE");
      return openSession({ signal: params.signal }, options => createImaResearchBudget({ ...options, limits: params.limits }));
    },
    bindResearch(createResearch) {
      const legacy = createResearch({});
      const configured = createResearch({ createWikiSession: input => settings.createSession(input) });
      const run = async (input = {}) => {
        assertOpen();
        refresh();
        if (Object.hasOwn(input, "wikiSourceRevision")) settings.assertRevision(input.wikiSourceRevision);
        const current = generation;
        const research = selected.mode === "local" ? legacy : configured;
        const controller = new AbortController();
        researchControllers.add(controller);
        const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
        try {
          // Keep existing research error codes; the provider cancellation helper
          // otherwise maps non-provider failures to SOURCE_UNAVAILABLE.
          const result = await runCancellable(signal, async () => {
            try { return { value: await research({ ...input, signal }) }; }
            catch (error) { return { error }; }
          });
          refresh();
          if (current !== generation || signal.aborted) throw providerError("CANCELLED");
          if (Object.hasOwn(result, "error")) throw result.error;
          return result.value;
        }
        finally { researchControllers.delete(controller); }
      };
      Object.defineProperty(run, "cacheable", { get: () => selected.mode === "local" && legacy.cacheable !== false });
      Object.defineProperty(run, "cacheRevision", { get: () => { refresh(); return profileRevision; } });
      return run;
    },
    close() { if (!closed) { closed = true; generation++; cancel(); libraries = []; } },
  };
  return Object.freeze(settings);
}
