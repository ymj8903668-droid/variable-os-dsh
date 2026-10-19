// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { isTerminalState } from "../label/helpers.mjs";
import { fail } from "./errors.mjs";
import { computeBlindEligibility } from "./eligibility.mjs";
import { uniqueWorkflowHead } from "./inclusion.mjs";
import { clockOf, envelope } from "./policy.mjs";
import { findInvalidations } from "./selection.mjs";
import { frozenPayloadHash } from "./universe.mjs";

const ACTOR_ID = "human:primary-reviewer";
const ACTOR_TYPE = "HUMAN";
const POLICY_VERSION = "opportunity-blind-replay-v1";
const LABELS = new Set(["TRADABLE", "NOT_TRADABLE"]);

function payloadOf(command) {
  return command && command.payload && typeof command.payload === "object"
    ? command.payload
    : {};
}

function requireActor(command) {
  if (command.actorId !== ACTOR_ID || command.actorType !== ACTOR_TYPE) {
    fail("ACTOR_FORBIDDEN", "actor is not on the allowlist");
  }
}

export function frozenTargetFromItem(item) {
  const payload = item && item.frozenReviewPayload;
  const target = item && item.reviewTarget;
  if (!payload || !target) {
    fail("PAYLOAD_HASH_MISMATCH", "frozen review payload is missing");
  }
  const recomputed = frozenPayloadHash(payload);
  if (recomputed !== item.frozenReviewPayloadHash) {
    fail("PAYLOAD_HASH_MISMATCH", "frozen payload hash is not recomputable");
  }
  if (target.type === "SCREENING_ATTEMPT") {
    if (!payload.attempt || !payload.decision || !payload.context || !payload.exposure) {
      fail("PAYLOAD_HASH_MISMATCH", "screening frozen payload is incomplete");
    }
    return {
      type: "SCREENING_ATTEMPT",
      screeningAttemptId: payload.attempt.id,
      scanExposureId: payload.exposure.id,
      decisionContextId: payload.context.id,
    };
  }
  if (!payload.card || !payload.context || !payload.presentationDecision) {
    fail("PAYLOAD_HASH_MISMATCH", "class frozen payload is incomplete");
  }
  return {
    type: "CARD_REVISION",
    cardRevisionId: payload.card.id,
    decisionContextId: payload.context.id,
    themeHypothesisIds: [...(payload.themeHypothesisIds || [])],
    securityMappingIds: [...(payload.securityMappingIds || [])],
  };
}

