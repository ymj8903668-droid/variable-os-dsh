// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";

function unionFind(ids) {
  const parent = new Map();
  for (const id of ids) {
    parent.set(id, id);
  }
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) {
      current = parent.get(current);
    }
    let walk = id;
    while (walk !== current) {
      const next = parent.get(walk);
      parent.set(walk, current);
      walk = next;
    }
    return current;
  };
  const link = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) {
      parent.set(a, b);
    }
  };
  return { find, link, parent };
}

function latestDecisionByEvent(events) {
  const decisions = events.filter(
    (row) => row && row.schema === "opportunity-relation-decision-v1",
  );
  const byEvent = new Map();
  for (const decision of decisions) {
    const key = decision.relationEventId;
    if (typeof key !== "string") {
      continue;
    }
    const previous = byEvent.get(key);
    if (!previous) {
      byEvent.set(key, decision);
      continue;
    }
    const prevTime = previous.decidedAt || previous.recordedAt || "";
    const nextTime = decision.decidedAt || decision.recordedAt || "";
    if (nextTime > prevTime || (nextTime === prevTime && decision.id > previous.id)) {
      byEvent.set(key, decision);
    }
  }
  return byEvent;
}

function currentRelationEvents(events) {
  const rows = events.filter(
    (row) => row && row.schema === "opportunity-relation-event-v1",
  );
  const superseded = new Set(
    rows.map((row) => row.supersedesRelationEventId).filter(Boolean),
  );
  return rows.filter((row) => !superseded.has(row.id));
}

