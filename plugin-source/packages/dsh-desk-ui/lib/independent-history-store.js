// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPrivateJsonProfile } from "./private-json-profile.js";
import { isIndependentPlan, isIndependentResult } from "../src/independent-research-contract.mjs";
import { wikiEvidenceIdentity } from "../../evidence-provider/src/contracts.mjs";
import { imaCardIdentity } from "../../../src/runtime/ima-card-input.mjs";
import { researchError } from "./independent-research-controller.js";

const unavailable = () => researchError("RESEARCH_HISTORY_UNAVAILABLE");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonce = () => randomBytes(32).toString("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => plain(value) && Object.keys(value).sort().join(",") === names.sort().join(",");
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

// Project a known derived report only. Inputs, credentials, search bodies and
// adapter diagnostics cannot become persistent data through extra properties.
function payload(plan, result) {
  if (!isIndependentPlan(plan) || !isIndependentResult(result, plan)) throw unavailable();
  const model = value => {
    if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string"
      || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(value.reasoningEffort))) throw unavailable();
    return pick(value, ["provider", "model", "reasoningEffort"]);
  };
  const p = { ...pick(plan, ["schema", "planId", "topic", "libraryId", "historyPersistence", "webSearchAllowed", "inputMode",
    "expiresInSeconds", "historyComplete", "complete"]), model: model(plan.model),
    limits: pick(plan.limits, ["maxQueries", "maxDocuments", "apiRequests", "downloads", "maxModelCalls",
      "maxWebSearches", "maxTokensPerCall", "maxInputCharacters", "totalTimeoutMs", "maxSegments", "segmentCharacters"]) };
  const r = { ...pick(result, ["schema", "kind", "authority", "topic", "status", "cacheable", "synthesisMarkdown", "generatedAt", "reportCharacterLimit"]),
    model: model(result.model), calls: pick(result.calls, ["model", "web"]),
    writePolicy: pick(result.writePolicy, ["readOnly", "wroteArtifacts", "exportAllowed"]),
    refs: result.refs.map(row => row.sourceType === "wiki" ? pick(row, ["sourceType", "ref", "datasetId", "evidenceId",
      "path", "title", "contentHash", "versionId", "observedAt", "exportAllowed"])
      : pick(row, ["sourceType", "ref", "title", "url"])),
    readScope: { ...pick(result.readScope, ["coverage", "datasetId", "matched", "included", "complete", "historyComplete", "version", "proof"]),
      queries: result.readScope.queries.map(row => pick(row, ["query", "matched", "included", "omitted", "complete", "evidenceIds", "omittedFor"])) },
    usage: pick(result.usage ?? {}, ["inputTokens", "outputTokens"]), latencyMs: result.latencyMs };
  if (result.queryAdmission) r.queryAdmission = pick(result.queryAdmission, ["proposed", "duplicates", "admitted", "omitted"]);
  if (result.inputProcessing) r.inputProcessing = {
    ...pick(result.inputProcessing, ["mode", "offsetUnit", "allAdmittedCharactersSent", "semanticCoverage", "notesPersisted", "segmentCount"]),
    documents: result.inputProcessing.documents.map(doc => ({ ...pick(doc, ["ref", "evidenceId", "contentHash", "characters"]),
      segments: doc.segments.map(segment => pick(segment, ["id", "start", "end", "contentHash"])) })),
  };
  const datasetId = wikiEvidenceIdentity({ provider: "ima", libraryId: p.libraryId, documentId: "scope" }).datasetId;
  const originals = new Set(r.refs.filter(row => row.sourceType === "wiki").map(row => row.evidenceId));
  if (!time(r.generatedAt) || r.readScope.datasetId !== datasetId || !Number.isFinite(r.latencyMs) || r.latencyMs < 0
    || ![r.usage.inputTokens, r.usage.outputTokens].every(value => value === null || Number.isSafeInteger(value) && value >= 0)
    || r.refs.some(row => row.sourceType === "wiki" && (imaCardIdentity(row.evidenceId).datasetId !== datasetId
      || row.path !== row.evidenceId || !time(row.observedAt)))
    || r.readScope.queries.some(row => typeof row.complete !== "boolean" || !Array.isArray(row.evidenceIds)
      || row.evidenceIds.length !== row.included || new Set(row.evidenceIds).size !== row.included
      || row.evidenceIds.some(id => !originals.has(id)) || !Array.isArray(row.omittedFor) || row.omittedFor.length > 4
      || row.omittedFor.some(reason => !["DOCUMENT_LIMIT", "DOWNLOAD_ALLOWANCE", "SEARCH_PAGE_LIMIT", "SOURCE_COVERAGE_UNKNOWN"].includes(reason)))
    || bytes({ plan: p, result: r }) > 64 * 1024) throw unavailable();
  return structuredClone({ plan: p, result: r });
}

/** One private, compare-and-swap file. Running markers contain no question or
 * output and cannot be resumed. No source access or model call lives here. */
