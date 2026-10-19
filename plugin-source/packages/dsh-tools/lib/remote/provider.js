// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { readRemoteConfig, remoteError } from "./config.js";
import { createPinnedTransport } from "./transport.js";
import { projectReadResponse, projectResearchContext, projectResearchStatus } from "./responses.js";
import { readSourceEnvironment } from "./source-settings.js";
import { waitForResponseClock } from "./response-clock.js";
import { encodeWikiPath } from "../../../evidence-provider/src/wiki-route.mjs";

function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !names.includes(key))) throw remoteError("INVALID_REQUEST");
}
function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw remoteError("INVALID_REQUEST");
  return value;
}
function wikiPath(value) {
  const encoded = encodeWikiPath(value);
  if (encoded === null || value === "index") throw remoteError("INVALID_REQUEST");
  return encoded;
}
function query(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!["string", "number"].includes(typeof value) || String(value).length > 1024) throw remoteError("INVALID_REQUEST");
    out.set(key, String(value));
  }
  return out.size ? `?${out}` : "";
}

export function createRemoteProvider({ env = process.env, resolveEnv, ...options } = {}) {
  const initialEnv = { ...env };
  const selectedEnvironment = resolveEnv ?? (() => readSourceEnvironment(initialEnv));
  let key, client;
  function current() {
    const selected = selectedEnvironment();
    const next = JSON.stringify(selected);
    if (key !== next) { client = createFixedProvider({ env: selected, ...options }); key = next; }
    return { client, key };
  }
  return Object.freeze({
    settings: () => current().client.settings(),
    async call(method, params, options) {
      const captured = current();
      const result = await captured.client.call(method, params, options);
      if (current().key !== captured.key) throw remoteError("CANCELLED");
      return result;
    },
    openCards: options => current().client.openCards(options),
  });
}

function createFixedProvider({ env, timeoutMs = 30000, streamIdleTimeoutMs = 45000, maxConcurrent = 4 }) {
  const config = readRemoteConfig(env);
  const transport = createPinnedTransport(config, { timeoutMs, streamIdleTimeoutMs });
  let active = 0;
  const get = (route, params, options) => transport.request("GET", route + query(params), undefined, options);
  const project = async (method, data, params, options) => {
    await waitForResponseClock(data?.receipt, { signal: options?.signal });
    return projectReadResponse(method, data, params);
  };
  const grantedDatasets = async (options) =>
    (await project("datasets", await get("/v1/datasets", {}, options), {}, options)).datasets.map((row) => row.datasetId);
  const methods = new Set(["capabilities", "datasets", "search", "inbox", "casefile", "evidence", "wikiIndex", "wiki", "researchContext", "researchStatus", "changes", "timeline"]);
  return Object.freeze({
    settings: () => config.public,
    async call(method, params = {}, options = {}) {
      if (!methods.has(method)) throw remoteError("METHOD_NOT_ALLOWED");
      if (config.code) throw remoteError(config.code);
      if (active >= Math.min(4, Math.max(1, maxConcurrent))) throw remoteError("CLIENT_BUSY");
      active++;
      try {
        let data;
        if (method === "capabilities" || method === "datasets") {
          fields(params, method === 'datasets' ? ['readSnapshot'] : []);
          if (params.readSnapshot !== undefined && !/^[a-f0-9]{32}$/.test(params.readSnapshot)) throw remoteError('INVALID_REQUEST');
          data = await get(`/v1/${method}`, params, options);
        } else if (method === "researchStatus") {
          fields(params, []);
          return projectResearchStatus(await get("/v1/research/status", {}, options));
        } else if (method === "search") {
          fields(params, ["query", "datasetIds", "asOf", "knownAt", "limit", "cursor"]);
          let datasets = params.datasetIds;
          if (datasets === undefined) datasets = await grantedDatasets(options);
          if (!Array.isArray(datasets) || !datasets.length || datasets.length > 100) throw remoteError("FORBIDDEN_SCOPE");
          const { datasetIds: _ids, ...rest } = params;
          data = await transport.request("POST", "/v1/searches", { ...rest, scope: { datasetIds: datasets.map(id) } }, options);
          return await project(method, data, { ...params, datasetIds: datasets }, options);
        } else if (method === "researchContext") {
          fields(params, ["topic", "sources", "asOf", "maxResults", "tavily", "proof"]);
          if (params.proof !== undefined && typeof params.proof !== "boolean") throw remoteError("INVALID_REQUEST");
          const datasets = await grantedDatasets(options);
          data = await transport.request("POST", "/v1/research/context", params, options);
          await waitForResponseClock(data?.receipt, { signal: options.signal, context: true });
          return projectResearchContext(data, datasets, params);
        } else if (method === "wiki") {
          fields(params, ["path", "datasetId", "asOf", "knownAt"]);
          const { path, ...rest } = params;
          id(rest.datasetId);
          data = await get(`/v1/wiki/${wikiPath(path)}`, rest, options);
        } else {
          fields(params, ["id", "card", "path", "datasetId", "asOf", "knownAt", "limit", "cursor", "version",
            ...(method === "inbox" ? ["include", "readSnapshot"] : []),
            ...(method === "timeline" ? ["variable"] : [])]);
          if (params.include !== undefined && params.include !== "publishedCard") throw remoteError("INVALID_REQUEST");
          if (params.readSnapshot !== undefined && params.readSnapshot !== 'start'
            && !/^[a-f0-9]{32}$/.test(params.readSnapshot)) throw remoteError('INVALID_REQUEST');
          if (method === "timeline" && params.variable !== undefined
            && (typeof params.variable !== "string" || params.variable !== params.variable.trim()
              || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(params.variable))) throw remoteError("INVALID_REQUEST");
          const { id: evidenceId, card, path, ...rest } = params;
          let route;
          if (method === "casefile") route = `/v1/cards/${encodeURIComponent(id(card))}`;
          else if (method === "evidence") route = `/v1/evidence/${encodeURIComponent(id(evidenceId))}`;
          else route = { inbox: "/v1/cards", wikiIndex: "/v1/wiki/index", changes: "/v1/cards/changes", timeline: "/v1/timeline" }[method];
          if (["casefile", "evidence"].includes(method)) id(rest.datasetId);
          data = await get(route, rest, options);
        }
        return await project(method, data, params, options);
      } finally { active--; }
    },
    openCards({ datasetId, lastEventId, signal } = {}) {
      if (lastEventId !== undefined && lastEventId !== null) id(lastEventId);
      return transport.stream("/v1/streams/cards" + query(datasetId ? { datasetId: id(datasetId) } : {}), { lastEventId, signal });
    },
  });
}
