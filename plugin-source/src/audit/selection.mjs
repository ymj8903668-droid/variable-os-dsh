// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { freezeLedgerHeads, ledgerHeads } from "../feedback/watermark.mjs";
import { classIdOf } from "../report/universe.mjs";
import { fail } from "./errors.mjs";
import { findAuditAuthority } from "./authority.mjs";
import {
  SELECTION_FROZEN_KEYS,
  assertWatermarkGrace,
  clockOf,
  envelope,
  loadDemoAuditPolicy,
  rejectOverrides,
} from "./policy.mjs";
import {
  auditOpportunityIdOf,
  buildAuditUniverse,
  itemIdOf,
  sampleUniverse,
  samplingSeedOf,
  taskIdOf,
} from "./universe.mjs";
import {
  captureExpandableWatermark,
  sliceProjectionAtHeads,
} from "./watermark.mjs";

const ACTOR_ID = "system:demo-runner";
const ACTOR_TYPE = "SYSTEM";
const POLICY_VERSION = "audit-sample-selection-v1";

function semanticSelectionKey(authorityKey) {
  return `audit-selection-v1:${authorityKey}`;
}

export function findSelectionReceipt(events, authorityKey) {
  return (events || []).filter(
    (row) =>
      row &&
      row.schema === "audit-sample-selection-receipt-v1" &&
      (!authorityKey || row.authorityKey === authorityKey),
  );
}

export function findInvalidations(events, selectionReceiptId) {
  return (events || []).filter(
    (row) =>
      row &&
      row.schema === "audit-period-invalidation-receipt-v1" &&
      (!selectionReceiptId ||
        row.auditSampleSelectionReceiptId === selectionReceiptId),
  );
}

export function selectionHashOf(fields) {
  return canonicalHash({
    authorityKey: fields.authorityKey,
    auditPeriodAuthorityReceiptId: fields.auditPeriodAuthorityReceiptId,
    auditPeriodAuthorityHash: fields.auditPeriodAuthorityHash,
    inputWatermarkHash: fields.inputWatermarkHash,
    universeHash: fields.universeHash,
    samplingSeed: fields.samplingSeed,
    selectedAuditSampleItemIds: fields.selectedAuditSampleItemIds,
    responseDeadline: fields.responseDeadline,
  });
}

function screeningOpportunity(events, item, now, actor, correlationId, targetCommitGroupId) {
  const attempt = item.frozenPayload.attempt;
  const exposure = item.frozenPayload.exposure;
  const opportunityId = auditOpportunityIdOf(item.fingerprint);
  const existing = (events || []).find(
    (row) => row && row.schema === "opportunity-v1" && row.id === opportunityId,
  );
  if (existing) {
    return { opportunityId, record: null };
  }
  return {
    opportunityId,
    record: envelope({
      schema: "opportunity-v1",
      id: opportunityId,
      now,
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId,
      targetCommitGroupId,
      supersedesId: null,
      policyVersion: POLICY_VERSION,
      extra: {
        canonicalFingerprint: canonicalHash({
          createdFrom: "AUDIT_SAMPLE",
          screeningAttemptId: attempt.id,
        }),
        triggerScanExposureId: attempt.scanExposureId,
        opportunityEligibleAt: exposure ? exposure.eligibleAt : null,
        createdFrom: "AUDIT_SAMPLE",
      },
    }),
  };
}

