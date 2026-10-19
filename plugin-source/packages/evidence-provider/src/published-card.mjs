// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { compareInstants } from "./contracts.mjs";

const fail = () => { throw Object.assign(Error("Invalid reviewed publication card"), { code: "PUBLISHED_CARD_INVALID" }); };
const fields = ["schema", "cardRevisionId", "variableId", "revision", "previousCardRevisionId", "variableTitle",
  "eventSummary", "variableThesis", "whyTradable", "expectationGap", "expectedHorizon", "relationToPrior",
  "counterEvidence", "uncertainties", "invalidationConditions", "scoreComponents", "systemSuggestion",
  "evidence", "themes", "mappings", "firstDetectedAt", "systemDecisionAt", "modelVersion", "promptVersion"];
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value, max = 4096) {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /(?:password|passwd|token|api[_ -]?key|secret)\s*[:=]\s*\S+/iu.test(value)) fail();
}
function id(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail(); }
function hash(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); }
function list(value, check, max = 32) {
  if (!Array.isArray(value) || value.length > max) fail();
  value.forEach(check);
}
function time(value, cutoff) {
  try { if (compareInstants(value, cutoff ?? value) > 0) fail(); } catch { fail(); }
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, ordered(value[key])]));
  return value;
}
// JSONB may reorder object keys. Sort keys, preserving array order and exact
// Unicode strings (including NFC/NFD differences) in the approved digest.
export const publishedCardHash = value => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");

const manualFields=['title','summary','thesis','evidence','counterEvidence','invalidation','horizon','themes'];
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function humanCard(source,{revision,previousCardRevisionId,publishedAt,publicationId=source.id}) {
  object(source,['schema','origin','id','revision','version','content','contentHash','createdAt','updatedAt']);
  if(source.schema!=='manual-card-v1'||source.origin!=='HUMAN_AUTHORED'||!uuid(source.id)||!uuid(source.revision)
    ||!Number.isSafeInteger(source.version)||source.version<1||source.version>100)fail();
  object(source.content,manualFields);
  for(const key of manualFields){const value=source.content[key],max=key==='title'?160:['horizon','themes'].includes(key)?500:16000;
    text(value,60000);if(value.length>max||['title','summary','thesis'].includes(key)&&!value.trim())fail();}
  if(Buffer.byteLength(JSON.stringify(source.content))>60000)fail();
  // The private manual-card-v1 digest predates this wire format and uses NFC.
  // The publication digest additionally protects the exact original Unicode.
  const normalized=Object.fromEntries(manualFields.map(key=>[key,source.content[key].normalize('NFC')]));
  if(source.contentHash!==publishedCardHash({schema:source.schema,origin:source.origin,id:source.id,version:source.version,content:normalized}))fail();
  time(source.createdAt,source.updatedAt);time(source.updatedAt,publishedAt);time(publishedAt);
  if(!Number.isSafeInteger(revision)||revision<1||!uuid(publicationId))fail();
  if(previousCardRevisionId!==null)id(previousCardRevisionId);
  if(revision===1&&previousCardRevisionId!==null||revision>1&&previousCardRevisionId===null)fail();
  const c=source.content;
  return {schema:'published-card-v3',cardRevisionId:`manual-${publicationId}-v${revision}`,variableId:`manual-${publicationId}`,
    revision,previousCardRevisionId,variableTitle:c.title,eventSummary:c.summary,variableThesis:c.thesis,whyTradable:'',expectationGap:'',
    expectedHorizon:c.horizon,relationToPrior:null,counterEvidence:c.counterEvidence?[c.counterEvidence]:[],uncertainties:[],
    invalidationConditions:c.invalidation?[c.invalidation]:[],scoreComponents:null,systemSuggestion:null,evidence:[],themes:[],mappings:[],
    firstDetectedAt:source.createdAt,systemDecisionAt:publishedAt,modelVersion:null,promptVersion:null,authorship:source};
}
/** Explicit author publication, not generated analysis. Preserve the saved
 * original, including unstructured citations, without asserting their truth. */
export function createHumanPublishedCard(source,options) {
  const value=humanCard(source,options);return validatePublishedCard(value);
}

/** Explicitly reviewed display data only. No arbitrary ledger objects, private
 * labels, raw locators, outcome nodes or bodies are part of this contract. */
