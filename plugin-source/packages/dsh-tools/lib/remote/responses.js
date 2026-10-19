// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { compareInstants, normalizeEvidenceRecord } from "../../../evidence-provider/src/contracts.mjs";
import { remoteError } from "./config.js";
import { validatePublishedCard } from "../../../evidence-provider/src/published-card.mjs";
import { cardSnapshotPageLimit } from './snapshot-limits.js';

const invalid = () => { throw remoteError("RESPONSE_INVALID"); };
function object(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return Object.fromEntries([...required, ...optional].filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
const list = (value, max = 100) => Array.isArray(value) && value.length <= max ? value : invalid();
const text = (value, max = 4096) => typeof value === "string" && Buffer.byteLength(value) <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
  !/(?:password|passwd|token|api[_ -]?key|secret)\s*[:=]\s*\S+/iu.test(value) ? value : invalid();
const nullableText = (value, max) => value === null ? null : text(value, max);
function wikiPath(value) {
  text(value, 1024);
  if (!value || !value.isWellFormed() || /[\s\\%?#:\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || /^raw$/i.test(part))) invalid();
  return value;
}
function wikiTitle(value) {
  text(value, 512);
  if (!value.trim() || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : invalid();
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalid();
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : invalid();
function before(value, limit) {
  try { if (compareInstants(value, limit) > 0) invalid(); } catch { invalid(); }
  return value;
}
function clocks(value, asOf, knownAt = asOf) {
  before(value.availableAt, asOf); before(value.recordedAt, knownAt); before(value.knownAt, knownAt);
  before(value.availableAt, value.knownAt); before(value.recordedAt, value.knownAt);
}
function same(left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) invalid();
}
function capabilities(value) {
  const keys = ["search", "readFull", "changes", "cancel", "asOf", "getEvidence", "getCard", "listWiki", "readWiki"];
  const out = object(value, [...keys, "timeBoundaries"]);
  if (keys.some((key) => typeof out[key] !== "boolean") || out.readFull !== false) invalid();
  out.timeBoundaries = object(out.timeBoundaries, ["search", "read", "getEvidence", "getCard", "readWiki", "listWiki", "changes"]);
  if (Object.values(out.timeBoundaries).some((value) => typeof value !== "boolean")) invalid();
  return out;
}
function versions(value) {
  const out = list(value).map((row) => {
    const result = object(row, ["datasetId", "version"]); id(result.datasetId); hash(result.version); return result;
  });
  if (new Set(out.map((row) => row.datasetId)).size !== out.length) invalid();
  return out;
}
function receipt(value, params) {
  const out = object(value, ["schema", "provider", "query", "scope", "datasetVersions", "datasetCapabilities",
    "asOf", "knownAt", "hitCount", "totalHits", "durationMs", "dataAge", "rateRemaining", "complete", "timeBoundary", "excluded"],
    params.readSnapshot !== undefined ? ['readSnapshot'] : []);
  if (params.readSnapshot !== undefined && (typeof out.readSnapshot !== 'string'
    || !/^[a-f0-9]{32}$/.test(out.readSnapshot)
    || params.readSnapshot !== 'start' && out.readSnapshot !== params.readSnapshot)) invalid();
  if (out.schema !== "evidence-provider-v1" || out.provider !== "publication-edge" || out.complete !== true || out.timeBoundary !== "STRICT") invalid();
  text(out.query, 800);
  out.scope = object(out.scope, ["datasetIds"]);
  out.scope.datasetIds = list(out.scope.datasetIds).map(id);
  if (!out.scope.datasetIds.length || new Set(out.scope.datasetIds).size !== out.scope.datasetIds.length) invalid();
  const requested = params.datasetIds ?? (params.datasetId ? [params.datasetId] : null);
  if (requested) same([...requested].sort(), [...out.scope.datasetIds].sort());
  out.datasetVersions = versions(out.datasetVersions);
  same(out.datasetVersions.map((row) => row.datasetId).sort(), [...out.scope.datasetIds].sort());
  out.datasetCapabilities = list(out.datasetCapabilities).map((row) => {
    const result = object(row, ["datasetId", "capabilities"]);
    if (!out.scope.datasetIds.includes(result.datasetId)) invalid();
    result.capabilities = capabilities(result.capabilities); return result;
  });
  before(out.asOf, new Date().toISOString()); before(out.knownAt, new Date().toISOString());
  if (params.asOf !== undefined) same(out.asOf, params.asOf);
  if (params.knownAt !== undefined) same(out.knownAt, params.knownAt);
  for (const key of ["hitCount", "totalHits"]) count(out[key]);
  if (out.hitCount > out.totalHits) invalid();
  finite(out.durationMs);
  if (out.dataAge !== null) finite(out.dataAge);
  if (out.rateRemaining !== null) count(out.rateRemaining);
  out.excluded = object(out.excluded, ["future", "mirrors", "withdrawn"]);
  Object.values(out.excluded).forEach(count);
  return out;
}
function record(value, meta, method, includeCard = false) {
  const out = object(value, ["evidenceId", "datasetId", "datasetVersion", "sourceFamily", "eventAt", "availableAt",
    "recordedAt", "knownAt", "epistemicType", "excerpt", "contentHash", "exportAllowed", "modelUseAllowed", "license", "mirrors", "revision"],
  ["cardId", "title", "nodes", "path", "excerptOnly", "publishedText", "publishedCard", "ownerFocus"]);
  if(Object.hasOwn(out,'ownerFocus')){
    if(out.sourceFamily!=='cards')invalid();
    const mark=object(out.ownerFocus,['selected','revision','updatedAt']);
    if(typeof mark.selected!=='boolean')invalid();id(mark.revision);
    try{compareInstants(mark.updatedAt,mark.updatedAt);}catch{invalid();}
  }
  id(out.evidenceId); id(out.datasetId);
  if (!meta.scope.datasetIds.includes(out.datasetId) || out.exportAllowed !== true || out.modelUseAllowed !== true) invalid();
  if (out.datasetVersion !== meta.datasetVersions.find((row) => row.datasetId === out.datasetId)?.version) invalid();
  clocks(out, meta.asOf, meta.knownAt); text(out.excerpt); nullableText(out.license, 160);
  if (!["evidence", "cards", "wiki", "graph", "facts", "brain"].includes(out.sourceFamily)) invalid();
  const family = { casefile: "cards", evidence: "evidence", wiki: "wiki", inbox: "cards" }[method];
  if (family && out.sourceFamily !== family) invalid();
  if (!count(out.revision) || list(out.mirrors).length) invalid();
  if (out.eventAt !== null) before(out.eventAt, meta.asOf);
  if (out.sourceFamily === "cards") {
    if (out.cardId !== out.evidenceId || list(out.nodes).length) invalid();
    if (Object.hasOwn(out, "publishedCard")) {
      if (method !== "casefile" && !includeCard || out.title !== out.publishedCard?.variableTitle) invalid();
      try { out.publishedCard = validatePublishedCard(out.publishedCard, {
        entityId: out.cardId, revision: out.revision, knownAt: out.knownAt, contentHash: out.contentHash,
      }); } catch { invalid(); }
    } else if (out.title !== null) invalid();
  } else if (["cardId", "nodes", "publishedCard", ...(out.sourceFamily === "wiki" ? [] : ["title"])]
    .some((key) => Object.hasOwn(out, key))) invalid();
  if (out.sourceFamily === "wiki") {
    wikiPath(out.path);
    if (Object.hasOwn(out, "title")) wikiTitle(out.title);
    if (typeof out.excerptOnly !== "boolean") invalid();
    if (out.excerptOnly) {
      if (Object.hasOwn(out, "publishedText")) invalid();
    } else {
      if (method !== "wiki") invalid();
      wikiTitle(out.title);
      text(out.publishedText, 32768);
      if (!out.publishedText.isWellFormed()) invalid();
    }
  } else if (["path", "excerptOnly", "publishedText"].some((key) => Object.hasOwn(out, key))) invalid();
  try { normalizeEvidenceRecord(out); } catch { invalid(); }
  return out;
}

export function projectReadResponse(method, value, params = {}) {
  const field = { capabilities: "capabilities", datasets: "datasets", search: "hits", inbox: "items",
    casefile: "item", evidence: "item", wikiIndex: "entries", wiki: "item", changes: "events", timeline: "items" }[method];
  if (!field) invalid();
  const includeCard = method === "inbox" && params.include === "publishedCard";
  const out = object(value, [field, "receipt", ...(includeCard ? ["cardContent"] : [])],
    ["nextCursor", ...(method === "capabilities" ? ["excerptOnly"] : [])]);
  if (includeCard && out.cardContent !== "REVIEWED_CARD_OR_EXCERPT") invalid();
  out.receipt = receipt(out.receipt, params);
  if (out.nextCursor !== undefined) text(out.nextCursor, 4096);
  if (method === "capabilities") {
    out.capabilities = capabilities(out.capabilities);
    if (out.excerptOnly !== true) invalid();
  } else if (method === "datasets") {
    out.datasets = versions(out.datasets);
    same(out.datasets, out.receipt.datasetVersions);
  } else if (method === "wikiIndex") {
    out.entries = list(out.entries).map((entry) => {
      const item = object(entry, ["datasetId", "path", "contentHash", "datasetVersion", "excerptOnly"]);
      wikiPath(item.path); hash(item.contentHash);
      if (typeof item.excerptOnly !== "boolean" || item.datasetVersion !== out.receipt.datasetVersions.find((row) => row.datasetId === item.datasetId)?.version) invalid();
      return item;
    });
  } else if (method === "changes") {
    out.events = list(out.events).map((entry) => {
      const item = object(entry, ["eventId", "datasetId", "evidenceId", "type", "revision", "knownAt", "datasetVersion"]);
      id(item.eventId); id(item.evidenceId); count(item.revision);
      if (!["card.committed", "card.revised", "card.withdrawn", "evidence.withdrawn"].includes(item.type) ||
          item.datasetVersion !== out.receipt.datasetVersions.find((row) => row.datasetId === item.datasetId)?.version) invalid();
      before(item.knownAt, out.receipt.knownAt); return item;
    });
  } else if (field === "item") {
    out.item = record(out.item, out.receipt, method);
    if ((params.id ?? params.card ?? params.path) !== (method === "wiki" ? out.item.path : out.item.evidenceId)) invalid();
  } else {
    out[field] = list(out[field], method === 'inbox' ? cardSnapshotPageLimit(params) : 100)
      .map((item) => record(item, out.receipt, method, includeCard));
    if (includeCard && out[field].length !== out.receipt.hitCount) invalid();
  }
  return { ...out, provider: "remote" };
}

export function projectResearchStatus(value) {
  const out = object(value, ["provider", "status", "connection", "reason"]);
  const valid = out.status === "NOT_CONFIGURED" ? out.reason === "CLIENT_NOT_CONFIGURED"
    : out.status === "READY" ? out.reason === "CLIENT_CONFIGURED"
      : out.status === "PAUSED" && ["TOKEN_WINDOW_BREAKER", "TOKEN_DAY_BREAKER"].includes(out.reason);
  if (out.provider !== "tavily" || out.connection !== "NOT_CHECKED" || !valid) invalid();
  return out;
}

const FAMILIES = [
  ["wiki", "wikiResults", "wiki", "snippet", "W"], ["graph", "graphExpansions", "graph", "snippet", "G"],
  ["facts", "factsResults", "facts", "excerpt", "F"], ["brain", "brainResults", "brain", "excerpt", "B"],
  ["raw", "licensedExcerpts", "evidence", "snippet", "R"],
];
function webUrl(value) {
  text(value, 2048);
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      [...url.searchParams.keys()].some((key) => /key|token|secret|signature|credential|password/i.test(key))) invalid();
  return value;
}
export function projectResearchContext(value, datasetIds, params = {}) {
  const out = object(value, ["contextId", "local", "web", "refs", "usage", "receipt"], ["provider"]);
  id(out.contextId);
  if (out.provider !== undefined && out.provider !== "remote") invalid();
  const allowed = new Set(list(datasetIds).map(id));
  if (!allowed.size) invalid();
  out.receipt = object(out.receipt, ["mode", "asOf", "sources", "maxResults", "coverage",
    ...(params.proof === true ? ["publicationEpoch"] : [])]);
  if (params.proof === true) hash(out.receipt.publicationEpoch);
  if (out.receipt.mode !== "context" || out.receipt.coverage !== "FILTERED_EDGE_SNAPSHOT") invalid();
  before(out.receipt.asOf, new Date().toISOString());
  if (params.asOf !== undefined) same(out.receipt.asOf, params.asOf);
  const sources = list(out.receipt.sources, 5);
  if (!sources.length || new Set(sources).size !== sources.length || sources.some((source) => !FAMILIES.some(([name]) => name === source))) invalid();
  if (params.sources) same([...sources].sort(), [...params.sources].sort());
  if (!count(out.receipt.maxResults) || out.receipt.maxResults > 50 ||
      (params.maxResults !== undefined && params.maxResults !== out.receipt.maxResults)) invalid();
  out.local = object(out.local, ["wikiResults", "graphExpansions", "factsResults", "brainResults", "rawSummary", "counts"]);
  out.local.rawSummary = object(out.local.rawSummary, ["matches", "licensedExcerpts"]);
  count(out.local.rawSummary.matches);
  out.local.counts = object(out.local.counts, ["wikiMatches", "rawMatches", "graphMatches", "factsMatches", "brainMatches"]);
  Object.values(out.local.counts).forEach(count);
  if (out.local.rawSummary.matches !== out.local.counts.rawMatches) invalid();
  const expectedRefs = [];
  for (const [source, key, scope, excerptKey, prefix] of FAMILIES) {
    const container = source === "raw" ? out.local.rawSummary : out.local;
    container[key] = list(container[key], 50).map((entry, index) => {
      const item = object(entry, ["ref", "evidenceId", "datasetId", "path", "title", excerptKey, "revision", "contentHash",
        "availableAt", "recordedAt", "knownAt", "sourceFamily", "epistemicType", "license", "exportAllowed"]);
      id(item.evidenceId); id(item.datasetId);
      if (!sources.includes(source) || !allowed.has(item.datasetId) || item.exportAllowed !== true ||
          item.ref !== `${prefix}${index + 1}`) invalid();
      if (source === "wiki") wikiPath(item.path);
      else if (item.path !== `publication/${scope}/${item.evidenceId}`) invalid();
      clocks(item, out.receipt.asOf);
      if (!count(item.revision)) invalid();
      if (item.contentHash !== null) hash(item.contentHash);
      text(item[excerptKey]);
      if (source === "wiki" && item.title !== null) wikiTitle(item.title);
      else nullableText(item.title, 300);
      nullableText(item.license, 160);
      text(item.sourceFamily, 80); text(item.epistemicType, 80);
      expectedRefs.push({ sourceType: source, ref: item.ref, evidenceId: item.evidenceId, datasetId: item.datasetId,
        path: item.path, title: item.title, excerpt: item[excerptKey] });
      return item;
    });
    if (container[key].length > out.local.counts[`${source}Matches`]) invalid();
  }
  if (expectedRefs.length > out.receipt.maxResults) invalid();
  out.web = object(out.web, ["status", "results"], ["reason", "pauseToken"]);
  if (!["done", "off", "timeout", "paused"].includes(out.web.status)) invalid();
  if (out.web.reason !== undefined && !/^[A-Z_]{1,80}$/.test(out.web.reason)) invalid();
  if (out.web.pauseToken !== undefined) id(out.web.pauseToken);
  if (out.web.status !== "done" && out.web.results?.length) invalid();
  out.web.results = list(out.web.results, out.receipt.maxResults).map((entry, index) => {
    const item = object(entry, ["ref", "title", "url", "snippet", "publishedAt", "license"]);
    if (item.ref !== `T${index + 1}`) invalid();
    nullableText(item.title, 300); webUrl(item.url); text(item.snippet); nullableText(item.license, 160);
    if (item.publishedAt !== null) before(item.publishedAt, out.receipt.asOf);
    expectedRefs.push({ sourceType: "web", ref: item.ref, title: item.title, url: item.url, excerpt: item.snippet });
    return item;
  });
  const references = list(out.refs, 100);
  if (references.length !== expectedRefs.length) invalid();
  const seen = new Set();
  for (const expected of expectedRefs) {
    const candidates = references.filter((ref) => ref?.ref === expected.ref);
    if (candidates.length !== 1 || seen.has(expected.ref)) invalid();
    seen.add(expected.ref);
    const actual = object(candidates[0], Object.keys(expected));
    for (const key of Object.keys(expected)) if (actual[key] !== expected[key]) invalid();
  }
  out.refs = expectedRefs;
  out.usage = object(out.usage, ["tavilyCreditsToday"]); count(out.usage.tavilyCreditsToday);
  return { contextId: out.contextId, local: out.local, web: out.web, refs: out.refs,
    usage: out.usage, receipt: out.receipt, provider: "remote" };
}

export function projectCardEvent(event, value, datasetId) {
  const out = object(value, ["datasetId", "cardId", "evidenceId", "revision", "variable", "themeMappingStatus",
    "evidenceRefs", "eventAt", "availableAt", "recordedAt", "knownAt", "epistemicTags"]);
  id(out.datasetId);
  if (datasetId && out.datasetId !== datasetId) invalid();
  if (event.startsWith("card.")) { id(out.cardId); if (out.evidenceId !== null) invalid(); }
  else if (event === "evidence.withdrawn") { id(out.evidenceId); if (out.cardId !== null) invalid(); }
  else invalid();
  if (out.variable !== null && (typeof out.variable !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(out.variable))) invalid();
  if (!count(out.revision) || out.themeMappingStatus !== "UNKNOWN" ||
      list(out.evidenceRefs).length || out.eventAt !== null) invalid();
  same(out.epistemicTags, ["UNKNOWN"]);
  clocks(out, new Date().toISOString());
  return out;
}
