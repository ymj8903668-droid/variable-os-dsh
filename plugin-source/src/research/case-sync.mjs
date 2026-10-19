// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { canonicalHash } from "../schema/canonical-json.mjs";
import {
  loadHorizonCalendar,
  resolveAShareHorizons,
} from "../card/horizon.mjs";
import { feedbackJobIdOf } from "../card/materialize.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basketForCase, RESEARCH_CASES } from "./cases.mjs";
import { fail } from "./errors.mjs";
import { cardsBoundToCase } from "./timeline.mjs";

const POLICY_VERSION = "research-case-sync-v1";
const ACTOR_TYPE = "SYSTEM";
const ACTOR_ID = "system:research-case-sync";
const CALENDAR_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/calendar/a-share-2026-q3.json",
);

function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

function logicalCaseNodes(nodes) {
  return (nodes || []).map((node) => ({
    evidenceId: node.evidenceId,
    summary: node.summary,
    eventAt: node.eventAt,
    timePrecision: node.timePrecision,
    evidenceLevel: node.evidenceLevel ?? null,
    sourceKind: node.sourceKind ?? null,
    sourceType: node.sourceType ?? null,
    sourceChannel: node.sourceChannel ?? null,
    suggestedNodeType: node.suggestedNodeType ?? null,
  }));
}

/**
 * Decision identity for a research case. Market bars are intentionally excluded
 * so later price refresh cannot rewrite card identity.
 */
export function researchCaseDecisionDigest(snapshot, caseDef) {
  if (!snapshot || !caseDef) {
    fail("INVALID_CASE", "snapshot and caseDef required for decision digest");
  }
  const caseRow = (snapshot.cases || []).find(
    (row) => row.caseId === caseDef.caseId,
  );
  return canonicalHash({
    caseId: caseDef.caseId,
    title: caseDef.title,
    kind: caseDef.kind,
    evaluationAnchorAt: caseDef.evaluationAnchorAt,
    wikiPath: caseDef.wikiPath,
    names: caseDef.names,
    evidenceIds: caseRow?.evidenceIds || [],
    nodes: logicalCaseNodes(caseRow?.nodes || []),
    sourceWatermarks: snapshot.watermarks || null,
  });
}

function existingBoundCard(events, caseDef) {
  const bound = cardsBoundToCase(events, caseDef).filter(
    (row) => row.researchCaseId === caseDef.caseId,
  );
  if (bound.length === 0) {
    return null;
  }
  return bound.slice().sort((left, right) => (left.id < right.id ? -1 : 1))[0];
}

function presentationForCard(events, cardId) {
  return (
    events.find(
      (row) =>
        row &&
        row.schema === "presentation-decision-v1" &&
        row.cardRevisionId === cardId,
    ) || null
  );
}

function scoreComponents() {
  return {
    evidenceStrength: 0.62,
    novelty: 0.55,
    timeSensitivity: 0.58,
    tradabilityConfidence: 0.5,
    mappingConfidence: 0.52,
  };
}

