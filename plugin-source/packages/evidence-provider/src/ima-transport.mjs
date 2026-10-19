// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import https from "node:https";
import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { decodeWikiContent } from "./contracts.mjs";
import { providerError } from "./errors.mjs";

const unavailable = (reason) => providerError("SOURCE_UNAVAILABLE", reason);
const MAX_API_BYTES = 524288;
const READ_FIELDS = Object.freeze({
  search_knowledge_base: ["query", "cursor", "limit"],
  get_knowledge_base: ["ids"],
  search_knowledge: ["query", "cursor", "knowledge_base_id"],
  get_knowledge_list: ["cursor", "limit", "knowledge_base_id", "folder_id"],
  get_media_info: ["media_id"],
});
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "application/md", "application/markdown"]);
const COS_DOWNLOAD_HEADERS = Object.freeze(["authorization", "x-cos-security-token", "x-cos-date", "date"]);
const IMA_DOWNLOAD_HEADERS = Object.freeze(["x-ima-create-url-time", "x-ima-platform", "x-ima-resource-category",
  "x-ima-sign", "x-ima-trace-id", "x-ima-uid-sha256"]);
const plain = (value) => value && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (value, max, empty = false) => typeof value === "string"
  && (empty || value.length > 0) && value.length <= max && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/.test(value);

function requestBody(operation, input) {
  try {
    if (typeof operation !== "string" || !Object.hasOwn(READ_FIELDS, operation) || !plain(input)) throw new TypeError();
    const fields = READ_FIELDS[operation];
    if (Object.keys(input).some((key) => !fields.includes(key))
      || fields.some((key) => key !== "folder_id" && !Object.hasOwn(input, key))) throw new TypeError();
    const validated = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "limit") {
        const max = operation === "search_knowledge_base" ? 20 : 50;
        if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError();
      } else if (key === "ids") {
        if (!Array.isArray(value)) throw new TypeError();
        const ids = Array.from(value);
        if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length
          || ids.some((id) => !string(id, 512) || id.trim() !== id)) throw new TypeError();
        validated.ids = ids;
        continue;
      } else if (!string(value, key === "cursor" ? 4096 : key === "query" ? 2048 : 512,
        key === "cursor" || (key === "query" && operation === "search_knowledge_base"))
        || (key !== "cursor" && value.trim() !== value)) throw new TypeError();
      validated[key] = value;
    }
    const body = JSON.stringify(validated);
    if (Buffer.byteLength(body) > 65536) throw new TypeError();
    return body;
  } catch { throw unavailable("IMA_REQUEST_INVALID"); }
}

function downloadPlan(info) {
  let url, imaService;
  try {
    if (!plain(info) || Object.keys(info).some((key) => !["url", "headers"].includes(key))
      || typeof info.url !== "string" || info.url.length > 16384 || /[^\x21-\x7e]|\\/.test(info.url)) throw new TypeError();
    url = new URL(info.url);
    imaService = url.hostname === "skb.ima.myqcloud.com";
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || (!imaService && !/^[a-z0-9][a-z0-9-]*-\d+\.cos\.[a-z0-9]+(?:-[a-z0-9]+)+\.myqcloud\.com$/.test(url.hostname))) {
      throw new TypeError();
    }
  } catch { throw unavailable("IMA_DOWNLOAD_URL_REJECTED"); }
  const headers = {}, allowed = imaService ? IMA_DOWNLOAD_HEADERS : COS_DOWNLOAD_HEADERS;
  try {
    if (info.headers !== undefined && !plain(info.headers)) throw new TypeError();
    for (const [name, value] of Object.entries(info.headers ?? {})) {
      const key = name.toLowerCase();
      if (!allowed.includes(key)
        || Object.hasOwn(headers, key) || typeof value !== "string" || value.length > 8192
        || (!value.length && !(imaService && key === "x-ima-resource-category"))
        || /[^\x20-\x7e]/.test(value)) throw new TypeError();
      headers[key] = value;
    }
    // Service signatures are not interchangeable with COS bucket credentials.
    if (imaService && allowed.some(name => !Object.hasOwn(headers, name))) throw new TypeError();
    if (Buffer.byteLength(JSON.stringify(headers)) > 16384) throw new TypeError();
  } catch { throw unavailable("IMA_DOWNLOAD_HEADERS_REJECTED"); }
  return { url, headers };
}

