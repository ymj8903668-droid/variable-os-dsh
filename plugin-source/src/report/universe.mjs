// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { computeExposureSet, relatedOpportunities } from "../label/exposure.mjs";
import { eventsAtAsOf, visibleAtAsOf } from "../ledger/as-of.mjs";
import { uniqueChainHead } from "../feedback/heads.mjs";
import { fail } from "./errors.mjs";

const EQUIV = "opportunity-equivalence-v1";
const MISS_ORIGINS = new Set(["HUMAN_MISS", "AUDIT_SAMPLE_MISS"]);

export function classIdOf(memberOpportunityIds) {
  return canonicalHash({
    memberOpportunityIds: [...memberOpportunityIds].sort(),
    equivalenceResolverVersion: EQUIV,
  });
}

export function pendingRelationIds(events) {
  const relations = (events || []).filter(
    (row) => row && row.schema === "opportunity-relation-event-v1",
  );
  const decisions = (events || []).filter(
    (row) => row && row.schema === "opportunity-relation-decision-v1",
  );
  const decided = new Set(decisions.map((row) => row.relationEventId));
  const pending = [];
  for (const relation of relations) {
    if (!decided.has(relation.id)) {
      pending.push(relation);
    }
  }
  return pending;
}

export function buildCohortUniverse(events, asOf = null) {
  const scoped = eventsAtAsOf(events, asOf);
  const opps = scoped.filter((row) => row && row.schema === "opportunity-v1");
  const seen = new Set();
  const classes = [];
  for (const opp of opps) {
    if (seen.has(opp.id)) {
      continue;
    }
    const related = relatedOpportunities(scoped, opp.id);
    for (const id of related.memberOpportunityIds) {
      seen.add(id);
    }
    classes.push({
      opportunityClassId: classIdOf(related.memberOpportunityIds),
      memberOpportunityIds: related.memberOpportunityIds,
      approvedRelationDecisionIds: related.approvedRelationDecisionIds || [],
    });
  }
  classes.sort((left, right) =>
    left.opportunityClassId < right.opportunityClassId
      ? -1
      : left.opportunityClassId > right.opportunityClassId
        ? 1
        : 0,
  );
  return {
    classes,
    count: classes.length,
    hash: canonicalHash(classes.map((row) => row.opportunityClassId)),
  };
}

export function cohortIntegrity(universeClasses, members) {
  const reasons = [];
  const universeIds = (universeClasses || []).map((row) => row.opportunityClassId);
  const memberIds = (members || []).map((row) => row.opportunityClassId);
  if (new Set(memberIds).size !== memberIds.length) {
    reasons.push("DUPLICATE_MEMBER");
  }
  if (memberIds.length !== universeIds.length) {
    reasons.push("MEMBER_COUNT_MISMATCH");
  }
  const universeSet = new Set(universeIds);
  const memberSet = new Set(memberIds);
  for (const id of universeIds) {
    if (!memberSet.has(id)) {
      reasons.push("MISSING_CLASS");
      break;
    }
  }
  for (const id of memberSet) {
    if (!universeSet.has(id)) {
      reasons.push("EXTRA_CLASS");
      break;
    }
  }
  return {
    ok: reasons.length === 0,
    reasonCodes: [...new Set(reasons)],
  };
}

function cardsOf(events, opportunityIds) {
  return (events || []).filter(
    (row) =>
      row &&
      row.schema === "variable-card-revision-v1" &&
      opportunityIds.includes(row.opportunityId),
  );
}

function uniqueOrExclude(rows, reasonCodes, code) {
  try {
    return uniqueChainHead(rows);
  } catch (err) {
    if (err && err.code === "HEAD_AMBIGUOUS") {
      reasonCodes.push(code);
      return null;
    }
    throw err;
  }
}

