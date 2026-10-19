// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { researchError } from "./independent-research-controller.js";
import { createHash } from "node:crypto";

function matchesSegments(document, content) {
  if (!document) return true;
  const chars = [...content];
  return chars.length === document.characters && document.segments.every(segment => createHash("sha256")
    .update(chars.slice(segment.start, segment.end).join("")).digest("hex") === segment.contentHash);
}

const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === fields.sort().join(",");
export function createIndependentResearchHistory({ store, wikiSettings }) {
  const reconcile = () => {
    const source = wikiSettings.snapshot();
    const binding = source.mode === "ima" && source.libraryId && source.credentialsConfigured && source.modelUseAllowed
      ? source.profileRevision : null;
    store.reconcile(binding);
    return { source, binding };
  };
  return Object.freeze({
    reconcile,
    list(params) {
      if (!exact(params, [])) throw researchError("INVALID_REQUEST");
      const { binding } = reconcile();
      return binding ? store.list(binding) : { entries: [], persistence: store.persistence };
    },
    remove(params) {
      if (!exact(params, ["id"])) throw researchError("INVALID_REQUEST");
      const { binding } = reconcile();
      if (!binding) throw researchError("RESEARCH_HISTORY_CHANGED");
      store.remove(params.id, binding);
      return { removed: true };
    },
    async read(params, { signal } = {}) {
      if (!exact(params, ["id"])) throw researchError("INVALID_REQUEST");
      if (signal?.aborted) throw researchError("CANCELLED");
      const { binding } = reconcile();
      if (!binding) throw researchError("RESEARCH_HISTORY_CHANGED");
      const loaded = store.read(params.id, binding);
      let session;
      const check = () => {
        if (signal?.aborted) throw researchError("CANCELLED");
        wikiSettings.assertRevision(binding); store.assertCurrent(loaded);
      };
      try {
        check();
        session = await wikiSettings.createResearchSession({ profileRevision: binding, signal,
          limits: { apiRequests: 80, downloads: 4, totalTimeoutMs: 90000 } });
        const refs = loaded.result.refs.filter(row => row.sourceType === "wiki");
        // Empty/web-only reports still require current library identity and
        // access, without searching or downloading unrelated documents.
        if (!refs.length) await session.checkLibraryAccess({ signal });
        else await session.prepareResearchReferences({ queries: loaded.result.readScope.queries.map(row => row.query), signal });
        for (const ref of refs) {
          check();
          let record;
          try { record = await session.readCardInput({ evidenceId: ref.evidenceId, modelUseAllowed: true, signal }); }
          catch (error) {
            if (error?.code !== "NO_RESULT") throw error;
          }
          const document = loaded.result.inputProcessing?.documents.find(row => row.ref === ref.ref);
          if (!record || record.contentHash !== ref.contentHash || record.wikiOrigin.title !== ref.title
            || !matchesSegments(document, record.content)) {
            store.retireEvidence(binding, ref.evidenceId);
            throw researchError("RESEARCH_HISTORY_STALE");
          }
          check();
        }
        check();
        return { plan: loaded.plan, result: loaded.result, history: { id: loaded.id, createdAt: loaded.createdAt,
          checkedAt: new Date().toISOString(), proof: "REVALIDATED", webRevalidated: false, persistence: store.persistence } };
      } catch (error) {
        if (["AUTH_REQUIRED", "FORBIDDEN_SCOPE"].includes(error?.code)) store.revoke(binding);
        if (error?.code === "WIKI_SOURCE_CHANGED") reconcile();
        throw error;
      } finally { session?.close(); }
    },
  });
}