function buildCaseMembers({
  assignId,
  targetCommitGroupId,
  now,
  caseDef,
  basket,
  digest,
  horizons,
}) {
  const correlationId = `research-case-sync:${caseDef.caseId}`;
  const cardId = assignId("variable-card-revision-v1", caseDef.caseId);
  const opportunityId = assignId("opportunity-v1", caseDef.caseId);
  const variableId = assignId("variable-v1", caseDef.caseId);
  const decisionContextId = assignId("decision-context-v1", caseDef.caseId);
  const themeId = assignId("theme-hypothesis-v1", caseDef.caseId);
  const presentationDecisionId = assignId(
    "presentation-decision-v1",
    caseDef.caseId,
  );
  const presentedId = assignId("delivery-interaction-v1", caseDef.caseId);
  const codes = basket.securities.map((row) => row.code);
  const thesis = `${caseDef.title} research case — 非推荐 / not a recommendation`;
  const members = [
    {
      file: "events",
      record: {
        schema: "variable-card-revision-v1",
        id: cardId,
        createdAt: now,
        recordedAt: now,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        researchCaseId: caseDef.caseId,
        researchCaseDecisionDigest: digest,
        opportunityId,
        variableId,
        decisionContextId,
        decisionRunReceiptId: null,
        triggerScanExposureId: null,
        opportunityEligibleAt: caseDef.evaluationAnchorAt,
        revision: 1,
        origin: "AI_DISCOVERED",
        variableEventLinkIds: [],
        eventSummary: `${caseDef.title} bounded research case`,
        variableThesis: thesis,
        whyTradable: `${caseDef.title} dossier for human review only; not a recommendation`,
        expectationGap: "research snapshot evidence vs market consensus",
        expectedHorizon: "T5",
        scoreComponents: scoreComponents(),
        uncertainties: ["research case is not a trading signal"],
        invalidationConditions: ["source watermark moves without re-sync"],
        cardEvidenceIds: [],
        evidenceSetHash: digest,
        firstDetectedAt: now,
        systemDecisionAt: caseDef.evaluationAnchorAt,
        modelVersion: "RULE",
        promptVersion: "research-case-sync-v1",
      },
    },
    {
      file: "events",
      record: {
        schema: "theme-hypothesis-v1",
        id: themeId,
        createdAt: now,
        recordedAt: now,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        cardRevisionId: cardId,
        decisionContextId,
        knowledgeCutoffAt: now,
        humanDecisionSnapshotId: null,
        themeRef: `theme:${caseDef.caseId}`,
        narrative: `${caseDef.title} theme hypothesis for mapping review`,
        constituentSnapshot: codes,
        origin: "AI_AT_DECISION",
        fermentationEligibility: "ELIGIBLE",
        fermentationEligibilityReason: "research sync seed",
      },
    },
  ];
  const mappingIds = [];
  basket.securities.forEach((security, index) => {
    const mappingId = assignId(
      "security-mapping-v1",
      `${caseDef.caseId}:${security.code}`,
    );
    mappingIds.push(mappingId);
    members.push({
      file: "events",
      record: {
        schema: "security-mapping-v1",
        id: mappingId,
        createdAt: now,
        recordedAt: now,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        themeHypothesisId: themeId,
        cardRevisionId: cardId,
        knowledgeCutoffAt: now,
        humanDecisionSnapshotId: null,
        securityCode: security.code,
        thesis: `${security.name} (${security.code}) mapped under ${caseDef.title}; not a recommendation`,
        origin: "AI_AT_DECISION",
        validFrom: now,
        validUntil: null,
        ordinal: index,
      },
    });
  });
  const frozenSnapshotHash = canonicalHash({
    cardRevisionId: cardId,
    themeHypothesisIds: [themeId],
    securityMappingIds: mappingIds,
    researchCaseId: caseDef.caseId,
  });
  for (const horizon of ["T1", "T3", "T5"]) {
    const slot = horizons.horizons[horizon];
    members.push({
      file: "events",
      record: {
        schema: "feedback-job-v1",
        id: feedbackJobIdOf({ cardRevisionId: cardId, horizon }),
        createdAt: now,
        recordedAt: now,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        jobKind: "BASE_CARD",
        metricUse: "BASE_OUTCOME",
        opportunityId,
        variableId,
        cardRevisionId: cardId,
        decisionContextId,
        triggerScanExposureId: null,
        systemDecisionAt: caseDef.evaluationAnchorAt,
        evaluationAnchorAt: caseDef.evaluationAnchorAt,
        anchorSource: {
          type: "RESEARCH_CASE",
          researchCaseId: caseDef.caseId,
        },
        horizon,
        themeHypothesisIds: [themeId],
        securityMappingIds: mappingIds,
        replacementTargetId: null,
        frozenSnapshotHash,
        anchorSession: horizons.anchorSession,
        scheduledSession: slot.scheduledSession,
        calendarRuleVersion: horizons.calendarRuleVersion,
      },
    });
  }
  members.push(
    {
      file: "events",
      record: {
        schema: "presentation-decision-v1",
        id: presentationDecisionId,
        createdAt: now,
        recordedAt: now,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        cardRevisionId: cardId,
        rankingDecisionContextId: decisionContextId,
        presentationCycleId: `research-cycle:${caseDef.caseId}`,
        tier: "MUST_REVIEW",
        rank: 1,
        score: 0.7,
        budgetBucket: "NEW",
        budgetVersion: "presentation-budget-v1",
        budgetPeriodId: String(now).slice(0, 10),
        capacity: 1,
        slot: 1,
        reasonCode: "RESEARCH_CASE_SEED",
        decisionAt: now,
        expiresAt: null,
      },
    },
    {
      file: "events",
      record: {
        schema: "delivery-interaction-v1",
        id: presentedId,
        createdAt: now,
        recordedAt: now,
        actorType: "HUMAN",
        actorId: "human:primary-reviewer",
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: "inbox-viewport-v1",
        cardRevisionId: cardId,
        presentationDecisionId,
        presentationCycleId: `research-cycle:${caseDef.caseId}`,
        eventType: "PRESENTED",
        channel: "INBOX",
        surface: "inbox-list",
        position: 1,
        occurredAt: now,
        presentationRuleVersion: "inbox-viewport-v1",
        receipt: { clientEventId: `research-presented:${caseDef.caseId}` },
        idempotencyKey: `research-presented:${caseDef.caseId}`,
        visibilityRatio: 1,
        visibleDurationMs: 0,
      },
    },
  );
  return {
    members,
    cardRevisionId: cardId,
    presentationDecisionId,
    digest,
  };
}

