// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { createRemoteProvider } from "../../dsh-tools/lib/remote/provider.js";
import { subscribeCards } from "../../dsh-tools/lib/remote/stream.js";
import { remoteError, safeError } from "../../dsh-tools/lib/remote/config.js";
import { createRemoteResearch } from "./remote-research.js";
import { createWikiSourceSettings } from "../../../src/runtime/wiki-source-settings.mjs";
import { createSourceSettings, sourceSettingsPath } from "../../dsh-tools/lib/remote/source-settings.js";
import { createPersonalHost, PERSONAL_METHODS } from "./personal-host.js";
import { createPublishedDesk } from "./published-desk.js";
import { createPersonalTurnResearch } from "./personal-turn-research.js";
import { createPublishedSync } from "./published-sync.js";
import { createPersonalCardAnalyzer } from "./personal-card-analysis.js";
import { createPersonalImaResearch } from "./personal-ima-research.js";
import { createPersonalImaLibraryResearch } from "./personal-ima-library-research.js";
import { createPersonalConversations } from "./personal-conversations.js";
import { createPersonalConversationStore } from "./personal-conversation-store.js";
import { canonicalHash } from "../../../src/schema/canonical-json.mjs";
import { createPersonalPublishedResearch } from "./personal-published-research.js";
import { createPersonalJudgment } from "./personal-judgment.js";
import { createPersonalDisclosureStore } from "./personal-disclosure-store.js";
import { guardImaResearchDisclosures } from "./ima-research-output.js";
import { createModelServiceSettings, MODEL_SETTINGS_METHODS, MODEL_SETTINGS_CODES } from "./model-service-settings.js";
import { createVoiceServiceSettings, VOICE_SETTINGS_METHODS, VOICE_SETTINGS_CODES } from "./voice-service-settings.js";
import { createPersonalDuplex } from "./personal-duplex.js";
import { createPersonalNarration, PERSONAL_NARRATION_CODES } from "./personal-narration.js";
import { createWebResearchSettings } from "./web-research-settings.js";
import { createWebServiceSettings, WEB_SERVICE_CODES } from "./web-service-settings.js";
import { createPersonalTavilySearch } from "./personal-tavily-search.js";
import { createWebResearchSession } from "./web-research-session.js";
import { createIndependentResearchController, INDEPENDENT_RESEARCH_METHODS, INDEPENDENT_RESEARCH_CODES } from "./independent-research-controller.js";
import { createIndependentHistoryStore } from "./independent-history-store.js";
import { createIndependentResearchHistory } from "./independent-research-history.js";
import { runIndependentResearch } from "./independent-research-engine.js";
export { createLocalNarrationController } from "./local-narration.js";
import { createPublicOnboarding } from "./public-onboarding.js";
export { loadPersonalVoiceRuntime } from "./personal-voice-runtime.js";
import { createDuplexHttpHandler } from "../../../src/http/research-host-duplex.mjs";
import { createResearchHostAgentHandler } from "../../../src/http/research-host-agent.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function closeRemoteServices({ duplex, voiceSettings, conversations, narration }) {
  // Native history must remain available until voice retirement has tried to
  // drain it. A failure in that phase must not skip the remaining cleanup.
  const results = await Promise.allSettled([Promise.resolve().then(() => duplex.close())]);
  results.push(...await Promise.allSettled([voiceSettings, conversations, ...(narration ? [narration] : [])]
    .map(service => Promise.resolve().then(() => service.close()))));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

function publicOnboardingRoot(env) {
  if (env.VARIABLE_OS_PUBLIC_DESK !== "1" ||
    ![env.DSH_HOME, env.VARIABLE_OS_PERSONAL_DESK_ROOT]
      .every(value => typeof value === "string" && path.isAbsolute(value))) return null;
  const root = path.resolve(env.DSH_HOME, "variable-os-public-onboarding");
  const workspace = path.resolve(env.VARIABLE_OS_PERSONAL_DESK_ROOT);
  const namespaces = [root, workspace].map((target, namespace) => {
    let current = path.parse(target).root;
    const parts = target.slice(current.length).split(path.sep).filter(Boolean), ancestors = [];
    for (let index = 0; index <= parts.length; index++) {
      try {
        const stat = lstatSync(current);
        if (!stat.isDirectory()) return null;
        ancestors.push({ dev: stat.dev, ino: stat.ino,
          tail: parts.slice(index).map(part => part.normalize("NFD").toLowerCase()) });
      } catch (error) {
        if (error.code === "ENOENT") {
          if (namespace === 0 && index < parts.length) return null;
          break;
        }
        return null;
      }
      if (index < parts.length) current = path.join(current, parts[index]);
    }
    return ancestors;
  });
  if (namespaces.some(value => value === null)) return null;
  // Existing aliases share directory identity. Future names are compared
  // conservatively even on a case-sensitive volume; navigation never claims a ledger.
  const prefix = (a, b) => a.length <= b.length && a.every((part, index) => part === b[index]);
  for (const a of namespaces[0]) for (const b of namespaces[1]) {
    if (a.dev === b.dev && a.ino === b.ino && (prefix(a.tail, b.tail) || prefix(b.tail, a.tail))) return null;
  }
  return root;
}

