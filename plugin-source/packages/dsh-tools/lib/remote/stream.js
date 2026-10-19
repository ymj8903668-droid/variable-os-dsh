// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import timers from "node:timers/promises";
import { remoteError, safeError } from "./config.js";
import { projectCardEvent } from "./responses.js";

const EVENTS = new Set(["card.committed", "card.revised", "card.withdrawn", "evidence.withdrawn"]);
const TRANSIENT = new Set(["SOURCE_UNAVAILABLE", "EDGE_TIMEOUT"]);
const MAX_BACKOFF_MS = 30000;

export function subscribeCards(provider, {
  datasetId, lastEventId = null, onEvent, onEvents, onState = () => {}, signal,
  maxReconnects = 3, reconnectDelayMs = 1000, continuous = false,
} = {}) {
  if (onEvents !== undefined && typeof onEvents !== "function") throw remoteError("INVALID_REQUEST");
  if (typeof continuous !== "boolean" || continuous && (!Number.isSafeInteger(reconnectDelayMs)
    || reconnectDelayMs < 1 || reconnectDelayMs > MAX_BACKOFF_MS)) throw remoteError("INVALID_REQUEST");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cursor = lastEventId;
  const seen = new Set(cursor ? [cursor] : []);
  const done = (async () => {
    let shortFailures = 0;
    for (let attempt = 0; (continuous || attempt <= Math.min(10, maxReconnects)) && !combined.aborted; attempt++) {
      let res, connectedAt, waitMs = reconnectDelayMs;
      try {
        res = await provider.openCards({ datasetId, lastEventId: cursor, signal: combined });
        if (combined.aborted) return;
        await onState({ code: "CONNECTED" });
        connectedAt = performance.now();
        let pending = "";
        let batch = [];
        const queued = new Set();
        const apply = async () => {
          if (!batch.length) return;
          const ids = batch.map(event => event.id);
          if (onEvents) await onEvents(Object.freeze(batch.map(event => Object.freeze(event))));
          else await onEvent(batch[0]);
          if (combined.aborted) throw remoteError("CANCELLED");
          // A batch is an acknowledgement of one fully applied live snapshot.
          // Keep every member unacknowledged when that application fails.
          for (const id of ids) {
            cursor = id;
            seen.add(id);
            if (seen.size > 256) seen.delete(seen.values().next().value);
          }
          batch = []; queued.clear();
        };
        res.setEncoding("utf8");
        for await (const chunk of res) {
          pending += chunk;
          pending = pending.replace(/\r\n/g, "\n");
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const block = pending.slice(0, boundary);
            if (Buffer.byteLength(block) + 2 > 65536) throw remoteError("RESPONSE_INVALID");
            pending = pending.slice(boundary + 2);
            const frame = { id: "", event: "", data: [] };
            for (const line of block.split("\n")) {
              const split = line.indexOf(":");
              if (split < 0) continue;
              const key = line.slice(0, split);
              const value = line.slice(split + 1).replace(/^ /, "");
              if (key === "data") frame.data.push(value);
              else if (key === "id" || key === "event") frame[key] = value;
            }
            if (!frame.event || frame.event === "heartbeat") continue;
            if (!EVENTS.has(frame.event) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(frame.id)) throw remoteError("RESPONSE_INVALID");
            if (seen.has(frame.id) || queued.has(frame.id)) continue;
            let data;
            try { data = JSON.parse(frame.data.join("\n")); } catch { throw remoteError("RESPONSE_INVALID"); }
            data = projectCardEvent(frame.event, data, datasetId);
            batch.push({ id: frame.id, event: frame.event, data }); queued.add(frame.id);
            if (!onEvents || batch.length === 32) await apply();
          }
          if (Buffer.byteLength(pending) > 65536) throw remoteError("RESPONSE_INVALID");
          await apply();
        }
        await onState({ code: "DISCONNECTED" });
      } catch (error) {
        const { code } = safeError(error);
        if (combined.aborted) return;
        if (code === "RESYNC_REQUIRED") { await onState({ code }); return; }
        await onState({ code: "DISCONNECTED", error: code });
        if (["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "TLS_REJECTED", "SPKI_MISMATCH", "RESPONSE_INVALID"].includes(code)) return;
        if (continuous && !TRANSIENT.has(code)) return;
        // A failed authorized snapshot is also a failed SSE application. Keep
        // its cursor unacknowledged and honor the service's bounded retry delay.
        if (code === "SOURCE_UNAVAILABLE" && Number.isFinite(error?.retryAfter)
          && error.retryAfter >= 0 && error.retryAfter <= 3600) {
          waitMs = Math.max(waitMs, error.retryAfter * 1000);
        }
      } finally { res?.destroy(); }
      if (continuous) {
        // A successful handshake or one frame cannot reset a flapping connection.
        // Only a sustained connection after its authorized snapshot may do so.
        if (connectedAt !== undefined && performance.now() - connectedAt >= MAX_BACKOFF_MS) shortFailures = 0;
        waitMs = Math.max(waitMs, Math.min(MAX_BACKOFF_MS, reconnectDelayMs * 2 ** shortFailures));
        shortFailures = Math.min(shortFailures + 1, 15);
      }
      if ((continuous || attempt < Math.min(10, maxReconnects)) && !combined.aborted) {
        try { await timers.setTimeout(waitMs, undefined, { signal: combined }); } catch { return; }
      }
    }
  })();
  return { done, close: () => controller.abort(), cursor: () => cursor };
}