export function createIndependentHistoryStore({ file, now = () => new Date().toISOString() } = {}) {
  if (file !== undefined && (typeof file !== "string" || !path.isAbsolute(file))) throw unavailable();
  const active = new Set();
  const valid = value => {
    try {
      return keys(value, ["schema", "revision", "entries"]) && value.schema === "independent-history-v1"
        && hash(value.revision) && Array.isArray(value.entries) && value.entries.length <= 32
        && new Set(value.entries.map(row => row.id)).size === value.entries.length
        && value.entries.every(row => keys(row, ["id", "binding", "revision", "createdAt", "status", "plan", "result"])
          && hash(row.id) && hash(row.binding) && hash(row.revision) && time(row.createdAt)
          && (row.status === "running" ? row.plan === null && row.result === null
            : row.status === "ready" && JSON.stringify(payload(row.plan, row.result)) === JSON.stringify({ plan: row.plan, result: row.result })));
    } catch { return false; }
  };
  const profile = createPrivateJsonProfile({ file, initial: () => ({ schema: "independent-history-v1", revision: nonce(), entries: [] }),
    validate: valid, maxBytes: 4 * 1024 * 1024, temporaryPrefix: ".research-history-",
    errors: { invalid: "RESEARCH_HISTORY_UNAVAILABLE", unavailable: "RESEARCH_HISTORY_UNAVAILABLE",
      changed: "RESEARCH_HISTORY_CHANGED", busy: "RESEARCH_HISTORY_BUSY", write: "RESEARCH_HISTORY_UNAVAILABLE" } });
  let observed = false;
  const current = () => {
    const selected = profile.current();
    if (file && selected.stamp.startsWith("absent:")) { if (observed) throw unavailable(); }
    else observed = true;
    return selected;
  };
  const write = (selected, entries) => {
    const next = { ...selected.record, revision: nonce(), entries };
    if (!valid(next)) throw unavailable();
    profile.write(next, selected); observed = true;
  };
  const select = (id, binding) => {
    if (!hash(id) || !hash(binding)) throw researchError("INVALID_REQUEST");
    const selected = current(), row = selected.record.entries.find(row => row.id === id && row.binding === binding);
    if (!row) throw researchError("RESEARCH_HISTORY_CHANGED");
    return { selected, row };
  };
  const removeWhere = matches => {
    const selected = current(), rows = selected.record.entries.filter(row => !matches(row));
    if (rows.length !== selected.record.entries.length) write(selected, rows);
  };
  return Object.freeze({
    persistence: file ? "local-private" : "session",
    reconcile(binding) {
      if (binding !== null && !hash(binding)) throw researchError("INVALID_REQUEST");
      removeWhere(row => row.binding !== binding);
    },
    list(binding) {
      if (!hash(binding)) throw researchError("INVALID_REQUEST");
      return { entries: current().record.entries.filter(row => row.binding === binding).map(row => ({ id: row.id,
        createdAt: row.createdAt, status: row.status === "ready" ? "ready" : active.has(row.id) ? "running" : "interrupted" }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), persistence: file ? "local-private" : "session" };
    },
    begin(binding, plan) {
      if (!hash(binding) || !isIndependentPlan(plan)) throw researchError("INVALID_REQUEST");
      const selected = current();
      if (selected.record.entries.length >= 32) throw researchError("RESEARCH_HISTORY_CAPACITY");
      const row = { id: nonce(), binding, revision: nonce(), createdAt: now(), status: "running", plan: null, result: null };
      write(selected, [...selected.record.entries, row]); active.add(row.id);
      return Object.freeze({ id: row.id, createdAt: row.createdAt,
        finish(result) {
          const data = payload(plan, result), latest = current();
          if (!latest.record.entries.some(item => item.id === row.id && item.revision === row.revision && item.status === "running")) {
            throw researchError("RESEARCH_HISTORY_CHANGED");
          }
          write(latest, latest.record.entries.map(item => item.id === row.id
            ? { ...row, revision: nonce(), status: "ready", ...data } : item));
          active.delete(row.id);
        },
        abandon() { removeWhere(item => item.id === row.id && item.revision === row.revision); active.delete(row.id); },
      });
    },
    read(id, binding) {
      const { row } = select(id, binding);
      if (row.status !== "ready") throw unavailable();
      return structuredClone(row);
    },
    assertCurrent(value) {
      const { row } = select(value.id, value.binding);
      if (row.status !== "ready" || row.revision !== value.revision) throw researchError("RESEARCH_HISTORY_CHANGED");
    },
    remove(id, binding) { select(id, binding); removeWhere(row => row.id === id && row.binding === binding); active.delete(id); },
    revoke(binding) { removeWhere(row => row.binding === binding); },
    retireEvidence(binding, evidenceId) {
      removeWhere(row => row.binding === binding && row.result?.refs.some(ref => ref.evidenceId === evidenceId));
    },
  });
}
