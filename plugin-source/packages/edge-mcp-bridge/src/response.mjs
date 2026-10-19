// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { compareRfc3339 } from "../../storage-contracts/src/time.mjs";
import { providerError } from "../../evidence-provider/src/errors.mjs";
import { validatePublishedCard } from "../../evidence-provider/src/published-card.mjs";
import { validatePublishedDocument, publishedDocumentHash } from "../../evidence-provider/src/published-document.mjs";

import {stockPriceContext} from '../../evidence-provider/src/stock-price-context.mjs';
import {STOCK_CONTEXT_MAX_BYTES} from '../../evidence-provider/src/publication-limits.mjs';
import {validMemberLibraryResult} from '../../evidence-provider/src/member-library-contract.mjs';

// These shapes describe the published WP5/WP11 fixture, not a generic
// JSON pass-through. Unknown fields fail closed instead of becoming model input.
const text = (max) => (value) => typeof value === "string" && Buffer.byteLength(value) <= max;
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const bool = (value) => typeof value === "boolean";
const yes = (value) => value === true;
const nil = (value) => value === null;
const empty = (value) => Array.isArray(value) && value.length === 0;
const nullable = (check) => (value) => value === null || check(value);
const wikiPath = (value) => text(1024)(value) && value.length > 0 && value.isWellFormed()
  && !/[\s\\%?#:\u0000-\u001f\u007f]/u.test(value)
  && value.split("/").every((part) => part && part !== "." && part !== ".." && !/^raw$/i.test(part));
const wikiTitle = (value) => text(512)(value) && value.trim().length > 0 && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/u.test(value);
const oneOf = (...values) => (value) => values.includes(value);
const list = (check, max = 100) => (value) => Array.isArray(value) && value.length <= max && value.every(check);
const object = (shape, optional = []) => (value) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => Object.hasOwn(shape, key) && shape[key](value[key]))
  && Object.keys(shape).every((key) => optional.includes(key) || Object.hasOwn(value, key));
const time = (value) => {
  try { compareRfc3339(value, value); return true; } catch { return false; }
};
const before = (left, right) => compareRfc3339(left, right) <= 0;
const sameSet = (left, right) => left.length === right.length
  && new Set(left).size === left.length && new Set(right).size === right.length
  && left.every((value) => right.includes(value));
const capabilities = object({
  search: bool, readFull: (value) => value === false, changes: bool, cancel: bool, asOf: bool,
  getEvidence: bool, getCard: bool, listWiki: bool, readWiki: bool,
  timeBoundaries: object(Object.fromEntries(
    ["search", "read", "getEvidence", "getCard", "readWiki", "listWiki", "changes"].map((key) => [key, bool]),
  )),
});
const scope = object({ datasetIds: (value) => list(identifier)(value) && value.length > 0 });
const version = object({ datasetId: identifier, version: hash });
const receipt = object({
  schema: oneOf("evidence-provider-v1"), provider: oneOf("publication-edge"), query: text(8192),
  scope, datasetVersions: list(version),
  datasetCapabilities: list(object({ datasetId: identifier, capabilities })),
  asOf: time, knownAt: time, hitCount: count, totalHits: count, durationMs: numeric,
  dataAge: nullable(numeric), rateRemaining: nullable(count), complete: yes,
  timeBoundary: oneOf("STRICT"), excluded: object({ future: count, mirrors: count, withdrawn: count }),
});
const recordShape = object({
  evidenceId: identifier, datasetId: identifier, datasetVersion: hash,
  sourceFamily: oneOf("evidence", "cards", "wiki", "graph", "facts", "brain", "stock-price"),
  eventAt: nil, availableAt: time, recordedAt: time, knownAt: time, epistemicType: oneOf("UNKNOWN"),
  excerpt: text(4096), contentHash: hash, exportAllowed: yes, modelUseAllowed: yes,
  license: nil, mirrors: empty, revision: (value) => count(value) && value > 0,
  ownerFocus: object({selected:bool,revision:identifier,updatedAt:time}),
  cardId: identifier, title: nullable(wikiTitle), nodes: empty, path: wikiPath, excerptOnly: yes,
}, ["cardId", "title", "nodes", "path", "excerptOnly", "ownerFocus"]);
const record = (value) => recordShape(value) && (!Object.hasOwn(value,'ownerFocus')||value.sourceFamily==='cards') && (value.sourceFamily === "wiki"
  ? wikiPath(value.path) && value.excerptOnly === true
    && (!Object.hasOwn(value, "title") || wikiTitle(value.title))
    && !["cardId", "nodes"].some((key) => Object.hasOwn(value, key))
  : !["path", "excerptOnly"].some((key) => Object.hasOwn(value, key))
    && (value.sourceFamily === "cards" || !["cardId", "nodes"].some((key) => Object.hasOwn(value, key)))
    && (!Object.hasOwn(value, "title") || value.title === null));
