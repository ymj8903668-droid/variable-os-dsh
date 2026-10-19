// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { fail } from "./errors.mjs";

const FERMENTATION_RULE = "fermentation-rule-v1";
const MAPPING_RULE = "mapping-rule-v1";
const REACTION_SEARCH_RULE = "reaction-search-v1";
const CALENDAR_RULE = "a-share-horizon-v1";

export function uniqueChainHead(rows, skipId = null) {
  const list = (rows || []).filter(
    (row) => row && typeof row.id === "string" && row.id !== skipId,
  );
  const superseded = new Set(
    list.map((row) => row.supersedesId).filter(Boolean),
  );
  const heads = list.filter((row) => !superseded.has(row.id));
  if (heads.length > 1) {
    fail("HEAD_AMBIGUOUS", "multiple current heads");
  }
  return heads[0] || null;
}

export function reviewAnchorId(feedbackJob) {
  const source = feedbackJob && feedbackJob.anchorSource;
  if (
    source &&
    source.type === "MAPPING_REVIEW" &&
    typeof source.mappingReviewId === "string" &&
    source.mappingReviewId
  ) {
    return source.mappingReviewId;
  }
  return null;
}

export function matchingReactionJobs(events, feedbackJob, themeId) {
  const wantKind =
    feedbackJob.jobKind === "MAPPING_SUPPLEMENT"
      ? "THEME_SUPPLEMENT"
      : feedbackJob.jobKind || "BASE_CARD";
  const wantReview = reviewAnchorId(feedbackJob);
  return (events || []).filter((row) => {
    if (!row || row.schema !== "reaction-search-job-v1") {
      return false;
    }
    if (row.cardRevisionId !== feedbackJob.cardRevisionId) {
      return false;
    }
    if ((row.jobKind || "BASE_CARD") !== wantKind) {
      return false;
    }
    if ((row.sourceMappingReviewId ?? null) !== wantReview) {
      return false;
    }
    return (row.themeHypothesisIds || []).includes(themeId);
  });
}

export function resolveLinkedAssessment(events, feedbackJob, themeId) {
  if (!feedbackJob.triggerScanExposureId) {
    return {
      linkStatus: "NO_VERIFIABLE_TRIGGER",
      assessmentId: null,
      assessment: null,
    };
  }
  const jobs = matchingReactionJobs(events, feedbackJob, themeId);
  if (jobs.length > 1) {
    fail("HEAD_AMBIGUOUS", "multiple matching reaction search jobs");
  }
  if (jobs.length === 0) {
    fail(
      "WAITING_REACTION_SEARCH",
      "no matching reaction search job for this feedback theme",
    );
  }
  const assessments = (events || []).filter(
    (row) =>
      row &&
      row.schema === "reaction-search-assessment-v1" &&
      row.reactionSearchJobId === jobs[0].id &&
      row.themeHypothesisId === themeId,
  );
  const head = uniqueChainHead(assessments);
  if (!head) {
    fail(
      "WAITING_REACTION_SEARCH",
      "no current reaction search assessment for this theme",
    );
  }
  return {
    linkStatus: "LINKED",
    assessmentId: head.id,
    assessment: head,
    reactionJob: jobs[0],
  };
}

export function primaryReviewReason(codes) {
  const ordered = [
    "CONFLICT",
    "LOW_CONFIDENCE",
    "CONFOUNDED",
    "WINDOW_REVERSAL",
  ];
  const found = ordered.find((code) => (codes || []).includes(code));
  return found || null;
}

export function presentationDecisionsForCard(events, cardRevisionId) {
  return (events || []).filter(
    (row) =>
      row &&
      row.schema === "presentation-decision-v1" &&
      row.cardRevisionId === cardRevisionId,
  );
}

export function resolvePresentationDecision(
  events,
  cardRevisionId,
  requestedId,
) {
  const rows = presentationDecisionsForCard(events, cardRevisionId);
  if (typeof requestedId === "string" && requestedId.length > 0) {
    if (requestedId === "pdec_none") {
      fail("INVALID_PRESENTATION", "placeholder presentation decision is forbidden");
    }
    const found = rows.find((row) => row.id === requestedId);
    if (!found) {
      fail(
        "INVALID_PRESENTATION",
        "presentationDecisionId does not belong to card",
      );
    }
    return found;
  }
  if (rows.length === 0) {
    return null;
  }
  if (rows.length === 1) {
    return rows[0];
  }
  fail(
    "PRESENTATION_DECISION_REQUIRED",
    "presentationDecisionId required when multiple decisions exist",
  );
}

export function assertJobGraph({ job, card, theme, mappings }) {
  if (!card || card.schema !== "variable-card-revision-v1") {
    fail("INPUT_REF_MISMATCH", "card revision is not committed");
  }
  if (card.id !== job.cardRevisionId) {
    fail("INPUT_REF_MISMATCH", "job cardRevisionId does not match card");
  }
  if (!theme || theme.schema !== "theme-hypothesis-v1") {
    fail("INPUT_REF_MISMATCH", "theme is not committed");
  }
  if (theme.cardRevisionId !== job.cardRevisionId) {
    fail("INPUT_REF_MISMATCH", "theme cardRevisionId does not match job");
  }
  if (!(job.themeHypothesisIds || []).includes(theme.id)) {
    fail("INPUT_REF_MISMATCH", "theme is not committed on this job");
  }
  const mappingIds = job.securityMappingIds || [];
  if (!Array.isArray(mappings) || mappings.length !== mappingIds.length) {
    fail("INPUT_REF_MISMATCH", "security mapping is not committed on this job");
  }
  for (const mapping of mappings) {
    if (mapping.schema !== "security-mapping-v1") {
      fail("INPUT_REF_MISMATCH", "security mapping is not committed on this job");
    }
    if (mapping.cardRevisionId !== job.cardRevisionId) {
      fail("INPUT_REF_MISMATCH", "mapping cardRevisionId does not match job");
    }
    if (mapping.themeHypothesisId !== theme.id) {
      fail("INPUT_REF_MISMATCH", "mapping themeHypothesisId does not match theme");
    }
  }
}

export function assertSupplementFrozen(job, events) {
  if (
    job.jobKind !== "THEME_SUPPLEMENT" &&
    job.jobKind !== "MAPPING_SUPPLEMENT"
  ) {
    return;
  }
  const reviewId = reviewAnchorId(job);
  if (!reviewId) {
    fail("INPUT_REF_MISMATCH", "supplement job missing mapping review anchor");
  }
  const review = (events || []).find(
    (row) => row.schema === "mapping-review-v1" && row.id === reviewId,
  );
  if (!review) {
    fail("INPUT_REF_MISMATCH", "mapping review anchor is not committed");
  }
  const expected = canonicalHash({
    mappingReviewId: reviewId,
    replacementTargetId: job.replacementTargetId,
    themeHypothesisIds: job.themeHypothesisIds,
    securityMappingIds: job.securityMappingIds,
    fermentationRuleVersion: FERMENTATION_RULE,
    mappingRuleVersion: MAPPING_RULE,
    reactionSearchRuleVersion: REACTION_SEARCH_RULE,
    calendarRuleVersion: CALENDAR_RULE,
  });
  if (job.frozenSnapshotHash !== expected) {
    fail("INPUT_HASH_MISMATCH", "supplement frozenSnapshotHash is not recomputable");
  }
}
