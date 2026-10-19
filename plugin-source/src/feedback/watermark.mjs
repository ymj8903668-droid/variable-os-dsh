// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { fail } from "./errors.mjs";

export const PROTOCOL_SCHEMAS = new Set([
  "command-intent-v1",
  "command-intent-resolution-v1",
  "commit-group-receipt-v1",
]);

export function ledgerHeads(projected, { targetCommitGroupId, intentId } = {}) {
  const events = (projected.events || []).filter((row) => {
    if (targetCommitGroupId && row.commitGroupId === targetCommitGroupId) {
      return false;
    }
    if (intentId && row.id === intentId) {
      return false;
    }
    if (
      intentId &&
      row.schema === "command-intent-resolution-v1" &&
      row.commandIntentId === intentId
    ) {
      return false;
    }
    return true;
  });
  const sources = (projected.sourceItems || []).filter((row) => {
    if (targetCommitGroupId && row.commitGroupId === targetCommitGroupId) {
      return false;
    }
    return true;
  });
  return {
    eventsHead: events.length ? events[events.length - 1].id : null,
    sourceHead: sources.length ? sources[sources.length - 1].id : null,
  };
}

export async function readProtocolEvents(store) {
  const rows = await store.readAll("events");
  return rows.filter((row) => PROTOCOL_SCHEMAS.has(row.schema));
}

export async function freezeLedgerHeads({
  store,
  projected,
  commandType,
  idempotencyKey,
}) {
  const intentId = brandedId("cmd_", { commandType, idempotencyKey });
  const protocol = await readProtocolEvents(store);
  const intents = protocol.filter(
    (row) =>
      row.schema === "command-intent-v1" &&
      row.commandType === commandType &&
      row.idempotencyKey === idempotencyKey,
  );
  const uniqueIds = [...new Set(intents.map((row) => row.id))];
  if (uniqueIds.length > 1) {
    fail("HEAD_AMBIGUOUS", "duplicate command intents for key");
  }
  if (intents.length === 1) {
    const intent = intents[0];
    if (intent.id !== intentId) {
      fail("IDEMPOTENCY_CONFLICT", "command intent id does not match key");
    }
    if (
      !intent.canonicalCommandInput ||
      typeof intent.commandInputHash !== "string"
    ) {
      fail("LEDGER_CORRUPT", "command intent missing frozen input");
    }
    if (
      canonicalHash(intent.canonicalCommandInput) !== intent.commandInputHash
    ) {
      fail("LEDGER_CORRUPT", "commandInputHash does not match canonical input");
    }
    return {
      eventsHead: intent.canonicalCommandInput.eventsHead ?? null,
      sourceHead: intent.canonicalCommandInput.sourceHead ?? null,
      intent,
    };
  }
  return { ...ledgerHeads(projected), intent: null };
}