export function createRemoteDesk({ env = process.env, appRoot = env.VARIABLE_OS_APP_ROOT,
  wikiSettings = createWikiSourceSettings({ env }), modelSettings = createModelServiceSettings(),
  voiceSettings = createVoiceServiceSettings(), voiceCredentials = () => undefined, createVoiceProvider, localNarration,
  webService = createWebServiceSettings({ env }), searchWeb = createPersonalTavilySearch(),
  ...harness } = {}) {
  env = { ...env };
  const onboardingRoot = publicOnboardingRoot(env);
  const publicOnboarding = createPublicOnboarding({
    enabled: onboardingRoot !== null, root: onboardingRoot,
  });
  const sources = createSourceSettings({ env });
  const provider = createRemoteProvider({ env, resolveEnv: sources.resolveEnv });
  let publishedSync;
  const published = createPublishedDesk({ sources, provider: {
    async call(...args) {
      const revision = sources.revision();
      publishedSync?.assertReadable(revision);
      try {
        const result = await provider.call(...args);
        publishedSync?.assertReadable(revision);
        return result;
      } catch (error) {
        publishedSync?.readDenied(error, { sourceRevision: revision, signal: args[2]?.signal });
        // Snapshot paging and pure original reads own their bounded Retry-After
        // wait. Disconnecting here would clear the library on a normal card click.
        // Other reads (including a model turn's final authority proof) still
        // fail closed and never replay a paid operation.
        if (!args[2]?.snapshotRead) publishedSync?.readThrottled(error, { sourceRevision: revision });
        throw error;
      }
    },
  } });
  const sourceFile = sourceSettingsPath(env);
  publishedSync = createPublishedSync({ provider, sources,
    file: sourceFile ? path.join(path.dirname(sourceFile), "published-sync.json") : null,
    // Notifications acknowledge the authorized metadata projection. The desk
    // reads original bodies independently, with their publication hash checks.
    readSnapshot: async options => {
      let membership;
      const health = await published.call("health", {}, {
        ...options, sourceRevision: sources.revision(), onMembership: value => { membership = value; },
      });
      return { ...health, result: { health: health.result, membership } };
    },
  });
  const webSettings = createWebResearchSettings({ sources, provider });
  const hasModelHost = [harness.llm?.stream, harness.currentSelection,
    harness.createUserMessage, harness.createBlockAssembler].every(value => typeof value === "function");
  const disclosures = createPersonalDisclosureStore({
    ...(path.isAbsolute(env.VARIABLE_OS_PERSONAL_DESK_ROOT ?? "")
      ? { file: path.join(env.VARIABLE_OS_PERSONAL_DESK_ROOT, "disclosures.json") } : {}),
  });
  let busy = false, generation = new AbortController(), closed = false;
  let configuringWeb = false;
  const webSession = (allowed, revision, signal) => {
    if (configuringWeb) throw remoteError("CLIENT_BUSY");
    return createWebResearchSession({ settings: webService, search: searchWeb, allowed, revision, signal });
  };
  let configuringModel = false, activeModelOperations = 0, modelConfigurationVersion = 0;
  const modelUnavailable = code => ({ ready: false, code, connection: "NOT_CHECKED" });
  const modelReadiness = async signal => {
    const unavailable = code => ({ value: modelUnavailable(code), assertCurrent() {} });
    if (!hasModelHost) return unavailable("MODEL_SETTINGS_UNAVAILABLE");
    if (configuringModel) return unavailable("CLIENT_BUSY");
    try {
      const proof = await modelSettings.inspectReadiness({ signal }), { value } = proof;
      return value?.connection === "NOT_CHECKED" && typeof value.ready === "boolean"
        && (value.ready ? value.code === "MODEL_CONFIGURED"
          : ["MODEL_SETTINGS_UNAVAILABLE", "MODEL_SETTINGS_INVALID", "MODEL_SELECTION_REQUIRED",
            "MODEL_CREDENTIAL_REQUIRED", "MODEL_PROVIDER_UNAVAILABLE"].includes(value.code))
        && typeof proof.assertCurrent === "function" ? proof : unavailable("MODEL_SETTINGS_UNAVAILABLE");
    } catch (error) {
      if (signal?.aborted) throw remoteError("CANCELLED");
      return unavailable(error?.code === "MODEL_SETTINGS_CHANGED" ? error.code : "MODEL_SETTINGS_UNAVAILABLE");
    }
  };
  const withModelLease = async operation => {
    if (configuringModel) throw remoteError("CLIENT_BUSY");
    activeModelOperations++;
    try { return await operation(); } finally { activeModelOperations--; }
  };
  const upstreamLlm = harness.llm;
  if (typeof upstreamLlm?.stream === "function") {
    harness.llm = {
      async *stream(...args) {
        if (configuringModel) throw remoteError("CLIENT_BUSY");
        activeModelOperations++;
        try { yield* upstreamLlm.stream(...args); } finally { activeModelOperations--; }
      },
      ...(typeof upstreamLlm.prepareCall === "function" ? {
        prepareCall: (...args) => withModelLease(() => upstreamLlm.prepareCall(...args)),
      } : {}),
    };
  }
  const runResearch = async (params, options = {}) => {
    const { signal } = options;
    if (Object.hasOwn(options, "wikiSourceRevision")) wikiSettings.assertRevision(options.wikiSourceRevision);
    if (params.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
    if (typeof params.webSearchAllowed !== "boolean") throw remoteError("INVALID_REQUEST");
    const web = webSession(params.webSearchAllowed, options.webServiceRevision, signal);
    const assertSource = () => {
      web.assertCurrent(signal);
      if (Object.hasOwn(options, "researchSourceRevision") &&
        options.researchSourceRevision !== sources.revision()) throw remoteError("SOURCE_CHANGED");
    };
    assertSource();
    if (busy) throw remoteError("CLIENT_BUSY");
    busy = true;
    try {
      const research = wikiSettings.bindResearch(options => createRemoteResearch({
        provider: { async call(...args) {
          assertSource();
          const result = await provider.call(...args);
          assertSource();
          return result;
        } }, ...harness, ...options, modelRouting: "selected", revalidate: true,
        tavily: web.tavily, ownWeb: web.ownWeb, assertWeb: web.assertCurrent,
      }));
      const result = await research({ topic: params.topic, signal,
        ...(Object.hasOwn(options, "wikiSourceRevision") ? { wikiSourceRevision: options.wikiSourceRevision } : {}) });
      if (signal?.aborted) throw remoteError("CANCELLED");
      assertSource();
      return result;
    } finally { busy = false; }
  };
  const runImaResearch = async (params, { signal, wikiSourceRevision, researchSourceRevision, webServiceRevision, withImaResearch } = {}) => {
    wikiSettings.assertRevision(wikiSourceRevision);
    if (params.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
    const library = params.researchScope === "library";
    const supplement = library && params.apiSupplementAllowed === true;
    const web = webSession(params.webSearchAllowed, webServiceRevision, signal);
    if (params.webSearchAllowed && !library ||
      (supplement || web.tavily === "edge") && !provider.settings().ready) throw remoteError("SOURCE_UNAVAILABLE");
    if (web.tavily === "edge" && !supplement) throw remoteError("MODEL_CONSENT_REQUIRED");
    const assertSources = () => {
      wikiSettings.assertRevision(wikiSourceRevision);
      web.assertCurrent(signal);
      if (supplement && sources.revision() !== researchSourceRevision) throw remoteError("SOURCE_CHANGED");
      if (signal?.aborted) throw remoteError("CANCELLED");
    };
    assertSources();
    if (busy) throw remoteError("CLIENT_BUSY");
    busy = true;
    try {
      const guardedInputs = guardImaResearchDisclosures(withImaResearch, disclosures);
      const research = library ? createPersonalImaLibraryResearch({
        ...harness, withImaResearch: guardedInputs, card: params.card, provider, assertSources,
        apiSupplementAllowed: supplement, webSearchAllowed: params.webSearchAllowed,
        ownWeb: web.ownWeb,
      }) : createPersonalImaResearch({ ...harness, withImaResearch: guardedInputs, card: params.card });
      const result = await research({ topic: params.topic, signal });
      assertSources();
      return result;
    } finally { busy = false; }
  };
  const independentHistoryStore = createIndependentHistoryStore({
    ...(path.isAbsolute(env.VARIABLE_OS_PERSONAL_DESK_ROOT ?? "")
      ? { file: path.join(env.VARIABLE_OS_PERSONAL_DESK_ROOT, "independent-research-history.json") } : {}),
  });
  const independentHistory = createIndependentResearchHistory({ store: independentHistoryStore, wikiSettings });
  // Local configuration changes purge old identity payloads even with no open
  // browser. No external access runs here; an unreadable store fails on use.
  const reconcileIndependentHistory = () => { try { independentHistory.reconcile(); } catch { /* surfaced on history/research admission */ } };
  reconcileIndependentHistory();
  const independentHistoryTimer = setInterval(reconcileIndependentHistory, 5000);
  independentHistoryTimer.unref?.();
  const independentResearch = createIndependentResearchController({
    async capture(params) {
      independentHistory.reconcile();
      const wiki = wikiSettings.snapshot();
      if (wiki.mode !== "ima" || !wiki.libraryId || !wiki.modelUseAllowed) throw remoteError("MODEL_CONSENT_REQUIRED");
      if (!wiki.credentialsConfigured) throw remoteError("AUTH_REQUIRED");
      const readiness = await modelReadiness();
      if (!readiness.value.ready) throw remoteError(readiness.value.code);
      const selected = harness.currentSelection();
      const model = { provider: selected?.provider, model: selected?.model,
        ...(selected?.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) };
      if (![model.provider, model.model].every(value => typeof value === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value))) throw remoteError("MODEL_SELECTION_REQUIRED");
      const webChoice = webService.snapshot(), modelVersion = modelConfigurationVersion;
      if (params.webSearchAllowed && (webChoice.mode !== "own" || !webChoice.configured)) throw remoteError("SOURCE_UNAVAILABLE");
      const web = webSession(params.webSearchAllowed, webChoice.revision);
      const assertCurrent = () => {
        wikiSettings.assertRevision(wiki.profileRevision); readiness.assertCurrent(); web.assertCurrent();
        const current = harness.currentSelection();
        if (closed || modelConfigurationVersion !== modelVersion || current?.provider !== model.provider
          || current?.model !== model.model || (current?.reasoningEffort || null) !== (model.reasoningEffort || null)) {
          throw remoteError("MODEL_SETTINGS_CHANGED");
        }
      };
      assertCurrent();
      return { public: { libraryId: wiki.libraryId, model, historyPersistence: independentHistoryStore.persistence },
        wikiRevision: wiki.profileRevision, assertCurrent, ownWeb: web.ownWeb,
        openWiki: signal => wikiSettings.createResearchSession({ profileRevision: wiki.profileRevision, signal,
          limits: { apiRequests: 80, downloads: 8, totalTimeoutMs: params.inputMode === "segmented" ? 1800000 : 300000 } }) };
    },
    execute: input => withModelLease(async () => {
      if (busy) throw remoteError("CLIENT_BUSY");
      busy = true;
      let claim;
      try {
        independentHistory.reconcile();
        claim = independentHistoryStore.begin(input.binding.wikiRevision, input.plan);
        const result = await runIndependentResearch({ ...input, harness, disclosures });
        if (input.signal?.aborted) throw remoteError("CANCELLED");
        input.binding.assertCurrent(); claim.finish(result);
        return { ...result, history: { id: claim.id, createdAt: claim.createdAt, state: "saved",
          persistence: independentHistoryStore.persistence } };
      } catch (error) { claim?.abandon(); throw error; }
      finally { busy = false; }
    }),
  });
  const nativeConversationAvailable = hasModelHost && typeof harness.llm?.prepareCall === "function" &&
    typeof appRoot === "string" && path.isAbsolute(appRoot);
  const runPublishedResearch = async (params,options) => {
    if(params?.modelUseAllowed!==true)throw remoteError("MODEL_CONSENT_REQUIRED");
    if(!hasModelHost)throw remoteError("METHOD_NOT_ALLOWED");
    if(!params||typeof params!=="object"||Array.isArray(params)||
      Object.keys(params).some(key=>!["card","topic","force","modelUseAllowed","webSearchAllowed"].includes(key))||
      typeof params.topic!=="string"||params.topic.trim().length<2||params.topic.length>200||
      typeof params.webSearchAllowed!=="boolean"||params.force!==undefined&&typeof params.force!=="boolean")
      throw remoteError("INVALID_REQUEST");
    const web=webSession(params.webSearchAllowed,options.webServiceRevision,options.signal);
    if(params.webSearchAllowed&&options.researchSourceRevision!==sources.revision())throw remoteError("SOURCE_CHANGED");
    const supplement=params.webSearchAllowed?createPersonalPublishedResearch({provider,
      webSearchAllowed:true,ownWeb:web.ownWeb,assertSource(){
        web.assertCurrent();if(options.researchSourceRevision!==sources.revision())throw remoteError("SOURCE_CHANGED");
      }}):undefined;
    let work;
    try {
      const result=await published.withResearchTurn({card:params.card,modelUseAllowed:true},turn=>{
        work=createPersonalTurnResearch(turn,harness,supplement)({topic:params.topic,signal:turn.signal});return work;
      },options);
      web.assertCurrent(options.signal);
      return {ok:true,sourceRevision:options.sourceRevision,projectionStatus:"UNCHANGED",
        result:{...result,card:params.card,cached:false}};
    }finally{await work?.catch(()=>{});}
  };
  const runJudgment = hasModelHost ? createPersonalJudgment({ ...harness, disclosures }) : undefined;
  const personal = createPersonalHost({ env, appRoot, sources, provider, wikiSettings, nativeConversationAvailable,
    ...(hasModelHost ? { runResearch, runImaResearch, runJudgment,
      analyzePublishedEvidence: createPersonalCardAnalyzer(harness) } : {}) });
  const validateScope = scope => {
      if (!nativeConversationAvailable) throw remoteError("METHOD_NOT_ALLOWED");
      if (!["published", "api", "ima"].includes(scope.cardSource) ||
        scope.cardSource !== "ima" && scope.imaEvidenceId !== null ||
        scope.cardSource === "published" && (!/^[a-f0-9]{64}$/.test(scope.publicationKey??"")||scope.wikiSourceRevision!==null))
        throw remoteError("INVALID_REQUEST");
      if (scope.sourceRevision !== (scope.cardSource === "published" ? sources.revision() : personal.sourceRevision(scope.cardSource))) throw remoteError("SOURCE_CHANGED");
      if (scope.cardSource === "ima") wikiSettings.assertRevision(scope.wikiSourceRevision);
      if (scope.researchPlan.scope === "published" && scope.researchPlan.sourceRevision !== sources.revision()) {
        throw remoteError("SOURCE_CHANGED");
      }
      if (scope.researchPlan.webSearchAllowed) {
        webSession(true, scope.researchPlan.webServiceRevision).assertCurrent();
      }
    };
  const history = nativeConversationAvailable && path.isAbsolute(env.VARIABLE_OS_PERSONAL_DESK_ROOT ?? "")
    ? createPersonalConversationStore({ root: path.join(env.VARIABLE_OS_PERSONAL_DESK_ROOT, "conversations") }) : null;
  const originalHistory = value => value?.published?.schema === "published-original-conversation-v1";
  const conversations = createPersonalConversations({
    validate: validateScope,
    ...(history ? { history } : {}),
    async createSession(scope, { personalDraftApproval = false, checkpoint } = {}) {
      const original = scope.cardSource === "published";
      const originalIdentity = { schema: "published-original-conversation-v1", card: scope.card,
        sourceRevision: scope.sourceRevision, publicationKey: scope.publicationKey };
      if (original && checkpoint && (!originalHistory(checkpoint)
        || canonicalHash({ ...checkpoint.published, supplement: null }) !== canonicalHash({ ...originalIdentity, supplement: null })))
        throw remoteError("RESEARCH_CHECKPOINT_INVALID");
      const supplement = original ? checkpoint?.published.supplement : checkpoint?.published;
      const web = webSession(scope.researchPlan.webSearchAllowed, scope.researchPlan.webServiceRevision);
      const { createPersonalAgentSession } = await import(pathToFileURL(path.join(appRoot,
        "packages/dsh-desk-ui/lib/personal-agent-session.js")).href);
      if (checkpoint && scope.researchPlan.scope !== "published" && supplement !== null) {
        throw remoteError("RESEARCH_CHECKPOINT_INVALID");
      }
      const publishedResearch = scope.researchPlan.scope === "published" ? createPersonalPublishedResearch({
          provider, webSearchAllowed: scope.researchPlan.webSearchAllowed,
          ownWeb: web.ownWeb,
          checkpointScope: canonicalHash({ scope, personalDraftApproval }),
          ...(checkpoint ? { checkpoint: supplement } : {}),
          assertSource() {
            web.assertCurrent();
            if (closed || scope.researchPlan.sourceRevision !== sources.revision()) throw remoteError("SOURCE_CHANGED");
          },
        }) : undefined;
      const session = createPersonalAgentSession({ ...harness, card: scope.card, publishedResearch,
        ...(original ? {} : {outputGuard:runJudgment}),
        ...(checkpoint ? { checkpoint: checkpoint.session } : {}),
        ...(personalDraftApproval ? { runJudgment } : {}),
        desk: { withResearchTurn: (params, operation, options) => original
          ? published.withResearchTurn(params,async turn=>{
            if((await turn.proveSource()).scopeKey!==scope.publicationKey)throw remoteError("SOURCE_CHANGED");
            return operation(turn);
          },{...scope,...options})
          : personal.withResearchTurn(params, operation, {
            ...scope, ...options, imaEvidenceId: scope.imaEvidenceId ?? undefined,
          }) } });
      return Object.freeze({ ...session, checkpoint: () => ({
        session: session.checkpoint(), published: original
          ? { ...originalIdentity, supplement: publishedResearch?.checkpoint() ?? null }
          : publishedResearch?.checkpoint() ?? null,
      }) });
    },
  });
  let stopHistoryWatch, historySweep = Promise.resolve(), historyAgain = false, historySweeping = false, historyFault = null;
  const sweepOriginalHistory = () => {
    if (closed) return;
    historyAgain = true;
    if (historySweeping) return;
    historySweeping = true;
    historySweep = (async () => {
      while (historyAgain && !closed) {
        historyAgain = false;
        const retired = await history.reconcileCheckpoints(async checkpoint => {
          if (!originalHistory(checkpoint)) return true;
          const saved = checkpoint.published;
          try {
            return await published.withResearchTurn({ card: saved.card, modelUseAllowed: true },
              async turn => (await turn.proveSource()).scopeKey === saved.publicationKey,
              { sourceRevision: saved.sourceRevision, signal: generation.signal });
          } catch (error) {
            if (["SOURCE_CHANGED", "NO_RESULT", "AUTH_REQUIRED", "FORBIDDEN_SCOPE", "PUBLISHED_CARD_REQUIRED"].includes(error?.code)) return false;
            // An outage is not revocation. The interactive path still requires
            // live proof before reading any saved content or calling a model.
            if (["CANCELLED", "CLIENT_BUSY", "SOURCE_UNAVAILABLE", "EDGE_TIMEOUT", "TLS_REJECTED", "SPKI_MISMATCH"].includes(error?.code)) return true;
            throw error;
          }
        });
        await conversations.retireIds(retired);
      }
      historyFault = null;
    })().catch(error => { historyFault = error; }).finally(() => { historySweeping = false; });
  };
  const watchOriginalHistory = () => {
    if (history && !stopHistoryWatch) stopHistoryWatch = publishedSync.watch(state => {
      if (state.status !== "CONNECTING") sweepOriginalHistory();
    });
  };
  try { if (history?.hasCheckpoint(originalHistory)) watchOriginalHistory(); }
  catch (error) { historyFault = error; }
  let duplex;
  const narration = createPersonalNarration({ device: localNarration,
    blocked: () => duplex?.isActive(),
    validate(scope) {
      if (closed || scope.sourceRevision !== personal.sourceRevision(scope.cardSource)) throw remoteError("SOURCE_CHANGED");
    },
    async prove(scope, options) {
      const result = await personal.call("casefile", { card: scope.card }, { ...scope, ...options,
        imaEvidenceId: scope.imaEvidenceId ?? undefined });
      if (!result.ok) throw remoteError(result.error?.code || "SOURCE_UNAVAILABLE");
    },
  });
  duplex = createPersonalDuplex({ voiceSettings, credentials: voiceCredentials, createProvider: createVoiceProvider,
    currentSelection: harness.currentSelection,
    admit(sessionId, scope) {
      if (configuringModel) throw remoteError("CLIENT_BUSY");
      validateScope(scope);
      if (conversations.has(sessionId)) throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
    },
    validate: validateScope,
    prove: async (scope, options) => {
      await narration.retire();
      return personal.withResearchTurn({ card: scope.card, modelUseAllowed: true },
        async turn => (await turn.proveSource()).scopeKey, {
        ...scope, ...options, imaEvidenceId: scope.imaEvidenceId ?? undefined,
        });
    },
    runResearch: (sessionId, question, scope, options) => withModelLease(() => conversations.call("run",
      { sessionId, question, card: scope.card, modelUseAllowed: true, researchPlan: scope.researchPlan }, { ...scope, ...options })),
    retireResearch: (sessionId, scope) => conversations.call("cancel",
      { sessionId, card: scope.card, researchPlan: scope.researchPlan }, scope),
  });
  const listeners = new Set();
  const assertOpen = signal => {
    if (closed || signal?.aborted) throw remoteError("CANCELLED");
  };
  return {
    provider, duplex,
    async retireOutputs() {
      const results = await Promise.allSettled([duplex.retire(), narration.retire()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
    async personalCall(method, params, options = {}) {
      assertOpen(options.signal);
      const original = options.cardSource === "published";
      if (original && !["bootstrap","deepResearch"].includes(method)) return published.call(method, params, {
        ...options, signal: options.signal ? AbortSignal.any([generation.signal, options.signal]) : generation.signal,
      });
      if (method === "deepResearch" && params?.modelUseAllowed === true && params.webSearchAllowed === true) {
        webSession(true, options.webServiceRevision, options.signal).assertCurrent();
      }
      const modelVersion = modelConfigurationVersion;
      // Inspect configuration before reading evidence, keeping the native
      // ledger's final live proof last. This never probes or resolves a model.
      const readiness = method === "bootstrap" ? await modelReadiness(options.signal) : null;
      if (["sourceSync", "generateCards", "command", "autoJudgment"].includes(method)) {
        await duplex.retire(); await narration.retire();
      }
      await conversations.revalidate();
      assertOpen(options.signal);
      if (method === "deepResearch" && (!hasModelHost ||
        (options.cardSource ?? "api") === "api" && !provider.settings().ready)) {
        throw remoteError("METHOD_NOT_ALLOWED");
      }
      if (!original && method === "deepResearch" && Object.hasOwn(options, "wikiSourceRevision")) {
        wikiSettings.assertRevision(options.wikiSourceRevision);
      }
      const operation = () => {
        const scoped={...options,signal:options.signal ? AbortSignal.any([generation.signal,options.signal]) : generation.signal};
        return original ? method==="deepResearch" ? runPublishedResearch(params,scoped) : published.call(method,params,scoped)
          : personal.call(method,params,scoped);
      };
      const response = await (["deepResearch", "generateCards", "autoJudgment"].includes(method)
        ? withModelLease(operation) : operation());
      if (method === "bootstrap" && response.ok) {
        let model = configuringModel ? modelUnavailable("CLIENT_BUSY") : modelVersion !== modelConfigurationVersion
          ? modelUnavailable("MODEL_SETTINGS_CHANGED") : readiness.value;
        try { readiness.assertCurrent(); } catch (error) {
          assertOpen(options.signal);
          model = modelUnavailable(error?.code === "MODEL_SETTINGS_CHANGED" ? error.code : "MODEL_SETTINGS_UNAVAILABLE");
        }
        const capabilities = { ...response.result.capabilities };
        if(original&&response.result.source?.ready===true){
          capabilities.deepResearch=hasModelHost;
          capabilities.researchConversation=nativeConversationAvailable;
          capabilities.conversationPublishedResearch=nativeConversationAvailable;
          capabilities.apiSupplement=hasModelHost;
        }
        const selectedWeb = webService.snapshot();
        const webStatus = selectedWeb.mode === "edge" ? webSettings.snapshot() : {
          provider: "tavily", status: selectedWeb.mode === "own" && selectedWeb.configured ? "READY" : "NOT_CONFIGURED",
          reason: selectedWeb.mode === "own" && selectedWeb.configured ? "CLIENT_CONFIGURED" : "CLIENT_NOT_CONFIGURED",
          connection: "NOT_CHECKED", ready: selectedWeb.mode === "own" && selectedWeb.configured,
          sourceRevision: selectedWeb.revision,
        };
        capabilities.webResearch = selectedWeb.mode === "own"
          ? selectedWeb.configured && capabilities.deepResearch === true
          : selectedWeb.mode === "edge" && capabilities.apiSupplement === true && webStatus.ready &&
            webStatus.sourceRevision === (original ? sources.revision() : response.result.researchSourceRevision);
        capabilities.webRequiresApiSupplement = selectedWeb.mode === "edge";
        for (const name of ["cardGeneration", "autoJudgment", "deepResearch", "webResearch",
          "apiSupplement", "researchConversation", "conversationPublishedResearch"]) {
          capabilities[name] = model.ready && capabilities[name] === true;
        }
        return { ...response, result: { ...response.result,
        webServiceRevision: selectedWeb.revision, webServiceMode: selectedWeb.mode,
        diagnostics: { ...response.result.diagnostics, modelService: model, webService: webStatus, localNarration: narration.availability() },
        capabilities: { ...capabilities,
          conversationDrafts: Boolean(!original && runJudgment && capabilities.researchConversation),
          narration: !original && narration.availability().available, realtimeVoice: Boolean(
          !original && capabilities.researchConversation && typeof createVoiceProvider === "function") },
        ...(original?{researchSourceRevision:sources.revision()}:{}), } };
      }
      return response;
    },
    sourceRevision: kind => kind === "published" ? sources.revision() : personal.sourceRevision(kind),
    webServiceRevision: () => webService.snapshot().revision,
    async personalAgent(action, params, options = {}) {
      assertOpen(options.signal);
      if(options.cardSource==="published"){
        if(action==="approve")throw remoteError("METHOD_NOT_ALLOWED");
        const scoped={...options,personalDraftApproval:false,
          signal:options.signal?AbortSignal.any([generation.signal,options.signal]):generation.signal};
        if(action==="cancel")return conversations.call(action,params,scoped);
        if(action!=="list"&&params?.modelUseAllowed!==true)throw remoteError("MODEL_CONSENT_REQUIRED");
        if(historyFault)throw remoteError("RESEARCH_CHECKPOINT_UNAVAILABLE");
        watchOriginalHistory();
        const buffered=[];
        let completed=false;
        const operation=()=>published.withResearchTurn({card:params?.card,modelUseAllowed:true},async turn=>{
          const {scopeKey}=await turn.proveSource();
          const result=await conversations.call(action,params,{...scoped,signal:turn.signal,
            publicationKey:scopeKey,onEvent:value=>buffered.push(value)});
          completed=true;
          return result;
        },scoped);
        try{
          const result=await (action==="list"?operation():withModelLease(operation));
          assertOpen(scoped.signal);
          for(const value of buffered){
            assertOpen(scoped.signal);
            if(scoped.sourceRevision!==sources.revision())throw remoteError("SOURCE_CHANGED");
            try{options.onEvent?.(value);}catch{/* Observers cannot alter a committed turn. */}
          }
          return result;
        }catch(error){
          // The registry owns failures during a turn. A failure of our final
          // source proof retires only this completed session, never another
          // active request that merely shares the published source.
          if(completed&&action!=="list")await conversations.call("cancel",{
            sessionId:params.sessionId,card:params.card,researchPlan:params.researchPlan,
          },{...scoped,signal:undefined});
          throw error;
        }
      }
      if (duplex.ownsSession(params?.sessionId)) throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
      if (action === "run") await narration.retire();
      // The registry validates this scope and registers its abort controller
      // before asynchronous admission. Unrelated retirement must not queue it.
      const operation = () => conversations.call(action, params, { ...options,
        personalDraftApproval: true,
        signal: options.signal ? AbortSignal.any([generation.signal, options.signal]) : generation.signal });
      return action === "list" ? operation() : withModelLease(operation);
    },
    subscribeSources(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    watchPublications: listener => publishedSync.watch(listener),
    refreshPublishedSource: () => publishedSync.refreshSource(),
    async close() {
      independentResearch.close();
      clearInterval(independentHistoryTimer);
      webSettings.reset();
      closed = true; generation.abort(); listeners.clear(); wikiSettings.close(); personal.close();
      stopHistoryWatch?.(); await historySweep;
      await Promise.all([publishedSync.close(), closeRemoteServices({ duplex, voiceSettings, conversations, narration })]);
    },
    async call(method, params = {}, options = {}) {
      assertOpen(options.signal);
      if (INDEPENDENT_RESEARCH_METHODS.has(method)) {
        const signal = options.signal ? AbortSignal.any([generation.signal, options.signal]) : generation.signal;
        if (method === "independentResearchHistoryList") return independentHistory.list(params);
        if (method === "independentResearchHistoryDelete") return independentHistory.remove(params);
        if (method === "independentResearchHistoryRead") {
          if (busy) throw remoteError("CLIENT_BUSY");
          busy = true;
          try { return await independentHistory.read(params, { signal }); }
          finally { busy = false; }
        }
        return method === "independentResearchPrepare" ? independentResearch.prepare(params, { signal })
          : independentResearch.run(params, { signal });
      }
      if (method === "webServiceStatus") {
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
          throw remoteError("INVALID_REQUEST");
        }
        if (configuringWeb) throw remoteError("CLIENT_BUSY");
        return webService.snapshot();
      }
      if (["webServiceConfigure", "webServiceRemove"].includes(method)) {
        if (configuringWeb) throw remoteError("CLIENT_BUSY");
        webService.capture(params?.revision);
        configuringWeb = true;
        try {
          generation.abort(); generation = new AbortController();
          await duplex.retire(); await narration.retire(); await conversations.reset();
          assertOpen(options.signal);
          return method === "webServiceConfigure" ? webService.configure(params) : webService.remove(params);
        } finally {
          webSettings.reset();
          configuringWeb = false;
          for (const listener of listeners) listener();
        }
      }
      if (method === "personalNarrationStatus") {
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
          throw remoteError("INVALID_REQUEST");
        }
        return narration.availability();
      }
      if (method === "personalNarration") return narration.call(params, options);
      if (method === "publicOnboardingStatus") {
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
          throw remoteError("INVALID_REQUEST");
        }
        return publicOnboarding.status();
      }
      if (method === "publicOnboardingComplete") return publicOnboarding.complete(params);
      if (method === "personalVoiceStatus") {
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
          throw remoteError("INVALID_REQUEST");
        }
        return duplex.availability();
      }
      if (VOICE_SETTINGS_METHODS.has(method)) return voiceSettings.call(method, params, {
        ...options, beforeWrite: () => duplex.retire(),
      });
      if (MODEL_SETTINGS_METHODS.has(method)) {
        if (method === "modelServiceStatus") return modelSettings.call(method, params, options);
        if (configuringModel || activeModelOperations) throw remoteError("CLIENT_BUSY");
        configuringModel = true;
        let writeAttempted = false;
        try {
          await duplex.retire(); await narration.retire();
          return await modelSettings.call(method, params, { ...options,
            beforeWrite: () => { writeAttempted = true; modelConfigurationVersion++; },
            writeRefused: () => { writeAttempted = false; } });
        } finally {
          try { if (writeAttempted) await conversations.reset(); } finally { configuringModel = false; }
        }
      }
      await conversations.revalidate();
      assertOpen(options.signal);
      if (["sourceConnectionConfigure", "sourceConnectionRemove"].includes(method)) {
        await narration.retire();
        assertOpen(options.signal);
        const result = method === "sourceConnectionRemove" ? sources.remove(params) : sources.configure(params);
        webSettings.reset();
        generation.abort(); generation = new AbortController();
        personal.reset("api");
        for (const listener of listeners) listener();
        await duplex.retire();
        await conversations.reset();
        return result;
      }
      const signal = options.signal ? AbortSignal.any([generation.signal, options.signal]) : generation.signal;
      options = { ...options, signal };
      if (["webResearchStatus", "webResearchCheck"].includes(method)) {
        return webSettings.call(method, params, options);
      }
      if (method === "sourceConnectionMcpExport") {
        if (!params || typeof params !== "object" || Array.isArray(params)
          || Object.keys(params).some(key => key !== "revision")
          || typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)) {
          throw remoteError("INVALID_REQUEST");
        }
        const snapshot = sources.snapshot(), file = sourceSettingsPath(env);
        if (!file || !snapshot.ready || !snapshot.mcp.profileShared) throw remoteError("SOURCE_UNAVAILABLE");
        if (params.revision !== snapshot.revision) throw remoteError("SOURCE_CHANGED");
        let entry;
        try {
          if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) throw Error();
          entry = path.join(appRoot, "packages/edge-mcp-bridge/src/stdio.mjs");
          if (!lstatSync(entry).isFile()) throw Error();
        } catch { throw remoteError("SOURCE_UNAVAILABLE"); }
        return { mcpServers: { "variable-os": {
          command: process.execPath, args: [entry],
          env: { VARIABLE_OS_PROVIDER: "remote", VARIABLE_OS_SOURCE_SETTINGS_FILE: file },
        } } };
      }
      if (["sourceConnectionStatus", "sourceConnectionCheck"].includes(method)) {
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) throw remoteError("INVALID_REQUEST");
        return method === "sourceConnectionStatus" ? sources.snapshot() : sources.check(provider, options);
      }
      if (method === "bootstrap") return { provider: "remote", settings: provider.settings(), wiki: wikiSettings.snapshot(), source: sources.snapshot(),
        desk: { surface: "original", rpcPath: "/variable-os-desk/personal-rpc", defaultCardSource: "published" } };
      if (["wikiSourceStatus", "wikiSourceConfigure", "wikiSourceCredentials", "wikiSourceCheck", "wikiSourceBrowse"].includes(method)) {
        const before = personal.sourceRevision("ima");
        try { return await wikiSettings.call(method, params, options); }
        finally {
          if (before !== personal.sourceRevision("ima")) {
            reconcileIndependentHistory();
            personal.reset("ima");
            for (const listener of listeners) listener();
            await duplex.retire();
            await narration.retire();
            await conversations.reset("ima");
          }
        }
      }
      if (method === "deepResearch") {
        if (!params || Object.keys(params).some(key => !["topic", "modelUseAllowed", "webSearchAllowed"].includes(key))) throw remoteError("INVALID_REQUEST");
        return withModelLease(() => runResearch(params, options));
      }
      return provider.call(method, params, options);
    },
  };
}

