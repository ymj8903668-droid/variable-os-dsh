// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import {
  resolveAShareHorizons,
  resolveReactionSearchWindow,
} from "../card/horizon.mjs";
import { fail } from "./errors.mjs";
import { computeExposureSet, isExposed } from "./exposure.mjs";
import {
  ACTOR_ID,
  ACTOR_TYPE,
  CALENDAR_RULE_VERSION,
  FERMENTATION_RULE_VERSION,
  MAPPING_RULE_VERSION,
  POLICY_VERSION,
  REACTION_SEARCH_RULE_VERSION,
  assertExposureMatch,
  clockOf,
  committedEventsOf,
  currentEntityRows,
  currentReviewHead,
  envelope,
  idsOf,
  latestInteraction,
  loadCalendar,
  outcomeStatus,
  plannedReviewId,
  requireActor,
  snapshotRecord,
  timingRecord,
  visiblePayloadHashOf,
} from "./helpers.mjs";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertReplacementPayload(targetType, replacement) {
  if (!replacement || typeof replacement !== "object") {
    fail("REPLACEMENT_REQUIRED", "CORRECTED requires a replacement");
  }
  if (targetType === "THEME_HYPOTHESIS") {
    if (!nonEmpty(replacement.themeRef)) {
      fail("REPLACEMENT_REQUIRED", "CORRECTED theme replacement is required");
    }
    return;
  }
  if (!nonEmpty(replacement.securityCode)) {
    fail("REPLACEMENT_REQUIRED", "CORRECTED mapping replacement is required");
  }
}

const REVIEWS = new Set(["APPROVED", "REJECTED", "CORRECTED"]);

function payloadOf(command) {
  return command && command.payload && typeof command.payload === "object"
    ? command.payload
    : {};
}

function semanticKey(clientActionId) {
  return `mapping-v1:${clientActionId}`;
}

function purposeOf(targetType) {
  return targetType === "THEME_HYPOTHESIS"
    ? "THEME_REVIEW"
    : "SECURITY_MAPPING_REVIEW";
}

function findTarget(events, target, cardRevisionId) {
  if (!target || typeof target !== "object") {
    return null;
  }
  if (target.type === "THEME_HYPOTHESIS") {
    const row = events.find(
      (item) => item.schema === "theme-hypothesis-v1" && item.id === target.id,
    );
    if (!row || row.cardRevisionId !== cardRevisionId) {
      return null;
    }
    return row;
  }
  if (target.type === "SECURITY_MAPPING") {
    const row = events.find(
      (item) => item.schema === "security-mapping-v1" && item.id === target.id,
    );
    if (!row || row.cardRevisionId !== cardRevisionId) {
      return null;
    }
    return row;
  }
  return null;
}

function replacementId(targetType, targetId, clientActionId) {
  if (targetType === "THEME_HYPOTHESIS") {
    return brandedId("thm_", {
      kind: "replacement",
      reviewedTargetId: targetId,
      clientActionId,
    });
  }
  return brandedId("smap_", {
    kind: "replacement",
    reviewedTargetId: targetId,
    clientActionId,
  });
}

function supplementJobId({ jobKind, replacementTargetId, horizon }) {
  return brandedId("fbj_", {
    jobKind,
    replacementTargetId,
    horizon,
    calendarRuleVersion: CALENDAR_RULE_VERSION,
  });
}

function supplementReactionId({ mappingReviewId, relevantThemeId }) {
  return brandedId("rsj_", {
    kind: "REACTION_SEARCH_THEME_SUPPLEMENT",
    mappingReviewId,
    relevantThemeId,
    reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
  });
}

