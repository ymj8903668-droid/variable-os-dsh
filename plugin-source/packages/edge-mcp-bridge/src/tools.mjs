// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { compareRfc3339 } from "../../storage-contracts/src/time.mjs";
import { encodeWikiPath } from "../../evidence-provider/src/wiki-route.mjs";
import {memberContextId,memberCitation} from '../../evidence-provider/src/member-library-contract.mjs';

const string = (minLength, maxLength, extra = {}) => ({ type: "string", minLength, maxLength, ...extra });
const id = string(1, 128, { pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" });
const time = string(1, 64, { format: "date-time" });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, minItems, maxItems) => ({ type: "array", items, minItems, maxItems, uniqueItems: true });
const boundary = { asOf: time, knownAt: time };
const page = { ...boundary, limit: integer(1, 100), cursor: string(1, 4096) };
const sources = { type: "string", enum: ["wiki", "raw", "graph", "facts", "brain", "stock-price"] };
const libraryRef = {contextId:string(36,36),ref:string(2,6)};
const definitions = [
  ["research.capabilities", "Read edge research capabilities.", object({})],
  ["search_evidence", "Search authorized evidence excerpts and citation IDs.", object({
    query: string(1, 2048), scope: object({ datasetIds: array(id, 1, 100) }, ["datasetIds"]), ...page,
  }, ["query", "scope"])],
  ["read_evidence", "Read a published record by datasetId and id, optionally includeDocument. Or read a member-library full source using only contextId and ref returned by research_context; requires current research entitlement.", object({
    ...libraryRef,
    id, datasetId: id, source: { type: "string", enum: ["raw", "graph", "facts", "brain", "stock-price"] },
    includeDocument: { type: "boolean", default: false }, ...boundary, version: string(1, 256),
  })],
  ["read_card", "Read an acknowledged public card by dataset and ID.", object({
    id, datasetId: id, ...boundary, version: string(1, 256),
  }, ["id", "datasetId"])],
  ["timeline", "Read the publication timeline, optionally filtered by an exact stored variable ID.", object({
    datasetId: id, variable: id, ...page,
  })],
  ["research_context", "Read context without synthesis; web is off by default. corpus=member-library explicitly reads the website's original six-source engine for entitled members, with expiring contextId/ref handles for full source reads; it never calls models or web and does not support asOf. Default published corpus retains the existing publication snapshot contract.", object({
    corpus:{type:'string',enum:['published','member-library']},
    topic: string(2, 200), sources: array(sources, 1, 6), asOf: time, maxResults: integer(1, 50),
    tavily: { type: "string", enum: ["off", "edge"], default: "off" },
  }, ["topic"])],
  ["read_wiki", "Read published Wiki text by path and datasetId. Or read member-library Wiki full text using only contextId and ref returned by research_context; current research entitlement is required.", object({
    ...libraryRef,
    path: string(1, 1024), datasetId: id, ...boundary,
  })],
];

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const TOOLS = freeze(definitions.map(([name, description, inputSchema]) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
})));

// Only the schema keywords emitted by this fixed read-only registry are supported.
export function valid(schema, value) {
  if (schema.type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value))
      && schema.required.every((key) => Object.hasOwn(value, key))
      && Object.keys(value).every((key) => Object.hasOwn(schema.properties, key)
        && valid(schema.properties[key], value[key]));
  }
  if (schema.type === "array") {
    return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems
      && new Set(value).size === value.length && value.every((item) => valid(schema.items, item));
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isSafeInteger(value)
    && value >= schema.minimum && value <= schema.maximum;
  if (schema.type !== "string" || typeof value !== "string") return false;
  if (schema.enum) return schema.enum.includes(value);
  const length = [...value].length;
  if (!value.trim() || length < schema.minLength || length > schema.maxLength
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value) > schema.maxLength * 4) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.format === "date-time") {
    try { compareRfc3339(value, value); } catch { return false; }
  }
  return true;
}

export function planTool(name, input) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool || !valid(tool.inputSchema, input)) return null;
  const args = structuredClone(input);
  if(['read_evidence','read_wiki'].includes(name)){
    if(Object.hasOwn(args,'contextId')||Object.hasOwn(args,'ref')){
      if(Object.keys(args).length!==2||!memberContextId(args.contextId)||!memberCitation(args.ref))return null;
      return {method:'GET',path:`/v1/research/library/contexts/${args.contextId}/${name}/${args.ref}`};
    }
    if(!args.datasetId||!(name==='read_wiki'?args.path:args.id))return null;
  }
  if (name === "search_evidence") return { method: "POST", path: "/v1/searches", body: args };
  if (name === "read_evidence") {
    const { source = "raw", id: entityId, includeDocument = false, ...query } = args;
    const family = { raw: "evidence", graph: "graph", facts: "facts", brain: "brain", "stock-price": "stock-price" }[source];
    if (includeDocument) query.include = "publishedDocument";
    return { method: "GET", path: `/v1/${family}/${encodeURIComponent(entityId)}?${new URLSearchParams(query)}` };
  }
  if (name === "research_context") {
    const {corpus,...body}=args;
    if(corpus==='member-library'){
      if(args.asOf||(args.tavily??'off')!=='off')return null;
      return {method:'POST',path:'/v1/research/library/context',body:{tavily:'off',...body}};
    }
    return { method: "POST", path: "/v1/research/context", body: { tavily: "off", ...body } };
  }
  if (name === "read_wiki") {
    const { path, ...query } = args;
    const encoded = encodeWikiPath(path);
    if (encoded === null || path === "index") return null;
    const route = `/v1/wiki/${encoded}`;
    return { method: "GET", path: `${route}?${new URLSearchParams(query)}` };
  }
  const route = {
    "research.capabilities": "/v1/capabilities", timeline: "/v1/timeline",
    read_evidence: "/v1/evidence/", read_card: "/v1/cards/",
  }[name];
  const { id: entityId, ...query } = args;
  const path = route + (entityId ? encodeURIComponent(entityId) : "");
  const parameters = new URLSearchParams(query).toString();
  return { method: "GET", path: path + (parameters ? `?${parameters}` : "") };
}