function publicAddress(row) {
  try {
    if (!plain(row) || ![4, 6].includes(row.family) || typeof row.address !== "string"
      || row.address.includes("%") || isIP(row.address) !== row.family) return false;
    const address = ipaddr.parse(row.address);
    return address.range() === "unicast"
      && (row.family === 4 || address.match(ipaddr.parse("2000::"), 3));
  } catch { return false; }
}

function acceptedType(headers, kind) {
  if (headers["content-encoding"] !== undefined && headers["content-encoding"] !== "identity") return false;
  const value = headers["content-type"];
  if (typeof value !== "string") return false;
  const [type, ...parameters] = value.toLowerCase().split(";").map((part) => part.trim());
  return (kind === "api" ? type === "application/json" : MARKDOWN_TYPES.has(type))
    && parameters.every((part) => /^charset=(?:"utf-8"|utf-8)$/.test(part));
}

function responseError(status) {
  if (status === 401) return providerError("AUTH_REQUIRED", "IMA_HTTP_REJECTED");
  if (status === 403) return providerError("FORBIDDEN_SCOPE", "IMA_HTTP_REJECTED");
  return unavailable(status === 429 ? "IMA_RATE_LIMITED" : "IMA_HTTP_REJECTED");
}

export function createImaTransport({ credentials, budget, lookup = systemLookup, request = https.request } = {}) {
  if (!plain(credentials) || ![credentials.clientId, credentials.apiKey]
    .every((value) => typeof value === "string" && /^[\x21-\x7e]{1,8192}$/.test(value))) {
    throw providerError("AUTH_REQUIRED", "IMA_CREDENTIALS_REQUIRED");
  }
  if (!budget || typeof budget.run !== "function" || !(budget.signal instanceof AbortSignal)
    || !Number.isSafeInteger(budget.limits?.maxFileBytes) || budget.limits.maxFileBytes < 1
    || budget.limits.maxFileBytes > 4194304 || typeof lookup !== "function" || typeof request !== "function") {
    throw unavailable("IMA_TRANSPORT_INVALID");
  }
  const apiHeaders = Object.freeze({
    "ima-openapi-clientid": credentials.clientId, "ima-openapi-apikey": credentials.apiKey,
  });
  const counts = { apiRequests: 0, downloads: 0 };
  async function exchange(kind, url, headers, body, signal, checkpoint) {
    let addresses;
    try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); }
    catch { throw unavailable("IMA_DNS_REJECTED"); }
    if (signal.aborted) throw providerError("CANCELLED");
    checkpoint();
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || !addresses.every(publicAddress)) {
      throw unavailable("IMA_DNS_REJECTED");
    }
    // Prefer IPv4 on dual-stack hosts; an advertised IPv6 address may have no route.
    // Pin one copied, validated address with no second DNS query or HTTP retry.
    const { address, family } = addresses.find(row => row.family === 4) ?? addresses[0];
    const limit = kind === "api" ? MAX_API_BYTES : budget.limits.maxFileBytes;
    return new Promise((resolve, reject) => {
      let req, res, settled = false, dispatched = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (error) {
          res?.destroy();
          req?.destroy();
          reject(error);
        } else resolve(value);
      };
      const cancel = () => finish(providerError("CANCELLED"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      try {
        req = request(url, {
          method: kind === "api" ? "POST" : "GET",
          agent: false, autoSelectFamily: false, family, servername: url.hostname,
          minVersion: "TLSv1.2", rejectUnauthorized: true, maxHeaderSize: 16384, signal,
          lookup(host, options, callback) {
            // Let HTTPS attach its socket error handlers before connecting.
            queueMicrotask(() => {
              if (host !== url.hostname) { callback(new Error("DNS_PIN_REJECTED")); return; }
              if (options?.all) callback(null, [{ address, family }]);
              else callback(null, address, family);
            });
          },
          headers: {
            ...headers, connection: "close", "accept-encoding": "identity",
            accept: kind === "api" ? "application/json" : "text/markdown",
            ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
          },
        }, (response) => {
          res = response;
          res.on("error", () => finish(unavailable("IMA_RESPONSE_INTERRUPTED")));
          res.on("aborted", () => finish(unavailable("IMA_RESPONSE_INTERRUPTED")));
          res.on("close", () => { if (!res.complete) finish(unavailable("IMA_RESPONSE_INTERRUPTED")); });
          if (settled || signal.aborted) { res.destroy(); cancel(); return; }
          if (res.statusCode >= 300 && res.statusCode < 400) {
            finish(unavailable("IMA_REDIRECT_REJECTED")); return;
          }
          if (res.statusCode !== 200) { finish(responseError(res.statusCode)); return; }
          if (!acceptedType(res.headers, kind)) { finish(unavailable("IMA_RESPONSE_TYPE_REJECTED")); return; }
          const lengthHeader = res.headers["content-length"];
          if (lengthHeader !== undefined && (typeof lengthHeader !== "string" || !/^(0|[1-9]\d*)$/.test(lengthHeader)
            || !Number.isSafeInteger(Number(lengthHeader)))) { finish(unavailable("IMA_RESPONSE_LENGTH_INVALID")); return; }
          const expected = lengthHeader === undefined ? null : Number(lengthHeader);
          if (expected !== null && expected > limit) { finish(unavailable("IMA_RESPONSE_TOO_LARGE")); return; }
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            if (settled) return;
            if (!(chunk instanceof Uint8Array)) { finish(unavailable("IMA_RESPONSE_INVALID")); return; }
            size += chunk.byteLength;
            if (size > limit) { finish(unavailable("IMA_RESPONSE_TOO_LARGE")); return; }
            if (expected !== null && size > expected) { finish(unavailable("IMA_RESPONSE_LENGTH_INVALID")); return; }
            chunks.push(Buffer.from(chunk));
          });
          res.on("end", () => {
            if (settled) return;
            if (!res.complete || (expected !== null && size !== expected)) {
              finish(unavailable("IMA_RESPONSE_INTERRUPTED")); return;
            }
            finish(null, Buffer.concat(chunks, size));
          });
        });
        req.on("error", () => finish(signal.aborted
          ? providerError("CANCELLED") : unavailable("IMA_TLS_OR_NETWORK_FAILURE")));
        // Neither the POST body nor its auth headers leave before TLS is verified.
        req.on("socket", (socket) => socket.once("secureConnect", () => {
          if (settled || signal.aborted || dispatched) return;
          try { checkpoint(); } catch (error) { finish(error); return; }
          if (socket.authorized !== true) { finish(unavailable("IMA_TLS_OR_NETWORK_FAILURE")); return; }
          dispatched = true;
          counts[kind === "api" ? "apiRequests" : "downloads"]++;
          try { req.end(body); } catch { finish(unavailable("IMA_TLS_OR_NETWORK_FAILURE")); }
        }));
      } catch { finish(unavailable("IMA_TLS_OR_NETWORK_FAILURE")); }
    });
  }
  return Object.freeze({
    snapshot: () => Object.freeze({ ...counts }),
    async call(operation, input) {
      const body = requestBody(operation, input);
      return budget.run("api", async (signal, checkpoint) => {
        const bytes = await exchange("api", new URL(`https://ima.qq.com/openapi/wiki/v1/${operation}`), apiHeaders, body, signal, checkpoint);
        let envelope;
        try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw unavailable("IMA_RESPONSE_INVALID"); }
        if (!plain(envelope) || !Number.isSafeInteger(envelope.code)) throw unavailable("IMA_RESPONSE_INVALID");
        if (envelope.code !== 0) {
          if (envelope.code === 110030) throw providerError("FORBIDDEN_SCOPE", "IMA_PERMISSION_DENIED");
          if (envelope.code === 110013) throw providerError("CANCELLED", "IMA_REMOTE_CANCELLED");
          throw unavailable(envelope.code === 110021 ? "IMA_RATE_LIMITED" : "IMA_API_REJECTED");
        }
        if (!plain(envelope.data)) throw unavailable("IMA_RESPONSE_INVALID");
        return envelope.data;
      });
    },
    async downloadMarkdown(info) {
      const { url, headers } = downloadPlan(info);
      return budget.run("download", async (signal, checkpoint) => {
        const bytes = await exchange("download", url, headers, undefined, signal, checkpoint);
        const content = decodeWikiContent(bytes);
        if (content.text.includes("\0") || /^\s*<(?:!doctype\s+html|html\b|head\b|body\b|\?xml\b|error\b)/i.test(content.text)) {
          throw unavailable("IMA_DOWNLOAD_CONTENT_REJECTED");
        }
        return content;
      });
    },
  });
}

export { createImaEvidenceProvider, listImaKnowledgeBases } from "./ima-provider.mjs";
export { createImaEvidenceCache } from "./ima-cache.mjs";