function buildReplacement({
  targetType,
  original,
  replacement,
  snapshotId,
  replacementTargetId,
  now,
  actorType,
  actorId,
  correlationId,
  targetCommitGroupId,
  origin,
}) {
  if (targetType === "THEME_HYPOTHESIS") {
    assertReplacementPayload(targetType, replacement);
    return envelope({
      schema: "theme-hypothesis-v1",
      id: replacementTargetId,
      now,
      actorType,
      actorId,
      correlationId,
      targetCommitGroupId,
      supersedesId: original.id,
      extra: {
        cardRevisionId: original.cardRevisionId,
        decisionContextId: original.decisionContextId,
        knowledgeCutoffAt: now,
        humanDecisionSnapshotId: snapshotId,
        themeRef: replacement.themeRef,
        narrative: replacement.narrative || original.narrative,
        constituentSnapshot:
          replacement.constituentSnapshot || original.constituentSnapshot || [],
        origin,
        fermentationEligibility:
          original.fermentationEligibility || "NOT_EVALUABLE",
      },
    });
  }
  assertReplacementPayload(targetType, replacement);
  return envelope({
    schema: "security-mapping-v1",
    id: replacementTargetId,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    supersedesId: original.id,
    extra: {
      themeHypothesisId: original.themeHypothesisId,
      cardRevisionId: original.cardRevisionId,
      knowledgeCutoffAt: now,
      humanDecisionSnapshotId: snapshotId,
      securityCode: replacement.securityCode,
      thesis: replacement.thesis || original.thesis,
      origin,
      validFrom: now,
      validUntil: null,
    },
  });
}

function verifiableTrigger(card) {
  return typeof card.triggerScanExposureId === "string" &&
    card.triggerScanExposureId.length > 0
    ? card.triggerScanExposureId
    : null;
}