function earliestHumanClue(events, opportunityIds) {
  const clues = (events || []).filter(
    (row) =>
      row &&
      row.schema === "human-clue-v1" &&
      opportunityIds.includes(row.opportunityId),
  );
  clues.sort((left, right) => {
    const leftAt = left.firstHumanClueAt || left.recordedAt || "";
    const rightAt = right.firstHumanClueAt || right.recordedAt || "";
    if (leftAt !== rightAt) {
      return leftAt < rightAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return clues[0] || null;
}

function adjsInClass(events, opportunityIds, mode, asOf) {
  return (events || []).filter(
    (row) =>
      row &&
      row.schema === "opportunity-adjudication-v1" &&
      row.mode === mode &&
      opportunityIds.includes(row.opportunityId) &&
      visibleAtAsOf(row, asOf),
  );
}

function liveBinding({ events, liveAdj, aiCard }) {
  if (!liveAdj || !aiCard) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (liveAdj.sourceHumanLabelId == null || liveAdj.sourceAuditSampleItemId != null) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (liveAdj.label !== "TRADABLE") {
    return { ok: false, reason: "LIVE_NOT_TRADABLE" };
  }
  const label = (events || []).find((row) => row.id === liveAdj.sourceHumanLabelId);
  const snapshot = (events || []).find(
    (row) => row.id === liveAdj.humanDecisionSnapshotId,
  );
  if (!label || !snapshot || snapshot.purpose !== "VARIABLE_LABEL") {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (label.cardRevisionId !== aiCard.id || snapshot.cardRevisionId !== aiCard.id) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (snapshot.decisionContextId !== aiCard.decisionContextId) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (
    !snapshot.targetRef ||
    snapshot.targetRef.type !== "CARD_REVISION" ||
    snapshot.targetRef.id !== aiCard.id
  ) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (label.humanDecisionSnapshotId !== snapshot.id) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (label.label !== liveAdj.label) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (
    liveAdj.actorId !== label.actorId ||
    liveAdj.actorId !== snapshot.actorId ||
    label.actorId !== snapshot.actorId
  ) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (
    liveAdj.commitGroupId !== label.commitGroupId ||
    liveAdj.commitGroupId !== snapshot.commitGroupId
  ) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  if (
    liveAdj.correlationId !== label.correlationId ||
    liveAdj.correlationId !== snapshot.correlationId
  ) {
    return { ok: false, reason: "LIVE_BINDING_INVALID" };
  }
  return { ok: true, label, snapshot };
}

function blindBinding({ events, blindAdj, aiCard }) {
  if (!blindAdj || !aiCard) {
    return { ok: false, reason: "BLIND_BINDING_INVALID" };
  }
  if (blindAdj.sourceHumanLabelId != null || !blindAdj.sourceAuditSampleItemId) {
    return { ok: false, reason: "BLIND_BINDING_INVALID" };
  }
  if (blindAdj.label !== "TRADABLE") {
    return { ok: false, reason: "BLIND_NOT_TRADABLE" };
  }
  const item = (events || []).find(
    (row) => row.id === blindAdj.sourceAuditSampleItemId,
  );
  const snapshot = (events || []).find(
    (row) => row.id === blindAdj.humanDecisionSnapshotId,
  );
  if (!item || !snapshot) {
    return { ok: false, reason: "BLIND_BINDING_INVALID" };
  }
  if (item.reviewTarget && item.reviewTarget.type === "SCREENING_ATTEMPT") {
    return { ok: false, reason: "SCREENING_AUDIT_NOT_AI" };
  }
  if (item.reviewTarget && item.reviewTarget.type !== "OPPORTUNITY_CLASS") {
    return { ok: false, reason: "BLIND_BINDING_INVALID" };
  }
  if (
    snapshot.purpose !== "OPPORTUNITY_BLIND_REPLAY" ||
    snapshot.targetRef?.id !== item.id ||
    snapshot.auditTaskId !== item.reviewTaskId ||
    snapshot.opportunityId !== item.opportunityId ||
    blindAdj.opportunityId !== item.opportunityId ||
    blindAdj.actorId !== snapshot.actorId ||
    blindAdj.commitGroupId !== snapshot.commitGroupId ||
    blindAdj.correlationId !== snapshot.correlationId
  ) {
    return { ok: false, reason: "BLIND_BINDING_INVALID" };
  }
  if (
    snapshot.reviewerKnowledgeDeclaration !== "UNAWARE" ||
    snapshot.outcomeExposureStatus !== "NOT_EXPOSED_IN_PRODUCT" ||
    blindAdj.blindEligibility !== "ELIGIBLE"
  ) {
    return { ok: false, reason: "BLIND_NOT_ELIGIBLE" };
  }
  const audit = snapshot.reviewerExposureAudit;
  if (
    !audit ||
    (Array.isArray(audit.priorOutcomeExposureInteractionIds) &&
      audit.priorOutcomeExposureInteractionIds.length > 0)
  ) {
    return { ok: false, reason: "BLIND_NOT_ELIGIBLE" };
  }
  const frozen = snapshot.frozenReviewTarget;
  const payload = item.frozenReviewPayload || {};
  const payloadCardId =
    (payload.card && payload.card.id) ||
    (item.reviewTarget && item.reviewTarget.representativeCardRevisionId);
  const payloadContextId =
    (payload.context && payload.context.id) ||
    (item.reviewTarget && item.reviewTarget.decisionContextId);
  if (
    !frozen ||
    frozen.type !== "CARD_REVISION" ||
    frozen.cardRevisionId !== aiCard.id ||
    frozen.decisionContextId !== aiCard.decisionContextId ||
    payloadCardId !== aiCard.id ||
    payloadContextId !== aiCard.decisionContextId ||
    (item.reviewTarget &&
      item.reviewTarget.representativeCardRevisionId &&
      item.reviewTarget.representativeCardRevisionId !== aiCard.id) ||
    (item.reviewTarget &&
      item.reviewTarget.decisionContextId &&
      item.reviewTarget.decisionContextId !== aiCard.decisionContextId)
  ) {
    return { ok: false, reason: "BLIND_BINDING_INVALID" };
  }
  return { ok: true, item, snapshot };
}

function missCardOf({ events, clue, missReport }) {
  if (!clue || !missReport) {
    return null;
  }
  const evidenceIds = new Set(
    (events || [])
      .filter(
        (row) =>
          row &&
          row.schema === "card-evidence-v1" &&
          row.target &&
          (row.target.id === clue.id || row.target.id === missReport.id),
      )
      .map((row) => row.cardRevisionId),
  );
  const cards = (events || []).filter((row) => {
    if (
      !row ||
      row.schema !== "variable-card-revision-v1" ||
      !MISS_ORIGINS.has(row.origin) ||
      row.opportunityId !== clue.opportunityId
    ) {
      return false;
    }
    if (evidenceIds.size > 0) {
      return evidenceIds.has(row.id);
    }
    return (
      row.commitGroupId === missReport.commitGroupId ||
      row.commitGroupId === clue.commitGroupId
    );
  });
  cards.sort((left, right) => {
    const leftAt = left.systemDecisionAt || left.recordedAt || "";
    const rightAt = right.systemDecisionAt || right.recordedAt || "";
    if (leftAt !== rightAt) {
      return leftAt < rightAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return cards[0] || null;
}

function cohortExposureOf({ events, actorId, opportunityId, asOf, classRow, cards }) {
  const exposure = computeExposureSet({
    events,
    actorId,
    card: { opportunityId },
  });
  const body = {
    opportunityClassId: classRow.opportunityClassId,
    memberOpportunityIds: [...(classRow.memberOpportunityIds || [])].sort(),
    adjudicatorActorId: actorId || null,
    approvedRelationDecisionIds: [...(classRow.approvedRelationDecisionIds || [])].sort(),
    relatedCardRevisionIds: cards.map((row) => row.id).sort(),
    priorOutcomeExposureInteractionIds: exposure.priorOutcomeExposureInteractionIds,
    auditedAsOf: asOf,
  };
  return {
    exposure,
    exposed: exposure.priorOutcomeExposureInteractionIds.length > 0,
    cohortExposureAudit: {
      ...body,
      auditHash: canonicalHash(body),
    },
  };
}

export function classifyMember({ events, classRow, asOf, pendingRelations }) {
  const reasonCodes = [];
  events = eventsAtAsOf(events, asOf);
  const opportunityIds = classRow.memberOpportunityIds;
  const pendingHit = (pendingRelations || []).some(
    (row) =>
      opportunityIds.includes(row.fromOpportunityId) ||
      opportunityIds.includes(row.toOpportunityId),
  );
  if (pendingHit) {
    reasonCodes.push("RELATION_PENDING");
  }
  const cards = cardsOf(events, opportunityIds);
  const aiCards = cards
    .filter((row) => row.origin === "AI_DISCOVERED" && !MISS_ORIGINS.has(row.origin))
    .slice()
    .sort((left, right) => {
      const leftAt = left.systemDecisionAt || "";
      const rightAt = right.systemDecisionAt || "";
      if (leftAt !== rightAt) {
        return leftAt < rightAt ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const aiCard = aiCards[0] || null;
  const liveAdj = uniqueOrExclude(
    adjsInClass(events, opportunityIds, "LIVE_LABEL", asOf),
    reasonCodes,
    "ADJUDICATION_FORK",
  );
  const blindAdj = liveAdj
    ? null
    : uniqueOrExclude(
        adjsInClass(events, opportunityIds, "BLIND_REPLAY", asOf),
        reasonCodes,
        "ADJUDICATION_FORK",
      );
  const live = liveAdj ? liveBinding({ events, liveAdj, aiCard }) : { ok: false };
  const timings = live.ok
    ? (events || []).filter(
        (row) =>
          row.schema === "human-judgment-timing-assessment-v1" &&
          row.target &&
          row.target.id === live.label.id &&
          visibleAtAsOf(row, asOf),
      )
    : [];
  const timingHead = uniqueOrExclude(timings, reasonCodes, "TIMING_FORK");
  if (timingHead && timingHead.reactionTiming !== "PRE_REACTION") {
    reasonCodes.push("TIMING_NOT_PRE_REACTION");
  }
  const rsaRows = aiCard
    ? (events || []).filter((row) => {
        if (row.schema !== "reaction-search-assessment-v1" || !visibleAtAsOf(row, asOf)) {
          return false;
        }
        const job = events.find(
          (item) =>
            item.schema === "reaction-search-job-v1" &&
            item.id === row.reactionSearchJobId,
        );
        return job && job.cardRevisionId === aiCard.id;
      })
    : [];
  const rsaHead = uniqueOrExclude(rsaRows, reasonCodes, "REACTION_HEAD_AMBIGUOUS");
  if (!rsaHead) {
    reasonCodes.push("MISSING_REACTION_HEAD");
  }
  const presented = aiCard
    ? (events || [])
        .filter(
          (row) =>
            row.schema === "delivery-interaction-v1" &&
            row.eventType === "PRESENTED" &&
            row.cardRevisionId === aiCard.id &&
            visibleAtAsOf(row, asOf),
        )
        .map((row) => row.occurredAt || row.recordedAt)
        .filter(Boolean)
        .sort()
    : [];
  const firstHumanPresentedAt = presented[0] || null;
  const firstReactionAt = rsaHead ? rsaHead.firstReactionAt : null;
  let selectedAdj = null;
  let selectedTiming = null;
  if (liveAdj) {
    if (!live.ok) {
      reasonCodes.push(live.reason || "LIVE_BINDING_INVALID");
    } else if (!timingHead || timingHead.reactionTiming !== "PRE_REACTION") {
      reasonCodes.push("TIMING_NOT_PRE_REACTION");
    } else {
      selectedAdj = liveAdj;
      selectedTiming = timingHead;
    }
  } else if (blindAdj) {
    const blind = blindBinding({ events, blindAdj, aiCard });
    if (!blind.ok) {
      reasonCodes.push(blind.reason || "BLIND_BINDING_INVALID");
    } else if (blindAdj.blindEligibility !== "ELIGIBLE") {
      reasonCodes.push("BLIND_NOT_ELIGIBLE");
    } else {
      selectedAdj = blindAdj;
    }
  } else {
    reasonCodes.push("MISSING_ADJUDICATION");
  }
  const exposure = selectedAdj
    ? cohortExposureOf({
        events,
        actorId: selectedAdj.actorId,
        opportunityId: opportunityIds[0],
        asOf,
        classRow,
        cards,
      })
    : cohortExposureOf({
        events,
        actorId: null,
        opportunityId: opportunityIds[0],
        asOf,
        classRow,
        cards,
      });
  if (selectedAdj && !liveAdj && exposure.exposed) {
    reasonCodes.push("BLIND_EXPOSURE_AT_ASOF");
    selectedAdj = null;
  }
  const base = {
    opportunityClassId: classRow.opportunityClassId,
    memberOpportunityIds: opportunityIds,
    auditSampleSelectionRefs: [],
    firstReactionAt,
    firstHumanPresentedAt,
    reactionSearchAssessmentIds: rsaHead ? [rsaHead.id] : [],
    cohortExposureAudit: exposure.cohortExposureAudit,
    reasonCodes: [...new Set(reasonCodes)],
  };
  const earliestClue = earliestHumanClue(events, opportunityIds);
  const clue = earliestClue;
  const missReport = clue
    ? (events || []).find(
        (row) =>
          row.schema === "miss-report-v1" && row.humanClueId === clue.id,
      )
    : null;
  const missCard = missCardOf({ events, clue, missReport });
  const missTiming = missReport
    ? uniqueOrExclude(
        (events || []).filter(
          (row) =>
            row.schema === "miss-timing-assessment-v1" &&
            row.missReportId === missReport.id,
        ),
        reasonCodes,
        "MISS_TIMING_FORK",
      )
    : null;
  const firstHumanClueAt = clue
    ? clue.firstHumanClueAt || clue.recordedAt
    : null;
  const timelyClock =
    aiCard &&
    aiCard.origin === "AI_DISCOVERED" &&
    rsaHead &&
    firstReactionAt &&
    aiCard.systemDecisionAt < firstReactionAt &&
    (!firstHumanClueAt || aiCard.systemDecisionAt < firstHumanClueAt);
  const aiBlockers = [
    "RELATION_PENDING",
    "BLIND_EXPOSURE_AT_ASOF",
    "ADJUDICATION_FORK",
    "LIVE_BINDING_INVALID",
    "BLIND_BINDING_INVALID",
    "SCREENING_AUDIT_NOT_AI",
    "BLIND_NOT_ELIGIBLE",
    "TIMING_NOT_PRE_REACTION",
  ];
  const qualifiedAi = Boolean(
    timelyClock &&
      selectedAdj &&
      !aiBlockers.some((code) => reasonCodes.includes(code)),
  );
  if (qualifiedAi) {
    return {
      ...base,
      reasonCodes: [],
      cohortRole: "AI_TIMELY",
      aiCardRevisionId: aiCard.id,
      humanClueId: clue ? clue.id : null,
      adjudicationId: selectedAdj.id,
      adjudicationTimingAssessmentId: selectedTiming ? selectedTiming.id : null,
      missTimingAssessmentId: null,
    };
  }
  const liveMiss =
    missCard &&
    clue &&
    missReport &&
    missTiming &&
    missTiming.timing === "LIVE_MISS" &&
    !qualifiedAi;
  if (liveMiss && !reasonCodes.includes("RELATION_PENDING") && !reasonCodes.includes("MISS_TIMING_FORK")) {
    return {
      ...base,
      reasonCodes: [],
      cohortRole: "HUMAN_ONLY_LIVE_MISS",
      aiCardRevisionId: null,
      humanClueId: clue.id,
      adjudicationId: null,
      adjudicationTimingAssessmentId: null,
      missTimingAssessmentId: missTiming.id,
    };
  }
  return {
    ...base,
    reasonCodes: [...new Set(reasonCodes.length ? reasonCodes : ["MISSING_ADJUDICATION"])],
    cohortRole: "EXCLUDED",
    aiCardRevisionId: aiCard ? aiCard.id : missCard ? missCard.id : null,
    humanClueId: clue ? clue.id : null,
    adjudicationId: selectedAdj ? selectedAdj.id : null,
    adjudicationTimingAssessmentId: selectedTiming ? selectedTiming.id : null,
    missTimingAssessmentId: missTiming ? missTiming.id : null,
  };
}

export function assembleMembers({ events, universe, asOf }) {
  if (!universe) {
    fail("NOT_COMPUTABLE", "cohort universe missing");
  }
  const scoped = eventsAtAsOf(events, asOf);
  const pendingRelations = pendingRelationIds(scoped);
  const members = universe.classes.map((classRow) =>
    classifyMember({ events: scoped, classRow, asOf, pendingRelations }),
  );
  members.sort((left, right) =>
    left.opportunityClassId < right.opportunityClassId
      ? -1
      : left.opportunityClassId > right.opportunityClassId
        ? 1
        : 0,
  );
  return members;
}