export async function selectAuditSample({ store, now, command = {} }) {
  const policy = await loadDemoAuditPolicy();
  rejectOverrides(command.payload || {}, SELECTION_FROZEN_KEYS);
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const authority = findAuditAuthority(projected.events, policy.auditPeriodId);
  if (!authority) {
    fail("INVALID_AUTHORITY", "audit period authority is not committed");
  }
  const authorityKey = authority.authorityKey;
  const callerKey =
    typeof command.idempotencyKey === "string" && command.idempotencyKey.length
      ? command.idempotencyKey
      : semanticSelectionKey(authorityKey);
  const existing = findSelectionReceipt(projected.events, authorityKey);
  if (existing.length > 1) {
    fail("WRITE_ONCE_CONFLICT", "competing audit selection receipts");
  }
  if (existing.length === 1 && existing[0].idempotencyKey !== callerKey) {
    fail(
      "WRITE_ONCE_CONFLICT",
      "authorityKey already has a write-once selection receipt",
    );
  }
  const liveCaptured = captureExpandableWatermark(projected);
  const frozen = await freezeLedgerHeads({
    store,
    projected,
    commandType: "selectAuditSample",
    idempotencyKey: callerKey,
  });
  const frozenInput = frozen.intent ? frozen.intent.canonicalCommandInput : null;
  const eventsHead = frozenInput ? frozenInput.eventsHead : liveCaptured.eventsHead;
  const sourceHead = frozenInput ? frozenInput.sourceHead : liveCaptured.sourceHead;
  const inputWatermarkHash = frozenInput
    ? frozenInput.inputWatermarkHash
    : liveCaptured.manifestHash;
  const correlationId = `asamp:${authority.auditPeriodId}`;
  return runtime.execute({
    commandType: "selectAuditSample",
    idempotencyKey: callerKey,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      authorityKey,
      auditPeriodAuthorityReceiptId: authority.id,
      auditPeriodAuthorityHash: authority.authorityHash,
      eventsHead,
      sourceHead,
      inputWatermarkHash,
    },
    immutableInputRefs: [
      {
        type: "AUDIT_PERIOD_AUTHORITY",
        id: authority.id,
        hash: canonicalHash(authority),
      },
    ],
    builderVersion: "audit-selection-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({
      assignId,
      targetCommitGroupId,
      now: stamped,
      committedProjection,
      canonicalCommandInput,
    }) => {
      const liveAuthority = findAuditAuthority(
        committedProjection.events,
        policy.auditPeriodId,
      );
      if (!liveAuthority || liveAuthority.id !== authority.id) {
        fail("INVALID_AUTHORITY", "authority is not committed");
      }
      const liveExisting = findSelectionReceipt(
        committedProjection.events,
        liveAuthority.authorityKey,
      ).filter((row) => row.commitGroupId !== targetCommitGroupId);
      if (liveExisting.length) {
        fail("WRITE_ONCE_CONFLICT", "selection receipt already committed");
      }
      assertWatermarkGrace({
        selectionCutoffAt: liveAuthority.selectionCutoffAt,
        watermarkCapturedAt: stamped,
        watermarkCaptureGraceMs: liveAuthority.watermarkCaptureGraceMs,
      });
      const sliced = sliceProjectionAtHeads(committedProjection, {
        eventsHead: canonicalCommandInput.eventsHead,
        sourceHead: canonicalCommandInput.sourceHead,
        expectedHash: canonicalCommandInput.inputWatermarkHash,
      });
      if (!sliced.ok) {
        fail("WATERMARK_INVALID", sliced.reason || "watermark is not expandable");
      }
      const universe = buildAuditUniverse(sliced.events, {
        universeAsOf: liveAuthority.selectionCutoffAt,
        universeRuleVersion: liveAuthority.universeRuleVersion,
      });
      const samplingSeed = samplingSeedOf({
        auditPeriodAuthorityReceiptId: liveAuthority.id,
        inputWatermarkHash: canonicalCommandInput.inputWatermarkHash,
        universeHash: universe.hash,
        seedDerivationVersion: liveAuthority.seedDerivationVersion,
      });
      const selected = sampleUniverse(
        universe.items,
        samplingSeed,
        liveAuthority.sampleSize,
      );
      const receiptId = brandedId("asamp_", {
        authorityKey: liveAuthority.authorityKey,
      });
      const watermarkId = assignId(
        "ledger-watermark-receipt-v1",
        "audit-watermark",
      );
      const actor = { actorType: ACTOR_TYPE, actorId: ACTOR_ID };
      const records = [];
      const itemIds = [];
      for (const item of selected) {
        const itemId = itemIdOf(receiptId, item.fingerprint);
        const taskId = taskIdOf(itemId);
        const scheduledId = assignId(
          "workflow-state-event-v1",
          `sched:${itemId}`,
        );
        const openId = assignId("workflow-state-event-v1", `open:${itemId}`);
        let opportunityId = item.opportunityId || null;
        if (item.type === "SCREENING_ATTEMPT") {
          const made = screeningOpportunity(
            sliced.events,
            item,
            stamped,
            actor,
            correlationId,
            targetCommitGroupId,
          );
          opportunityId = made.opportunityId;
          if (made.record) {
            records.push(made.record);
          }
        }
        if (!opportunityId) {
          fail("UNIVERSE_INVALID", "selected item is missing opportunityId");
        }
        const opportunityClassIdAtSelection =
          item.type === "OPPORTUNITY_CLASS" && item.opportunityClassId
            ? item.opportunityClassId
            : classIdOf([opportunityId]);
        const memberOpportunityIdsAtSelection =
          item.type === "OPPORTUNITY_CLASS" && Array.isArray(item.memberOpportunityIds)
            ? [...item.memberOpportunityIds].sort()
            : [opportunityId];
        itemIds.push(itemId);
        records.push(
          envelope({
            schema: "audit-sample-item-v1",
            id: itemId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            extra: {
              auditSampleSelectionReceiptId: receiptId,
              auditPeriodId: liveAuthority.auditPeriodId,
              opportunityId,
              opportunityClassIdAtSelection,
              memberOpportunityIdsAtSelection,
              reviewTarget: item.reviewTarget,
              frozenReviewPayloadHash: item.frozenReviewPayloadHash,
              frozenReviewPayload: item.frozenPayload,
              reviewTaskId: taskId,
              reviewTaskOpenStateEventId: openId,
            },
          }),
        );
        records.push(
          envelope({
            schema: "review-task-v1",
            id: taskId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            extra: {
              objectRef: { type: "AUDIT_SAMPLE_ITEM", id: itemId },
              reason: "AUDIT_SAMPLE",
              watchLabelId: null,
              reviewDueAt: liveAuthority.responseDeadline,
              earlyWakeRelations: [],
              priorityBucket: "BLIND_AUDIT",
              ruleVersion: liveAuthority.algorithmVersion,
              idempotencyKey: `blind-task:${itemId}`,
              createdAt: stamped,
            },
          }),
        );
        records.push(
          envelope({
            schema: "workflow-state-event-v1",
            id: scheduledId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            extra: {
              objectType: "REVIEW_TASK",
              objectId: taskId,
              objectRevisionId: null,
              fromState: null,
              toState: "SCHEDULED",
              previousStateEventId: null,
              stateVersion: 1,
              expectedHeadId: null,
              expectedStateVersion: null,
              occurredAt: stamped,
              reason: "AUDIT_SAMPLE_SCHEDULED",
              idempotencyKey: `blind-scheduled:${itemId}`,
            },
          }),
        );
        records.push(
          envelope({
            schema: "workflow-state-event-v1",
            id: openId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            extra: {
              objectType: "REVIEW_TASK",
              objectId: taskId,
              objectRevisionId: null,
              fromState: "SCHEDULED",
              toState: "OPEN",
              previousStateEventId: scheduledId,
              stateVersion: 2,
              expectedHeadId: scheduledId,
              expectedStateVersion: 1,
              occurredAt: stamped,
              reason: "AUDIT_SAMPLE_OPEN",
              idempotencyKey: `blind-open:${itemId}`,
            },
          }),
        );
      }
      itemIds.sort();
      const receiptFields = {
        authorityKey: liveAuthority.authorityKey,
        auditPeriodAuthorityReceiptId: liveAuthority.id,
        auditPeriodAuthorityHash: liveAuthority.authorityHash,
        inputWatermarkHash: canonicalCommandInput.inputWatermarkHash,
        universeHash: universe.hash,
        samplingSeed,
        selectedAuditSampleItemIds: itemIds,
        responseDeadline: liveAuthority.responseDeadline,
      };
      const selectionHash = selectionHashOf(receiptFields);
      records.unshift(
        envelope({
          schema: "ledger-watermark-receipt-v1",
          id: watermarkId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: null,
          policyVersion: POLICY_VERSION,
          extra: {
            purpose: "AUDIT_SAMPLE_SELECTION",
            commandIntentId: canonicalCommandInput.authorityKey,
            capturedAtCommandStart: true,
            writerLockEpoch: 1,
            eventsHead: canonicalCommandInput.eventsHead,
            sourceHead: canonicalCommandInput.sourceHead,
            capturedAt: stamped,
            ledgers: sliced.ledgers,
            manifestHash: canonicalCommandInput.inputWatermarkHash,
          },
        }),
      );
      records.push(
        envelope({
          schema: "audit-sample-selection-receipt-v1",
          id: receiptId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: null,
          policyVersion: POLICY_VERSION,
          extra: {
            authorityKey: liveAuthority.authorityKey,
            auditPeriodAuthorityReceiptId: liveAuthority.id,
            auditPeriodAuthorityHash: liveAuthority.authorityHash,
            auditPeriodId: liveAuthority.auditPeriodId,
            auditPeriodStartAt: liveAuthority.auditPeriodStartAt,
            auditPeriodEndAt: liveAuthority.auditPeriodEndAt,
            selectionCutoffAt: liveAuthority.selectionCutoffAt,
            authorityPolicyVersion: liveAuthority.authorityPolicyVersion,
            universeAsOf: liveAuthority.selectionCutoffAt,
            inputLedgerWatermarkReceiptId: watermarkId,
            inputWatermarkHash: canonicalCommandInput.inputWatermarkHash,
            watermarkCapturedAt: stamped,
            universeRuleVersion: liveAuthority.universeRuleVersion,
            universeManifestRef: `synthetic://audit-universe/${receiptId}`,
            universeItemCount: universe.count,
            universeHash: universe.hash,
            seedDerivationVersion: liveAuthority.seedDerivationVersion,
            samplingSeed,
            algorithmVersion: liveAuthority.algorithmVersion,
            sampleSize: liveAuthority.sampleSize,
            selectedAuditSampleItemIds: itemIds,
            responseDeadline: liveAuthority.responseDeadline,
            hashAlgorithm: "SHA-256",
            canonicalizationVersion: "canonical-json-v1",
            selectionHash,
            idempotencyKey: callerKey,
          },
        }),
      );
      return records.map((record) => ({ file: "events", record }));
    },
  });
}

