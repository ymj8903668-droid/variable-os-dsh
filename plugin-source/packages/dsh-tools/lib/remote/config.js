// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";

export const isRemoteMode = () => Boolean(process.env.VARIABLE_OS_PROVIDER && process.env.VARIABLE_OS_PROVIDER !== "local");
export const remoteError = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
export const safeError = (error) => ({
  code: SAFE_CODES.has(error?.code) ? error.code : "SOURCE_UNAVAILABLE",
  ...(Number.isFinite(error?.retryAfter) ? { retryAfter: error.retryAfter } : {}),
});
const SAFE_CODES = new Set([
  "EDGE_URL_REQUIRED", "EDGE_URL_INVALID", "EDGE_PIN_REQUIRED", "EDGE_PIN_INVALID", "EDGE_CA_INVALID",
  "PROVIDER_INVALID", "AUTH_REQUIRED", "FORBIDDEN_SCOPE", "SOURCE_UNAVAILABLE", "NO_RESULT",
  "TIME_BOUNDARY", "CANCELLED", "WORKER_OFFLINE", "WORKER_BUSY", "RATE_LIMITED", "CLIENT_BUSY",
  "SPKI_MISMATCH", "TLS_REJECTED", "REDIRECT_REFUSED", "EDGE_TIMEOUT", "RESPONSE_INVALID",
  "METHOD_NOT_ALLOWED", "INVALID_REQUEST", "RESYNC_REQUIRED", "CSRF_INVALID", "DEEP_RESEARCH_TIMEOUT",
  "DEEP_RESEARCH_OUTPUT_INVALID", "DEEP_RESEARCH_CONTRACT_INVALID", "DEEP_RESEARCH_ABORTED",
  "SOURCE_CONFIG_INVALID", "SOURCE_CONFIG_WRITE_FAILED",
  "WIKI_PROFILE_INVALID", "WIKI_PROFILE_WRITE_FAILED", "WIKI_SOURCE_CHANGED",
  "MODEL_CONSENT_REQUIRED", "MODEL_SELECTION_REQUIRED", "SOURCE_CHANGED",
  "PUBLISHED_CARD_REQUIRED",
]);

export function readRemoteConfig(env) {
  let code = null;
  let url;
  let ca;
  if (env.VARIABLE_OS_PROVIDER && env.VARIABLE_OS_PROVIDER !== "remote") code = "PROVIDER_INVALID";
  else if (!env.VARIABLE_OS_EDGE_URL) code = "EDGE_URL_REQUIRED";
  else {
    try {
      url = new URL(env.VARIABLE_OS_EDGE_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          url.pathname !== "/" || !url.hostname) throw Error();
    } catch { code = "EDGE_URL_INVALID"; }
  }
  const token = env.VARIABLE_OS_EDGE_TOKEN;
  const pin = env.VARIABLE_OS_EDGE_SPKI;
  if (!code && (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token))) code = "AUTH_REQUIRED";
  if (!code && !pin) code = "EDGE_PIN_REQUIRED";
  if (!code && !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin)) code = "EDGE_PIN_INVALID";
  if (!code && env.VARIABLE_OS_EDGE_CA_PEM) {
    try {
      if (env.VARIABLE_OS_EDGE_CA_FILE || typeof env.VARIABLE_OS_EDGE_CA_PEM !== "string") throw Error();
      const pem = env.VARIABLE_OS_EDGE_CA_PEM;
      if (Buffer.byteLength(pem) > 65536 ||
          !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) throw Error();
      ca = Buffer.from(new X509Certificate(pem).toString());
    } catch { code = "EDGE_CA_INVALID"; }
  } else if (!code && env.VARIABLE_OS_EDGE_CA_FILE) {
    try {
      ca = readFileSync(env.VARIABLE_OS_EDGE_CA_FILE);
      if (ca.length > 65536 || !ca.toString().includes("-----BEGIN CERTIFICATE-----")) throw Error();
    } catch { code = "EDGE_CA_INVALID"; }
  }
  return {
    code, url, token, pin, ca,
    servername: url && !isIP(url.hostname) ? url.hostname : undefined,
    public: Object.freeze({
      provider: "remote", code: code || "CONFIGURED", ready: !code,
      tls: "TLSv1.3", trust: ca ? "EXPLICIT_CA" : "SYSTEM_CA",
      urlConfigured: Boolean(env.VARIABLE_OS_EDGE_URL), tokenConfigured: Boolean(token), pinConfigured: Boolean(pin),
    }),
  };
}
