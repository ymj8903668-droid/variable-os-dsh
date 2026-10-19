// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { fail } from "./errors.mjs";
import { resolvePresentationDecision } from "./heads.mjs";

const ACTOR_ID = "human:primary-reviewer";
const ACTOR_TYPE = "HUMAN";
const POLICY_VERSION = "inbox-viewport-v1";

function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

export async function revealOutcome({ store, now, command }) {
  if (!command || command.commandType !== "revealOutcome") {
    fail("UNKNOWN_COMMAND", "only revealOutcome is allowed");
  }
  if (command.actorId !== ACTOR_ID || command.actorType !== ACTOR_TYPE) {
    fail("ACTOR_FORBIDDEN", "actor is not on the allowlist");
  }
  const payload = command.payload || {};
  if (typeof payload.cardRevisionId !== "string" || !payload.cardRevisionId) {
    fail("INVALID_COMMAND", "cardRevisionId required");
  }
  if (typeof payload.clientEventId !== "string" || !payload.clientEventId) {
    fail("INVALID_COMMAND", "clientEventId required");
  }
  const clock = clockOf(now);
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
  const requested =
    typeof payload.presentationDecisionId === "string" &&
    payload.presentationDecisionId
      ? payload.presentationDecisionId
      : null;
  const decision = resolvePresentationDecision(
    projected.events,
    card.id,
    requested,
  );
  if (!decision) {
    fail("INVALID_PRESENTATION", "card has no committed presentation decision");
  }
  const clientEventId = payload.clientEventId;
  const semanticKey = `reveal-v1:${card.id}:${decision.id}:${clientEventId}`;
  const correlationId = `reveal:${card.id}:${decision.id}`;
  return runtime.execute({
    commandType: "revealOutcome",
    idempotencyKey: semanticKey,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      cardRevisionId: card.id,
      presentationDecisionId: decision.id,
      eventType: "OUTCOME_EXPOSED",
      clientEventId,
    },
    immutableInputRefs: [
      { type: "CARD_REVISION", id: card.id, hash: canonicalHash(card) },
      {
        type: "PRESENTATION_DECISION",
        id: decision.id,
        hash: canonicalHash(decision),
      },
    ],
    builderVersion: "reveal-v1",
    engineResultId: null,
    expectedHeads: Array.isArray(command.expectedHeads) ? command.expectedHeads : [],
    buildMembers: ({ targetCommitGroupId, now: stamped, committedProjection }) => {
      if (!committedProjection || !Array.isArray(committedProjection.events)) {
        fail("LEDGER_CORRUPT", "committed projection unavailable");
      }
      const live = committedProjection.events.find((row) => row.id === card.id);
      if (!live || live.schema !== "variable-card-revision-v1") {
        fail("INPUT_REF_MISMATCH", "card revision is not committed");
      }
      const liveDecision = resolvePresentationDecision(
        committedProjection.events,
        live.id,
        decision.id,
      );
      if (!liveDecision) {
        fail("INVALID_PRESENTATION", "presentation decision is not committed");
      }
      const id = brandedId("dint_", {
        eventType: "OUTCOME_EXPOSED",
        clientEventId,
        cardRevisionId: card.id,
        presentationDecisionId: liveDecision.id,
      });
      return [
        {
          file: "events",
          record: {
            schema: "delivery-interaction-v1",
            id,
            createdAt: stamped,
            recordedAt: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            commitGroupId: targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            cardRevisionId: card.id,
            presentationDecisionId: liveDecision.id,
            presentationCycleId: liveDecision.presentationCycleId,
            eventType: "OUTCOME_EXPOSED",
            channel: "INBOX",
            surface: "feedback",
            position: 1,
            occurredAt: stamped,
            presentationRuleVersion: POLICY_VERSION,
            receipt: { clientEventId },
            idempotencyKey: semanticKey,
          },
        },
      ];
    },
  });
}
