// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { fail } from "./errors.mjs";
import { computeExposureSet, isExposed } from "./exposure.mjs";
import {
  ACTOR_ID,
  ACTOR_TYPE,
  POLICY_VERSION,
  assertExposureMatch,
  clockOf,
  committedEventsOf,
  currentAdjudicationHead,
  currentEntityRows,
  currentLabelHead,
  envelope,
  idsOf,
  latestInteraction,
  loadCalendar,
  outcomeStatus,
  plannedLabelId,
  requireActor,
  snapshotRecord,
  timingRecord,
  visiblePayloadHashOf,
} from "./helpers.mjs";
import {
  cancelWatchMembers,
  resolveWatchDueAt,
  watchMembers,
} from "./watch-task.mjs";

const LABELS = new Set(["TRADABLE", "WATCH", "NOT_TRADABLE"]);

function payloadOf(command) {
  return command && command.payload && typeof command.payload === "object"
    ? command.payload
    : {};
}

function semanticKey(clientActionId) {
  return `label-v1:${clientActionId}`;
}

function watchSessions(payload) {
  if (payload.watchHorizonSessions === undefined || payload.watchHorizonSessions === null) {
    return 1;
  }
  return payload.watchHorizonSessions;
}

function reviewNoteOf(payload) {
  if (payload.reviewNote === undefined || payload.reviewNote === null) return "";
  if (typeof payload.reviewNote !== "string" || payload.reviewNote.length > 300) {
    fail("INVALID_COMMAND", "reviewNote must be a string of at most 300 characters");
  }
  return payload.reviewNote.trim();
}

function selectedEvidenceIdsOf(payload) {
  if (payload.selectedEvidenceIds === undefined || payload.selectedEvidenceIds === null) {
    return [];
  }
  if (!Array.isArray(payload.selectedEvidenceIds) || payload.selectedEvidenceIds.length > 20) {
    fail("INVALID_COMMAND", "selectedEvidenceIds must contain at most 20 ids");
  }
  const ids = payload.selectedEvidenceIds;
  if (ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) {
    fail("INVALID_COMMAND", "selectedEvidenceIds contains an invalid id");
  }
  return [...new Set(ids.map((id) => id.trim()))];
}

