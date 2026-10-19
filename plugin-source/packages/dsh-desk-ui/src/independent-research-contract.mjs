// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { independentResearchLimits } from "./independent-research-limits.mjs";
const text = (value, max) => typeof value === "string" && value.length > 0 && [...value].length <= max && value.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const number = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const persistence = value => ["local-private", "session"].includes(value);
const identifier = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function isIndependentPlan(value) {
  const segmented = value?.schema === "independent-research-plan-v2" && value.inputMode === "segmented";
  const limits = independentResearchLimits(value?.webSearchAllowed, segmented);
  return Boolean((segmented || value?.schema === "independent-research-plan-v1" && !Object.hasOwn(value, "inputMode"))
    && /^[a-f0-9]{64}$/.test(value.planId ?? "")
    && text(value.topic, 200) && text(value.libraryId, 512) && text(value.model?.provider, 160) && text(value.model?.model, 160)
    && typeof value.webSearchAllowed === "boolean" && value.complete === false && value.historyComplete === false
    && persistence(value.historyPersistence)
    && value.expiresInSeconds === 300 && Object.entries(limits).every(([key, expected]) => value.limits?.[key] === expected));
}

export function isIndependentHistoryList(value) {
  return Boolean(persistence(value?.persistence) && Array.isArray(value.entries) && value.entries.length <= 32
    && new Set(value.entries.map(row => row?.id)).size === value.entries.length
    && value.entries.every(row => identifier(row?.id) && timestamp(row.createdAt)
      && ["ready", "running", "interrupted"].includes(row.status)));
}
export function isIndependentSavedHistory(value, plan) {
  return Boolean(identifier(value?.id) && timestamp(value.createdAt) && value.state === "saved"
    && persistence(value.persistence) && value.persistence === plan.historyPersistence);
}
export function isIndependentHistoryRestore(value, id) {
  const history = value?.history;
  return Boolean(isIndependentPlan(value?.plan) && isIndependentResult(value?.result, value.plan)
    && identifier(history?.id) && history.id === id && timestamp(history.createdAt) && timestamp(history.checkedAt)
    && history.proof === "REVALIDATED" && history.webRevalidated === false && persistence(history.persistence)
    && history.persistence === value.plan.historyPersistence);
}
function safeUrl(value) {
  try {
    if (!text(value, 2048) || /[\s\\]/u.test(value)) return false;
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => /key|token|secret|signature|credential|password/i.test(key));
  } catch { return false; }
}
function segmentedProcessing(value, refs, limits) {
  if (value?.mode !== "segmented-v1" || value.offsetUnit !== "unicode-code-points"
    || value.allAdmittedCharactersSent !== true || value.semanticCoverage !== "NOT_PROVEN" || value.notesPersisted !== false
    || !number(value.segmentCount, limits.maxSegments) || !Array.isArray(value.documents) || value.documents.length !== refs.length) return false;
  let count = 0;
  for (const [index, doc] of value.documents.entries()) {
    const ref = refs[index];
    if (doc?.ref !== ref.ref || doc.evidenceId !== ref.evidenceId || doc.contentHash !== ref.contentHash
      || !number(doc.characters, limits.maxSegments * limits.segmentCharacters) || !doc.characters
      || !Array.isArray(doc.segments) || !doc.segments.length || doc.segments.length > limits.maxSegments) return false;
    let at = 0;
    for (const [i, segment] of doc.segments.entries()) {
      if (segment?.id !== `${doc.ref}.S${i + 1}` || segment.start !== at
        || !number(segment.end, doc.characters) || segment.end <= at || segment.end - at > limits.segmentCharacters
        || !identifier(segment.contentHash)) return false;
      at = segment.end; count++;
    }
    if (at !== doc.characters) return false;
  }
  return count === value.segmentCount;
}
export function isIndependentResult(value, plan) {
  const scope = value?.readScope;
  if (!isIndependentPlan(plan) || value?.schema !== "deep-research-proposal-v1" || value.kind !== "independent-ima-v1"
    || value.authority !== "proposal" || value.topic !== plan.topic || !["partial", "empty"].includes(value.status)
    || value.cacheable !== false || value.model?.provider !== plan.model.provider || value.model?.model !== plan.model.model
    || value.writePolicy?.readOnly !== true || value.writePolicy?.wroteArtifacts !== false || value.writePolicy?.exportAllowed !== false
    || !number(value.calls?.model, plan.limits.maxModelCalls) || !number(value.calls?.web, plan.limits.maxWebSearches)
    || !text(value.synthesisMarkdown, 6000) || scope?.coverage !== "IMA_LIBRARY_MULTI_QUERY"
    || scope.proof !== "REVALIDATED" || scope.complete !== false || scope.historyComplete !== false
    || scope.matched !== null || scope.version !== null || !number(scope.included, 4)
    || !Array.isArray(scope.queries) || !scope.queries.length || scope.queries.length > 4
    || !scope.queries.every(row => text(row?.query, 200) && number(row.matched, Number.MAX_SAFE_INTEGER)
      && number(row.included, 4) && row.omitted === row.matched - row.included && row.omitted >= 0)
    || !Array.isArray(value.refs) || value.refs.length > 14 || new Set(value.refs.map(row => row?.ref)).size !== value.refs.length) return false;
  if (value.reportCharacterLimit !== undefined && (!number(value.reportCharacterLimit, 6000)
    || value.reportCharacterLimit < 1 || value.synthesisMarkdown.length > value.reportCharacterLimit)) return false;
  if (value.queryAdmission !== undefined) {
    const q = value.queryAdmission;
    if (!q || Object.keys(q).sort().join(",") !== "admitted,duplicates,omitted,proposed"
      || !Object.values(q).every(n => number(n, 8)) || q.admitted > 2
      || q.admitted !== Math.min(2, q.proposed - q.duplicates)
      || q.proposed !== q.admitted + q.duplicates + q.omitted
      || scope.queries.length < q.admitted + 1 || scope.queries.length > q.admitted + 2) return false;
  }
  let wiki = 0, web = 0;
  for (const row of value.refs) {
    if (row?.sourceType === "wiki") {
      if (row.ref !== `W${++wiki}` || !text(row.title, 300) || row.datasetId !== scope.datasetId
        || !text(row.evidenceId, 2048) || !/^[a-f0-9]{64}$/.test(row.contentHash ?? "")
        || row.versionId !== null || row.exportAllowed !== false) return false;
    } else if (row?.sourceType === "web") {
      if (!plan.webSearchAllowed || row.ref !== `T${++web}` || !safeUrl(row.url)
        || row.title !== null && !text(row.title, 300)) return false;
    } else return false;
  }
  if (wiki !== scope.included || value.status === "empty" && (value.refs.length || value.calls.model !== 0)) return false;
  if (plan.inputMode !== "segmented") return value.inputProcessing === undefined;
  return segmentedProcessing(value.inputProcessing, value.refs.filter(row => row.sourceType === "wiki"), plan.limits)
    && value.calls.model === (value.status === "empty" ? 0 : value.inputProcessing.segmentCount + 3);
}