export async function invalidateAuditPeriod({ store, now, command = {} }) {
  const payload = command.payload || {};
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const selectionId = payload.auditSampleSelectionReceiptId;
  const selection = (projected.events || []).find(
    (row) =>
      row &&
      row.schema === "audit-sample-selection-receipt-v1" &&
      row.id === selectionId,
  );
  if (!selection) {
    fail("INPUT_REF_MISMATCH", "selection receipt is not committed");
  }
  const reasonCode = payload.reasonCode || "SELECTION_INVALID";
  const allowed = new Set([
    "POLICY_VIOLATION",
    "WATERMARK_INVALID",
    "UNIVERSE_INVALID",
    "SELECTION_INVALID",
  ]);
  if (!allowed.has(reasonCode)) {
    fail("INVALID_COMMAND", "invalidation reasonCode is not allowed");
  }
  const key = `audit-invalidation-v1:${selection.id}:${reasonCode}`;
  const correlationId = `ainv:${selection.auditPeriodId}`;
  return runtime.execute({
    commandType: "invalidateAuditPeriod",
    idempotencyKey: key,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      auditSampleSelectionReceiptId: selection.id,
      reasonCode,
    },
    immutableInputRefs: [
      { type: "AUDIT_SAMPLE_SELECTION", id: selection.id, hash: canonicalHash(selection) },
    ],
    builderVersion: "audit-invalidation-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({ assignId, targetCommitGroupId, now: stamped }) => [
      {
        file: "events",
        record: envelope({
          schema: "audit-period-invalidation-receipt-v1",
          id: assignId("audit-period-invalidation-receipt-v1", "invalidation"),
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: null,
          policyVersion: POLICY_VERSION,
          extra: {
            auditPeriodAuthorityReceiptId: selection.auditPeriodAuthorityReceiptId,
            auditSampleSelectionReceiptId: selection.id,
            reasonCode,
            evidenceRefs: Array.isArray(payload.evidenceRefs)
              ? payload.evidenceRefs
              : [],
            invalidatedAt: stamped,
          },
        }),
      },
    ],
  });
}

export { ledgerHeads, semanticSelectionKey };
