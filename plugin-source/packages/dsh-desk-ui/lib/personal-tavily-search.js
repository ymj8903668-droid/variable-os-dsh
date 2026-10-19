// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import https from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail("WEB_SEARCH_RESPONSE_INVALID");
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const text = value => typeof value === "string" && value.isWellFormed() && !controls.test(value);
const excerptText = value => typeof value === "string" && value.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
const plain = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fields(value, allowed) {
  try {
    if (!plain(value)) throw Error();
    const descriptors = Object.getOwnPropertyDescriptors(value), out = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (!allowed.includes(key) || !Object.hasOwn(descriptors[key], "value")) throw Error();
      out[key] = descriptors[key].value;
    }
    return out;
  } catch { fail("INVALID_REQUEST"); }
}

function observation(now) {
  try {
    const sampled = now();
    if (typeof sampled !== "number" || !Number.isFinite(sampled)) throw Error();
    const observedAt = new Date(sampled).toISOString();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observedAt)) throw Error();
    return { observedAt, historicalAvailability: "UNKNOWN", revalidated: false };
  } catch { fail("WEB_SEARCH_FAILED"); }
}

function boundedText(value, limit, validate = text) {
  if (!validate(value)) invalid();
  const bounded = value.slice(0, limit);
  return bounded.isWellFormed() ? bounded : bounded.slice(0, -1);
}

function resultUrl(value, apiKey) {
  if (!text(value) || !value.length || value.length > 2048 || value.trim() !== value
    || value.includes("\\") || !/^https?:\/\//i.test(value)) invalid();
  try {
    const decoded = decodeURIComponent(value);
    if (!text(decoded) || decoded.includes(apiKey)) invalid();
    const url = new URL(value), host = url.hostname.replace(/\.$/, "");
    // Results are references, never fetched here. Until a shared classifier
    // is exported, conservatively refuse all IP literals rather than guess ranges.
    if (url.username || url.password || isIP(host.replace(/^\[|\]$/g, ""))
      || host.length > 253 || !host.includes(".")
      || host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      || /(?:^|\.)(?:localhost|local|internal|lan|home|arpa|onion|invalid|test)$/.test(host)
      || [...url.searchParams.keys()].some(key => /key|token|secret|signature|credential|password/i.test(key))) invalid();
    url.hash = "";
    return url.href;
  } catch { invalid(); }
}

function project(bytes, apiKey, maxResults) {
  let value;
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (body.includes(apiKey)) invalid();
    value = JSON.parse(body);
  } catch { invalid(); }
  // Check discarded fields too: JSON escapes must not hide an echoed credential.
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === "string") {
      if (!excerptText(entry) || entry.includes(apiKey)) invalid();
    } else if (entry && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) pending.push(key, child);
    }
  }
  if (!plain(value) || !Array.isArray(value.results) || value.results.length > maxResults) invalid();
  return value.results.map((item, index) => {
    if (!plain(item)) invalid();
    return {
      ref: `T${index + 1}`,
      title: item.title === undefined || item.title === null ? null : boundedText(item.title, 300),
      url: resultUrl(item.url, apiKey),
      snippet: boundedText(item.content, 2000, excerptText),
      publishedAt: null,
      license: null,
    };
  });
}

function responseLength(headers, maxBytes) {
  const type = headers["content-type"], encoding = headers["content-encoding"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?\s*$/i.test(type)
    || encoding !== undefined && encoding !== "identity") invalid();
  const raw = headers["content-length"];
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)
    || !Number.isSafeInteger(Number(raw)) || Number(raw) > maxBytes) invalid();
  return Number(raw);
}