export function validatePublishedCard(value, { entityId, revision, knownAt, contentHash } = {}) {
  if(value?.schema==='published-card-v3') {
    object(value,[...fields,'authorship']);
    const expected=humanCard(value.authorship,{revision:value.revision,previousCardRevisionId:value.previousCardRevisionId,publishedAt:value.systemDecisionAt,publicationId:typeof value.variableId==='string'&&value.variableId.startsWith('manual-')?value.variableId.slice(7):''});
    if(publishedCardHash(value)!==publishedCardHash(expected)||Buffer.byteLength(JSON.stringify(value))>131072
      ||entityId!==undefined&&value.variableId!==entityId||revision!==undefined&&value.revision!==revision
      ||contentHash!==undefined&&publishedCardHash(value)!==contentHash)fail();
    time(value.systemDecisionAt,knownAt);return ordered(value);
  }
  // Early native first revisions predate these two fields. V4 preserves their
  // absence and the immutable native digest; it never manufactures advice.
  const legacy = value?.schema === "published-card-v4";
  const withPresentation = value?.schema === "published-card-v2" || legacy;
  object(value, legacy ? [...fields.filter(k => !["previousCardRevisionId", "systemSuggestion"].includes(k)), "presentation", "nativeCardRecordHash"]
    : withPresentation ? [...fields, "presentation"] : fields);
  if (!["published-card-v1", "published-card-v2", "published-card-v4"].includes(value.schema)) fail();
  if (legacy) { if (value.revision !== 1) fail(); hash(value.nativeCardRecordHash); }
  if (withPresentation) {
    const p = value.presentation;
    object(p, ["id", "recordHash", "tier", "decisionAt", "policyVersion"]);
    id(p.id); hash(p.recordHash); text(p.policyVersion, 160);
    if (!p.policyVersion.trim() || !["MUST_REVIEW", "CANDIDATE_POOL"].includes(p.tier)) fail();
    time(p.decisionAt, knownAt);
    if (compareInstants(p.decisionAt, value.systemDecisionAt) < 0) fail();
  }
  id(value.cardRevisionId); id(value.variableId);
  if (!legacy && value.previousCardRevisionId !== null) id(value.previousCardRevisionId);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 ||
    entityId !== undefined && value.variableId !== entityId ||
    revision !== undefined && value.revision !== revision) fail();
  for (const key of ["variableTitle", "eventSummary", "variableThesis", "whyTradable", "expectationGap",
    "expectedHorizon", "modelVersion", "promptVersion"]) {
    if (!(legacy && key === "expectationGap" && value[key] === null)) text(value[key]);
  }
  if (!value.variableTitle.trim() || !value.eventSummary.trim()) fail();
  if (value.relationToPrior !== null) text(value.relationToPrior, 160);
  for (const key of ["counterEvidence", "uncertainties", "invalidationConditions"]) list(value[key], item => text(item));
  object(value.scoreComponents, ["evidenceStrength", "novelty", "timeSensitivity", "tradabilityConfidence", "mappingConfidence"]);
  if (Object.values(value.scoreComponents).some(n => !Number.isFinite(n) || n < 0 || n > 1)) fail();
  for (const key of ["firstDetectedAt", "systemDecisionAt"]) time(value[key], knownAt);
  list(value.evidence, row => {
    object(row, ["id", "sourceItemId", "sourceRecordHash", "contentHash", "role", "evidenceLevel", "quote", "availableAt", "recordedAt",
      ...(Object.hasOwn(row??{},"retrievalRef")?["retrievalRef"]:[]),
      ...(Object.hasOwn(row??{},"sourceRecordType")?["sourceRecordType"]:[])]);
    if(Object.hasOwn(row,"sourceRecordType")&&(row.sourceRecordType!=="CARD_EVIDENCE"||row.sourceItemId!==row.id||!row.retrievalRef))fail();
    if(Object.hasOwn(row,"retrievalRef"))id(row.retrievalRef);
    id(row.id); id(row.sourceItemId); hash(row.sourceRecordHash); hash(row.contentHash);
    if (!["FOCAL", "SUPPORT", "COUNTER", "CONTEXT"].includes(row.role)) fail();
    text(row.evidenceLevel, 80); text(row.quote);
    time(row.availableAt, knownAt); time(row.recordedAt, knownAt);
  });
  const evidenceIds = new Set(value.evidence.map(row => row.id));
  if (!evidenceIds.size || evidenceIds.size !== value.evidence.length) fail();
  const refs = values => {
    list(values, ref => { if (!evidenceIds.has(ref)) fail(); });
    if (!values.length || new Set(values).size !== values.length) fail();
  };
  const suggestion = value.systemSuggestion;
  if (!legacy) {
  object(suggestion, ["authority", "label", "rationale", "basis", "evidenceIds", "suggestedAt", "modelVersion", "promptVersion"]);
  if (suggestion.authority !== "SYSTEM_SUGGESTION" || !["MODEL", "RULE"].includes(suggestion.basis)) fail();
  for (const key of ["label", "rationale", "modelVersion", "promptVersion"]) text(suggestion[key]);
  refs(suggestion.evidenceIds); time(suggestion.suggestedAt, knownAt);
  }
  list(value.themes, row => {
    object(row, ["id", "themeRef", "narrative", "evidenceIds"]);
    id(row.id); text(row.themeRef, 1024); if(!row.themeRef.trim())fail(); text(row.narrative); refs(row.evidenceIds);
  });
  list(value.mappings, row => {
    object(row, ["id", "securityCode", "securityName", "thesis", "evidenceIds"]);
    id(row.id); id(row.securityCode);
    if (row.securityName !== null) text(row.securityName, 300);
    text(row.thesis); refs(row.evidenceIds);
  });
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) fail();
  if (contentHash !== undefined && publishedCardHash(value) !== contentHash) fail();
  return ordered(value);
}