function readWikiRecord(value) {
  if (record(value)) return value.sourceFamily === "wiki";
  if (!value || value.sourceFamily !== "wiki" || value.excerptOnly !== false
    || !wikiTitle(value.title) || !text(32768)(value.publishedText)
    || !value.publishedText.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.publishedText)
    || /(?:password|passwd|token|api[_ -]?key|secret)\s*[:=]\s*\S+/iu.test(value.publishedText)) return false;
  const { publishedText, ...summary } = value;
  return record({ ...summary, excerptOnly: true });
}
function readCardRecord(value) {
  if (!Object.hasOwn(value ?? {}, "publishedCard")) return record(value) && value.sourceFamily === "cards";
  const { publishedCard, ...summary } = value;
  if (summary.sourceFamily !== "cards" || summary.title !== publishedCard?.variableTitle ||
    !record({ ...summary, title: null })) return false;
  try {
    validatePublishedCard(publishedCard, { entityId: value.cardId, revision: value.revision,
      knownAt: value.knownAt, contentHash: value.contentHash });
    return true;
  } catch { return false; }
}
function readDocumentRecord(value, includeDocument) {
  if (!Object.hasOwn(value ?? {}, "publishedDocument")) return record(value);
  if (includeDocument !== true) return false;
  const { publishedDocument, ...summary } = value;
  if (!record(summary)) return false;
  try {
    validatePublishedDocument(publishedDocument, { entityId: summary.evidenceId,
      revision: summary.revision, scope: summary.sourceFamily + "/", contentHash: summary.contentHash,
      datasetId: summary.datasetId, availableAt: summary.availableAt, recordedAt: summary.recordedAt, knownAt: summary.knownAt });
    return true;
  } catch { return false; }
}
const contextFields = {
  ref: text(16), evidenceId: identifier, datasetId: identifier, path: text(256), title: nullable(text(300)),
  revision: (value) => count(value) && value > 0, contentHash: nullable(hash),
  availableAt: time, recordedAt: time, knownAt: time, sourceFamily: text(80), epistemicType: text(80),
  license: nullable(text(160)), exportAllowed: yes,
};
const snippetItem = object({ ...contextFields, snippet: text(4096) });
const wikiItem = object({ ...contextFields, path: wikiPath, title: nullable(wikiTitle), snippet: text(4096) });
const excerptItem = object({ ...contextFields, excerpt: text(4096) });
const stockItemShape=object({...contextFields,title:wikiTitle,contentHash:hash,excerpt:text(4096),sourceFamily:oneOf('stock-price'),publishedDocument:v=>v&&typeof v==='object',stockPrice:v=>v&&typeof v==='object'});
function stockItem(value){
 if(!stockItemShape(value))return false;
 try{
  const doc=validatePublishedDocument(value.publishedDocument,{entityId:value.evidenceId,revision:value.revision,scope:'stock-price/',contentHash:value.contentHash,datasetId:value.datasetId,availableAt:value.availableAt,recordedAt:value.recordedAt,knownAt:value.knownAt});
  return value.title===doc.title&&publishedDocumentHash(value.stockPrice)===publishedDocumentHash(stockPriceContext(doc));
 }catch{return false;}
}

