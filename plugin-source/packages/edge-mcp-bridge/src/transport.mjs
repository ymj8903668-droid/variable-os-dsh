// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { DOCUMENT_ENVELOPE_MAX_BYTES } from "../../evidence-provider/src/publication-limits.mjs";
import {MEMBER_LIBRARY_READ_TIMEOUT_MS} from '../../evidence-provider/src/member-library-contract.mjs';
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { EvidenceProviderError, ERROR_CODES, providerError } from "../../evidence-provider/src/errors.mjs";
import { createSourceSettings, readSourceEnvironment } from "../../dsh-tools/lib/remote/source-settings.js";
import { readRemoteConfig } from "../../dsh-tools/lib/remote/config.js";

const unavailable = (reason) => providerError("SOURCE_UNAVAILABLE", reason);
const MAX_RESPONSE = 524288;
const MAX_REQUEST = 65536;
const HANDSHAKE_DEADLINE_MS = 5000;
const REQUEST_DEADLINE_MS = 30000;

function configuration(env, selection) {
  const selected = selection?.env ?? readSourceEnvironment(env);
  const fromProfile = selection ? selection.fromProfile : selected !== env;
  env = selected;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.VARIABLE_OS_EDGE_TOKEN ?? "")) {
    throw providerError("AUTH_REQUIRED", "TOKEN_REQUIRED");
  }
  const url = new URL(env.VARIABLE_OS_EDGE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash) throw unavailable("INVALID_CONFIGURATION");
  const spki = env.VARIABLE_OS_EDGE_SPKI;
  if (typeof spki !== "string" || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(spki)) {
    throw unavailable("INVALID_CONFIGURATION");
  }
  const caPath = env.VARIABLE_OS_EDGE_CA_FILE;
  if (fromProfile || env.VARIABLE_OS_EDGE_CA_PEM) {
    const config = readRemoteConfig(env);
    if (config.code) throw unavailable("INVALID_CONFIGURATION");
    return { origin: url.origin, token: config.token, ca: config.ca, spki };
  }
  // Omitted CA uses the runtime trust store; an explicitly invalid file still fails closed.
  if (caPath === undefined) return { origin: url.origin, token: env.VARIABLE_OS_EDGE_TOKEN, spki };
  if (typeof caPath !== "string" || !isAbsolute(caPath)) throw unavailable("INVALID_CONFIGURATION");
  const fd = openSync(caPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let ca;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw unavailable("INVALID_CONFIGURATION");
    ca = Buffer.alloc(stat.size);
    if (readSync(fd, ca, 0, ca.length, 0) !== ca.length) throw unavailable("INVALID_CONFIGURATION");
    new X509Certificate(ca);
  } finally { closeSync(fd); }
  return { origin: url.origin, token: env.VARIABLE_OS_EDGE_TOKEN, ca, spki };
}

