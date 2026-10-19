// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalize, canonicalHash } from "../schema/canonical-json.mjs";
import { fail } from "./errors.mjs";

const LEDGER_ORDER = Object.freeze(["events", "source_items"]);

function emptyRolling() {
  return canonicalHash({ ledger: "empty" });
}

export function ledgerStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let byteLength = 0;
  let rollingHash = emptyRolling();
  for (const row of list) {
    const line = `${canonicalize(row)}\n`;
    byteLength += Buffer.byteLength(line, "utf8");
    rollingHash = canonicalHash({
      previous: rollingHash,
      id: row.id,
      recordHash: canonicalHash(row),
    });
  }
  return {
    recordCount: list.length,
    byteLength,
    lastRecordId: list.length ? list[list.length - 1].id : null,
    rollingHash,
  };
}

export function sliceRows(rows, lastRecordId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!lastRecordId) {
    return list.length === 0 ? list : null;
  }
  const index = list.findIndex((row) => row && row.id === lastRecordId);
  if (index < 0) {
    return null;
  }
  return list.slice(0, index + 1);
}

export function expandLedgerWatermark(projected, receipt) {
  if (!receipt || receipt.schema !== "ledger-watermark-receipt-v1") {
    return { ok: false, reason: "MISSING_WATERMARK" };
  }
  const ledgers = Array.isArray(receipt.ledgers) ? receipt.ledgers : [];
  if (ledgers.length !== LEDGER_ORDER.length) {
    return { ok: false, reason: "WATERMARK_LEDGER_MISSING" };
  }
  const sliced = {
    events: [],
    sourceItems: [],
  };
  const recomputed = [];
  for (let index = 0; index < LEDGER_ORDER.length; index += 1) {
    const name = LEDGER_ORDER[index];
    const declared = ledgers[index];
    if (!declared || declared.ledgerName !== name) {
      return { ok: false, reason: "WATERMARK_LEDGER_MISSING" };
    }
    const rows =
      name === "events" ? projected.events || [] : projected.sourceItems || [];
    const slice = sliceRows(rows, declared.lastRecordId);
    if (slice === null) {
      return { ok: false, reason: "WATERMARK_HEAD_MISMATCH" };
    }
    const stats = ledgerStats(slice);
    if (
      stats.recordCount !== declared.recordCount ||
      stats.byteLength !== declared.byteLength ||
      stats.lastRecordId !== declared.lastRecordId ||
      stats.rollingHash !== declared.rollingHash
    ) {
      return { ok: false, reason: "WATERMARK_HASH_MISMATCH" };
    }
    recomputed.push({ ledgerName: name, ...stats });
    if (name === "events") {
      sliced.events = slice;
    } else {
      sliced.sourceItems = slice;
    }
  }
  const manifestHash = canonicalHash(recomputed);
  if (manifestHash !== receipt.manifestHash) {
    return { ok: false, reason: "WATERMARK_HASH_MISMATCH" };
  }
  if (receipt.eventsHead !== (sliced.events.length ? sliced.events[sliced.events.length - 1].id : null)) {
    return { ok: false, reason: "WATERMARK_HEAD_MISMATCH" };
  }
  if (
    receipt.sourceHead !==
    (sliced.sourceItems.length ? sliced.sourceItems[sliced.sourceItems.length - 1].id : null)
  ) {
    return { ok: false, reason: "WATERMARK_HEAD_MISMATCH" };
  }
  return { ok: true, ...sliced, hash: manifestHash, ledgers: recomputed };
}

export function captureExpandableWatermark(projected) {
  const events = Array.isArray(projected.events) ? projected.events : [];
  const sources = Array.isArray(projected.sourceItems)
    ? projected.sourceItems
    : [];
  const ledgers = [
    { ledgerName: "events", ...ledgerStats(events) },
    { ledgerName: "source_items", ...ledgerStats(sources) },
  ];
  return {
    eventsHead: events.length ? events[events.length - 1].id : null,
    sourceHead: sources.length ? sources[sources.length - 1].id : null,
    ledgers,
    manifestHash: canonicalHash(ledgers),
  };
}

export function sliceProjectionAtHeads(projected, { eventsHead, sourceHead, expectedHash }) {
  const eventsSlice = sliceRows(projected.events || [], eventsHead);
  const sourceSlice = sliceRows(projected.sourceItems || [], sourceHead);
  if (eventsSlice === null) {
    return { ok: false, reason: "EVENTS_HEAD_MISSING" };
  }
  if (sourceSlice === null) {
    return { ok: false, reason: "SOURCE_HEAD_MISSING" };
  }
  const captured = captureExpandableWatermark({
    events: eventsSlice,
    sourceItems: sourceSlice,
  });
  if (captured.eventsHead !== (eventsHead || null) || captured.sourceHead !== (sourceHead || null)) {
    return { ok: false, reason: "WATERMARK_HEAD_MISMATCH" };
  }
  if (expectedHash && captured.manifestHash !== expectedHash) {
    return { ok: false, reason: "WATERMARK_HASH_MISMATCH" };
  }
  return {
    ok: true,
    events: eventsSlice,
    sourceItems: sourceSlice,
    hash: captured.manifestHash,
    ledgers: captured.ledgers,
    eventsHead: captured.eventsHead,
    sourceHead: captured.sourceHead,
  };
}

export function requireExpandable(receipt) {
  if (!receipt || !Array.isArray(receipt.ledgers) || receipt.ledgers.length === 0) {
    fail("WATERMARK_INVALID", "ledger watermark is not expandable");
  }
}