export async function submitBlindReplay({ store, now, command = {} }) {
  requireActor(command);
  const payload = payloadOf(command);
  const label = payload.label;
  if (label === "WATCH") {
    fail("WATCH_FORBIDDEN", "blind replay does not accept WATCH");
  }
  if (!LABELS.has(label)) {
    fail("INVALID_COMMAND", "blind replay accepts TRADABLE or NOT_TRADABLE only");
  }
  if (payload.adHocPayload || payload.replacementPayload) {
    fail("PAYLOAD_HASH_MISMATCH", "ad-hoc or replacement payload is forbidden");
  }
  const itemId = payload.auditSampleItemId;
  if (typeof itemId !== "string" || !itemId) {
    fail("INVALID_COMMAND", "auditSampleItemId required");
  }
  const clientActionId = payload.clientActionId;
  if (typeof clientActionId !== "string" || !clientActionId) {
    fail("INVALID_COMMAND", "clientActionId required");
  }
  const expectedTaskHeadId = payload.expectedTaskHeadId;
  const expectedTaskStateVersion = payload.expectedTaskStateVersion;
  if (typeof expectedTaskHeadId !== "string" || !expectedTaskHeadId) {
    fail("INVALID_COMMAND", "expected task head is required");
  }
  if (!Number.isInteger(expectedTaskStateVersion)) {
    fail("INVALID_COMMAND", "expected task version is required");
  }
  const knowledge = payload.reviewerKnowledgeDeclaration;
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const item = projected.events.find(
    (row) => row.schema === "audit-sample-item-v1" && row.id === itemId,
  );
  if (!item) {
    fail("INPUT_REF_MISMATCH", "audit sample item is not committed");
  }
  const receipt = projected.events.find(
    (row) =>
      row.schema === "audit-sample-selection-receipt-v1" &&
      row.id === item.auditSampleSelectionReceiptId,
  );
  if (!receipt) {
    fail("INPUT_REF_MISMATCH", "selection receipt is not committed");
  }
  const task = projected.events.find(
    (row) => row.schema === "review-task-v1" && row.id === item.reviewTaskId,
  );
  if (!task) {
    fail("INPUT_REF_MISMATCH", "blind review task is not committed");
  }
  const key = `blind-replay-v1:${clientActionId}`;
  const correlationId = `blind:${item.id}`;
  const expectedHeads = Array.isArray(command.expectedHeads)
    ? command.expectedHeads
    : [
        {
          chainType: "review-task",
          objectId: task.id,
          expectedHeadId: expectedTaskHeadId,
          expectedStateVersion: expectedTaskStateVersion,
        },
      ];
  try {
    return await runtime.execute({
      commandType: "submitBlindReplay",
      idempotencyKey: key,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        auditSampleItemId: item.id,
        label,
        clientActionId,
        expectedTaskHeadId,
        expectedTaskStateVersion,
        reviewerKnowledgeDeclaration: knowledge,
        expectedPayloadHash: payload.expectedPayloadHash || item.frozenReviewPayloadHash,
        replacementCardRevisionId: payload.replacementCardRevisionId || null,
      },
      immutableInputRefs: [
        { type: "AUDIT_SAMPLE_ITEM", id: item.id, hash: canonicalHash(item) },
        { type: "REVIEW_TASK", id: task.id, hash: canonicalHash(task) },
      ],
      builderVersion: "blind-replay-v1",
      engineResultId: null,
      expectedHeads,
      buildMembers: ({
        assignId,
        targetCommitGroupId,
        now: stamped,
        canonicalCommandInput,
        committedProjection,
      }) => {
        const events = committedProjection.events || [];
        const liveItem = events.find(
          (row) => row.schema === "audit-sample-item-v1" && row.id === item.id,
        );
        const liveReceipt = events.find(
          (row) =>
            row.schema === "audit-sample-selection-receipt-v1" &&
            row.id === item.auditSampleSelectionReceiptId,
        );
        const liveTask = events.find(
          (row) => row.schema === "review-task-v1" && row.id === item.reviewTaskId,
        );
        if (!liveItem || !liveReceipt || !liveTask) {
          fail("INPUT_REF_MISMATCH", "blind sample graph is not committed");
        }
        if (findInvalidations(events, liveReceipt.id).length) {
          fail("PERIOD_INVALIDATED", "audit period has been invalidated");
        }
        if (stamped >= liveReceipt.responseDeadline) {
          fail("DEADLINE_EXPIRED", "blind replay is past responseDeadline");
        }
        const liveHash = liveItem.frozenReviewPayloadHash;
        if (
          canonicalCommandInput.expectedPayloadHash &&
          canonicalCommandInput.expectedPayloadHash !== liveHash
        ) {
          fail("PAYLOAD_HASH_MISMATCH", "frozen payload hash does not match item");
        }
        if (canonicalCommandInput.replacementCardRevisionId) {
          fail("PAYLOAD_HASH_MISMATCH", "replacement card payload is forbidden");
        }
        const frozenReviewTarget = frozenTargetFromItem(liveItem);
        const chain = uniqueWorkflowHead(events, liveTask.id);
        if (chain.reason || !chain.head) {
          fail("HEAD_CONFLICT", chain.reason || "review task chain is not unique");
        }
        const state = chain.head;
        if (
          state.id !== canonicalCommandInput.expectedTaskHeadId ||
          state.stateVersion !== canonicalCommandInput.expectedTaskStateVersion
        ) {
          fail("HEAD_CONFLICT", "review task head changed");
        }
        if (isTerminalState(state.toState)) {
          fail("HEAD_CONFLICT", "review task is already terminal");
        }
        if (state.toState !== "OPEN" && state.toState !== "IN_PROGRESS") {
          fail("HEAD_CONFLICT", "review task is not open");
        }
        const judged = computeBlindEligibility({
          events,
          actorId: ACTOR_ID,
          opportunityId: liveItem.opportunityId,
          knowledge: canonicalCommandInput.reviewerKnowledgeDeclaration,
          now: stamped,
        });
        const snapshotId = brandedId("hds_", {
          purpose: "OPPORTUNITY_BLIND_REPLAY",
          auditSampleItemId: liveItem.id,
          clientActionId: canonicalCommandInput.clientActionId,
        });
        const adjudicationId = brandedId("oadj_", {
          mode: "BLIND_REPLAY",
          auditSampleItemId: liveItem.id,
          clientActionId: canonicalCommandInput.clientActionId,
        });
        const completedId = assignId(
          "workflow-state-event-v1",
          "blind-completed",
        );
        const snapshot = envelope({
          schema: "human-decision-snapshot-v1",
          id: snapshotId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: null,
          policyVersion: POLICY_VERSION,
          extra: {
            visibleDataAsOf: stamped,
            reactionSearchRuleVersionAtDecision: "reaction-search-v1",
            visiblePayloadHash: liveHash,
            exposureHeadIdAtDecision: judged.exposure.headId,
            outcomeExposureStatus: judged.outcomeExposureStatus,
            reviewerExposureAudit: judged.reviewerExposureAudit,
            reviewerKnowledgeDeclaration: judged.reviewerKnowledgeDeclaration,
            purpose: "OPPORTUNITY_BLIND_REPLAY",
            targetRef: { type: "AUDIT_SAMPLE_ITEM", id: liveItem.id },
            opportunityId: liveItem.opportunityId,
            frozenReviewTarget,
            presentationInteractionId: null,
            auditTaskId: liveTask.id,
            taskStateHeadIdAtDecision: state.id,
            taskStateVersionAtDecision: state.stateVersion,
            auditSampleSelectionReceiptId: liveReceipt.id,
          },
        });
        const adjudication = envelope({
          schema: "opportunity-adjudication-v1",
          id: adjudicationId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: null,
          policyVersion: POLICY_VERSION,
          extra: {
            opportunityId: liveItem.opportunityId,
            humanDecisionSnapshotId: snapshotId,
            blindEligibility: judged.blindEligibility,
            outcomeExposureStatus: judged.outcomeExposureStatus,
            adjudicatedAt: stamped,
            idempotencyKey: key,
            mode: "BLIND_REPLAY",
            sourceHumanLabelId: null,
            sourceAuditSampleItemId: liveItem.id,
            label: canonicalCommandInput.label,
          },
        });
        const completed = envelope({
          schema: "workflow-state-event-v1",
          id: completedId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: null,
          policyVersion: POLICY_VERSION,
          extra: {
            objectType: "REVIEW_TASK",
            objectId: liveTask.id,
            objectRevisionId: null,
            fromState: state.toState,
            toState: "COMPLETED",
            previousStateEventId: state.id,
            stateVersion: state.stateVersion + 1,
            expectedHeadId: state.id,
            expectedStateVersion: state.stateVersion,
            occurredAt: stamped,
            reason: "BLIND_REPLAY_COMPLETED",
            idempotencyKey: `blind-completed:${liveItem.id}`,
          },
        });
        return [snapshot, adjudication, completed].map((record) => ({
          file: "events",
          record,
        }));
      },
    });
  } catch (err) {
    if (err && err.code === "IDEMPOTENCY_CONFLICT") {
      fail(
        "IDEMPOTENCY_CONFLICT",
        "clientActionId reused with a different payload",
      );
    }
    throw err;
  }
}