function feedbackJobsForCard(events, cardId) {
  return (events || []).filter(
    (row) =>
      row &&
      row.schema === "feedback-job-v1" &&
      row.cardRevisionId === cardId,
  );
}

function buildFeedbackJobMembers({
  targetCommitGroupId,
  now,
  caseDef,
  card,
  theme,
  mappings,
  horizons,
}) {
  const correlationId = `research-feedback-jobs:${caseDef.caseId}`;
  const mappingIds = mappings.map((row) => row.id);
  const frozenSnapshotHash = canonicalHash({
    cardRevisionId: card.id,
    themeHypothesisIds: [theme.id],
    securityMappingIds: mappingIds,
    researchCaseId: caseDef.caseId,
  });
  const members = [];
  for (const horizon of ["T1", "T3", "T5"]) {
    const slot = horizons.horizons[horizon];
    const id = feedbackJobIdOf({ cardRevisionId: card.id, horizon });
    members.push({
      file: "events",
      record: {
        schema: "feedback-job-v1",
        id,
        createdAt: now,
        recordedAt: now,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        jobKind: "BASE_CARD",
        metricUse: "BASE_OUTCOME",
        opportunityId: card.opportunityId || null,
        variableId: card.variableId || null,
        cardRevisionId: card.id,
        decisionContextId: card.decisionContextId || null,
        triggerScanExposureId: null,
        systemDecisionAt: caseDef.evaluationAnchorAt,
        evaluationAnchorAt: caseDef.evaluationAnchorAt,
        anchorSource: {
          type: "RESEARCH_CASE",
          researchCaseId: caseDef.caseId,
        },
        horizon,
        themeHypothesisIds: [theme.id],
        securityMappingIds: mappingIds,
        replacementTargetId: null,
        frozenSnapshotHash,
        anchorSession: horizons.anchorSession,
        scheduledSession: slot.scheduledSession,
        calendarRuleVersion: horizons.calendarRuleVersion,
      },
    });
  }
  return members;
}

