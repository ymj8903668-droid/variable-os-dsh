// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { DeliveryError } from "./errors.mjs";

const ACTORS = Object.freeze({
  "human:primary-reviewer": "HUMAN",
  "system:demo-runner": "SYSTEM",
});
const POLICY_VERSION = "inbox-viewport-v1";
const BUILDER_VERSION = "delivery-v1";

function fail(code, message, details) {
  throw new DeliveryError(code, message, details);
}

function envelope({ id, now, targetCommitGroupId, extra }) {
  return {
    schema: "delivery-interaction-v1",
    id,
    createdAt: now,
    recordedAt: now,
    actorType: extra.actorType,
    actorId: extra.actorId,
    correlationId: extra.correlationId,
    commitGroupId: targetCommitGroupId,
    supersedesId: null,
    policyVersion: POLICY_VERSION,
    ...extra,
  };
}

export async function recordDeliveryInteraction({
  store,
  now = () => new Date().toISOString(),
  command,
}) {
  if (!command || command.commandType !== "recordDeliveryInteraction") {
    fail("UNKNOWN_COMMAND", "only recordDeliveryInteraction is allowed");
  }
  if (typeof command.idempotencyKey !== "string" || command.idempotencyKey.length === 0) {
    fail("INVALID_COMMAND", "idempotencyKey required");
  }
  if (!Array.isArray(command.expectedHeads)) {
    fail("INVALID_COMMAND", "expectedHeads array required");
  }
  if (command.expectedHeads.length !== 0) {
    fail("INVALID_COMMAND", "this slice only allows empty expectedHeads");
  }
  const actorId = command.actorId;
  if (!ACTORS[actorId]) {
    fail("ACTOR_FORBIDDEN", "actor is not on the allowlist");
  }
  const actorType = command.actorType || ACTORS[actorId];
  if (actorType !== ACTORS[actorId]) {
    fail("ACTOR_FORBIDDEN", "actorType does not match allowlist");
  }
  const payload = command.payload || {};
  const eventType = payload.eventType;
  if (eventType === "ENQUEUED" || eventType === "OUTCOME_EXPOSED") {
    fail("EVENT_TYPE_FORBIDDEN", "ENQUEUED/OUTCOME_EXPOSED is not PRESENTED");
  }
  if (eventType !== "PRESENTED" && eventType !== "OPENED") {
    fail("EVENT_TYPE_FORBIDDEN", "unsupported delivery eventType");
  }
  if (typeof payload.clientEventId !== "string" || !payload.clientEventId) {
    fail("INVALID_COMMAND", "clientEventId required");
  }
  if (typeof payload.cardRevisionId !== "string" || !payload.cardRevisionId) {
    fail("INVALID_COMMAND", "cardRevisionId required");
  }
  if (
    typeof payload.presentationDecisionId !== "string" ||
    !payload.presentationDecisionId
  ) {
    fail("INVALID_COMMAND", "presentationDecisionId required");
  }
  if (payload.channel && payload.channel !== "INBOX") {
    fail("INVALID_COMMAND", "only INBOX channel is allowed in this slice");
  }
  if (eventType === "PRESENTED") {
    if (!(Number(payload.visibilityRatio) >= 0.5)) {
      fail("INVALID_PRESENTATION", "PRESENTED requires visibilityRatio >= 0.5");
    }
    if (!(Number(payload.visibleDurationMs) >= 300)) {
      fail("INVALID_PRESENTATION", "PRESENTED requires visibleDurationMs >= 300");
    }
  }

  const clock = typeof now === "function" ? now : () => now;
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const card = projected.events.find(
    (row) =>
      row.schema === "variable-card-revision-v1" &&
      row.id === payload.cardRevisionId,
  );
  if (!card) {
    fail("INPUT_REF_MISMATCH", "card revision is not committed");
  }
  const decision = projected.events.find(
    (row) =>
      row.schema === "presentation-decision-v1" &&
      row.id === payload.presentationDecisionId,
  );
  if (!decision || decision.cardRevisionId !== payload.cardRevisionId) {
    fail("INPUT_REF_MISMATCH", "presentation decision is not committed");
  }

  const surface =
    payload.surface || (eventType === "OPENED" ? "inbox-detail" : "inbox-list");
  const semanticKey = `delivery-v1:${payload.clientEventId}`;
  const correlationId = `delivery:${payload.cardRevisionId}`;
  let executed;
  try {
    executed = await runtime.execute({
    commandType: "recordDeliveryInteraction",
    idempotencyKey: semanticKey,
    actorType,
    actorId,
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      eventType,
      clientEventId: payload.clientEventId,
      cardRevisionId: payload.cardRevisionId,
      presentationDecisionId: payload.presentationDecisionId,
      channel: "INBOX",
      surface,
    },
    immutableInputRefs: [
      { type: "CARD_REVISION", id: card.id, hash: canonicalHash(card) },
      {
        type: "PRESENTATION_DECISION",
        id: decision.id,
        hash: canonicalHash(decision),
      },
    ],
    builderVersion: BUILDER_VERSION,
    engineResultId: null,
    expectedHeads: command.expectedHeads,
    buildMembers: ({ targetCommitGroupId, now: stamped }) => {
      const id = brandedId("dint_", {
        eventType,
        clientEventId: payload.clientEventId,
        cardRevisionId: payload.cardRevisionId,
        presentationDecisionId: payload.presentationDecisionId,
      });
      const receipt = {
        clientEventId: payload.clientEventId,
      };
      if (eventType === "PRESENTED") {
        receipt.visibilityRatio = Number(payload.visibilityRatio);
        receipt.visibleDurationMs = Number(payload.visibleDurationMs);
      }
      return [
        {
          file: "events",
          record: envelope({
            id,
            now: stamped,
            targetCommitGroupId,
            extra: {
              actorType,
              actorId,
              correlationId,
              cardRevisionId: payload.cardRevisionId,
              presentationDecisionId: payload.presentationDecisionId,
              presentationCycleId: decision.presentationCycleId,
              eventType,
              channel: "INBOX",
              surface,
              position:
                typeof payload.position === "number"
                  ? payload.position
                  : decision.slot,
              occurredAt: stamped,
              presentationRuleVersion: POLICY_VERSION,
              receipt,
              idempotencyKey: semanticKey,
            },
          }),
        },
      ];
    },
    });
  } catch (err) {
    if (err && err.code === "IDEMPOTENCY_CONFLICT") {
      fail(
        "IDEMPOTENCY_CONFLICT",
        "clientEventId reused with a different payload",
      );
    }
    throw err;
  }
  return {
    commitGroupId: executed.commitGroupId,
    commitGroupReceipt: executed.commitGroupReceipt,
    memberRecordIds: executed.memberRecordIds,
    reused: executed.reused,
  };
}
