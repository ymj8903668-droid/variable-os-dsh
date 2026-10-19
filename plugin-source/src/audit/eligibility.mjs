// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { computeExposureSet, isExposed, reviewerExposureAudit } from "../label/exposure.mjs";
import { pendingRelationIds } from "../report/universe.mjs";
import { fail } from "./errors.mjs";

const KNOWLEDGE = new Set(["UNAWARE", "AWARE", "UNSURE"]);

export function requireKnowledge(value) {
  if (!KNOWLEDGE.has(value)) {
    fail("INVALID_KNOWLEDGE", "blind replay requires UNAWARE, AWARE, or UNSURE");
  }
  return value;
}

export function relationConflict(events, opportunityId) {
  const pending = pendingRelationIds(events);
  return pending.some(
    (row) =>
      row.fromOpportunityId === opportunityId ||
      row.toOpportunityId === opportunityId,
  );
}

export function computeBlindEligibility({
  events,
  actorId,
  opportunityId,
  knowledge,
  now,
}) {
  const declaration = requireKnowledge(knowledge);
  const exposure = computeExposureSet({
    events,
    actorId,
    card: { opportunityId },
  });
  const audit = reviewerExposureAudit({ exposure, now });
  const conflict = relationConflict(events, opportunityId);
  const exposed = isExposed(exposure);
  let blindEligibility = "ELIGIBLE";
  if (conflict) {
    blindEligibility = "RELATION_CONFLICT";
  } else if (exposed) {
    blindEligibility = "PRIOR_PLATFORM_EXPOSURE";
  } else if (declaration === "AWARE") {
    blindEligibility = "DECLARED_AWARE";
  } else if (declaration === "UNSURE") {
    blindEligibility = "DECLARED_UNSURE";
  }
  return {
    exposure,
    reviewerExposureAudit: audit,
    outcomeExposureStatus: exposed
      ? "EXPOSED_BEFORE_DECISION"
      : "NOT_EXPOSED_IN_PRODUCT",
    blindEligibility,
    reviewerKnowledgeDeclaration: declaration,
  };
}