function compareInteraction(left, right) {
  const leftAt = left.occurredAt || left.recordedAt || "";
  const rightAt = right.occurredAt || right.recordedAt || "";
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function createExposureProjectionIndex(events, actorId) {
  const rows = Array.isArray(events) ? events : [];
  const ids = new Set();
  const cards = [];
  for (const row of rows) {
    if (row?.schema === "opportunity-v1" && typeof row.id === "string") {
      ids.add(row.id);
    }
    if (row?.schema === "variable-card-revision-v1" && row.opportunityId) {
      ids.add(row.opportunityId);
      cards.push(row);
    }
    if (row?.schema === "opportunity-relation-event-v1") {
      if (row.fromOpportunityId) ids.add(row.fromOpportunityId);
      if (row.toOpportunityId) ids.add(row.toOpportunityId);
    }
  }
  const { find, link } = unionFind(ids);
  const decisions = latestDecisionByEvent(rows);
  const approvedRelationDecisionIds = [];
  for (const relation of currentRelationEvents(rows)) {
    const decision = decisions.get(relation.id);
    if (decision?.decision !== "APPROVE" || relation.relation !== "SAME_AS") {
      continue;
    }
    if (relation.fromOpportunityId && relation.toOpportunityId) {
      link(relation.fromOpportunityId, relation.toOpportunityId);
      approvedRelationDecisionIds.push(decision.id);
    }
  }
  approvedRelationDecisionIds.sort();
  const membersByRoot = new Map();
  for (const id of ids) {
    const root = find(id);
    const members = membersByRoot.get(root) || [];
    members.push(id);
    membersByRoot.set(root, members);
  }
  for (const members of membersByRoot.values()) members.sort();
  const cardsByRoot = new Map();
  for (const card of cards) {
    const root = find(card.opportunityId);
    const relatedCards = cardsByRoot.get(root) || [];
    relatedCards.push(card);
    cardsByRoot.set(root, relatedCards);
  }
  const exposuresByCard = new Map();
  for (const row of rows) {
    if (
      row?.schema !== "delivery-interaction-v1" ||
      row.eventType !== "OUTCOME_EXPOSED" ||
      row.actorId !== actorId
    ) {
      continue;
    }
    const exposures = exposuresByCard.get(row.cardRevisionId) || [];
    exposures.push(row);
    exposuresByCard.set(row.cardRevisionId, exposures);
  }
  const byOpportunity = new Map();
  for (const [root, memberOpportunityIds] of membersByRoot) {
    const relatedCardRevisionIds = (cardsByRoot.get(root) || [])
      .map((row) => row.id)
      .sort();
    const exposures = relatedCardRevisionIds
      .flatMap((cardRevisionId) => exposuresByCard.get(cardRevisionId) || [])
      .sort(compareInteraction);
    const priorOutcomeExposureInteractionIds = exposures.map((row) => row.id);
    const value = {
      setHash: canonicalHash(priorOutcomeExposureInteractionIds),
      headId: priorOutcomeExposureInteractionIds.at(-1) || null,
      opportunityClassIds: [
        canonicalHash({
          memberOpportunityIds,
          equivalenceResolverVersion: "opportunity-equivalence-v1",
        }),
      ],
      memberOpportunityIds,
      approvedRelationDecisionIds,
      relatedCardRevisionIds,
      priorOutcomeExposureInteractionIds,
    };
    for (const id of memberOpportunityIds) byOpportunity.set(id, value);
  }
  return { events: rows, actorId, byOpportunity };
}

export function relatedOpportunities(events, opportunityId) {
  const ids = new Set();
  if (typeof opportunityId === "string" && opportunityId.length > 0) {
    ids.add(opportunityId);
  }
  for (const row of events) {
    if (row && row.schema === "opportunity-v1" && typeof row.id === "string") {
      ids.add(row.id);
    }
    if (row && row.schema === "variable-card-revision-v1" && row.opportunityId) {
      ids.add(row.opportunityId);
    }
    if (row && row.schema === "opportunity-relation-event-v1") {
      if (row.fromOpportunityId) {
        ids.add(row.fromOpportunityId);
      }
      if (row.toOpportunityId) {
        ids.add(row.toOpportunityId);
      }
    }
  }
  const { find, link } = unionFind(ids);
  const decisions = latestDecisionByEvent(events);
  const approvedRelationDecisionIds = [];
  for (const relation of currentRelationEvents(events)) {
    const decision = decisions.get(relation.id);
    if (!decision || decision.decision !== "APPROVE") {
      continue;
    }
    if (relation.relation !== "SAME_AS") {
      continue;
    }
    if (relation.fromOpportunityId && relation.toOpportunityId) {
      link(relation.fromOpportunityId, relation.toOpportunityId);
      approvedRelationDecisionIds.push(decision.id);
    }
  }
  const root =
    typeof opportunityId === "string" && opportunityId.length > 0
      ? find(opportunityId)
      : null;
  const memberOpportunityIds = [...ids]
    .filter((id) => root !== null && find(id) === root)
    .sort();
  if (memberOpportunityIds.length === 0 && opportunityId) {
    memberOpportunityIds.push(opportunityId);
  }
  return {
    memberOpportunityIds,
    approvedRelationDecisionIds: approvedRelationDecisionIds.sort(),
  };
}

export function computeExposureSet({ events, actorId, card, index = null }) {
  const rows = Array.isArray(events) ? events : [];
  if (index?.events === rows && index.actorId === actorId) {
    const cached = index.byOpportunity.get(card?.opportunityId);
    if (cached) return cached;
  }
  const related = relatedOpportunities(rows, card && card.opportunityId);
  const relatedCards = rows.filter(
    (row) =>
      row &&
      row.schema === "variable-card-revision-v1" &&
      related.memberOpportunityIds.includes(row.opportunityId),
  );
  const relatedCardRevisionIds = relatedCards.map((row) => row.id).sort();
  const exposures = rows
    .filter(
      (row) =>
        row &&
        row.schema === "delivery-interaction-v1" &&
        row.eventType === "OUTCOME_EXPOSED" &&
        row.actorId === actorId &&
        relatedCardRevisionIds.includes(row.cardRevisionId),
    )
    .slice()
    .sort(compareInteraction);
  const priorOutcomeExposureInteractionIds = exposures.map((row) => row.id);
  const opportunityClassIds = [
    canonicalHash({
      memberOpportunityIds: related.memberOpportunityIds,
      equivalenceResolverVersion: "opportunity-equivalence-v1",
    }),
  ];
  const setHash = canonicalHash(priorOutcomeExposureInteractionIds);
  const headId =
    priorOutcomeExposureInteractionIds.length === 0
      ? null
      : priorOutcomeExposureInteractionIds[
          priorOutcomeExposureInteractionIds.length - 1
        ];
  return {
    setHash,
    headId,
    opportunityClassIds,
    memberOpportunityIds: related.memberOpportunityIds,
    approvedRelationDecisionIds: related.approvedRelationDecisionIds,
    relatedCardRevisionIds,
    priorOutcomeExposureInteractionIds,
  };
}

export function reviewerExposureAudit({ exposure, now }) {
  const body = {
    opportunityClassIds: exposure.opportunityClassIds,
    memberOpportunityIds: exposure.memberOpportunityIds,
    approvedRelationDecisionIds: exposure.approvedRelationDecisionIds,
    relatedCardRevisionIds: exposure.relatedCardRevisionIds,
    priorOutcomeExposureInteractionIds:
      exposure.priorOutcomeExposureInteractionIds,
    auditedAt: now,
  };
  return {
    ...body,
    auditHash: canonicalHash(body),
  };
}

export function isExposed(exposure) {
  return exposure.priorOutcomeExposureInteractionIds.length > 0;
}
