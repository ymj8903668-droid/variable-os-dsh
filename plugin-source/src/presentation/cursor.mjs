// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { PresentationError } from "./errors.mjs";

const BUCKET_ORDER = Object.freeze({
  URGENT: 0,
  NEW: 1,
  WATCH_RETURN: 2,
});

function fail(code, message, details) {
  throw new PresentationError(code, message, details);
}

function decisionId(row) {
  return row.id || row.presentationDecisionId;
}

function isExpired(row, now) {
  if (typeof row.expiresAt !== "string" || typeof now !== "string") {
    return false;
  }
  return now >= row.expiresAt;
}

function compareMustReview(left, right) {
  if (left.budgetPeriodId !== right.budgetPeriodId) {
    return left.budgetPeriodId < right.budgetPeriodId ? -1 : 1;
  }
  const leftBucket = BUCKET_ORDER[left.budgetBucket];
  const rightBucket = BUCKET_ORDER[right.budgetBucket];
  if (leftBucket !== rightBucket) {
    return leftBucket - rightBucket;
  }
  if (left.slot !== right.slot) {
    return left.slot - right.slot;
  }
  const leftId = decisionId(left);
  const rightId = decisionId(right);
  if (leftId < rightId) {
    return -1;
  }
  if (leftId > rightId) {
    return 1;
  }
  return 0;
}

function comparePool(left, right) {
  if (left.decisionAt !== right.decisionAt) {
    return left.decisionAt > right.decisionAt ? -1 : 1;
  }
  const leftId = decisionId(left);
  const rightId = decisionId(right);
  if (leftId < rightId) {
    return 1;
  }
  if (leftId > rightId) {
    return -1;
  }
  return 0;
}

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    fail("CURSOR_INVALID", "limit must be a positive integer");
  }
}

export function pageMustReview({ decisions, cursor, limit, now }) {
  assertLimit(limit);
  if (!Array.isArray(decisions)) {
    fail("CURSOR_INVALID", "decisions required");
  }
  const items = decisions
    .filter((row) => row && row.tier === "MUST_REVIEW")
    .slice()
    .sort(compareMustReview);
  let start = 0;
  if (cursor) {
    if (
      !cursor.budgetPeriodId ||
      !cursor.budgetBucket ||
      typeof cursor.slot !== "number" ||
      !cursor.presentationDecisionId
    ) {
      fail("CURSOR_INVALID", "MUST_REVIEW cursor shape invalid");
    }
    const found = items.find(
      (row) => decisionId(row) === cursor.presentationDecisionId,
    );
    if (!found) {
      fail("CURSOR_INVALID", "MUST_REVIEW cursor does not match a decision");
    }
    if (
      found.budgetPeriodId !== cursor.budgetPeriodId ||
      found.budgetBucket !== cursor.budgetBucket ||
      found.slot !== cursor.slot
    ) {
      fail("CURSOR_INVALID", "MUST_REVIEW cursor fields do not match decision");
    }
    if (isExpired(found, now)) {
      fail("CURSOR_EXPIRED", "MUST_REVIEW cursor has expired");
    }
    start = items.indexOf(found) + 1;
  }
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: last
      ? {
          budgetPeriodId: last.budgetPeriodId,
          budgetBucket: last.budgetBucket,
          slot: last.slot,
          presentationDecisionId: decisionId(last),
        }
      : null,
  };
}

export function pageCandidatePool({ decisions, cursor, limit, now }) {
  assertLimit(limit);
  if (!Array.isArray(decisions)) {
    fail("CURSOR_INVALID", "decisions required");
  }
  const items = decisions
    .filter((row) => row && row.tier === "CANDIDATE_POOL")
    .slice()
    .sort(comparePool);
  let start = 0;
  if (cursor) {
    if (!cursor.latestDecisionAt || !cursor.presentationDecisionId) {
      fail("CURSOR_INVALID", "CANDIDATE_POOL cursor shape invalid");
    }
    const found = items.find(
      (row) => decisionId(row) === cursor.presentationDecisionId,
    );
    if (!found) {
      fail("CURSOR_INVALID", "CANDIDATE_POOL cursor does not match a decision");
    }
    if (found.decisionAt !== cursor.latestDecisionAt) {
      fail("CURSOR_INVALID", "CANDIDATE_POOL cursor time does not match");
    }
    if (isExpired(found, now)) {
      fail("CURSOR_EXPIRED", "CANDIDATE_POOL cursor has expired");
    }
    start = items.indexOf(found) + 1;
  }
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: last
      ? {
          latestDecisionAt: last.decisionAt,
          presentationDecisionId: decisionId(last),
        }
      : null,
  };
}