export function createPersonalTavilySearch(options = {}) {
  const { requestImpl = https.request, now = Date.now, timeoutMs = 15000, maxBytes = 262144 } =
    fields(options, ["requestImpl", "now", "timeoutMs", "maxBytes"]);
  if (typeof requestImpl !== "function" || typeof now !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) fail("INVALID_REQUEST");

  return async function search(input, options = {}) {
    const { signal, assertCurrent } = fields(options, ["signal", "assertCurrent"]);
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail("INVALID_REQUEST");
    if (assertCurrent !== undefined && typeof assertCurrent !== "function") fail("INVALID_REQUEST");
    if (signal?.aborted) fail("CANCELLED");
    const { query, apiKey, maxResults = 5 } = fields(input, ["query", "apiKey", "maxResults"]);
    if (apiKey === undefined || apiKey === null || apiKey === "") fail("AUTH_REQUIRED");
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)
      || !text(query) || !query.trim() || query.length > 2048 || query.includes(apiKey)
      || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 5) fail("INVALID_REQUEST");
    observation(now);
    if (signal?.aborted) fail("CANCELLED");
    const body = JSON.stringify({
      query, search_depth: "basic", auto_parameters: false, include_answer: false,
      include_raw_content: false, include_images: false, topic: "general", max_results: maxResults, include_usage: false,
    });
    const started = performance.now();
    const value = await new Promise((resolve, reject) => {
      let req, res, settled = false, sent = false;
      const destroy = target => { try { target?.destroy(); } catch { /* Never expose wire errors. */ } };
      const interruption = () => signal?.aborted ? "CANCELLED"
        : performance.now() - started >= timeoutMs ? "WEB_SEARCH_TIMEOUT" : null;
      const finish = (code, result) => {
        if (settled) return;
        code = interruption() || code;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (code) {
          destroy(res);
          destroy(req);
          reject(Object.assign(new Error(code), { code }));
        } else resolve(result);
      };
      const cancel = () => finish("CANCELLED");
      const timer = setTimeout(() => finish("WEB_SEARCH_TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      const onResponse = response => {
        if (settled) {
          response.on("error", () => {});
          destroy(response);
          return;
        }
        res = response;
        res.on("error", () => finish("WEB_SEARCH_FAILED"));
        res.on("aborted", () => finish("WEB_SEARCH_FAILED"));
        res.on("close", () => { if (!settled) finish("WEB_SEARCH_FAILED"); });
        if (interruption()) { finish(interruption()); return; }
        if (!sent) { finish("WEB_SEARCH_FAILED"); return; }
        if (res.statusCode !== 200) {
          finish([401, 403].includes(res.statusCode) ? "AUTH_REQUIRED" : "WEB_SEARCH_FAILED");
          return;
        }
        let expected;
        try { expected = responseLength(res.headers, maxBytes); }
        catch { finish("WEB_SEARCH_RESPONSE_INVALID"); return; }
        const chunks = [];
        let size = 0;
        res.on("data", chunk => {
          if (settled) return;
          if (interruption()) { finish(interruption()); return; }
          if (!(chunk instanceof Uint8Array)) { finish("WEB_SEARCH_RESPONSE_INVALID"); return; }
          size += chunk.byteLength;
          if (size > maxBytes || expected !== null && size > expected) {
            finish("WEB_SEARCH_RESPONSE_INVALID"); return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          if (settled) return;
          if (!res.complete || expected !== null && size !== expected) {
            finish("WEB_SEARCH_RESPONSE_INVALID"); return;
          }
          let results;
          try { results = project(Buffer.concat(chunks, size), apiKey, maxResults); }
          catch { finish("WEB_SEARCH_RESPONSE_INVALID"); return; }
          let metadata;
          try { metadata = observation(now); }
          catch { finish("WEB_SEARCH_FAILED"); return; }
          finish(null, { status: "done", results, observation: metadata });
        });
      };
      try {
        req = requestImpl(new URL("https://api.tavily.com/search"), {
          method: "POST", agent: false, rejectUnauthorized: true,
          servername: "api.tavily.com", minVersion: "TLSv1.2", maxHeaderSize: 16384,
          headers: {
            accept: "application/json", "accept-encoding": "identity", connection: "close",
            "content-type": "application/json", "content-length": Buffer.byteLength(body),
          },
        }, onResponse);
        req.on("error", () => finish("WEB_SEARCH_FAILED"));
        req.on("close", () => { if (!res) finish("WEB_SEARCH_FAILED"); });
        if (settled) { destroy(req); return; }
        req.once("socket", socket => socket.once("secureConnect", () => {
          if (settled) return;
          if (interruption()) { finish(interruption()); return; }
          if (socket.authorized !== true) { finish("WEB_SEARCH_FAILED"); return; }
          try { assertCurrent?.(); }
          catch { finish("SOURCE_CHANGED"); return; }
          if (interruption()) { finish(interruption()); return; }
          try {
            req.setHeader("authorization", `Bearer ${apiKey}`);
            sent = true;
            req.end(body);
          } catch { finish("WEB_SEARCH_FAILED"); }
        }));
      } catch { finish("WEB_SEARCH_FAILED"); }
    });
    if (signal?.aborted) fail("CANCELLED");
    return value;
  };
}