const url = (value) => {
  if (!text(2048)(value)) return false;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
};
const webItem = object({
  ref: text(16), title: nullable(text(300)), url, snippet: text(4096),
  publishedAt: nullable(time), license: nil,
});
const localRef = object({
  sourceType: oneOf("raw", "graph", "facts", "brain"), ref: text(16),
  evidenceId: identifier, datasetId: identifier, path: text(256), title: nullable(text(300)), excerpt: text(4096),
});
const wikiRef = object({
  sourceType: oneOf("wiki"), ref: text(16), evidenceId: identifier, datasetId: identifier,
  path: wikiPath, title: nullable(wikiTitle), excerpt: text(4096),
});
const stockRef=object({sourceType:oneOf('stock-price'),ref:text(16),evidenceId:identifier,datasetId:identifier,path:text(256),title:wikiTitle,excerpt:text(4096),revision:v=>count(v)&&v>0,contentHash:hash,documentContentHash:hash,documentOrigin:object({sourceId:identifier,recordId:identifier,version:text(256),contentHash:hash}),stockPrice:v=>v&&typeof v==='object'});
const webRef = object({
  sourceType: oneOf("web"), ref: text(16), title: nullable(text(300)), url, excerpt: text(4096),
});
const context = object({
  contextId: text(64),
  local: object({
    stockPriceResults:list(stockItem,50),
    wikiResults: list(wikiItem, 50), graphExpansions: list(snippetItem, 50),
    factsResults: list(excerptItem, 50), brainResults: list(excerptItem, 50),
    rawSummary: object({ matches: count, licensedExcerpts: list(snippetItem, 50) }),
    counts: object(Object.fromEntries(
      ["wikiMatches", "rawMatches", "graphMatches", "factsMatches", "brainMatches", "stockPriceMatches"].map((key) => [key, count]),
    ),["stockPriceMatches"]),
  },["stockPriceResults"]),
  web: object({
    status: oneOf("off", "done", "timeout", "paused"), results: list(webItem, 50),
    reason: oneOf("DISABLED", "CLIENT_NOT_CONFIGURED", "CLOCK_ROLLBACK", "HISTORICAL_WEB_UNAVAILABLE",
      "CLIENT_BUSY", "TOKEN_PAUSED", "UPSTREAM_UNAVAILABLE", "RETRY_EXHAUSTED", "INVALID_UPSTREAM",
      "CACHED_WEB_AFTER_ASOF", "TOKEN_WINDOW_BREAKER", "TOKEN_DAY_BREAKER"),
    pauseToken: text(64),
  }, ["reason", "pauseToken"]),
  refs: list((value) => localRef(value) || wikiRef(value) || stockRef(value) || webRef(value)),
  usage: object({ tavilyCreditsToday: count }),
  receipt: object({
    mode: oneOf("context"), asOf: time, sources: list(oneOf("wiki", "raw", "graph", "facts", "brain", "stock-price"), 6),
    maxResults: (value) => count(value) && value >= 1 && value <= 50,
    coverage: oneOf("FILTERED_EDGE_SNAPSHOT"),
  }),
});

function coherent(item, asOf, knownAt = asOf) {
  return before(item.availableAt, asOf) && before(item.recordedAt, knownAt) && before(item.knownAt, knownAt)
    && before(item.availableAt, item.knownAt) && before(item.recordedAt, item.knownAt);
}

