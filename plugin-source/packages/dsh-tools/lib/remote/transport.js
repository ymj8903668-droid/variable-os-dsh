// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { createHash, X509Certificate, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { remoteError, safeError } from "./config.js";
import { cardSnapshotResponseBytes } from './snapshot-limits.js';

const MAX_BYTES = 1024 * 1024;
const fingerprint = (raw) => `sha256/${createHash("sha256").update(
  new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" }),
).digest("base64")}`;

export function createPinnedTransport(config, { timeoutMs = 30000, streamIdleTimeoutMs = 45000 } = {}) {
  // A bounded pool belongs to this exact immutable source configuration. Never
  // share it with another source/pin/token; SSE retains its dedicated socket.
  const verify = (host, cert) => {
    if (checkServerIdentity(host, cert)) return remoteError('TLS_REJECTED');
    try {
      if (!timingSafeEqual(Buffer.from(fingerprint(cert.raw)), Buffer.from(config.pin))) throw Error();
    } catch { return remoteError('SPKI_MISMATCH'); }
  };
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxTotalSockets: 4,
    maxFreeSockets: 1, timeout: 15000, maxCachedSessions: 0, checkServerIdentity: verify });
  const resetReads = new WeakSet();
  function open(method, route, body, { signal, lastEventId, stream = false } = {}) {
    if (config.code) return Promise.reject(remoteError(config.code));
    if (signal?.aborted) return Promise.reject(remoteError("CANCELLED"));
    if (!route.startsWith("/v1/") || route.startsWith("//") || /[\r\n\\]/.test(route)) {
      return Promise.reject(remoteError("INVALID_REQUEST"));
    }
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 65536) return Promise.reject(remoteError("INVALID_REQUEST"));
    return new Promise((resolve, reject) => {
      let refusal = null;
      let response;
      const req = https.request(new URL(route, config.url), {
        method, agent: stream ? false : agent, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
        ca: config.ca, servername: config.servername, rejectUnauthorized: true,
        checkServerIdentity: verify,
        headers: { "x-variable-os-owner-focus": "1", accept: stream ? "text/event-stream" : "application/json" },
      });
      const fail = (code) => {
        refusal = code;
        req.destroy(remoteError(code));
        response?.destroy(remoteError(code));
      };
      const timer = setTimeout(() => fail("EDGE_TIMEOUT"), timeoutMs);
      const abort = () => fail("CANCELLED");
      signal?.addEventListener("abort", abort, { once: true });
      req.once("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
      req.on("error", (error) => {
        const safe = remoteError(refusal || (["TLS_REJECTED","SPKI_MISMATCH"].includes(error.code) ? error.code
          : /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || "") ? "TLS_REJECTED" : "SOURCE_UNAVAILABLE"));
        if (!refusal && !response && !stream && method === 'GET' && error.code === 'ECONNRESET') resetReads.add(safe);
        reject(safe);
      });
      // Do not even attach credentials until the authenticated TLS socket is ready.
      req.once("socket", (socket) => {
       const send = () => {
        if (req.destroyed || signal?.aborted) return fail('CANCELLED');
        if (!socket.authorized || socket.getProtocol() !== "TLSv1.3") return fail("TLS_REJECTED");
        const error = verify(config.url.hostname, socket.getPeerCertificate());
        if (error) return fail(error.code);
        req.setHeader("authorization", `Bearer ${config.token}`);
        if (lastEventId) req.setHeader("last-event-id", lastEventId);
        if (encoded) {
          req.setHeader("content-type", "application/json");
          req.setHeader("content-length", Buffer.byteLength(encoded));
        }
        req.end(encoded);
       };
       // Reused sockets do not emit secureConnect again. Recheck the actual
       // peer certificate/protocol before attaching credentials on every read.
       if (req.reusedSocket) send(); else socket.once('secureConnect', send);
      });
      req.once("response", (res) => {
        response = res;
        if (stream && res.statusCode === 200 && String(res.headers["content-type"]).startsWith("text/event-stream")) {
          clearTimeout(timer);
          const socket = res.socket;
          const idle = () => {
            // A snapshot verifier may intentionally pause the SSE reader.
            // Buffered events prove receipt; do not mistake its backpressure
            // for an idle network. Once drained, the same deadline applies.
            if (res.readableLength > 0) socket.setTimeout(streamIdleTimeoutMs);
            else fail("EDGE_TIMEOUT");
          };
          socket.on("timeout", idle);
          socket.setTimeout(streamIdleTimeoutMs);
          res.once("close", () => { socket.setTimeout(0); socket.removeListener("timeout", idle); });
        }
        resolve(res);
      });
    });
  }

  async function decode(res, maxBytes = MAX_BYTES) {
    let text = "";
    let size = 0;
    const decoder = new StringDecoder("utf8");
    try {
      for await (const chunk of res) {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); throw remoteError("RESPONSE_INVALID"); }
        text += decoder.write(chunk);
      }
      text += decoder.end();
    } catch (error) { throw remoteError(safeError(error).code); }
    if (res.statusCode >= 300 && res.statusCode < 400) throw remoteError("REDIRECT_REFUSED");
    let data;
    try { data = JSON.parse(text); } catch { throw remoteError("RESPONSE_INVALID"); }
    if (res.statusCode !== 200) {
      const code = safeError(data?.error).code;
      const retry = Number(res.headers["retry-after"]);
      throw remoteError(code, Number.isFinite(retry) && retry >= 0 && retry <= 3600 ? { retryAfter: retry } : {});
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw remoteError("RESPONSE_INVALID");
    return data;
  }
  return {
    request: async (method, route, body, options) => {
      let response;
      try { response = await open(method, route, body, options); }
      catch (error) {
        // A connection may reset before a read receives any headers. Retry
        // that same GET once; never replay POSTs or partial response bodies.
        if (!resetReads.has(error)) throw error;
        response = await open(method, route, body, options);
      }
      return decode(response, response.statusCode === 200 ? cardSnapshotResponseBytes(method, route) : MAX_BYTES);
    },
    async stream(route, options) {
      const res = await open("GET", route, undefined, { ...options, stream: true });
      if (res.statusCode !== 200) { await decode(res); throw remoteError("RESPONSE_INVALID"); }
      if (!String(res.headers["content-type"]).startsWith("text/event-stream")) {
        res.destroy(); throw remoteError("RESPONSE_INVALID");
      }
      return res;
    },
  };
}