export async function submitMappingReview({ store, now, command, watchCalendar }) {
  if (!command || command.commandType !== "submitMappingReview") {
    fail("UNKNOWN_COMMAND", "only submitMappingReview is allowed");
  }
  requireActor(command);
  const payload = payloadOf(command);
  const review = payload.review;
  if (!REVIEWS.has(review)) {
    fail("INVALID_COMMAND", "review must be APPROVED, REJECTED, or CORRECTED");
  }
  if (typeof payload.cardRevisionId !== "string" || !payload.cardRevisionId) {
    fail("INVALID_COMMAND", "cardRevisionId required");
  }
  if (typeof payload.clientActionId !== "string" || !payload.clientActionId) {
    fail("INVALID_COMMAND", "clientActionId required");
  }
  if (typeof payload.expectedOpportunityExposureSetHash !== "string") {
    fail("INVALID_COMMAND", "expectedOpportunityExposureSetHash required");
  }
  const target = payload.target;
  if (
    !target ||
    (target.type !== "THEME_HYPOTHESIS" && target.type !== "SECURITY_MAPPING") ||
    typeof target.id !== "string"
  ) {
    fail("INVALID_COMMAND", "mapping review target is invalid");
  }
  if (review === "CORRECTED") {
    assertReplacementPayload(target.type, payload.replacement);
  }
  if (review !== "CORRECTED" && payload.replacement != null) {
    fail("INVALID_COMMAND", "APPROVED/REJECTED replacement must be null");
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
  const original = findTarget(projected.events, target, card.id);
  if (!original) {
    fail("INPUT_REF_MISMATCH", "review target is not committed on this card");
  }
  const presented =
    (payload.presentationInteractionId
      ? projected.events.find(
          (row) =>
            row.id === payload.presentationInteractionId &&
            row.schema === "delivery-interaction-v1" &&
            row.eventType === "PRESENTED" &&
            row.cardRevisionId === card.id,
        )
      : null) ||
    latestInteraction(projected.events, {
      cardRevisionId: card.id,
      actorId: ACTOR_ID,
      eventType: "OPENED",
    });
  if (payload.presentationInteractionId && !presented) {
    fail("INPUT_REF_MISMATCH", "PRESENTED interaction is not committed");
  }
  const presentedRow =
    presented && presented.eventType === "PRESENTED"
      ? presented
      : latestInteraction(projected.events, {
          cardRevisionId: card.id,
          actorId: ACTOR_ID,
          eventType: "PRESENTED",
        });
  if (!presentedRow) {
    fail("INPUT_REF_MISMATCH", "PRESENTED interaction is not committed");
  }
  const calendar = review === "CORRECTED" ? watchCalendar ?? await loadCalendar() : null;
  const expectedReviewHeadId = payload.expectedReviewHeadId ?? null;
  const expectedHeads = Array.isArray(command.expectedHeads)
    ? command.expectedHeads
    : [
        {
          chainType: "mapping-review",
          objectId: target.id,
          expectedHeadId: expectedReviewHeadId,
        },
      ];
  const clientActionId = payload.clientActionId;
  const key = semanticKey(clientActionId);
  const correlationId = `mapping:${card.id}:${target.id}`;
  const opened = latestInteraction(projected.events, {
    cardRevisionId: card.id,
    actorId: ACTOR_ID,
    eventType: "OPENED",
  });

  try {
    return await runtime.execute({
      commandType: "submitMappingReview",
      idempotencyKey: key,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        cardRevisionId: card.id,
        target,
        review,
        replacement: payload.replacement ?? null,
        clientActionId,
        expectedReviewHeadId,
        expectedExposureHeadId: payload.expectedExposureHeadId ?? null,
        expectedOpportunityExposureSetHash:
          payload.expectedOpportunityExposureSetHash,
        presentationInteractionId: presentedRow.id,
        reason: payload.reason ?? null,
      },
      immutableInputRefs: [
        { type: "CARD_REVISION", id: card.id, hash: canonicalHash(card) },
        { type: target.type, id: original.id, hash: canonicalHash(original) },
        {
          type: "PRESENTATION_INTERACTION",
          id: presentedRow.id,
          hash: canonicalHash(presentedRow),
        },
      ],
      builderVersion: "mapping-review-v1",
      engineResultId: null,
      expectedHeads,
      buildMembers: ({
        targetCommitGroupId,
        now: stamped,
        canonicalCommandInput,
        committedProjection,
      }) => {
        // Exact replay must rebuild the pre-command view, not consume its
        // own replacement entities as additional human-visible input.
        const events = committedEventsOf(committedProjection)
          .filter(row => row.commitGroupId !== targetCommitGroupId);
        const liveCard = events.find(
          (row) =>
            row.schema === "variable-card-revision-v1" && row.id === card.id,
        );
        if (!liveCard) {
          fail("INPUT_REF_MISMATCH", "card revision is not committed");
        }
        const liveTarget = findTarget(events, target, card.id);
        if (!liveTarget) {
          fail("INPUT_REF_MISMATCH", "review target is not committed on this card");
        }
        const live = computeExposureSet({
          events,
          actorId: ACTOR_ID,
          card: liveCard,
        });
        assertExposureMatch(live, canonicalCommandInput);
        const plannedId = plannedReviewId(target.id, clientActionId);
        const reviewHead = currentReviewHead(events, target.id, plannedId);
        if ((reviewHead ? reviewHead.id : null) !== expectedReviewHeadId) {
          fail("HEAD_CONFLICT", "mapping-review head changed");
        }
        const exposed = isExposed(live);
        const origin = exposed ? "POST_HOC" : "HUMAN_CORRECTION";
        const snapshotId = brandedId("hds_", {
          purpose: purposeOf(target.type),
          targetId: target.id,
          clientActionId,
        });
        const timingId = brandedId("hjta_", {
          targetType: "MAPPING_REVIEW",
          targetId: plannedId,
        });
        const liveThemes = idsOf(events, "theme-hypothesis-v1", card.id);
        const liveMappings = idsOf(events, "security-mapping-v1", card.id);
        const visiblePayloadHash = visiblePayloadHashOf({
          card: liveCard,
          themes: currentEntityRows(events, "theme-hypothesis-v1", card.id),
          securities: currentEntityRows(events, "security-mapping-v1", card.id),
          presentationInteractionId: presentedRow.id,
          openedInteractionId: opened ? opened.id : null,
        });
        const snapshot = snapshotRecord({
          id: snapshotId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          purpose: purposeOf(target.type),
          targetRef: {
            type: target.type,
            id: target.id,
          },
          card: liveCard,
          themeHypothesisIds: liveThemes,
          securityMappingIds: liveMappings,
          presentationInteractionId: presentedRow.id,
          exposure: live,
          exposed,
          visiblePayloadHash,
        });
        const records = [snapshot];
        let replacementTargetId = null;
        let replacementRow = null;
        if (review === "CORRECTED") {
          replacementTargetId = replacementId(
            target.type,
            target.id,
            clientActionId,
          );
          replacementRow = buildReplacement({
            targetType: target.type,
            original: liveTarget,
            replacement: canonicalCommandInput.replacement,
            snapshotId,
            replacementTargetId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            origin,
          });
          records.push(replacementRow);
        }
        const reviewRecord = envelope({
          schema: "mapping-review-v1",
          id: plannedId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: expectedReviewHeadId,
          extra: {
            target: { type: target.type, id: target.id },
            cardRevisionId: card.id,
            humanDecisionSnapshotId: snapshotId,
            review,
            replacementTargetId,
            outcomeExposureStatus: outcomeStatus({ exposed, kind: "review" }),
            reason: canonicalCommandInput.reason,
            reviewedAt: stamped,
            idempotencyKey: key,
          },
        });
        records.push(reviewRecord);
        records.push(
          timingRecord({
            id: timingId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            target: { type: "MAPPING_REVIEW", id: plannedId },
            visibleDataAsOf: stamped,
          }),
        );
        if (review === "CORRECTED") {
          const jobKind =
            target.type === "THEME_HYPOTHESIS"
              ? "THEME_SUPPLEMENT"
              : "MAPPING_SUPPLEMENT";
          const horizons = resolveAShareHorizons({
            evaluationAnchorAt: stamped,
            calendar,
          });
          const relevantThemeId =
            target.type === "THEME_HYPOTHESIS"
              ? replacementTargetId
              : liveTarget.themeHypothesisId;
          const themeHypothesisIds =
            jobKind === "THEME_SUPPLEMENT"
              ? [replacementTargetId]
              : [liveTarget.themeHypothesisId];
          const securityMappingIds =
            jobKind === "MAPPING_SUPPLEMENT" ? [replacementTargetId] : [];
          const frozenSnapshotHash = canonicalHash({
            mappingReviewId: plannedId,
            replacementTargetId,
            themeHypothesisIds,
            securityMappingIds,
            fermentationRuleVersion: FERMENTATION_RULE_VERSION,
            mappingRuleVersion: MAPPING_RULE_VERSION,
            reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
            calendarRuleVersion: CALENDAR_RULE_VERSION,
          });
          const metricUse = exposed
            ? "OBSERVATION_ONLY"
            : "PENDING_JUDGMENT_TIMING";
          for (const horizon of ["T1", "T3", "T5"]) {
            const slot = horizons.horizons[horizon];
            records.push(
              envelope({
                schema: "feedback-job-v1",
                id: supplementJobId({
                  jobKind,
                  replacementTargetId,
                  horizon,
                }),
                now: stamped,
                actorType: ACTOR_TYPE,
                actorId: ACTOR_ID,
                correlationId,
                targetCommitGroupId,
                extra: {
                  jobKind,
                  metricUse,
                  opportunityId: liveCard.opportunityId,
                  variableId: liveCard.variableId,
                  cardRevisionId: card.id,
                  decisionContextId: liveCard.decisionContextId,
                  triggerScanExposureId: verifiableTrigger(liveCard),
                  systemDecisionAt: liveCard.systemDecisionAt || stamped,
                  evaluationAnchorAt: stamped,
                  anchorSource: {
                    type: "MAPPING_REVIEW",
                    mappingReviewId: plannedId,
                  },
                  horizon,
                  themeHypothesisIds,
                  securityMappingIds,
                  replacementTargetId,
                  frozenSnapshotHash,
                  anchorSession: horizons.anchorSession,
                  scheduledSession: slot.scheduledSession,
                  calendarRuleVersion: CALENDAR_RULE_VERSION,
                },
              }),
            );
          }
          const trigger = verifiableTrigger(liveCard);
          if (
            trigger &&
            typeof liveCard.opportunityEligibleAt === "string" &&
            relevantThemeId
          ) {
            const t5 = horizons.horizons.T5.scheduledAt;
            const window = resolveReactionSearchWindow({
              opportunityEligibleAt: liveCard.opportunityEligibleAt,
              t5CloseAt: t5,
              calendar,
            });
            records.push(
              envelope({
                schema: "reaction-search-job-v1",
                id: supplementReactionId({
                  mappingReviewId: plannedId,
                  relevantThemeId,
                }),
                now: stamped,
                actorType: ACTOR_TYPE,
                actorId: ACTOR_ID,
                correlationId,
                targetCommitGroupId,
                extra: {
                  jobKind: "THEME_SUPPLEMENT",
                  opportunityId: liveCard.opportunityId,
                  cardRevisionId: card.id,
                  sourceMappingReviewId: plannedId,
                  triggerScanExposureId: trigger,
                  themeHypothesisIds: [relevantThemeId],
                  reactionSearchStartAt: window.reactionSearchStartAt,
                  reactionSearchEndAt: window.reactionSearchEndAt,
                  reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
                  frozenSnapshotHash,
                },
              }),
            );
          }
        }
        return records.map((record) => ({ file: "events", record }));
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