export function createTransport(env) {
  env = { ...env };
  return async function request(plan, signal) {
    if (signal?.aborted) throw providerError("CANCELLED", "REQUEST_CANCELLED");
    let config, sources, revision;
    const changed = () => providerError("CANCELLED", "SOURCE_CHANGED");
    const current = () => {
      try { return sources.revision() === revision; } catch { return false; }
    };
    try {
      sources = createSourceSettings({ env });
      const selection = sources.capture();
      revision = selection.revision;
      config = configuration(env, selection);
    } catch (error) {
      throw error instanceof EvidenceProviderError ? error : unavailable("INVALID_CONFIGURATION");
    }
    const body = plan.body === undefined ? undefined : JSON.stringify(plan.body);
    const target = new URL(plan.path, config.origin);
    const deadline=target.pathname.startsWith('/v1/research/library/')?MEMBER_LIBRARY_READ_TIMEOUT_MS:REQUEST_DEADLINE_MS;
    const responseLimit = plan.method === "GET" && ((/^\/v1\/(evidence|graph|facts|brain)\/[^/]+$/.test(target.pathname)
      && target.searchParams.get("include") === "publishedDocument") || /^\/v1\/research\/library\/contexts\/[a-f0-9-]+\/(read_wiki|read_evidence)\/[A-Z]{1,3}[1-9][0-9]{0,2}$/.test(target.pathname)) ? DOCUMENT_ENVELOPE_MAX_BYTES : MAX_RESPONSE;
    if (body && Buffer.byteLength(body) > MAX_REQUEST) throw unavailable("REQUEST_TOO_LARGE");
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const startedAt = performance.now();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!current()) reject(changed());
        else if (error) reject(error); else resolve(value);
      };
      const req = https.request(new URL(plan.path, config.origin), {
        method: plan.method, agent: false, signal, minVersion: "TLSv1.3",
        rejectUnauthorized: true, ca: config.ca, maxHeaderSize: 16384,
        checkServerIdentity(host, cert) {
          const error = checkServerIdentity(host, cert);
          if (error) return error;
          try {
            const key = new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" });
            const actual = createHash("sha256").update(key).digest();
            if (timingSafeEqual(actual, Buffer.from(config.spki.slice(7), "base64"))) return undefined;
          } catch { /* A missing or malformed public key cannot authorize a connection. */ }
          return new Error("TLS_IDENTITY_REJECTED");
        },
        headers: {
          "x-variable-os-owner-focus": "1",
          authorization: `Bearer ${config.token}`, accept: "application/json", connection: "close",
          ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          finish(unavailable("REDIRECT_REJECTED"));
          res.destroy();
          return;
        }
        if (res.headers["content-type"]?.split(";")[0].trim() !== "application/json"
          || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
          finish(unavailable("INVALID_RESPONSE"));
          res.destroy();
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > responseLimit) {
            finish(unavailable("RESPONSE_TOO_LARGE"));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on("error", () => finish(unavailable("RESPONSE_INTERRUPTED")));
        res.on("aborted", () => finish(unavailable("RESPONSE_INTERRUPTED")));
        res.on("end", () => {
          if (settled) return;
          try {
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            if (res.statusCode !== 200) {
              const code = ERROR_CODES.includes(value?.error?.code) ? value.error.code
                : ({ 401: "AUTH_REQUIRED", 403: "FORBIDDEN_SCOPE", 404: "NO_RESULT" }[res.statusCode] ?? "SOURCE_UNAVAILABLE");
              const error = providerError(code, "EDGE_REJECTED");
              const retry = res.headers["retry-after"];
              if (/^[1-9]\d{0,4}$/.test(retry ?? "") && Number(retry) <= 86400) {
                error.details.retryAfterSeconds = Number(retry);
              }
              finish(error);
            } else if (!value || typeof value !== "object" || Array.isArray(value) || value.error) {
              finish(unavailable("INVALID_RESPONSE"));
            } else finish(null, value);
          } catch { finish(unavailable("INVALID_RESPONSE")); }
        });
      });
      const expire = () => { finish(unavailable("REQUEST_TIMEOUT")); req.destroy(); };
      timer = setTimeout(expire, HANDSHAKE_DEADLINE_MS);
      req.on("error", () => finish(signal?.aborted
        ? providerError("CANCELLED", "REQUEST_CANCELLED") : unavailable("TLS_OR_NETWORK_FAILURE")));
      // No application bytes are flushed until TLS chain, SAN, pin and version pass.
      req.on("socket", (socket) => socket.once("secureConnect", () => {
        if (!current()) { finish(changed()); req.destroy(); }
        else {
          // Keep the TLS handshake bounded, then allow the same 30-second
          // total read budget as the plugin. Bytes never extend this deadline.
          clearTimeout(timer);
          timer = setTimeout(expire, Math.max(0, deadline - (performance.now() - startedAt)));
          req.end(body);
        }
      }));
    });
  };
}