export async function submitHumanLabel({ store, now, command, watchCalendar }) {
  if (!command || command.commandType !== "submitHumanLabel") {
    fail("UNKNOWN_COMMAND", "only submitHumanLabel is allowed");
  }
  requireActor(command);
  const payload = payloadOf(command);
  const label = payload.label;
  if (!LABELS.has(label)) {
    fail("INVALID_COMMAND", "label must be TRADABLE, WATCH, or NOT_TRADABLE");
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
  if (label === "WATCH") {
    const sessions = watchSessions(payload);
    if (payload.reviewDueAt === null || sessions === 0 || sessions === "0") {
      fail("INVALID_WATCH_HORIZON", "WATCH requires a due date");
    }
  }
  const reviewNote = reviewNoteOf(payload);
  const selectedEvidenceIds = selectedEvidenceIdsOf(payload);
  if (reviewNote.length < 6) {
    fail("INVALID_COMMAND", "formal judgment requires a reviewNote of at least 6 characters");
  }
  if (selectedEvidenceIds.length === 0) {
    fail("INVALID_COMMAND", "formal judgment requires at least one evidence id");
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
      eventType: "PRESENTED",
    });
  if (!presented) {
    fail("INPUT_REF_MISMATCH", "PRESENTED interaction is not committed");
  }
  const opened = latestInteraction(projected.events, {
    cardRevisionId: card.id,
    actorId: ACTOR_ID,
    eventType: "OPENED",
  });
  const calendar = label === "WATCH" ? watchCalendar ?? await loadCalendar() : null;
  const previousDecision = projected.events.find(row => row.schema === "human-label-v1" &&
    row.cardRevisionId === card.id && row.clientActionId === payload.clientActionId && row.label === "WATCH");
  const reviewDueAt =
    label === "WATCH"
      ? previousDecision?.watchReview?.reviewDueAt ?? resolveWatchDueAt({
          labeledAt: clock(),
          sessions: watchSessions(payload),
          calendar,
        })
      : null;
  const expectedLabelHeadId = payload.expectedLabelHeadId ?? null;
  const expectedHeads = Array.isArray(command.expectedHeads)
    ? command.expectedHeads
    : [
        {
          chainType: "human-label",
          objectId: card.id,
          expectedHeadId: expectedLabelHeadId,
        },
      ];
  const clientActionId = payload.clientActionId;
  const key = semanticKey(clientActionId);
  const themeHypothesisIds = idsOf(
    projected.events,
    "theme-hypothesis-v1",
    card.id,
  );
  const securityMappingIds = idsOf(
    projected.events,
    "security-mapping-v1",
    card.id,
  );
  const reasonCodes = Array.isArray(payload.reasonCodes)
    ? payload.reasonCodes
    : [];
  const correlationId = `label:${card.id}`;

  try {
    return await runtime.execute({
      commandType: "submitHumanLabel",
      idempotencyKey: key,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        cardRevisionId: card.id,
        label,
        clientActionId,
        expectedLabelHeadId,
        supersedesId: payload.supersedesId ?? expectedLabelHeadId,
        expectedExposureHeadId: payload.expectedExposureHeadId ?? null,
        expectedOpportunityExposureSetHash:
          payload.expectedOpportunityExposureSetHash,
        watchHorizonSessions: label === "WATCH" ? watchSessions(payload) : null,
        reviewDueAt,
        presentationInteractionId: presented.id,
        reasonCodes,
        reviewNote,
        selectedEvidenceIds,
      },
      immutableInputRefs: [
        { type: "CARD_REVISION", id: card.id, hash: canonicalHash(card) },
        {
          type: "PRESENTATION_INTERACTION",
          id: presented.id,
          hash: canonicalHash(presented),
        },
      ],
      builderVersion: "human-label-v1",
      engineResultId: null,
      expectedHeads,
      buildMembers: ({
        assignId,
        targetCommitGroupId,
        now: stamped,
        canonicalCommandInput,
        committedProjection,
      }) => {
        const events = committedEventsOf(committedProjection);
        const liveCard = events.find(
          (row) =>
            row.schema === "variable-card-revision-v1" && row.id === card.id,
        );
        if (!liveCard) {
          fail("INPUT_REF_MISMATCH", "card revision is not committed");
        }
        const live = computeExposureSet({
          events,
          actorId: ACTOR_ID,
          card: liveCard,
        });
        assertExposureMatch(live, canonicalCommandInput);
        const plannedId = plannedLabelId(card.id, clientActionId);
        const labelHead = currentLabelHead(events, card.id, plannedId);
        if ((labelHead ? labelHead.id : null) !== expectedLabelHeadId) {
          fail("HEAD_CONFLICT", "human-label head changed");
        }
        if (expectedLabelHeadId && canonicalCommandInput.supersedesId !== expectedLabelHeadId) {
          fail("HEAD_CONFLICT", "explicit relabel requires supersedesId");
        }
        if (labelHead && !expectedLabelHeadId) {
          fail("HEAD_CONFLICT", "human-label head changed");
        }
        const exposed = isExposed(live);
        const snapshotId = brandedId("hds_", {
          purpose: "VARIABLE_LABEL",
          cardRevisionId: card.id,
          clientActionId,
        });
        const adjudicationId = brandedId("oadj_", {
          opportunityId: liveCard.opportunityId,
          mode: "LIVE_LABEL",
          sourceHumanLabelId: plannedId,
        });
        const timingId = brandedId("hjta_", {
          targetType: "HUMAN_LABEL",
          targetId: plannedId,
        });
        const themeRows = currentEntityRows(
          events,
          "theme-hypothesis-v1",
          card.id,
        );
        const mappingRows = currentEntityRows(
          events,
          "security-mapping-v1",
          card.id,
        );
        const liveThemes = idsOf(events, "theme-hypothesis-v1", card.id);
        const liveMappings = idsOf(events, "security-mapping-v1", card.id);
        const liveOpened =
          opened && events.some((row) => row.id === opened.id) ? opened : null;
        const visiblePayloadHash = visiblePayloadHashOf({
          card: liveCard,
          themes: themeRows,
          securities: mappingRows,
          presentationInteractionId: presented.id,
          openedInteractionId: liveOpened ? liveOpened.id : null,
        });
        const snapshot = snapshotRecord({
          id: snapshotId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          purpose: "VARIABLE_LABEL",
          targetRef: { type: "CARD_REVISION", id: card.id },
          card: liveCard,
          themeHypothesisIds: liveThemes,
          securityMappingIds: liveMappings,
          presentationInteractionId: presented.id,
          exposure: live,
          exposed,
          visiblePayloadHash,
        });
        const labelRecord = envelope({
          schema: "human-label-v1",
          id: plannedId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: canonicalCommandInput.supersedesId,
          extra: {
            variableId: liveCard.variableId,
            cardRevisionId: card.id,
            humanDecisionSnapshotId: snapshotId,
            reactionAssessment: "NOT_ASSESSED",
            reasonCodes,
            reviewNote: canonicalCommandInput.reviewNote,
            selectedEvidenceIds: canonicalCommandInput.selectedEvidenceIds,
            outcomeExposureStatus: outcomeStatus({ exposed, kind: "label" }),
            labeledAt: stamped,
            clientActionId: canonicalCommandInput.clientActionId,
            idempotencyKey: key,
            label,
            watchReview:
              label === "WATCH"
                ? {
                    reviewDueAt: canonicalCommandInput.reviewDueAt,
                    earlyWakeRelations: ["REINFORCES", "UPDATES", "CONTRADICTS"],
                  }
                : null,
          },
        });
        const previousAdj = currentAdjudicationHead(
          events,
          liveCard.opportunityId,
          adjudicationId,
        );
        const adjudication = envelope({
          schema: "opportunity-adjudication-v1",
          id: adjudicationId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          supersedesId: previousAdj ? previousAdj.id : null,
          extra: {
            opportunityId: liveCard.opportunityId,
            humanDecisionSnapshotId: snapshotId,
            blindEligibility: "NOT_APPLICABLE",
            outcomeExposureStatus: outcomeStatus({
              exposed,
              kind: "decision",
            }),
            adjudicatedAt: stamped,
            idempotencyKey: key,
            mode: "LIVE_LABEL",
            sourceHumanLabelId: plannedId,
            sourceAuditSampleItemId: null,
            label,
          },
        });
        const timing = timingRecord({
          id: timingId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          targetCommitGroupId,
          target: { type: "HUMAN_LABEL", id: plannedId },
          visibleDataAsOf: stamped,
        });
        const records = [snapshot, labelRecord, adjudication, timing];
        if (label === "WATCH") {
          records.push(
            ...watchMembers({
              assignId,
              targetCommitGroupId,
              now: stamped,
              actorType: ACTOR_TYPE,
              actorId: ACTOR_ID,
              correlationId,
              card: liveCard,
              labelId: plannedId,
              reviewDueAt: canonicalCommandInput.reviewDueAt,
            }),
          );
        }
        if (
          labelHead &&
          labelHead.label === "WATCH" &&
          label !== "WATCH"
        ) {
          records.push(
            ...cancelWatchMembers({
              assignId,
              targetCommitGroupId,
              now: stamped,
              actorType: ACTOR_TYPE,
              actorId: ACTOR_ID,
              correlationId,
              events,
              watchLabelId: labelHead.id,
            }),
          );
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
