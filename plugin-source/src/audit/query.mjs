// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { fail } from "./errors.mjs";
import { findInvalidations } from "./selection.mjs";
import { uniqueWorkflowHead } from "./inclusion.mjs";

const FORBIDDEN =
  /fermentationResult|mappingEvaluation|marketObservation|returnPct|firstReactionAt|AUDIT_SAMPLE_MISS|HUMAN_MISS|今日无变量/;

function summaryOf(item) {
  const payload = item.frozenReviewPayload || {};
  if (item.reviewTarget.type === "SCREENING_ATTEMPT") {
    const context = payload.context;
    const decision = payload.decision;
    return {
      eventSummary:
        (context &&
          context.engine &&
          context.engine.canonicalDecisionInput &&
          context.engine.canonicalDecisionInput.ruleInput &&
          context.engine.canonicalDecisionInput.ruleInput.sourceDocumentKey) ||
        item.reviewTarget.screeningAttemptId,
      whyTradable: null,
      uncertainties: [],
      screeningReasonCode: decision ? decision.reasonCode : item.reviewTarget.screeningReasonCode,
    };
  }
  const card = payload.card;
  return {
    eventSummary: card ? card.eventSummary : item.reviewTarget.opportunityClassId,
    whyTradable: card ? card.whyTradable : null,
    uncertainties: card && Array.isArray(card.uncertainties) ? card.uncertainties : [],
    screeningReasonCode: null,
  };
}

function contextItemsOf(item) {
  const context =
    item.frozenReviewPayload && item.frozenReviewPayload.context
      ? item.frozenReviewPayload.context
      : null;
  const rows = context && Array.isArray(context.contextItems) ? context.contextItems : [];
  return rows.map((row) => ({
    stream: row.stream,
    availableAt: row.availableAt,
    contentHash: row.contentHash,
  }));
}

export function projectBlindTasks(events, { taskId = null, now = null } = {}) {
  const items = (events || []).filter(
    (row) => row && row.schema === "audit-sample-item-v1",
  );
  const tasks = [];
  for (const item of items) {
    const task = (events || []).find(
      (row) => row.schema === "review-task-v1" && row.id === item.reviewTaskId,
    );
    if (!task || task.priorityBucket !== "BLIND_AUDIT") {
      continue;
    }
    const chain = uniqueWorkflowHead(events, task.id);
    const state = chain.head;
    if (!state || state.toState !== "OPEN" || chain.reason) {
      continue;
    }
    const receipt = (events || []).find(
      (row) =>
        row.schema === "audit-sample-selection-receipt-v1" &&
        row.id === item.auditSampleSelectionReceiptId,
    );
    if (!receipt) {
      continue;
    }
    if (findInvalidations(events, receipt.id).length) {
      continue;
    }
    if (now && receipt.responseDeadline && now >= receipt.responseDeadline) {
      continue;
    }
    const summary = summaryOf(item);
    const view = {
      reviewTaskId: task.id,
      auditSampleItemId: item.id,
      opportunityId: item.opportunityId,
      auditSampleSelectionReceiptId: receipt.id,
      expectedTaskHeadId: state.id,
      expectedTaskStateVersion: state.stateVersion,
      frozenReviewPayloadHash: item.frozenReviewPayloadHash,
      frozenReviewTarget: {
        type: item.reviewTarget.type,
        screeningAttemptId: item.reviewTarget.screeningAttemptId || null,
        representativeCardRevisionId:
          item.reviewTarget.representativeCardRevisionId || null,
        decisionContextId: item.reviewTarget.decisionContextId,
      },
      dueAt: task.reviewDueAt,
      eventSummary: summary.eventSummary,
      whyTradable: summary.whyTradable,
      uncertainties: summary.uncertainties,
      screeningReasonCode: summary.screeningReasonCode,
      contextItems: contextItemsOf(item),
    };
    const blob = JSON.stringify(view);
    if (FORBIDDEN.test(blob)) {
      fail("VIEW_POLLUTED", "outcome or miss identity leaked into blind view");
    }
    tasks.push(view);
  }
  tasks.sort((left, right) =>
    left.reviewTaskId < right.reviewTaskId
      ? -1
      : left.reviewTaskId > right.reviewTaskId
        ? 1
        : 0,
  );
  const selected = taskId
    ? tasks.find((row) => row.reviewTaskId === taskId) || null
    : tasks[0] || null;
  return { tasks, selected };
}
