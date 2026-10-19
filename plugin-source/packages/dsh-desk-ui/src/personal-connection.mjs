// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { personalResearchPlan } from "../lib/personal-research-plan.js";
const failure = code => ({ ok: false, error: { code, message: code } });
const agentError = code => Object.assign(Error(code), { code });
const reads = new Set(["bootstrap", "health", "sourceHealth", "imaAccess", "inbox", "casefile", "evidence",
  "feedback", "report", "catalystWatchList", "catalystWatchDetail", "catalystAuditOverview", "catalystSourceList"]);
const commands = new Set(["recordDeliveryInteraction", "submitHumanLabel", "submitMappingReview", "revealOutcome"]);
export function createPersonalConnection({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let personal = false, csrf = "", revision = null, capabilities = null, generation = 0;
  let syncControl = null;
  let settingsGeneration = 0;
  let readingGeneration = 0;
  let viewInvalidated = false;
  let readFailureCode = null;
  // Retained only to discard stale configuration drafts across an outage.
  let settingsSourceRevision = null;
  let controller = null;
  let bootstrapRequest = null;
  let watchController = null, watchers = 0, disconnected = false;
  let publishedProjectionDigest = null;
  let publicationSyncStatus = null;
  let cardSource = "api", watchToken = "", imaEvidenceId = null;
  let explicitCardSource = false;
  let researchSourceRevision = null;
  let webServiceRevision = null, webServiceMode = null;
  let playback = null, narrationTail = Promise.resolve();
  const listeners = new Set();
  const agentScopes = new Map();
  const agentApprovals = new Map();
  const invalidate = ({ keepSelection = false, preserveSettings = false, preserveReading = false, deniedImaRead = false, refresh = false } = {}) => {
    const changed = refresh || !preserveSettings || !viewInvalidated || imaEvidenceId !== null;
    controller?.abort(); controller = null;
    agentApprovals.clear();
    if (!keepSelection) imaEvidenceId = null;
    if (changed) { generation++; if (!preserveReading) readingGeneration++; }
    if (!preserveSettings) { settingsGeneration++; settingsSourceRevision = null; }
    viewInvalidated = true;
    readFailureCode = deniedImaRead ? "FORBIDDEN_SCOPE" : null;
    revision = null; capabilities = null; bootstrapRequest = null;
    publishedProjectionDigest = null;
    syncControl = null;
    researchSourceRevision = null;
    webServiceRevision = null; webServiceMode = null;
    void narrationCall({ action: "stop" });
    if (changed) for (const listener of listeners) listener(generation);
  };
  const connection = {
    select(value) {
      personal = value?.provider === "remote";
      if (personal && !explicitCardSource && value.desk?.defaultCardSource === "published"
        && cardSource !== "published") {
        connection.selectCardSource("published");
        explicitCardSource = false;
      }
    },
    cardSource: () => cardSource,
    publicationSyncStatus: () => cardSource === "published" ? publicationSyncStatus : null,
    imaEvidenceId: () => imaEvidenceId,
    scopeKey: () => `${generation}:${cardSource}:${imaEvidenceId ?? ""}`,
    settingsScopeKey: () => settingsGeneration,
    // An in-memory navigation scope only; never a proof that old data is readable.
    readingScopeKey: () => `${readingGeneration}:${cardSource}`,
    readFailure: () => personal && readFailureCode
      ? Object.freeze({ code: readFailureCode, message: readFailureCode }) : null,
    selectImaEvidence(value) {
      if (cardSource !== "ima" || value !== null && (typeof value !== "string" ||
        value.length > 4096 || !/^wiki:ima:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value))) {
        throw Object.assign(Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
      }
      if (value === imaEvidenceId) return;
      imaEvidenceId = value;
      invalidate({ keepSelection: true });
    },
    selectCardSource(value) {
      if (!["published", "api", "ima"].includes(value)) throw Object.assign(Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" });
      explicitCardSource = true;
      if (value === cardSource) return;
      cardSource = value;
      publicationSyncStatus = null;
      watchController?.abort(); watchController = null;
      disconnected = false;
      invalidate();
      if (watchers) startMonitor();
    },
    isPersonal: () => personal,
    hasAgentSession: id => agentScopes.has(id),
    allows: name => !personal || capabilities?.[name] === true ||
      name === "sourceIntake" && syncControl?.sourceIntake === true,
    voiceContext(params) {
      if (!personal || disconnected || !revision) throw agentError("SOURCE_CHANGED");
      if (capabilities?.realtimeVoice !== true) throw agentError("METHOD_NOT_ALLOWED");
      const keys = ["card", "voiceRevision", "wikiSourceRevision", "researchPlan",
        "modelUseAllowed", "audioUseAllowed", "summaryUseAllowed"];
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some(key => !keys.includes(key))
        || ["modelUseAllowed", "audioUseAllowed", "summaryUseAllowed"].some(key => params[key] !== true)
        || typeof params.card !== "string" || !params.card || params.card.length > 200
        || !/^[a-f0-9]{64}$/.test(params.voiceRevision ?? "")
        || cardSource === "ima" && (!imaEvidenceId || !/^[a-f0-9]{64}$/.test(params.wikiSourceRevision ?? ""))) {
        throw agentError("DUPLEX_CONTEXT_INVALID");
      }
      const plan = personalResearchPlan(params.researchPlan?.scope === "published"
        ? { ...params.researchPlan, sourceRevision: researchSourceRevision,
          ...(params.researchPlan.webSearchAllowed ? { webServiceRevision } : {}) } : params.researchPlan);
      if (plan.scope === "published" && capabilities?.conversationPublishedResearch !== true) {
        throw agentError("METHOD_NOT_ALLOWED");
      }
      return Object.freeze({ card: params.card, cardSource, sourceRevision: revision, imaEvidenceId,
        wikiSourceRevision: cardSource === "ima" ? params.wikiSourceRevision : null,
        voiceRevision: params.voiceRevision, researchPlan: plan,
        modelUseAllowed: true, audioUseAllowed: true, summaryUseAllowed: true });
    },
    async voiceFetch(action, payload, { signal } = {}) {
      if (!["start", "audio", "mute", "stop-speaking", "cancel-research", "hangup"].includes(action)) {
        throw agentError("METHOD_NOT_ALLOWED");
      }
      if (!personal || !csrf || action !== "hangup" && (disconnected || !revision)) throw agentError("SOURCE_CHANGED");
      if (action !== "hangup" && capabilities?.realtimeVoice !== true) throw agentError("METHOD_NOT_ALLOWED");
      if (action === "start" && (payload?.context?.sourceRevision !== revision
        || payload.context.cardSource !== cardSource || payload.context.imaEvidenceId !== imaEvidenceId)) {
        throw agentError("SOURCE_CHANGED");
      }
      const current = generation;
      controller ??= new AbortController();
      const combined = action === "hangup" ? signal
        : signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const response = await fetchImpl("/variable-os-desk/personal-duplex", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: combined,
        headers: { "content-type": "application/json", "x-variable-os-csrf": csrf },
        body: JSON.stringify({ ...payload, action }),
      });
      if (action !== "hangup" && current !== generation) {
        await response.body?.cancel();
        throw agentError("SOURCE_CHANGED");
      }
      return response;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    invalidate,
    watch(token) {
      watchToken = token;
      if (++watchers === 1) {
        startMonitor();
      }
      return () => { if (--watchers === 0) { watchController?.abort(); watchController = null; } };
    },
    observeAgentApproval(sessionId, event) {
      const scope = agentScopes.get(sessionId);
      if (!personal || disconnected || !revision || scope?.generation !== generation ||
        capabilities?.conversationDrafts !== true || !event || Array.isArray(event) ||
        Object.keys(event).sort().join(",") !== "approvalId,reason,status,toolId,type" ||
        event.type !== "approval" || event.toolId !== "draftJudgment" ||
        !/^personal-approval-[a-f0-9-]{36}$/.test(event.approvalId ?? "") ||
        typeof event.reason !== "string" || event.reason.length > 300 ||
        !["awaiting-confirmation", "allowed-once", "rejected", "cancelled"].includes(event.status)) return false;
      const pending = agentApprovals.get(sessionId);
      if (event.status === "awaiting-confirmation") {
        if (pending || scope.approvalIds.has(event.approvalId)) return false;
        scope.approvalIds.add(event.approvalId);
        agentApprovals.set(sessionId, { scope, approvalId: event.approvalId, deciding: false });
      } else {
        if (pending?.approvalId !== event.approvalId) return false;
        agentApprovals.delete(sessionId);
      }
      return true;
    },
    async agentFetch(params, { signal, wikiSourceRevision } = {}) {
      if (!["run", "resume", "cancel", "approve", "list"].includes(params?.action)) throw agentError("METHOD_NOT_ALLOWED");
      const listing = params.action === "list";
      if (listing && (Object.keys(params).some(key => !["action", "card", "researchPlan", "cursor"].includes(key)) ||
        params.cursor != null && !/^[a-f0-9]{64}$/.test(params.cursor))) throw agentError("INVALID_REQUEST");
      const cancel = params.action === "cancel", approve = params.action === "approve";
      const control = cancel || approve;
      if (!control && !listing && params.modelUseAllowed !== true) throw agentError("MODEL_CONSENT_REQUIRED");
      if (!personal || !cancel && (disconnected || !revision)) throw agentError("SOURCE_CHANGED");
      if (!cancel && capabilities?.researchConversation !== true) throw agentError("METHOD_NOT_ALLOWED");
      if (approve && capabilities?.conversationDrafts !== true) throw agentError("METHOD_NOT_ALLOWED");
      if (!listing && (typeof params.sessionId !== "string" || !/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(params.sessionId))) {
        throw agentError("INVALID_REQUEST");
      }
      let scope = agentScopes.get(params.sessionId);
      if (cancel && !scope) throw agentError("XIAOMEI_SESSION_NOT_FOUND");
      if (approve) {
        if (Object.keys(params).some(key => !["action", "sessionId", "approvalId", "outcome"].includes(key)) ||
          !["allowed-once", "rejected"].includes(params.outcome)) throw agentError("INVALID_REQUEST");
        const pending = agentApprovals.get(params.sessionId);
        if (!scope || scope.generation !== generation || !pending || pending.scope !== scope ||
          pending.deciding || pending.approvalId !== params.approvalId) throw agentError("XIAOMEI_APPROVAL_NOT_PENDING");
        // A lost response is uncertain, never permission to retry this token.
        pending.deciding = true;
      }
      const plan = control ? scope.researchPlan : personalResearchPlan(params.researchPlan?.scope === "published"
        ? { ...params.researchPlan, sourceRevision: researchSourceRevision,
          ...(params.researchPlan.webSearchAllowed ? { webServiceRevision } : {}) } : params.researchPlan);
      if (!control && plan.scope === "published" && capabilities?.conversationPublishedResearch !== true) {
        throw agentError("METHOD_NOT_ALLOWED");
      }
      if (!control && (typeof params.card !== "string" || !params.card || params.card.length > 200)) {
        throw agentError("INVALID_REQUEST");
      }
      if (!control && scope && (scope.generation !== generation || scope.card !== params.card ||
        JSON.stringify(scope.researchPlan) !== JSON.stringify(plan))) {
        throw agentError("XIAOMEI_SESSION_SCOPE_CHANGED");
      }
      if (!scope) {
        scope = Object.freeze({ generation, card: params.card, cardSource, revision, imaEvidenceId,
          wikiSourceRevision: cardSource === "ima" ? wikiSourceRevision : null, researchPlan: plan,
          approvalIds: new Set() });
        if (!listing) agentScopes.set(params.sessionId, scope);
      }
      if (!approve) agentApprovals.delete(params.sessionId);
      controller ??= new AbortController();
      const combined = cancel ? signal : signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const response = await fetchImpl("/variable-os-desk/research-host-agent", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: combined,
        headers: { "content-type": "application/json", "x-variable-os-csrf": csrf,
          "x-variable-os-card-source": scope.cardSource, "x-variable-os-source-revision": scope.revision,
          ...(scope.imaEvidenceId ? { "x-variable-os-ima-evidence-id": scope.imaEvidenceId } : {}),
          ...(scope.wikiSourceRevision ? { "x-variable-os-wiki-revision": scope.wikiSourceRevision } : {}) },
        body: JSON.stringify(listing ? { action: "list", card: scope.card, cursor: params.cursor ?? null,
          researchPlan: plan } : { action: params.action, sessionId: params.sessionId, card: scope.card,
          researchPlan: scope.researchPlan,
          ...(cancel ? { receiptId: params.receiptId, trigger: params.trigger, requestedAt: params.requestedAt }
            : approve ? { approvalId: params.approvalId, outcome: params.outcome }
              : { question: params.question, modelUseAllowed: true }) }),
      });
      if (!cancel && scope.generation !== generation) {
        await response.body?.cancel();
        throw agentError("SOURCE_CHANGED");
      }
      if (combined?.aborted) throw agentError("REQUEST_ABORTED");
      return response;
    },
    async call(method, params = {}, options = {}) {
      if (method === "narration") return narrationCall(params, options);
      if (disconnected) return failure("SOURCE_DISCONNECTED");
      if (method === "imaAccess" && (!personal || cardSource !== "ima" || !imaEvidenceId ||
        !revision || capabilities?.personalReads !== true)) return failure("SOURCE_CHANGED");
      if (!reads.has(method) && !["sourceSync", "deepResearch", "generateCards", "command", "autoJudgment"].includes(method)) return failure("METHOD_NOT_ALLOWED");
      if (method === "command" && !commands.has(params?.commandType)) return failure("METHOD_NOT_ALLOWED");
      if (["deepResearch", "generateCards", "autoJudgment"].includes(method) && params?.modelUseAllowed !== true) return failure("MODEL_CONSENT_REQUIRED");
      if (method === "deepResearch" && typeof params?.webSearchAllowed !== "boolean") return failure("INVALID_REQUEST");
      const requestedGeneration = generation;
      const usesApi = method === "deepResearch" && (["published", "api"].includes(cardSource) ||
        params.apiSupplementAllowed === true || params.webSearchAllowed === true && webServiceMode !== "own");
      // Consent uses the scope already displayed, never one acquired by an implicit refresh.
      const researchRevision = usesApi ? researchSourceRevision : null;
      const webRevision = method === "deepResearch" && params.webSearchAllowed ? webServiceRevision : null;
      if (method === "deepResearch" && params.webSearchAllowed && !webRevision) return failure("SOURCE_CHANGED");
      if (method !== "bootstrap" && !revision && !(method === "sourceSync" && syncControl)) {
        const boot = await connection.call("bootstrap", {}, options);
        if (requestedGeneration !== generation) return failure("SOURCE_CHANGED");
        if (!boot.ok) return boot;
      }
      if (method === "sourceSync" && capabilities?.sourceIntake !== true && !syncControl) return failure("METHOD_NOT_ALLOWED");
      if (method === "deepResearch" && capabilities?.deepResearch !== true) return failure("METHOD_NOT_ALLOWED");
      if (usesApi && !researchRevision) return failure("SOURCE_CHANGED");
      if (method === "generateCards" && capabilities?.cardGeneration !== true) return failure("METHOD_NOT_ALLOWED");
      if (method === "autoJudgment" && capabilities?.autoJudgment !== true) return failure("METHOD_NOT_ALLOWED");
      if (method === "command" && capabilities?.personalWrites !== true) return failure("METHOD_NOT_ALLOWED");
      if (method !== "bootstrap") return execute(method, params, options, researchRevision, webRevision);
      if (!bootstrapRequest) {
        const pending = execute(method, params, options).finally(() => {
          if (bootstrapRequest === pending) bootstrapRequest = null;
        });
        bootstrapRequest = pending;
      }
      return bootstrapRequest;
    },
  };
  function narrationCall(params, options = {}) {
    const requestedGeneration = generation;
    const operation = narrationTail.then(async () => {
      const starting = ["start", "preview"].includes(params?.action);
      const idle = () => ({ ok: true, result: { available: capabilities?.narration === true,
        backend: "macos-say", state: "idle" } });
      if (!params || typeof params !== "object" || Array.isArray(params)
        || !["start", "preview", "status", "pause", "resume", "stop"].includes(params.action)
        || Object.keys(params).some(key => !["action", ...(starting ? ["audioUseAllowed", "rate",
          ...(params.action === "start" ? ["card", "text"] : [])] : [])].includes(key))) {
        return failure("NARRATION_INVALID_INPUT");
      }
      if (starting && params.audioUseAllowed !== true) return failure("NARRATION_CONSENT_REQUIRED");
      if (starting && (!personal || disconnected || !revision || requestedGeneration !== generation)) {
        return failure("SOURCE_CHANGED");
      }
      if (starting && capabilities?.narration !== true) return failure("NARRATION_UNAVAILABLE");
      if (starting && (![0.8, 1, 1.2].includes(params.rate) || params.action === "start" &&
        (typeof params.card !== "string" || !params.card || params.card.length > 200 ||
          typeof params.text !== "string" || !params.text.trim() || params.text.length > 900 ||
          cardSource === "ima" && !imaEvidenceId))) return failure("NARRATION_INVALID_INPUT");
      if (starting && playback) return failure("NARRATION_BUSY");
      if (!starting && !playback) return ["stop", "status"].includes(params.action)
        ? idle() : failure("NARRATION_NOT_OWNER");
      if (starting) playback = { id: crypto.randomUUID(), generation };
      const owner = playback;
      if (["pause", "resume"].includes(params.action) && owner.generation !== generation) return failure("SOURCE_CHANGED");
      const payload = starting ? { action: params.action, playbackId: owner.id, rate: params.rate,
        audioUseAllowed: true, ...(params.action === "start" ? { text: params.text,
          context: { card: params.card, cardSource, sourceRevision: revision, imaEvidenceId } } : {}) }
        : { action: params.action, playbackId: owner.id };
      try {
        const response = await fetchImpl("/variable-os-desk/rpc", {
          method: "POST", credentials: "same-origin", cache: "no-store", signal: options.signal,
          headers: { "content-type": "application/json", "x-variable-os-csrf": csrf },
          body: JSON.stringify({ method: "personalNarration", params: payload }),
        });
        const body = await response.json();
        if (starting && requestedGeneration !== generation) return failure("SOURCE_CHANGED");
        if (!body?.ok) return failure(/^[A-Z_]{2,64}$/.test(body?.error?.code)
          ? body.error.code : "NARRATION_CONTROL_FAILED");
        const value = body.result;
        if (!value || Object.keys(value).some(key => !["available", "backend", "state"].includes(key))
          || typeof value.available !== "boolean" || value.backend !== "macos-say"
          || !["idle", "starting", "speaking", "paused", "stopping", "error"].includes(value.state)
          || starting && value.state !== "speaking" || params.action === "stop" && value.state !== "idle") {
          return failure("NARRATION_CONTROL_FAILED");
        }
        if (value.state === "idle" && playback === owner) playback = null;
        return { ok: true, result: value };
      } catch { return failure("NARRATION_TRANSPORT_FAILED"); }
    });
    narrationTail = operation.catch(() => undefined);
    return operation;
  }
  function startMonitor() {
    watchController = new AbortController();
    disconnected = false;
    publicationSyncStatus = cardSource === "published" ? "CONNECTING" : null;
    void monitorConnection(watchController.signal, watchToken, cardSource);
  }
  async function monitorConnection(signal, token, source) {
    let delay = 1000;
    while (!signal.aborted) {
      const outcome = await monitor(signal, token, source);
      if (source !== "published" || !outcome.retry || signal.aborted) return;
      if (outcome.synchronized) delay = 1000;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, delay);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
      delay = Math.min(delay * 2, 30000);
    }
  }
  async function monitor(signal, token, source) {
    let reader, retry = false, synchronized = false;
    try {
      const response = await fetchImpl("/variable-os-desk/source-events", {
        headers: { "x-variable-os-csrf": token, "x-variable-os-card-source": source },
        credentials: "same-origin", cache: "no-store", signal,
      }).catch(error => { retry = error instanceof TypeError; throw error; });
      if (!response.ok || response.headers.get("content-type") !== "application/x-ndjson") throw Error();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "", seen = null, seenWeb = null, seenPublication = null;
      while (!signal.aborted) {
        const { done, value } = await reader.read().catch(error => {
          retry = error instanceof TypeError; throw error;
        });
        if (done) { retry = pending.length === 0; break; }
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 4096) throw Error();
        let at;
        while ((at = pending.indexOf("\n")) >= 0) {
          const next = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
          if (!/^[a-f0-9]{64}$/.test(next?.revision)
            || Object.keys(next).some(key => !["revision", "webServiceRevision", ...(source === "published" ? ["publication"] : [])].includes(key))
            || next.webServiceRevision !== undefined && (typeof next.webServiceRevision !== "string" ||
              !/^[a-f0-9]{64}$/.test(next.webServiceRevision))) throw Error();
          if (source === "published") {
            const publication = next.publication;
            if (!publication || !["projectionDigest,status", "appendFromDigest,projectionDigest,status"].includes(Object.keys(publication).sort().join(","))
              || !["NOT_CONFIGURED", "CONNECTING", "SYNCED", "DISCONNECTED"].includes(publication.status)
              || publication.appendFromDigest !== undefined && (publication.status !== "SYNCED"
                || !/^[a-f0-9]{64}$/.test(publication.appendFromDigest ?? "")
                || publication.appendFromDigest === publication.projectionDigest)
              || (publication.status === "SYNCED" ? !/^[a-f0-9]{64}$/.test(publication.projectionDigest ?? "")
                : publication.projectionDigest !== null)) throw Error();
            const statusChanged = publicationSyncStatus !== publication.status;
            publicationSyncStatus = publication.status;
            if (publication.status === "NOT_CONFIGURED") {
              const changed = disconnected || seenPublication && seenPublication.status !== "NOT_CONFIGURED";
              disconnected = false;
              if (changed) invalidate({ preserveSettings: true, refresh: true });
            } else if (publication.status !== "SYNCED") {
              disconnected = true;
              invalidate({ preserveSettings: true, refresh: statusChanged });
            } else {
              synchronized = true;
              // HTTP may have already read the revision announced by this
              // delayed frame. Compare with that snapshot before the preceding
              // notification so matching content does not retire the reader.
              // Disconnects and source-revision changes still clear authority.
              const previousDigest = seenPublication?.status === "SYNCED" ? seenPublication.projectionDigest : null;
              const append = !disconnected && publication.appendFromDigest &&
                [previousDigest, publishedProjectionDigest].includes(publication.appendFromDigest);
              const changed = disconnected || !append &&
                publication.projectionDigest !== publishedProjectionDigest &&
                publication.projectionDigest !== previousDigest &&
                Boolean(publishedProjectionDigest || seenPublication || bootstrapRequest);
              const preserveReading = !disconnected;
              disconnected = false;
              if (changed) invalidate({ preserveSettings: true, preserveReading, refresh: true });
            }
            seenPublication = publication;
          }
          if ((seen && seen !== next.revision) || (revision && revision !== next.revision)
            || (settingsSourceRevision && settingsSourceRevision !== next.revision)) invalidate();
          if (next.webServiceRevision && ((seenWeb && seenWeb !== next.webServiceRevision) ||
            (webServiceRevision && webServiceRevision !== next.webServiceRevision))) {
            invalidate({ keepSelection: true, preserveSettings: true });
          }
          settingsSourceRevision = next.revision;
          seen = next.revision;
          seenWeb = next.webServiceRevision ?? seenWeb;
        }
      }
    } catch {
      // Only transport failure can reopen this read-only notification stream.
      // HTTP denial and malformed notifications remain closed until reconnection
      // is explicitly requested by mounting a new view.
    }
    finally {
      await reader?.cancel().catch(() => {});
      if (!signal.aborted) {
        disconnected = true;
        if (source === "published") publicationSyncStatus = "DISCONNECTED";
        invalidate({ preserveSettings: source === "published" });
      }
    }
    return { retry, synchronized };
  }
  async function readPersonalRpc(init, scopeSignal, callerSignal, settleDeniedRead) {
    // Authority is invalidated immediately. A published read may still finish
    // its small HTTP error so an SSE notification does not truncate that reply.
    // Success bodies and model-backed work remain cancellable immediately.
    const transport = new AbortController();
    let response, deadline;
    const abort = () => transport.abort(scopeSignal.reason);
    const cancel = () => transport.abort(callerSignal.reason);
    const retire = () => {
      if (!settleDeniedRead || response && response.status !== 400) abort();
      else deadline ??= setTimeout(abort, 1000);
    };
    if (scopeSignal.aborted) abort();
    else scopeSignal.addEventListener("abort", retire, { once: true });
    if (callerSignal?.aborted) cancel();
    else callerSignal?.addEventListener("abort", cancel, { once: true });
    try {
      response = await fetchImpl("/variable-os-desk/personal-rpc", {
        ...init, signal: transport.signal,
      });
      if (scopeSignal.aborted && response.status !== 400) abort();
      if (settleDeniedRead && response.status === 400) {
        // Use the browser's complete-body consumer so a fully read error remains
        // a completed HTTP response, including in native browser diagnostics.
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 4096) { transport.abort(); throw Error("RPC_ERROR_BODY_LIMIT"); }
        return JSON.parse(new TextDecoder().decode(bytes));
      }
      return await response.json();
    } finally {
      clearTimeout(deadline);
      scopeSignal.removeEventListener("abort", retire);
      callerSignal?.removeEventListener("abort", cancel);
    }
  }
  async function execute(method, params, { signal, wikiSourceRevision } = {}, researchRevision = null, webRevision = null) {
      const current = generation, requestedEvidenceId = imaEvidenceId, requestedSource = cardSource;
      const control = method === "sourceSync" && !revision ? syncControl : null;
      const selected = control?.sourceRevision ?? revision, token = control?.csrfToken ?? csrf;
      controller ??= new AbortController();
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const body = await readPersonalRpc({
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "content-type": "application/json",
            "x-variable-os-card-source": cardSource,
            ...(requestedEvidenceId ? { "x-variable-os-ima-evidence-id": requestedEvidenceId } : {}),
            ...(token ? { "x-variable-os-csrf": token } : {}),
            ...(["deepResearch", "autoJudgment"].includes(method) && wikiSourceRevision ? { "x-variable-os-wiki-revision": wikiSourceRevision } : {}),
            ...(method === "deepResearch" && researchRevision
              ? { "x-variable-os-research-source-revision": researchRevision } : {}),
            ...(method === "deepResearch" && webRevision
              ? { "x-variable-os-web-service-revision": webRevision } : {}),
            ...(selected ? { "x-variable-os-source-revision": selected } : {}) },
          body: JSON.stringify({ method, params }),
        }, controller.signal, signal, requestedSource === "published" && reads.has(method));
        if (current !== generation) return failure("SOURCE_CHANGED");
        if (combined.aborted) {
          if (method === "imaAccess") {
            invalidate({ preserveSettings: true });
            return failure("SOURCE_UNAVAILABLE");
          }
          return failure("REQUEST_ABORTED");
        }
        const observed = /^[a-f0-9]{64}$/.test(body?.sourceRevision ?? "") ? body.sourceRevision : null;
        if (observed && settingsSourceRevision && observed !== settingsSourceRevision) {
          invalidate();
          settingsSourceRevision = observed;
          return failure("SOURCE_CHANGED");
        }
        if (observed) settingsSourceRevision = observed;
        if (requestedSource === "published" && body?.ok !== true && reads.has(method)) {
          invalidate({ preserveSettings: true });
          return failure(/^[A-Z_]{2,64}$/.test(body?.error?.code) ? body.error.code : "INVALID_RPC_RESPONSE");
        }
        if (method === "imaAccess") {
          const value = body?.result;
          if (body?.ok === true && body.sourceRevision === selected &&
            body.imaEvidenceId === requestedEvidenceId && value &&
            Object.keys(value).sort().join(",") === "contentVerified,status" &&
            value.status === "METADATA_VISIBLE" && value.contentVerified === false) {
            return { ok: true, sourceRevision: selected, imaEvidenceId: requestedEvidenceId,
              result: { status: "METADATA_VISIBLE", contentVerified: false } };
          }
          const denied = body?.ok === false && ["FORBIDDEN_SCOPE", "NO_RESULT"].includes(body.error?.code);
          invalidate({ preserveSettings: true, deniedImaRead: denied });
          return failure(denied ? "FORBIDDEN_SCOPE" : "SOURCE_UNAVAILABLE");
        }
        if (requestedSource === "ima" && requestedEvidenceId && body?.ok === false &&
          body.error?.code === "FORBIDDEN_SCOPE") {
          // Discard evidence authority, not the safe denial notice needed after
          // the unselected metadata workspace has recovered.
          invalidate({ preserveSettings: true, deniedImaRead: true });
          return failure("FORBIDDEN_SCOPE");
        }
        if (["SOURCE_CHANGED", "SOURCE_UNAVAILABLE", "GENERATION_ACTIVATION_UNKNOWN"].includes(body?.error?.code)) {
          const recovery = body.syncControl;
          const canSync = method === "bootstrap" && requestedSource === "api" && body.ok === false &&
            body.error.code === "SOURCE_CHANGED" && observed && recovery?.sourceRevision === observed &&
            recovery.sourceIntake === true && typeof recovery.csrfToken === "string" &&
            recovery.csrfToken.length > 0 && recovery.csrfToken.length <= 256 &&
            Object.keys(recovery).length === 3;
          // Failed evidence is discarded; an already-empty view must not
          // remount and bootstrap forever or erase its repair settings.
          const sameControl = canSync && viewInvalidated &&
            syncControl?.sourceRevision === observed && syncControl.csrfToken === recovery.csrfToken;
          if (!sameControl) invalidate({ preserveSettings: Boolean(canSync) || body.error.code !== "SOURCE_CHANGED" });
          if (canSync) syncControl = { sourceRevision: observed, sourceIntake: true, csrfToken: recovery.csrfToken };
          return failure(body.error.code);
        }
        if (body?.ok && requestedSource === "ima" && ((body.imaEvidenceId ?? null) !== requestedEvidenceId ||
          method === "bootstrap" && requestedEvidenceId &&
          (body.result?.readScope?.coverage !== "SELECTED_IMA_DOCUMENT" ||
            body.result.readScope.evidenceId !== requestedEvidenceId))) {
          invalidate(); return failure("SOURCE_CHANGED");
        }
        if (body?.ok && method === "bootstrap") {
          if (!/^[a-f0-9]{64}$/.test(body.result?.source?.revision) || !body.result?.csrfToken) {
            return failure("INVALID_RPC_RESPONSE");
          }
          if (body.result.webServiceRevision !== undefined &&
            (typeof body.result.webServiceRevision !== "string" ||
              !/^[a-f0-9]{64}$/.test(body.result.webServiceRevision))) {
            invalidate({ keepSelection: requestedSource === "ima", preserveSettings: true });
            return failure("INVALID_RPC_RESPONSE");
          }
          const nextResearchRevision = typeof body.result.researchSourceRevision === "string" &&
            /^[a-f0-9]{64}$/.test(body.result.researchSourceRevision)
            ? body.result.researchSourceRevision : null;
          const nextWebRevision = /^[a-f0-9]{64}$/.test(body.result.webServiceRevision ?? "")
            ? body.result.webServiceRevision : null;
          const nextWebMode = ["edge", "own", "off"].includes(body.result.webServiceMode)
            ? body.result.webServiceMode : null;
          // An unchanged IMA document does not carry consent to a replacement API.
          if (revision && (researchSourceRevision !== nextResearchRevision ||
            webServiceRevision !== nextWebRevision || webServiceMode !== nextWebMode)) {
            invalidate({ keepSelection: requestedSource === "ima",
              preserveSettings: researchSourceRevision === nextResearchRevision });
            return failure("SOURCE_CHANGED");
          }
          revision = body.result.source.revision;
          syncControl = null;
          viewInvalidated = false;
          csrf = body.result.csrfToken; delete body.result.csrfToken;
          capabilities = body.result.capabilities;
          if (requestedSource === "published") publishedProjectionDigest = body.result.health?.projectionDigest ?? null;
          researchSourceRevision = nextResearchRevision;
          webServiceRevision = nextWebRevision; webServiceMode = nextWebMode;
        }
        if (body?.ok && body.sourceRevision !== (method === "bootstrap" ? revision : selected)) {
          invalidate(); return failure("SOURCE_CHANGED");
        }
        return body;
      } catch {
        if (requestedSource === "published" && reads.has(method) && current === generation) {
          const code = combined.aborted ? "REQUEST_ABORTED" : "RPC_UNREACHABLE";
          invalidate({ preserveSettings: true });
          return failure(code);
        }
        if (method === "imaAccess" && current === generation) {
          invalidate({ preserveSettings: true });
          return failure("SOURCE_UNAVAILABLE");
        }
        return failure(current !== generation ? "SOURCE_CHANGED" : combined.aborted ? "REQUEST_ABORTED" : "RPC_UNREACHABLE");
      }
  }
  return connection;
}
export const personalConnection = createPersonalConnection();
