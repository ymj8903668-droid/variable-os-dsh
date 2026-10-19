// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { loadHorizonCalendar } from "../card/horizon.mjs";
import { fail } from "./errors.mjs";

export const ACTOR_ID = "human:primary-reviewer";
export const ACTOR_TYPE = "HUMAN";
export const POLICY_VERSION = "human-label-v1";
export const REACTION_SEARCH_RULE_VERSION = "reaction-search-v1";
export const CALENDAR_RULE_VERSION = "a-share-horizon-v1";
export const AGGREGATION_RULE_VERSION = "judgment-timing-v1";
export const WATCH_RULE_VERSION = "watch-task-v1";
export const FERMENTATION_RULE_VERSION = "fermentation-rule-v1";
export const MAPPING_RULE_VERSION = "mapping-rule-v1";

const calendarPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/calendar/a-share-2026-q3.json",
);

let calendarPromise = null;

export function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

export async function loadCalendar() {
  if (!calendarPromise) {
    calendarPromise = loadHorizonCalendar(calendarPath).catch((err) => {
      calendarPromise = null;
      fail("INVALID_WATCH_HORIZON", "synthetic calendar unavailable", {
        cause: err && err.code,
      });
    });
  }
  return calendarPromise;
}

export function requireActor(command) {
  const actorId = command && command.actorId;
  const actorType = command && command.actorType;
  if (actorId !== ACTOR_ID || actorType !== ACTOR_TYPE) {
    fail("ACTOR_FORBIDDEN", "actor is not on the allowlist");
  }
}

export function envelope({ schema, id, now, actorType, actorId, correlationId, targetCommitGroupId, supersedesId, extra }) {
  return {
    schema,
    id,
    createdAt: now,
    recordedAt: now,
    actorType,
    actorId,
    correlationId,
    commitGroupId: targetCommitGroupId,
    supersedesId: supersedesId ?? null,
    policyVersion: POLICY_VERSION,
    ...extra,
  };
}

export function committedEventsOf(committedProjection) {
  if (!committedProjection || !Array.isArray(committedProjection.events)) {
    fail("LEDGER_CORRUPT", "committed projection unavailable");
  }
  return committedProjection.events;
}

export function chainHead(rows, skipId = null) {
  const list = (rows || []).filter(
    (row) => row && typeof row.id === "string" && row.id !== skipId,
  );
  const superseded = new Set(list.map((row) => row.supersedesId).filter(Boolean));
  const heads = list.filter((row) => !superseded.has(row.id));
  if (heads.length > 1) {
    fail("HEAD_AMBIGUOUS", "multiple current heads");
  }
  return heads[0] || null;
}

export function currentLabelHead(events, cardRevisionId, skipId = null) {
  return chainHead(
    events.filter(
      (row) =>
        row &&
        row.schema === "human-label-v1" &&
        row.cardRevisionId === cardRevisionId,
    ),
    skipId,
  );
}

export function currentAdjudicationHead(events, opportunityId, skipId = null) {
  return chainHead(
    events.filter(
      (row) =>
        row &&
        row.schema === "opportunity-adjudication-v1" &&
        row.opportunityId === opportunityId &&
        row.mode === "LIVE_LABEL",
    ),
    skipId,
  );
}

export function reviewsForTarget(events, targetId) {
  return events.filter((row) => {
    if (!row || row.schema !== "mapping-review-v1") {
      return false;
    }
    if (row.target && row.target.id === targetId) {
      return true;
    }
    return row.review === "CORRECTED" && row.replacementTargetId === targetId;
  });
}

export function currentReviewHead(events, targetId, skipId = null) {
  return chainHead(reviewsForTarget(events, targetId), skipId);
}

const CARD_VISIBLE_FIELDS = Object.freeze([
  "id",
  "eventSummary",
  "expectationGap",
  "whyTradable",
  "expectedHorizon",
  "uncertainties",
  "systemDecisionAt",
  "origin",
  "decisionContextId",
  "opportunityId",
  "variableId",
]);

export function pickVisibleCard(card) {
  const out = {};
  for (const key of CARD_VISIBLE_FIELDS) {
    out[key] = card && Object.prototype.hasOwnProperty.call(card, key) ? card[key] : null;
  }
  return out;
}

