// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
function projectionError(message, details = {}) {
  const error = new Error(message);
  error.code = "CATALYST_WATCH_PROJECTION_INVALID";
  Object.assign(error, details);
  return error;
}

function currentState(events, watchId) {
  const stateEvents = events
    .filter(
      (row) =>
        row?.schema === "catalyst-watch-state-event-v1" &&
        row.watchId === watchId,
    )
    .sort((left, right) => {
      const sequence = Number(left.stateSequence) - Number(right.stateSequence);
      return sequence || String(left.id).localeCompare(String(right.id));
    });
  const superseded = new Set(
    stateEvents.map((row) => row.supersedesId).filter(Boolean),
  );
  const heads = stateEvents.filter((row) => !superseded.has(row.id));
  if (heads.length !== 1) {
    throw projectionError("watch state must have exactly one head", {
      watchId,
      headCount: heads.length,
    });
  }
  const head = heads[0];
  if (Number(head.stateSequence) !== stateEvents.length) {
    throw projectionError("watch state sequence is incomplete", { watchId });
  }
  return { head, stateEvents };
}

function watchRow(watch, events) {
  const { head, stateEvents } = currentState(events, watch.id);
  return Object.freeze({
    watchId: watch.id,
    screeningAttemptId: watch.screeningAttemptId,
    screeningDecisionId: watch.screeningDecisionId,
    exposureId: watch.exposureId,
    decisionContextId: watch.decisionContextId,
    sourceItemId: watch.sourceItemId,
    sourceNamespace: watch.sourceNamespace,
    sourceType: watch.sourceType,
    sourceRefs: [...watch.sourceRefs],
    evidenceRefs: [...watch.evidenceRefs],
    eventTime: watch.eventTime,
    sourceAvailableAt: watch.sourceAvailableAt,
    ingestedAt: watch.ingestedAt,
    analyzedAt: watch.analyzedAt,
    sourceCutoff: watch.sourceCutoff,
    expiresAt: watch.expiresAt,
    catalystArchetype: watch.catalystArchetype,
    expectedHorizon: watch.expectedHorizon,
    importance: watch.importance,
    evidenceMaturity: watch.evidenceMaturity,
    missingEvidence: [...watch.missingEvidence],
    verificationPlan: [...watch.verificationPlan],
    invalidationConditions: [...watch.invalidationConditions],
    status: head.toState,
    stateHeadId: head.id,
    stateSequence: Number(head.stateSequence),
    policyVersion: watch.policyVersion,
    promptVersion: watch.promptVersion,
    modelVersion: watch.modelVersion,
    createdAt: watch.createdAt,
    stateEvents: stateEvents.map((row) => Object.freeze({
      eventId: row.id,
      fromState: row.fromState,
      toState: row.toState,
      reasonCode: row.reasonCode,
      stateSequence: Number(row.stateSequence),
      transitionedAt: row.transitionedAt,
      formalScreeningDecisionId: row.formalScreeningDecisionId || null,
    })),
  });
}

function uniqueVariables(events) {
  return new Set(
    events
      .filter((row) => row?.schema === "variable-card-revision-v1")
      .map((row) => row.variableId || row.id),
  ).size;
}

export function projectCatalystWatch(projected) {
  const events = Array.isArray(projected?.events) ? projected.events : [];
  const watches = events.filter((row) => row?.schema === "catalyst-watch-v1");
  const watchIds = new Set();
  const rows = watches.map((watch) => {
    if (watchIds.has(watch.id)) {
      throw projectionError("watch identity is duplicated", { watchId: watch.id });
    }
    watchIds.add(watch.id);
    return watchRow(watch, events);
  });
  const decisions = events.filter(
    (row) => row?.schema === "screening-decision-v1",
  );
  const sourceItems = Array.isArray(projected?.sourceItems)
    ? projected.sourceItems
    : [];
  const rejected = decisions.filter((row) => row.decision === "REJECT");
  const deduplicatedVariables = uniqueVariables(events);
  const metrics = Object.freeze({
    sourceItems: sourceItems.length,
    screeningCompleted: decisions.length,
    rejected: rejected.length,
    watchCatalysts: rows.length,
    discarded: rejected.filter((row) => row.rejectDisposition === "DISCARD").length,
    unknownRejectDisposition: rejected.filter(
      (row) => !["WATCH_CATALYST", "DISCARD"].includes(row.rejectDisposition),
    ).length,
    formalPublished: decisions.filter((row) => row.decision === "CREATE_CARD").length,
    linkedExisting: decisions.filter((row) => row.decision === "LINK_TO_EXISTING").length,
    deduplicatedVariables,
    formalCards: deduplicatedVariables,
  });
  return Object.freeze({
    rows: Object.freeze(rows),
    metrics,
  });
}
