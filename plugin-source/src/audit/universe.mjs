// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { relatedOpportunities } from "../label/exposure.mjs";
import { eventsAtAsOf, visibleAtAsOf } from "../ledger/as-of.mjs";
import { fail } from "./errors.mjs";

function classIdOf(memberOpportunityIds) {
  return canonicalHash({
    memberOpportunityIds: [...memberOpportunityIds].sort(),
    equivalenceResolverVersion: "opportunity-equivalence-v1",
  });
}

export function frozenPayloadHash(payload) {
  return canonicalHash(payload);
}

function contextOf(events, id) {
  return (events || []).find(
    (row) => row && row.schema === "decision-context-v1" && row.id === id,
  );
}

function asOfOk(row, universeAsOf) {
  return visibleAtAsOf(row, universeAsOf);
}

function currentCardChildren(events, schema, cardId) {
  const rows = (events || []).filter(
    (row) => row && row.schema === schema && row.cardRevisionId === cardId,
  );
  const superseded = new Set(rows.map((row) => row.supersedesId).filter(Boolean));
  return rows
    .filter((row) => !superseded.has(row.id))
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function screeningAttemptUniverse(events, universeAsOf) {
  const items = [];
  const attempts = (events || []).filter(
    (row) =>
      row &&
      row.schema === "screening-attempt-v1" &&
      row.result === "DECIDED" &&
      typeof row.screeningDecisionId === "string" &&
      asOfOk(row, universeAsOf),
  );
  for (const attempt of attempts) {
    const decision = (events || []).find(
      (row) =>
        row &&
        row.schema === "screening-decision-v1" &&
        row.id === attempt.screeningDecisionId,
    );
    const context = contextOf(events, attempt.decisionContextId);
    const exposure = (events || []).find(
      (row) =>
        row &&
        row.schema === "scan-exposure-v1" &&
        row.id === attempt.scanExposureId,
    );
    if (!decision || decision.decision !== "REJECT") {
      continue;
    }
    if (!context || !exposure) {
      continue;
    }
    if (
      typeof decision.scanExposureId !== "string" ||
      decision.scanExposureId !== attempt.scanExposureId
    ) {
      continue;
    }
    if (
      typeof decision.decisionContextId !== "string" ||
      decision.decisionContextId !== attempt.decisionContextId
    ) {
      continue;
    }
    if (exposure.id !== attempt.scanExposureId) {
      continue;
    }
    if (context.id !== attempt.decisionContextId) {
      continue;
    }
    if (!asOfOk(decision, universeAsOf) || !asOfOk(exposure, universeAsOf)) {
      continue;
    }
    if (!asOfOk(context, universeAsOf)) {
      continue;
    }
    const reviewTarget = {
      type: "SCREENING_ATTEMPT",
      screeningAttemptId: attempt.id,
      scanExposureId: attempt.scanExposureId,
      decisionContextId: attempt.decisionContextId,
      screeningReasonCode: decision.reasonCode,
    };
    const frozenPayload = {
      reviewTarget,
      attempt,
      decision,
      context,
      exposure,
    };
    items.push({
      type: "SCREENING_ATTEMPT",
      fingerprint: canonicalHash(reviewTarget),
      reviewTarget,
      frozenPayload,
      frozenReviewPayloadHash: frozenPayloadHash(frozenPayload),
    });
  }
  return items;
}

function representativeCard(events, opportunityIds, universeAsOf) {
  const cards = (events || [])
    .filter(
      (row) =>
        row &&
        row.schema === "variable-card-revision-v1" &&
        opportunityIds.includes(row.opportunityId) &&
        asOfOk(row, universeAsOf),
    )
    .slice()
    .sort((left, right) => {
      const leftAt = left.systemDecisionAt || "";
      const rightAt = right.systemDecisionAt || "";
      if (leftAt !== rightAt) {
        return leftAt < rightAt ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const ai = cards.filter((row) => row.origin === "AI_DISCOVERED");
  return ai[0] || cards[0] || null;
}

export function opportunityClassUniverse(events, universeAsOf) {
  const items = [];
  const seen = new Set();
  const opps = (events || []).filter(
    (row) => row && row.schema === "opportunity-v1" && asOfOk(row, universeAsOf),
  );
  for (const opp of opps) {
    if (seen.has(opp.id)) {
      continue;
    }
    const related = relatedOpportunities(events, opp.id);
    for (const id of related.memberOpportunityIds) {
      seen.add(id);
    }
    const card = representativeCard(events, related.memberOpportunityIds, universeAsOf);
    if (!card) {
      continue;
    }
    const presentation = (events || [])
      .filter(
        (row) =>
          row &&
          row.schema === "presentation-decision-v1" &&
          row.cardRevisionId === card.id &&
          asOfOk(row, universeAsOf),
      )
      .slice()
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )[0];
    if (!presentation) {
      continue;
    }
    const context = contextOf(events, card.decisionContextId);
    if (!context) {
      continue;
    }
    if (context.id !== card.decisionContextId) {
      continue;
    }
    if (typeof presentation.rankingDecisionContextId !== "string") {
      continue;
    }
    const rankingContext = contextOf(events, presentation.rankingDecisionContextId);
    if (!rankingContext) {
      continue;
    }
    if (rankingContext.id !== presentation.rankingDecisionContextId) {
      continue;
    }
    const themes = currentCardChildren(events, "theme-hypothesis-v1", card.id);
    const mappings = currentCardChildren(events, "security-mapping-v1", card.id);
    const themeHypothesisIds = themes.map((row) => row.id);
    const securityMappingIds = mappings.map((row) => row.id);
    const opportunityClassId = classIdOf(related.memberOpportunityIds);
    const reviewTarget = {
      type: "OPPORTUNITY_CLASS",
      opportunityClassId,
      representativeCardRevisionId: card.id,
      decisionContextId: card.decisionContextId,
      presentationDecisionId: presentation.id,
    };
    const frozenPayload = {
      reviewTarget,
      card,
      context,
      presentationDecision: presentation,
      memberOpportunityIds: [...related.memberOpportunityIds].sort(),
      opportunityClassId,
      themeHypothesisIds,
      securityMappingIds,
      themeManifest: themes,
      mappingManifest: mappings,
    };
    items.push({
      type: "OPPORTUNITY_CLASS",
      fingerprint: canonicalHash(reviewTarget),
      reviewTarget,
      frozenPayload,
      frozenReviewPayloadHash: frozenPayloadHash(frozenPayload),
      opportunityId: card.opportunityId,
      opportunityClassId,
      memberOpportunityIds: [...related.memberOpportunityIds].sort(),
    });
  }
  return items;
}

export function buildAuditUniverse(events, { universeAsOf, universeRuleVersion }) {
  if (universeRuleVersion !== "audit-universe-v1") {
    fail("UNIVERSE_INVALID", "unsupported universeRuleVersion");
  }
  const scoped = eventsAtAsOf(events, universeAsOf);
  const items = [
    ...screeningAttemptUniverse(scoped, universeAsOf),
    ...opportunityClassUniverse(scoped, universeAsOf),
  ].sort((left, right) =>
    left.fingerprint < right.fingerprint
      ? -1
      : left.fingerprint > right.fingerprint
        ? 1
        : 0,
  );
  const manifest = items.map((row) => ({
    type: row.type,
    fingerprint: row.fingerprint,
    reviewTarget: row.reviewTarget,
  }));
  return {
    items,
    manifest,
    count: items.length,
    hash: canonicalHash(manifest),
  };
}

export function sampleUniverse(items, samplingSeed, sampleSize) {
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    fail("UNIVERSE_INVALID", "sampleSize must be a positive integer");
  }
  if (items.length < sampleSize) {
    fail("UNIVERSE_TOO_SMALL", "universe is smaller than frozen sampleSize");
  }
  const ranked = items.map((item) => ({
    item,
    key: canonicalHash({ seed: samplingSeed, fingerprint: item.fingerprint }),
  }));
  ranked.sort((left, right) => {
    if (left.key !== right.key) {
      return left.key < right.key ? -1 : 1;
    }
    return left.item.fingerprint < right.item.fingerprint
      ? -1
      : left.item.fingerprint > right.item.fingerprint
        ? 1
        : 0;
  });
  return ranked
    .slice(0, sampleSize)
    .map((row) => row.item)
    .sort((left, right) =>
      left.fingerprint < right.fingerprint
        ? -1
        : left.fingerprint > right.fingerprint
          ? 1
          : 0,
    );
}

export function samplingSeedOf({
  auditPeriodAuthorityReceiptId,
  inputWatermarkHash,
  universeHash,
  seedDerivationVersion,
}) {
  return canonicalHash({
    auditPeriodAuthorityReceiptId,
    inputWatermarkHash,
    universeHash,
    seedDerivationVersion,
  });
}

export function itemIdOf(receiptId, fingerprint) {
  return brandedId("asitem_", { receiptId, fingerprint });
}

export function taskIdOf(itemId) {
  return brandedId("rt_", { auditSampleItemId: itemId, bucket: "BLIND_AUDIT" });
}

export function auditOpportunityIdOf(fingerprint) {
  return brandedId("opp_", { createdFrom: "AUDIT_SAMPLE", fingerprint });
}

export { classIdOf };
