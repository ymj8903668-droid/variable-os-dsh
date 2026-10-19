// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { isTerminalState } from "../label/helpers.mjs";
import { uniqueChainHead } from "../feedback/heads.mjs";
import { authorityHashFromReceipt } from "./policy.mjs";
import { selectionHashOf } from "./selection.mjs";
import { eventsAtAsOf } from "../ledger/as-of.mjs";
import { frozenPayloadHash, itemIdOf, taskIdOf } from "./universe.mjs";
import { expandLedgerWatermark } from "./watermark.mjs";

function uniqueAdj(rows) {
  try {
    return { head: uniqueChainHead(rows), reason: null };
  } catch (err) {
    if (err && err.code === "HEAD_AMBIGUOUS") {
      return { head: null, reason: "AUDIT_ADJUDICATION_INCONSISTENT" };
    }
    throw err;
  }
}

export function uniqueWorkflowHead(events, objectId) {
  const rows = (events || []).filter(
    (row) =>
      row &&
      row.schema === "workflow-state-event-v1" &&
      row.objectId === objectId,
  );
  if (rows.length === 0) {
    return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
  }
  if (rows.some((row) => row.objectType !== "REVIEW_TASK")) {
    return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const referenced = new Set(
    rows.map((row) => row.previousStateEventId).filter(Boolean),
  );
  const heads = rows.filter((row) => !referenced.has(row.id));
  if (heads.length !== 1) {
    return { head: null, reason: "AUDIT_TASK_FORK" };
  }
  const roots = rows.filter((row) => !row.previousStateEventId);
  if (roots.length !== 1) {
    return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
  }
  const head = heads[0];
  const seen = new Set();
  let cursor = head;
  let expectedVersion = head.stateVersion;
  while (cursor) {
    if (seen.has(cursor.id)) {
      return { head: null, reason: "AUDIT_TASK_FORK" };
    }
    seen.add(cursor.id);
    if (cursor.objectId !== objectId || cursor.objectType !== "REVIEW_TASK") {
      return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
    }
    if (cursor.stateVersion !== expectedVersion) {
      return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
    }
    expectedVersion -= 1;
    if (!cursor.previousStateEventId) {
      if (
        cursor.id !== roots[0].id ||
        cursor.stateVersion !== 1 ||
        cursor.fromState !== null ||
        cursor.expectedHeadId != null ||
        cursor.expectedStateVersion != null
      ) {
        return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
      }
      break;
    }
    const prev = byId.get(cursor.previousStateEventId);
    if (!prev) {
      return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
    }
    if (
      prev.objectId !== objectId ||
      prev.objectType !== "REVIEW_TASK" ||
      prev.toState !== cursor.fromState ||
      cursor.expectedHeadId !== prev.id ||
      cursor.expectedStateVersion !== prev.stateVersion ||
      cursor.previousStateEventId !== prev.id
    ) {
      return { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
    }
    cursor = prev;
  }
  if (seen.size !== rows.length) {
    return { head: null, reason: "AUDIT_TASK_FORK" };
  }
  return { head, reason: null };
}

function verifyReceiptIntegrity({ events, sourceItems, receipt, authority }) {
  const reasons = [];
  if (authority) {
    if (receipt.auditPeriodAuthorityReceiptId !== authority.id) {
      reasons.push("AUTHORITY_REF_MISMATCH");
    }
    if (receipt.auditPeriodAuthorityHash !== authority.authorityHash) {
      reasons.push("AUTHORITY_HASH_MISMATCH");
    }
    if (authority.authorityHash !== authorityHashFromReceipt(authority)) {
      reasons.push("AUTHORITY_HASH_MISMATCH");
    }
  } else {
    reasons.push("MISSING_AUDIT_AUTHORITY");
  }
  const recomputedSelection = selectionHashOf({
    authorityKey: receipt.authorityKey,
    auditPeriodAuthorityReceiptId: receipt.auditPeriodAuthorityReceiptId,
    auditPeriodAuthorityHash: receipt.auditPeriodAuthorityHash,
    inputWatermarkHash: receipt.inputWatermarkHash,
    universeHash: receipt.universeHash,
    samplingSeed: receipt.samplingSeed,
    selectedAuditSampleItemIds: receipt.selectedAuditSampleItemIds,
    responseDeadline: receipt.responseDeadline,
  });
  if (recomputedSelection !== receipt.selectionHash) {
    reasons.push("SELECTION_HASH_MISMATCH");
  }
  const selected = [...(receipt.selectedAuditSampleItemIds || [])].sort();
  if (receipt.sampleSize !== selected.length) {
    reasons.push("SAMPLE_SIZE_MISMATCH");
  }
  const items = (events || []).filter(
    (row) =>
      row &&
      row.schema === "audit-sample-item-v1" &&
      row.auditSampleSelectionReceiptId === receipt.id,
  );
  const actual = items.map((row) => row.id).sort();
  if (canonicalHash(selected) !== canonicalHash(actual)) {
    reasons.push("AUDIT_ITEM_MISMATCH");
  }
  const sameGroup = items.filter((row) => row.commitGroupId === receipt.commitGroupId);
  if (sameGroup.length !== items.length) {
    reasons.push("AUDIT_ITEM_MISMATCH");
  }
  const watermark = (events || []).find(
    (row) => row.id === receipt.inputLedgerWatermarkReceiptId,
  );
  const expanded = expandLedgerWatermark(
    { events, sourceItems: sourceItems || [] },
    watermark,
  );
  if (!expanded.ok) {
    reasons.push("WATERMARK_INVALID");
  } else if (expanded.hash !== receipt.inputWatermarkHash) {
    reasons.push("WATERMARK_HASH_MISMATCH");
  }
  for (const item of items) {
    const expectedItemId = itemIdOf(receipt.id, canonicalHash(item.reviewTarget));
    if (item.id !== expectedItemId) {
      reasons.push("AUDIT_ITEM_ID_MISMATCH");
    }
    const expectedTaskId = taskIdOf(item.id);
    if (item.reviewTaskId !== expectedTaskId) {
      reasons.push("AUDIT_TASK_ID_MISMATCH");
    }
    if (item.commitGroupId !== receipt.commitGroupId) {
      reasons.push("AUDIT_ITEM_MISMATCH");
    }
    if (frozenPayloadHash(item.frozenReviewPayload) !== item.frozenReviewPayloadHash) {
      reasons.push("AUDIT_PAYLOAD_HASH_MISMATCH");
    }
    if (
      !item.frozenReviewPayload ||
      item.frozenReviewPayload.context == null ||
      (item.reviewTarget &&
        item.reviewTarget.type === "SCREENING_ATTEMPT" &&
        (!item.frozenReviewPayload.attempt ||
          !item.frozenReviewPayload.decision ||
          !item.frozenReviewPayload.exposure))
    ) {
      reasons.push("AUDIT_PAYLOAD_INCOMPLETE");
    }
    const tasks = (events || []).filter(
      (row) =>
        row &&
        row.schema === "review-task-v1" &&
        row.id === item.reviewTaskId &&
        row.priorityBucket === "BLIND_AUDIT",
    );
    if (tasks.length !== 1) {
      reasons.push("AUDIT_TASK_INCONSISTENT");
      continue;
    }
    const task = tasks[0];
    if (
      !task.objectRef ||
      task.objectRef.id !== item.id ||
      task.commitGroupId !== receipt.commitGroupId
    ) {
      reasons.push("AUDIT_TASK_INCONSISTENT");
    }
    const openState = (events || []).find(
      (row) => row.id === item.reviewTaskOpenStateEventId,
    );
    if (
      !openState ||
      openState.toState !== "OPEN" ||
      openState.objectId !== task.id ||
      openState.commitGroupId !== receipt.commitGroupId
    ) {
      reasons.push("AUDIT_TASK_INCONSISTENT");
    }
    const chain = uniqueWorkflowHead(events, task.id);
    if (chain.reason) {
      reasons.push(chain.reason);
    }
  }
  return [...new Set(reasons)];
}

export function collectAuditInclusion(events, requiredPeriodIds, extras = {}) {
  const reasons = [];
  const receipts = [];
  const required = [...(requiredPeriodIds || [])].sort();
  const sourceItems = extras.sourceItems || [];
  for (const periodId of required) {
    const matches = (events || []).filter(
      (row) =>
        row &&
        row.schema === "audit-sample-selection-receipt-v1" &&
        row.auditPeriodId === periodId,
    );
    if (matches.length === 0) {
      reasons.push("MISSING_AUDIT_RECEIPT");
      continue;
    }
    if (matches.length > 1) {
      reasons.push("COMPETING_AUDIT_RECEIPT");
      continue;
    }
    const receipt = matches[0];
    const invalidations = (events || []).filter(
      (row) =>
        row &&
        row.schema === "audit-period-invalidation-receipt-v1" &&
        row.auditSampleSelectionReceiptId === receipt.id,
    );
    if (invalidations.length) {
      reasons.push("INVALIDATED_AUDIT_PERIOD");
    }
    const authority =
      extras.authority ||
      (events || []).find(
        (row) =>
          row &&
          row.schema === "audit-period-authority-receipt-v1" &&
          row.auditPeriodId === periodId,
      );
    reasons.push(
      ...verifyReceiptIntegrity({ events, sourceItems, receipt, authority }),
    );
    receipts.push(receipt);
  }
  const ids = receipts.map((row) => row.id).sort();
  return {
    receipts,
    ids,
    count: ids.length,
    hash: canonicalHash(ids),
    reasonCodes: [...new Set(reasons)],
    requiredPeriodIds: required,
  };
}

export function auditResponseRef({ events, receipt, item, asOf }) {
  const reasons = [];
  const scoped = eventsAtAsOf(events, asOf);
  const task = scoped.find(
    (row) => row && row.schema === "review-task-v1" && row.id === item.reviewTaskId,
  );
  const chain = task ? uniqueWorkflowHead(scoped, task.id) : { head: null, reason: "AUDIT_TASK_INCONSISTENT" };
  const state = chain.head;
  if (!task || !state) {
    return {
      ok: false,
      reasonCodes: [chain.reason || "AUDIT_TASK_INCONSISTENT"],
      ref: null,
    };
  }
  if (chain.reason) {
    reasons.push(chain.reason);
  }
  const invalidated = scoped.some(
    (row) =>
      row.schema === "audit-period-invalidation-receipt-v1" &&
      row.auditSampleSelectionReceiptId === receipt.id,
  );
  const adjs = scoped.filter(
    (row) =>
      row &&
      row.schema === "opportunity-adjudication-v1" &&
      row.mode === "BLIND_REPLAY" &&
      row.sourceAuditSampleItemId === item.id,
  );
  const { head: adj, reason: adjReason } = uniqueAdj(adjs);
  if (adjReason) {
    reasons.push(adjReason);
  }
  const deadline = receipt.responseDeadline;
  const pastDeadline = asOf >= deadline;
  let taskStateAtAsOf = state.toState;
  let responseStatus = "PENDING";
  let adjudicationId = null;
  let responseAt = null;
  if (invalidated) {
    responseStatus = "INVALIDATED_PERIOD";
  } else if (adj && state.toState === "COMPLETED") {
    const snapshot = scoped.find(
      (row) =>
        row.schema === "human-decision-snapshot-v1" &&
        row.id === adj.humanDecisionSnapshotId,
    );
    const completed = scoped.find(
      (row) =>
        row.schema === "workflow-state-event-v1" &&
        row.objectId === task.id &&
        row.toState === "COMPLETED" &&
        row.id === state.id,
    );
    if (
      adj.sourceAuditSampleItemId !== item.id ||
      !snapshot ||
      snapshot.purpose !== "OPPORTUNITY_BLIND_REPLAY" ||
      snapshot.targetRef?.id !== item.id ||
      snapshot.auditTaskId !== task.id ||
      snapshot.actorId !== adj.actorId ||
      snapshot.opportunityId !== item.opportunityId ||
      adj.opportunityId !== item.opportunityId ||
      snapshot.commitGroupId !== adj.commitGroupId ||
      snapshot.correlationId !== adj.correlationId ||
      !completed ||
      completed.commitGroupId !== adj.commitGroupId ||
      completed.correlationId !== adj.correlationId
    ) {
      reasons.push("AUDIT_ADJUDICATION_INCONSISTENT");
    }
    responseStatus = "RESPONDED";
    adjudicationId = adj.id;
    responseAt = adj.adjudicatedAt;
    taskStateAtAsOf = "COMPLETED";
  } else if (pastDeadline) {
    responseStatus = "NO_RESPONSE";
    taskStateAtAsOf = isTerminalState(state.toState) ? state.toState : "EXPIRED";
    if (adj) {
      reasons.push("AUDIT_ADJUDICATION_INCONSISTENT");
    }
  } else if (state.toState === "OPEN" || state.toState === "IN_PROGRESS") {
    responseStatus = "PENDING";
    taskStateAtAsOf = state.toState;
  } else {
    reasons.push("AUDIT_TASK_INCONSISTENT");
  }
  return {
    ok: reasons.length === 0,
    reasonCodes: reasons,
    ref: {
      receiptId: receipt.id,
      auditSampleItemId: item.id,
      opportunityClassIdAtSelection: item.opportunityClassIdAtSelection,
      reviewTaskId: task.id,
      taskStateAtAsOf,
      taskStateHeadEventId: state.id,
      responseStatus,
      adjudicationId,
      responseAt,
      responseReasonCodes: [],
    },
  };
}

export function attachAuditSampleRefs({ members, events, asOf, receipts }) {
  const reasons = [];
  const next = (members || []).map((row) => ({
    ...row,
    auditSampleSelectionRefs: [],
  }));
  const seenItems = new Set();
  for (const receipt of receipts || []) {
    const items = (events || []).filter(
      (row) =>
        row &&
        row.schema === "audit-sample-item-v1" &&
        row.auditSampleSelectionReceiptId === receipt.id,
    );
    for (const item of items) {
      seenItems.add(item.id);
      const built = auditResponseRef({ events, receipt, item, asOf });
      if (!built.ok) {
        reasons.push(...built.reasonCodes);
        continue;
      }
      const member = next.find((row) =>
        (row.memberOpportunityIds || []).includes(item.opportunityId),
      );
      if (!member) {
        reasons.push("MISSING_AUDIT_CLASS");
        continue;
      }
      member.auditSampleSelectionRefs.push(built.ref);
    }
  }
  for (const member of next) {
    member.auditSampleSelectionRefs.sort((left, right) =>
      left.auditSampleItemId < right.auditSampleItemId
        ? -1
        : left.auditSampleItemId > right.auditSampleItemId
          ? 1
          : 0,
    );
  }
  return {
    members: next,
    reasonCodes: [...new Set(reasons)],
    selectedItemCount: seenItems.size,
  };
}
