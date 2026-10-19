// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { pathToFileURL } from "node:url";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { createLivePublishedEvidenceReader } from "../../dsh-tools/lib/remote/intake.js";
import { createHash } from "node:crypto";

export const PERSONAL_READ_METHODS = new Set(["bootstrap", "health", "sourceHealth", "imaAccess", "inbox",
  "casefile", "evidence", "feedback", "report", "catalystWatchList", "catalystWatchDetail",
  "catalystAuditOverview", "catalystSourceList"]);
export const PERSONAL_METHODS = new Set([...PERSONAL_READ_METHODS, "sourceSync", "deepResearch", "generateCards", "command", "autoJudgment"]);

/** The optional native reader is loaded only after explicit private storage
 * configuration. The standalone remote transport must still run without core. */
export function createPersonalHost({ env, appRoot, sources, provider, wikiSettings, runResearch, runImaResearch, runJudgment, analyzePublishedEvidence,
  nativeConversationAvailable = false }) {
  const workspaceRoot = env.VARIABLE_OS_PERSONAL_DESK_ROOT;
  const desks = new Map();
  const selectedDesks = new Set();
  let closed = false;
  const source = (kind = "api") => {
    if (kind === "api") return sources.snapshot();
    if (kind !== "ima" || !wikiSettings) throw remoteError("INVALID_REQUEST");
    const wiki = wikiSettings.snapshot();
    return { kind: "ima", ownership: "self", connection: wiki.connection,
      configured: wiki.mode === "ima" && wiki.credentialsConfigured && Boolean(wiki.libraryId),
      revision: createHash("sha256").update(`ima-card-source:${wiki.profileRevision}`).digest("hex") };
  };
  const reset = kind => {
    if (kind === undefined || kind === "ima") for (const desk of selectedDesks) desk.close();
    for (const [key, previous] of desks) {
      if (kind !== undefined && kind !== key) continue;
      desks.delete(key);
      void previous.promise.then(desk => desk.close(), () => {});
    }
  };
  const access = async (method, params, options = {}, operation) => {
      const { signal, sourceRevision, cardSource = "api", imaEvidenceId } = options;
      if (!PERSONAL_METHODS.has(method) && !(method === "researchTurn" && typeof operation === "function")) {
        throw remoteError("METHOD_NOT_ALLOWED");
      }
      if (closed || signal?.aborted) throw remoteError("CANCELLED");
      if (method === "autoJudgment") {
        if (typeof runJudgment !== "function" || cardSource === "api" && !provider?.settings().ready) {
          throw remoteError("METHOD_NOT_ALLOWED");
        }
        if (!params || typeof params !== "object" || Array.isArray(params) ||
          Object.keys(params).some(key => !["card", "modelUseAllowed"].includes(key)) ||
          typeof params.card !== "string" || !params.card || params.card.length > 200) throw remoteError("INVALID_REQUEST");
        if (params.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
      }
      const selection = source(cardSource), selected = selection.revision;
      const revision = () => source(cardSource).revision;
      if (method !== "bootstrap" && sourceRevision !== selected) throw remoteError("SOURCE_CHANGED");
      if (!workspaceRoot) throw remoteError("PERSONAL_WORKSPACE_REQUIRED");
      if (!path.isAbsolute(workspaceRoot) || !appRoot || !path.isAbsolute(appRoot)) throw remoteError("PERSONAL_WORKSPACE_INVALID");
      const wiki = cardSource === "ima" ? wikiSettings.snapshot() : null;
      if (imaEvidenceId !== undefined) {
        if (cardSource !== "ima") throw remoteError("INVALID_REQUEST");
        const { imaCardIdentity } = await import(pathToFileURL(path.join(appRoot, "src/runtime/ima-card-input.mjs")).href);
        const identity = imaCardIdentity(imaEvidenceId);
        if (!selection.configured || identity.datasetId !== `wiki:ima:${Buffer.from(wiki.libraryId).toString("base64url")}`) {
          throw remoteError("FORBIDDEN_SCOPE");
        }
      }
      if (method === "imaAccess") {
        if (cardSource !== "ima" || !imaEvidenceId) throw remoteError("METHOD_NOT_ALLOWED");
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
          throw remoteError("INVALID_REQUEST");
        }
        wikiSettings.assertRevision(wiki.profileRevision);
        const session = await wikiSettings.createSession({ signal });
        try {
          await session.checkCardAccess({ evidenceId: imaEvidenceId, signal });
          if (closed || signal?.aborted) throw remoteError("CANCELLED");
          wikiSettings.assertRevision(wiki.profileRevision);
          if (selected !== revision()) throw remoteError("SOURCE_CHANGED");
          return { ok: true, sourceRevision: selected, imaEvidenceId,
            result: { status: "METADATA_VISIBLE", contentVerified: false } };
        } finally { session.close(); }
      }
      if (desks.get(cardSource)?.revision !== selected) {
        reset(cardSource);
        const wikiRevision = cardSource === "ima" ? wikiSettings.snapshot().profileRevision : null;
        const published = cardSource === "api" && provider?.settings().ready
          ? createLivePublishedEvidenceReader({ provider: { call(...args) {
            if (selected !== revision()) throw remoteError("SOURCE_CHANGED");
            return provider.call(...args);
          } } }) : null;
        const promise = import(pathToFileURL(path.join(appRoot, "src/research/personal-desk.mjs")).href)
          .then(({ createPersonalDesk }) => createPersonalDesk({
            workspaceRoot, sourceRevision: selected, currentSourceRevision: revision,
            cardSource, analyzePublishedEvidence,
            ...(cardSource === "ima" && selection.configured ? { readImaCandidates: async ({ signal }) => {
              wikiSettings.assertRevision(wikiRevision);
              const session = await wikiSettings.createSession({ signal });
              try {
                const result = await session.readCardCandidates({ signal });
                wikiSettings.assertRevision(wikiRevision);
                return result;
              } finally { session.close(); }
            } } : {}),
            ...(published ? { readPublishedEvidence: published.read, provePublishedEvidence: published.prove } : {}),
          }));
        desks.set(cardSource, { revision: selected, promise });
      }
      const parent = await desks.get(cardSource).promise;
      if (closed || signal?.aborted) throw remoteError("CANCELLED");
      if (selected !== revision()) throw remoteError("SOURCE_CHANGED");
      let desk = parent, scoped;
      try {
        if (imaEvidenceId !== undefined && method !== "sourceSync") {
          const { createPersonalDesk } = await import(pathToFileURL(path.join(appRoot, "src/research/personal-desk.mjs")).href);
          scoped = await createPersonalDesk({
            workspaceRoot, sourceRevision: selected, currentSourceRevision: revision,
            cardSource: "ima", imaEvidenceId,
            readImaCandidates: options => parent.readImaCandidateSnapshot(options),
            ...(wiki.modelUseAllowed ? { analyzePublishedEvidence } : {}),
            openImaCardSession: async ({ signal }) => {
              wikiSettings.assertRevision(wiki.profileRevision);
              const session = await wikiSettings.createSession({ signal });
              try { wikiSettings.assertRevision(wiki.profileRevision); return session; }
              catch (error) { session.close(); throw error; }
            },
          });
          selectedDesks.add(scoped); desk = scoped;
          if (closed || signal?.aborted) throw remoteError("CANCELLED");
          if (selected !== revision()) throw remoteError("SOURCE_CHANGED");
        }
        if (method === "researchTurn") {
          if (!nativeConversationAvailable || (cardSource === "api" ? !provider?.settings().ready
            : !scoped || !wiki.modelUseAllowed)) throw remoteError("METHOD_NOT_ALLOWED");
          if (cardSource === "ima") wikiSettings.assertRevision(options.wikiSourceRevision);
          return await desk.withResearchTurn(params, operation, { signal });
        }
        // Assemble metadata first so the selected read's final live proof remains last.
        const metadata = method === "bootstrap" && scoped ? await parent.call("bootstrap", {}, { signal }) : null;
        let response;
        if (metadata && !metadata.ok) response = metadata;
        else if (method === "generateCards" && scoped && scoped.capabilities.cardGeneration) {
          if (!params || typeof params !== "object" || Array.isArray(params) ||
            Object.keys(params).some(key => key !== "modelUseAllowed")) throw remoteError("INVALID_REQUEST");
          if (params.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
          const intake = await scoped.call("sourceSync", {}, { signal });
          response = intake.ok ? await scoped.call(method, params, { signal }) : intake;
        } else if (method === "autoJudgment") {
          if (cardSource === "api" ? !provider?.settings().ready : !scoped || !wiki.modelUseAllowed) {
            throw remoteError("METHOD_NOT_ALLOWED");
          }
          if (cardSource === "ima") wikiSettings.assertRevision(options.wikiSourceRevision);
          response = { ok: true, projectionStatus: "UNCHANGED",
            result: await runJudgment({ desk, card: params.card, signal }) };
        } else if (method === "deepResearch") {
          const ima = cardSource === "ima" && scoped && wiki.modelUseAllowed && typeof runImaResearch === "function";
          if (!ima && (cardSource !== "api" || !provider?.settings().ready || typeof runResearch !== "function")) throw remoteError("METHOD_NOT_ALLOWED");
          if (!params || typeof params !== "object" || Array.isArray(params) ||
            Object.keys(params).some(key => !["card", "topic", "force", "modelUseAllowed", "webSearchAllowed",
              ...(ima ? ["researchScope", "apiSupplementAllowed"] : [])].includes(key))
            || typeof params.card !== "string" || params.card.length > 200
            || typeof params.topic !== "string" || params.topic.trim().length < 2 || params.topic.length > 200
            || (params.force !== undefined && typeof params.force !== "boolean")) throw remoteError("INVALID_REQUEST");
          if (params.modelUseAllowed !== true) throw remoteError("MODEL_CONSENT_REQUIRED");
          if (typeof params.webSearchAllowed !== "boolean") throw remoteError("INVALID_REQUEST");
          if (ima && ((params.researchScope !== undefined && !["selected", "library"].includes(params.researchScope)) ||
            (params.apiSupplementAllowed !== undefined && (typeof params.apiSupplementAllowed !== "boolean" ||
              params.researchScope !== "library")))) throw remoteError("INVALID_REQUEST");
          if ((cardSource === "api" || params.apiSupplementAllowed === true) &&
            (typeof options.researchSourceRevision !== "string" ||
              !/^[a-f0-9]{64}$/.test(options.researchSourceRevision) ||
              options.researchSourceRevision !== sources.revision())) throw remoteError("SOURCE_CHANGED");
          if (ima) {
            response = { ok: true, projectionStatus: "UNCHANGED",
              result: { ...await runImaResearch(params, { ...options, withImaResearch: scoped.withImaResearch }),
                card: params.card, cached: false } };
          } else {
            const scope = await desk.call("casefile", { card: params.card }, { signal });
            response = !scope.ok ? scope : { ok: true, projectionStatus: "UNCHANGED",
              result: { ...await runResearch(params, options), card: params.card, cached: false } };
          }
        } else response = await desk.call(method, params, { signal });
        if (response.ok && metadata?.ok) {
          response = { ...response, result: {
            ...response.result, wikiIntake: metadata.result.wikiIntake,
          } };
        }
        if (closed || signal?.aborted) throw remoteError("CANCELLED");
        if (selected !== revision()) throw remoteError("SOURCE_CHANGED");
        const scope = cardSource === "ima" ? { imaEvidenceId: imaEvidenceId ?? null } : {};
        // Withdrawal denies the ledger, not an explicit fresh intake. This
        // descriptor grants no evidence read, model use or ledger capability.
        if (method === "bootstrap" && !response.ok && response.error?.code === "SOURCE_CHANGED" &&
          cardSource === "api" && parent.capabilities.sourceIntake && provider?.settings().ready) {
          return { ...response, sourceRevision: selected,
            syncControl: { sourceRevision: selected, sourceIntake: true } };
        }
        if (!response.ok || method !== "bootstrap") return { ...response, ...scope, sourceRevision: selected };
        return { ...response, ...scope, sourceRevision: selected,
          result: { ...response.result, source: source(cardSource),
            researchSourceRevision: sources.snapshot().revision,
            capabilities: { ...response.result.capabilities,
              autoJudgment: Boolean(typeof runJudgment === "function" && (cardSource === "api"
                ? provider?.settings().ready : scoped && wiki.modelUseAllowed)),
              deepResearch: Boolean(cardSource === "api" ? provider?.settings().ready && typeof runResearch === "function"
                : scoped && wiki.modelUseAllowed && typeof runImaResearch === "function"),
              apiSupplement: Boolean(provider?.settings().ready && (cardSource === "api"
                ? typeof runResearch === "function" : scoped && wiki.modelUseAllowed && typeof runImaResearch === "function")),
              webResearch: false,
              researchConversation: Boolean(nativeConversationAvailable && (cardSource === "api"
                ? provider?.settings().ready : scoped && wiki.modelUseAllowed)),
              conversationPublishedResearch: Boolean(nativeConversationAvailable && provider?.settings().ready),
              researchAssistant: false } } };
      } finally {
        if (scoped) { selectedDesks.delete(scoped); scoped.close(); }
      }
    };
  return {
    reset, sourceRevision: kind => source(kind).revision,
    close() { closed = true; reset(); },
    call: (method, params, options) => access(method, params, options),
    withResearchTurn: (params, operation, options) => access("researchTurn", params, options, operation),
  };
}