export function currentEntityRows(events, schema, cardRevisionId) {
  const rows = events.filter(
    (row) =>
      row && row.schema === schema && row.cardRevisionId === cardRevisionId,
  );
  const superseded = new Set(rows.map((row) => row.supersedesId).filter(Boolean));
  return rows
    .filter((row) => !superseded.has(row.id))
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function visiblePayloadHashOf({
  card,
  themes,
  securities,
  presentationInteractionId,
  openedInteractionId,
}) {
  return canonicalHash({
    card: pickVisibleCard(card),
    themes: (themes || []).map((row) => canonicalHash(row)).sort(),
    securities: (securities || []).map((row) => canonicalHash(row)).sort(),
    presentationInteractionId: presentationInteractionId ?? null,
    openedInteractionId: openedInteractionId ?? null,
  });
}

export function latestInteraction(events, { cardRevisionId, actorId, eventType }) {
  const rows = events
    .filter(
      (row) =>
        row &&
        row.schema === "delivery-interaction-v1" &&
        row.eventType === eventType &&
        row.cardRevisionId === cardRevisionId &&
        row.actorId === actorId,
    )
    .slice()
    .sort((left, right) => {
      const leftAt = left.occurredAt || left.recordedAt || "";
      const rightAt = right.occurredAt || right.recordedAt || "";
      if (leftAt !== rightAt) {
        return leftAt < rightAt ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  return rows.length ? rows[rows.length - 1] : null;
}

export function latestStateEvent(events, objectId) {
  const rows = events
    .filter(
      (row) =>
        row &&
        row.schema === "workflow-state-event-v1" &&
        row.objectId === objectId,
    )
    .slice()
    .sort((left, right) => {
      if (left.stateVersion !== right.stateVersion) {
        return left.stateVersion - right.stateVersion;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  return rows.length ? rows[rows.length - 1] : null;
}

export function watchTaskForLabel(events, watchLabelId) {
  const tasks = events.filter(
    (row) =>
      row && row.schema === "review-task-v1" && row.watchLabelId === watchLabelId,
  );
  return tasks.length ? tasks[tasks.length - 1] : null;
}

export function isTerminalState(state) {
  return state === "CANCELED" || state === "COMPLETED" || state === "EXPIRED";
}

export function emptyAssessmentSetHash() {
  return canonicalHash([]);
}

export function outcomeStatus({ exposed, kind }) {
  if (!exposed) {
    return "NOT_EXPOSED_IN_PRODUCT";
  }
  if (kind === "label") {
    return "EXPOSED_BEFORE_LABEL";
  }
  if (kind === "review") {
    return "EXPOSED_BEFORE_REVIEW";
  }
  return "EXPOSED_BEFORE_DECISION";
}

export function assertExposureMatch(live, payload) {
  if (
    live.setHash !== payload.expectedOpportunityExposureSetHash ||
    (live.headId ?? null) !== (payload.expectedExposureHeadId ?? null)
  ) {
    fail("EXPOSURE_CONFLICT", "opportunity exposure set changed");
  }
}

export function idsOf(events, schema, cardRevisionId) {
  return events
    .filter(
      (row) =>
        row && row.schema === schema && row.cardRevisionId === cardRevisionId,
    )
    .map((row) => row.id)
    .sort();
}

export function timingRecord({
  id,
  now,
  actorType,
  actorId,
  correlationId,
  targetCommitGroupId,
  target,
  visibleDataAsOf,
}) {
  return envelope({
    schema: "human-judgment-timing-assessment-v1",
    id,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      target,
      reactionTiming: "REACTION_UNKNOWN",
      reactionAtUsed: null,
      reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
      marketDataAsOf: visibleDataAsOf,
      sourceReactionSearchAssessmentIds: [],
      sourceReactionAssessmentSetHash: emptyAssessmentSetHash(),
      aggregationRuleVersion: AGGREGATION_RULE_VERSION,
      assessedAt: now,
    },
  });
}

export function snapshotRecord({
  id,
  now,
  actorType,
  actorId,
  correlationId,
  targetCommitGroupId,
  purpose,
  targetRef,
  card,
  themeHypothesisIds,
  securityMappingIds,
  presentationInteractionId,
  exposure,
  exposed,
  visiblePayloadHash,
}) {
  return envelope({
    schema: "human-decision-snapshot-v1",
    id,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      visibleDataAsOf: now,
      reactionSearchRuleVersionAtDecision: REACTION_SEARCH_RULE_VERSION,
      visiblePayloadHash,
      exposureHeadIdAtDecision: exposure.headId,
      outcomeExposureStatus: outcomeStatus({
        exposed,
        kind: "decision",
      }),
      reviewerExposureAudit: {
        opportunityClassIds: exposure.opportunityClassIds,
        memberOpportunityIds: exposure.memberOpportunityIds,
        approvedRelationDecisionIds: exposure.approvedRelationDecisionIds,
        relatedCardRevisionIds: exposure.relatedCardRevisionIds,
        priorOutcomeExposureInteractionIds:
          exposure.priorOutcomeExposureInteractionIds,
        auditedAt: now,
        auditHash: canonicalHash({
          opportunityClassIds: exposure.opportunityClassIds,
          memberOpportunityIds: exposure.memberOpportunityIds,
          approvedRelationDecisionIds: exposure.approvedRelationDecisionIds,
          relatedCardRevisionIds: exposure.relatedCardRevisionIds,
          priorOutcomeExposureInteractionIds:
            exposure.priorOutcomeExposureInteractionIds,
          auditedAt: now,
        }),
      },
      reviewerKnowledgeDeclaration: "NOT_COLLECTED",
      purpose,
      targetRef,
      presentationInteractionId,
      auditTaskId: null,
      cardRevisionId: card.id,
      decisionContextId: card.decisionContextId,
      themeHypothesisIds,
      securityMappingIds,
    },
  });
}

export function plannedLabelId(cardRevisionId, clientActionId) {
  return brandedId("lbl_", { cardRevisionId, clientActionId });
}

export function plannedReviewId(targetId, clientActionId) {
  return brandedId("mrev_", { targetId, clientActionId });
}