function sameOrigin(req) {
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function send(res, body, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readRequest(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > 16384) throw remoteError("INVALID_REQUEST");
  }
  try { return JSON.parse(body); } catch { throw remoteError("INVALID_REQUEST"); }
}

export function applyRemoteHost(ctx, { createUserMessage, createBlockAssembler, wikiSettings,
  createVoiceProvider, voiceWorklet, localNarration,
  searchWeb, modelSettings, currentSelection,
  env = process.env, appRoot = env.VARIABLE_OS_APP_ROOT }) {
  const desk = createRemoteDesk({
    env, appRoot, searchWeb,
    modelSettings: modelSettings ?? createModelServiceSettings(),
    voiceSettings: createVoiceServiceSettings({ services: () => ({ credentials: ctx.get?.("credentials") }) }),
    voiceCredentials: () => ctx.get?.("credentials"), createVoiceProvider, localNarration,
    llm: ctx.llm, currentSelection: currentSelection
      ?? (modelSettings ? () => ctx.agentDefaultModel.currentSelection() : () => null),
    createUserMessage, createBlockAssembler, wikiSettings,
  });
  const csrf = randomBytes(32).toString("hex");
  if (publicOnboardingRoot(env) !== null && typeof ctx.on === "function") {
    ctx.effect(() => ctx.on("webserver/index-inject", rows => {
      rows.push({ kind: "global", name: "__VARIABLE_OS_PUBLIC_SETUP__", value: { version: 1 } });
    }), "variable-os-desk-ui: public onboarding");
  }
  const validCsrf = (req) => {
    const value = req.headers["x-variable-os-csrf"];
    return typeof value === "string" && value.length === csrf.length && timingSafeEqual(Buffer.from(value), Buffer.from(csrf));
  };
  const controllers = new Set();
  const allowed = new Set(["bootstrap", "capabilities", "datasets", "search", "inbox", "casefile", "evidence", "wikiIndex", "wiki", "changes", "timeline", "deepResearch", "wikiSourceStatus", "wikiSourceConfigure", "wikiSourceCredentials", "wikiSourceCheck", "wikiSourceBrowse", "sourceConnectionStatus", "sourceConnectionConfigure", "sourceConnectionRemove", "sourceConnectionCheck", "sourceConnectionMcpExport", "personalVoiceStatus", "publicOnboardingStatus", "publicOnboardingComplete", ...MODEL_SETTINGS_METHODS, ...VOICE_SETTINGS_METHODS]);
  allowed.add("personalNarrationStatus"); allowed.add("personalNarration");
  allowed.add("webResearchStatus"); allowed.add("webResearchCheck");
  allowed.add("webServiceStatus"); allowed.add("webServiceConfigure"); allowed.add("webServiceRemove");
  for (const method of INDEPENDENT_RESEARCH_METHODS) allowed.add(method);
  const handler = async (req, res) => {
    const abort = new AbortController();
    controllers.add(abort);
    res.once("close", () => { abort.abort(); controllers.delete(abort); });
    try {
      if (req.method !== "POST" || !sameOrigin(req)) throw remoteError("METHOD_NOT_ALLOWED");
      const body = await readRequest(req);
      if (!body || Object.keys(body).some((key) => !["method", "params"].includes(key)) || !allowed.has(body.method)) throw remoteError("METHOD_NOT_ALLOWED");
      if (body.method !== "bootstrap" && !validCsrf(req)) throw remoteError("CSRF_INVALID");
      const result = await desk.call(body.method, body.params ?? {}, { signal: abort.signal,
        ...(body.method === "deepResearch" ? { wikiSourceRevision: req.headers["x-variable-os-wiki-revision"],
          webServiceRevision: req.headers["x-variable-os-web-service-revision"] } : {}) });
      send(res, { ok: true, result: body.method === "bootstrap" ? { ...result, csrfToken: csrf } : result });
    } catch (error) { send(res, { ok: false, provider: "remote",
      error: INDEPENDENT_RESEARCH_CODES.has(error?.code) || MODEL_SETTINGS_CODES.has(error?.code) || VOICE_SETTINGS_CODES.has(error?.code) || WEB_SERVICE_CODES.has(error?.code) || PERSONAL_NARRATION_CODES.has(error?.code)
        ? { code: error.code } : safeError(error) }, 400); }
  };
  const personalHandler = async (req, res) => {
    const abort = new AbortController();
    controllers.add(abort);
    res.once("close", () => { abort.abort(); controllers.delete(abort); });
    try {
      if (req.method !== "POST" || !sameOrigin(req)) throw remoteError("METHOD_NOT_ALLOWED");
      const body = await readRequest(req);
      if (!body || Object.keys(body).some(key => !["method", "params"].includes(key))
        || !PERSONAL_METHODS.has(body.method)) throw remoteError("METHOD_NOT_ALLOWED");
      if (body.method !== "bootstrap" && !validCsrf(req)) throw remoteError("CSRF_INVALID");
      const response = await desk.personalCall(body.method, body.params ?? {}, {
        signal: abort.signal, sourceRevision: req.headers["x-variable-os-source-revision"],
        cardSource: req.headers["x-variable-os-card-source"] ?? "api",
        imaEvidenceId: req.headers["x-variable-os-ima-evidence-id"],
        ...(body.method === "deepResearch"
          ? { researchSourceRevision: req.headers["x-variable-os-research-source-revision"],
            webServiceRevision: req.headers["x-variable-os-web-service-revision"] } : {}),
        ...(["deepResearch", "autoJudgment"].includes(body.method) ? { wikiSourceRevision: req.headers["x-variable-os-wiki-revision"] } : {}),
      });
      send(res, response.ok && body.method === "bootstrap"
        ? { ...response, result: { ...response.result, csrfToken: csrf } }
        : body.method === "bootstrap" && response.syncControl
          ? { ...response, syncControl: { ...response.syncControl, csrfToken: csrf } } : response);
    } catch (error) {
      const code = ["PERSONAL_WORKSPACE_REQUIRED", "PERSONAL_WORKSPACE_INVALID", "SOURCE_CHANGED",
        "AUTO_JUDGMENT_IN_PROGRESS", "AUTO_JUDGMENT_OUTPUT_INVALID", "AUTO_JUDGMENT_CAPACITY",
        "RESEARCH_DISCLOSURE_UNAVAILABLE"].includes(error.code)
        ? error.code : safeError(error).code;
      send(res, { ok: false, error: { code, message: code } }, 400);
    }
  };
  const nativeHandler = (req, res) => {
    const invoke = action => (params, options) => desk.personalAgent(action, params, {
      ...options, sourceRevision: req.headers["x-variable-os-source-revision"],
      cardSource: req.headers["x-variable-os-card-source"] ?? "api",
      imaEvidenceId: req.headers["x-variable-os-ima-evidence-id"],
      wikiSourceRevision: req.headers["x-variable-os-wiki-revision"],
    });
    return createResearchHostAgentHandler({ csrfToken: csrf, maxBodyBytes: 16384,
      manager: Object.fromEntries(["run", "resume", "cancel", "approve", "list"].map(action => [action, invoke(action)])),
    })(req, res);
  };
  const sourceEvents = (req, res) => {
    if (req.method !== "GET" || !sameOrigin(req) || !validCsrf(req)) {
      return send(res, { ok: false, error: { code: "CSRF_INVALID" } }, 403);
    }
    if (new URL(req.url, "http://fixture.invalid").search) {
      return send(res, { ok: false, error: { code: "INVALID_REQUEST" } }, 400);
    }
    const cardSource = req.headers["x-variable-os-card-source"] ?? "api";
    if (!["published", "api", "ima"].includes(cardSource)) return send(res, {
      ok: false, error: { code: "INVALID_REQUEST" },
    }, 400);
    const abort = new AbortController();
    controllers.add(abort);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store",
      "x-accel-buffering": "no" });
    let previous, publication = { status: "CONNECTING", projectionDigest: null };
    const notify = () => {
      try {
        if (cardSource === "published") desk.refreshPublishedSource();
        const revision = desk.sourceRevision(cardSource), webServiceRevision = desk.webServiceRevision();
        const next = JSON.stringify({ revision, webServiceRevision,
          ...(cardSource === "published" ? { publication } : {}) });
        if (next === previous) return;
        previous = next;
        if (!res.write(next + "\n")) abort.abort();
      } catch { abort.abort(); }
    };
    const unsubscribe = desk.subscribeSources(notify);
    const stopPublications = cardSource === "published" ? desk.watchPublications(value => {
      publication = value; notify();
    }) : () => {};
    // Also notice an atomic profile replacement by another Host process.
    const timer = setInterval(notify, 1000);
    timer.unref();
    abort.signal.addEventListener("abort", () => {
      clearInterval(timer); unsubscribe(); stopPublications(); controllers.delete(abort); res.end();
    }, { once: true });
    res.once("close", () => abort.abort());
    notify();
  };
  const events = async (req, res) => {
    if (req.method !== "GET" || !sameOrigin(req) || !validCsrf(req)) return send(res, { ok: false, error: { code: "CSRF_INVALID" } }, 403);
    const url = new URL(req.url, "http://fixture.invalid");
    if ([...url.searchParams.keys()].some((key) => key !== "datasetId")) return send(res, { ok: false, error: { code: "INVALID_REQUEST" } }, 400);
    const abort = new AbortController();
    controllers.add(abort);
    const unsubscribe = desk.subscribeSources(() => { abort.abort(); res.end(); });
    res.once("close", () => { unsubscribe(); abort.abort(); controllers.delete(abort); });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
    const write = (event, data, id) => {
      if (res.destroyed) throw remoteError("CANCELLED");
      if (!res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        abort.abort(); res.end(); throw remoteError("CLIENT_BUSY");
      }
    };
    const stream = subscribeCards(desk.provider, {
      datasetId: url.searchParams.get("datasetId") || undefined,
      lastEventId: req.headers["last-event-id"] || null, signal: abort.signal,
      onEvent: ({ event, data, id }) => write(event, data, id),
      onState: (state) => write("connection", state),
    });
    try { await stream.done; } finally { res.end(); }
  };
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/variable-os-desk/rpc", handler }), "variable-os-desk-ui: remote read RPC");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/variable-os-desk/remote-events", handler: events }), "variable-os-desk-ui: remote card stream");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/variable-os-desk/personal-rpc", handler: personalHandler }), "variable-os-desk-ui: personal native reads");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/variable-os-desk/source-events", handler: sourceEvents }), "variable-os-desk-ui: source selection notifications");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/variable-os-desk/research-host-agent", handler: nativeHandler }), "variable-os-desk-ui: personal native conversation");
  if (typeof createVoiceProvider === "function") ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/variable-os-desk/personal-duplex",
    handler: createDuplexHttpHandler({ service: desk.duplex, csrfToken: csrf }) }), "variable-os-desk-ui: personal voice");
  if (typeof createVoiceProvider === "function" && Buffer.isBuffer(voiceWorklet)) {
    const worklet = Buffer.from(voiceWorklet);
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/variable-os-desk/personal-voice-worklet",
      handler(req, res) {
        if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(worklet);
      } }), "variable-os-desk-ui: personal voice worklet");
  }
  if (typeof ctx.on === "function") ctx.effect(() => {
    const stop = () => { void desk.retireOutputs().catch(() => {}); };
    const dispose = ["credentials/reference-updated", "credentials/record-updated",
      "settings/updated", "settings/document-updated"].map(event => ctx.on(event, stop));
    return () => { for (const remove of dispose) remove(); };
  }, "variable-os-desk-ui: voice native configuration retirement");
  ctx.effect(() => () => {
    for (const controller of controllers) controller.abort();
    return desk.close();
  }, "variable-os-desk-ui: remote cancellation");
}