export function validateResult(name, value, args) {
  if(args.corpus==='member-library'||args.contextId){
    if(!validMemberLibraryResult(name,value,args))throw providerError('SOURCE_UNAVAILABLE','INVALID_RESPONSE');
    return value;
  }
  let valid = false;
  try {
    if (name === "research_context") {
      valid = context(value);
      if (valid) {
        const { local, web, receipt: meta } = value;
        const families = [
          ["wiki", local.wikiResults], ["raw", local.rawSummary.licensedExcerpts],
          ["graph", local.graphExpansions], ["facts", local.factsResults], ["brain", local.brainResults],
          ["stock-price",local.stockPriceResults??[]],
        ];
        const items = families.flatMap(([, entries]) => entries);
        const expectedRefs = families.flatMap(([sourceType, entries]) => entries.map((item) => ({
          ...(sourceType==="stock-price"?{revision:item.revision,contentHash:item.contentHash,documentOrigin:item.publishedDocument.origin,documentContentHash:item.publishedDocument.contentHash,stockPrice:item.stockPrice}:{}),
          sourceType, ref: item.ref, evidenceId: item.evidenceId, datasetId: item.datasetId,
          path: item.path, title: item.title, excerpt: item.snippet ?? item.excerpt,
        }))).concat(web.results.map((item) => ({
          sourceType: "web", ref: item.ref, title: item.title, url: item.url, excerpt: item.snippet,
        })));
        const stock=meta.sources.includes("stock-price");
        valid = Object.hasOwn(local,"stockPriceResults")===stock && Object.hasOwn(local.counts,"stockPriceMatches")===stock
          && (!stock || local.counts.stockPriceMatches>=local.stockPriceResults.length && Buffer.byteLength(JSON.stringify(value))<=STOCK_CONTEXT_MAX_BYTES)
          && items.length <= (args.maxResults ?? 20)
          && sameSet(meta.sources, args.sources ?? ["wiki", "raw", "graph", "facts", "brain"])
          && families.every(([source, entries]) => meta.sources.includes(source) || entries.length === 0)
          && (!args.asOf || before(meta.asOf, args.asOf))
          && items.every((item) => coherent(item, meta.asOf))
          && web.results.every((item) => item.publishedAt === null || before(item.publishedAt, meta.asOf))
          && ((args.tavily ?? "off") !== "off" || (web.status === "off" && web.results.length === 0))
          && value.refs.length === expectedRefs.length
          && value.refs.every((ref, index) => Object.entries(expectedRefs[index]).every(([key, entry]) => typeof entry==="object"&&entry!==null?publishedDocumentHash(ref[key])===publishedDocumentHash(entry):ref[key] === entry));
      }
    } else {
      const content = name === "research.capabilities" ? { capabilities, excerptOnly: yes }
        : name === "search_evidence" ? { hits: list(record) }
          : name === "timeline" ? { items: list(record) }
            : { item: name === "read_wiki" ? readWikiRecord : name === "read_card" ? readCardRecord : name === "read_evidence" ? (item) => readDocumentRecord(item, args.includeDocument) : record };
      valid = object({ ...content, receipt, nextCursor: text(4096) }, ["nextCursor"])(value);
      if (valid) {
        const meta = value.receipt;
        const items = value.hits ?? value.items ?? (value.item ? [value.item] : []);
        const datasetIds = args.scope?.datasetIds ?? (args.datasetId ? [args.datasetId] : meta.scope.datasetIds);
        valid = meta.scope.datasetIds.every((id) => datasetIds.includes(id))
          && sameSet(meta.scope.datasetIds, meta.datasetVersions.map((entry) => entry.datasetId))
          && sameSet(meta.scope.datasetIds, meta.datasetCapabilities.map((entry) => entry.datasetId))
          && (!args.asOf || before(meta.asOf, args.asOf))
          && (!(args.knownAt ?? args.asOf) || before(meta.knownAt, args.knownAt ?? args.asOf))
          && items.length === meta.hitCount && items.length <= (args.limit ?? 20)
          && items.every((item) => meta.scope.datasetIds.includes(item.datasetId)
            && meta.datasetVersions.some((entry) => entry.datasetId === item.datasetId && entry.version === item.datasetVersion)
            && coherent(item, meta.asOf, meta.knownAt)
            && (!args.id || item.evidenceId === args.id)
            && (name !== "read_wiki" || item.path === args.path)
            && (name !== "read_evidence" || item.sourceFamily === ({raw:'evidence',graph:'graph',facts:'facts',brain:'brain','stock-price':'stock-price'}[args.source??'raw']))
            && (name !== "read_card" || (item.sourceFamily === "cards" && item.cardId === args.id)));
      }
    }
  } catch { valid = false; }
  if (!valid) throw providerError("SOURCE_UNAVAILABLE", "INVALID_RESPONSE");
  return value;
}