export async function syncResearchCases({ store, snapshot, now } = {}) {
  if (!store) {
    fail("STORE_REQUIRED", "store required for research case sync");
  }
  if (!snapshot || snapshot.status !== "COMPLETE") {
    fail("SNAPSHOT_NOT_COMPLETE", "complete research snapshot required");
  }
  const clock = clockOf(now);
  const stamped = clock();
  const runtime = new CommandRuntime({ store, now: clock });
  const calendar = await loadHorizonCalendar(CALENDAR_PATH);
  const cases = [];

  for (const caseDef of RESEARCH_CASES) {
    const basket = basketForCase(caseDef.caseId);
    if (!basket) {
      fail("INVALID_CASE", `missing research basket for ${caseDef.caseId}`);
    }
    const digest = researchCaseDecisionDigest(snapshot, caseDef);
    const horizons = resolveAShareHorizons({
      evaluationAnchorAt: caseDef.evaluationAnchorAt,
      calendar,
    });
    const projected = await runtime.project();
    const existing = existingBoundCard(projected.events, caseDef);
    if (existing) {
      const decision = presentationForCard(projected.events, existing.id);
      const jobs = feedbackJobsForCard(projected.events, existing.id);
      if (jobs.length < 3) {
        const theme = projected.events.find(
          (row) =>
            row.schema === "theme-hypothesis-v1" &&
            row.cardRevisionId === existing.id,
        );
        const mappings = projected.events.filter(
          (row) =>
            row.schema === "security-mapping-v1" &&
            row.cardRevisionId === existing.id,
        );
        if (theme && mappings.length) {
          const missingHorizons = ["T1", "T3", "T5"].filter(
            (horizon) =>
              !jobs.some((job) => job.horizon === horizon),
          );
          if (missingHorizons.length) {
            await runtime.execute({
              commandType: "research.ensureFeedbackJobs",
              idempotencyKey: `research-feedback-jobs:${caseDef.caseId}:${digest}`,
              actorType: ACTOR_TYPE,
              actorId: ACTOR_ID,
              correlationId: `research-feedback-jobs:${caseDef.caseId}`,
              policyVersion: POLICY_VERSION,
              canonicalCommandInput: {
                caseId: caseDef.caseId,
                cardRevisionId: existing.id,
                horizons: missingHorizons,
              },
              immutableInputRefs: [
                {
                  type: "RESEARCH_SNAPSHOT",
                  id: snapshot.id,
                  hash: snapshot.id,
                },
              ],
              builderVersion: "research-case-sync-v1",
              engineResultId: null,
              expectedHeads: [],
              buildMembers: ({ targetCommitGroupId, now: memberNow }) => {
                const all = buildFeedbackJobMembers({
                  targetCommitGroupId,
                  now: memberNow,
                  caseDef,
                  card: existing,
                  theme,
                  mappings,
                  horizons,
                });
                return all.filter((row) =>
                  missingHorizons.includes(row.record.horizon),
                );
              },
            });
          }
        }
      }
      cases.push({
        caseId: caseDef.caseId,
        cardRevisionId: existing.id,
        presentationDecisionId: decision ? decision.id : null,
        decisionDigest: digest,
        reused: true,
        feedbackJobs: Math.max(
          jobs.length,
          feedbackJobsForCard((await runtime.project()).events, existing.id)
            .length,
        ),
      });
      continue;
    }

    const planned = {
      cardRevisionId: null,
      presentationDecisionId: null,
    };
    await runtime.execute({
      commandType: "research.syncCase",
      idempotencyKey: `research-sync:${caseDef.caseId}:${digest}`,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId: `research-case-sync:${caseDef.caseId}`,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        caseId: caseDef.caseId,
        decisionDigest: digest,
        snapshotId: snapshot.id,
      },
      immutableInputRefs: [
        {
          type: "RESEARCH_SNAPSHOT",
          id: snapshot.id,
          hash: snapshot.id,
        },
      ],
      builderVersion: "research-case-sync-v1",
      engineResultId: null,
      expectedHeads: [],
      buildMembers: ({ assignId, targetCommitGroupId, now: memberNow }) => {
        const built = buildCaseMembers({
          assignId,
          targetCommitGroupId,
          now: memberNow,
          caseDef,
          basket,
          digest,
          horizons,
        });
        planned.cardRevisionId = built.cardRevisionId;
        planned.presentationDecisionId = built.presentationDecisionId;
        return built.members;
      },
    });
    cases.push({
      caseId: caseDef.caseId,
      cardRevisionId: planned.cardRevisionId,
      presentationDecisionId: planned.presentationDecisionId,
      decisionDigest: digest,
      reused: false,
      feedbackJobs: 3,
    });
  }

  return Object.freeze({
    ok: true,
    syncedAt: stamped,
    cases: Object.freeze(cases.map((row) => Object.freeze({ ...row }))),
  });
}
