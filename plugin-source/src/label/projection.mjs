// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import {
  computeExposureSet,
  createExposureProjectionIndex,
} from "./exposure.mjs";
import {
  ACTOR_ID,
  currentEntityRows,
  currentLabelHead,
  currentReviewHead,
  isTerminalState,
  latestInteraction,
  latestStateEvent,
  watchTaskForLabel,
} from "./helpers.mjs";

function reviewOf(events, targetId) {
  const head = currentReviewHead(events, targetId);
  return head ? head.review : "UNREVIEWED";
}

function pushIndexed(map, key, row) {
  if (!key) return;
  const rows = map.get(key) || [];
  rows.push(row);
  map.set(key, rows);
}

function indexedRows(index, map, key, fallback) {
  return index ? map.get(key) || [] : fallback;
}

export function createCardLabelProjectionIndex(events, actorId = ACTOR_ID) {
  const rows = Array.isArray(events) ? events : [];
  const labelsByCard = new Map();
  const themesByCard = new Map();
  const securitiesByCard = new Map();
  const reviewsByTarget = new Map();
  const presentedByCard = new Map();
  const tasksByLabel = new Map();
  const statesByObject = new Map();
  for (const row of rows) {
    switch (row?.schema) {
      case "human-label-v1":
        pushIndexed(labelsByCard, row.cardRevisionId, row);
        break;
      case "theme-hypothesis-v1":
        pushIndexed(themesByCard, row.cardRevisionId, row);
        break;
      case "security-mapping-v1":
        pushIndexed(securitiesByCard, row.cardRevisionId, row);
        break;
      case "mapping-review-v1": {
        const targetIds = new Set([
          row.target?.id,
          row.review === "CORRECTED" ? row.replacementTargetId : null,
        ]);
        for (const targetId of targetIds) pushIndexed(reviewsByTarget, targetId, row);
        break;
      }
      case "delivery-interaction-v1":
        if (row.eventType === "PRESENTED" && row.actorId === actorId) {
          pushIndexed(presentedByCard, row.cardRevisionId, row);
        }
        break;
      case "review-task-v1":
        pushIndexed(tasksByLabel, row.watchLabelId, row);
        break;
      case "workflow-state-event-v1":
        pushIndexed(statesByObject, row.objectId, row);
        break;
      default:
        break;
    }
  }
  return {
    events: rows,
    actorId,
    exposure: createExposureProjectionIndex(rows, actorId),
    labelsByCard,
    themesByCard,
    securitiesByCard,
    reviewsByTarget,
    presentedByCard,
    tasksByLabel,
    statesByObject,
  };
}

export function projectCardLabelState(
  events,
  card,
  actorId = ACTOR_ID,
  index = null,
) {
  const indexed = index?.events === events && index.actorId === actorId ? index : null;
  const exposure = computeExposureSet({
    events,
    actorId,
    card,
    index: indexed?.exposure,
  });
  const label = currentLabelHead(
    indexedRows(indexed, indexed?.labelsByCard, card.id, events),
    card.id,
  );
  const watchTask =
    label && label.label === "WATCH"
      ? watchTaskForLabel(
          indexedRows(indexed, indexed?.tasksByLabel, label.id, events),
          label.id,
        )
      : null;
  const watchState = watchTask
    ? latestStateEvent(
        indexedRows(indexed, indexed?.statesByObject, watchTask.id, events),
        watchTask.id,
      )
    : null;
  const activeWatch =
    watchTask && watchState && !isTerminalState(watchState.toState)
      ? {
          id: watchTask.id,
          reviewDueAt: watchTask.reviewDueAt,
          state: watchState.toState,
          watchLabelId: watchTask.watchLabelId,
        }
      : null;
  const themes = currentEntityRows(
    indexedRows(indexed, indexed?.themesByCard, card.id, events),
    "theme-hypothesis-v1",
    card.id,
  ).map(
    (row) => {
      const head = currentReviewHead(
        indexedRows(indexed, indexed?.reviewsByTarget, row.id, events),
        row.id,
      );
      return {
        id: row.id,
        themeRef: row.themeRef,
        narrative: row.narrative,
        review: head ? head.review : "UNREVIEWED",
        expectedReviewHeadId: head ? head.id : null,
      };
    },
  );
  const securities = currentEntityRows(
    indexedRows(indexed, indexed?.securitiesByCard, card.id, events),
    "security-mapping-v1",
    card.id,
  ).map((row) => {
    const head = currentReviewHead(
      indexedRows(indexed, indexed?.reviewsByTarget, row.id, events),
      row.id,
    );
    return {
      id: row.id,
      securityCode: row.securityCode,
      themeHypothesisId: row.themeHypothesisId,
      review: head ? head.review : "UNREVIEWED",
      expectedReviewHeadId: head ? head.id : null,
    };
  });
  const themeReview =
    themes.find((row) => row.review !== "UNREVIEWED")?.review || "UNREVIEWED";
  const mappingReview =
    securities.find((row) => row.review !== "UNREVIEWED")?.review ||
    "UNREVIEWED";
  const presented = latestInteraction(indexedRows(
    indexed,
    indexed?.presentedByCard,
    card.id,
    events,
  ), {
    cardRevisionId: card.id,
    actorId,
    eventType: "PRESENTED",
  });
  return {
    currentLabel: {
      state: label ? label.label : "UNLABELED",
      id: label ? label.id : null,
      labeledAt: label ? label.labeledAt : null,
      outcomeExposureStatus: label ? label.outcomeExposureStatus : null,
      reviewNote: label ? label.reviewNote || "" : "",
      selectedEvidenceIds:
        label && Array.isArray(label.selectedEvidenceIds)
          ? label.selectedEvidenceIds
          : [],
    },
    currentWatchTask: activeWatch,
    expectedLabelHeadId: label ? label.id : null,
    expectedExposureHeadId: exposure.headId,
    expectedOpportunityExposureSetHash: exposure.setHash,
    presentationInteractionId: presented ? presented.id : null,
    themeReview,
    mappingReview,
    themes,
    securities,
  };
}

export { reviewOf };
