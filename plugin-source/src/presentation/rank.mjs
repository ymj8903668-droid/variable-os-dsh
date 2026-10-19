// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PresentationError } from "./errors.mjs";

const BUDGETS = Object.freeze(["NEW", "WATCH_RETURN", "URGENT"]);
const BUDGET_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/policies/budget-v1.json",
);

function fail(code, message, details) {
  throw new PresentationError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[-_]/g, "");
}

function isForbiddenKey(key) {
  const n = normalizedKey(key);
  if (/涨|跌|收益/.test(key) || /涨|跌|收益/.test(n)) {
    return true;
  }
  return (
    n.includes("fermentation") ||
    n.includes("humanlabel") ||
    n.includes("marketobservation") ||
    n.includes("mappingeval") ||
    n.includes("returnpct") ||
    n.includes("abnormalreturn") ||
    n.includes("firstreaction") ||
    n === "outcome" ||
    n === "pnl" ||
    n === "labeledat" ||
    n === "feedbackjob"
  );
}

function assertNoOutcome(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoOutcome(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === "string" && /涨跌|收益率|下单/.test(value)) {
      fail("OUTCOME_FORBIDDEN", "outcome copy in ranking input", { path });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) {
      fail("OUTCOME_FORBIDDEN", `outcome field ${key} in ranking input`, {
        path,
        key,
      });
    }
    assertNoOutcome(value[key], `${path}.${key}`);
  }
}

function assertScoreComponents(value) {
  if (!isPlainObject(value)) {
    fail("INVALID_CANDIDATE", "scoreComponents required");
  }
  for (const key of [
    "evidenceStrength",
    "novelty",
    "timeSensitivity",
    "tradabilityConfidence",
    "mappingConfidence",
  ]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      fail("INVALID_CANDIDATE", `scoreComponents.${key} required`);
    }
  }
}

export function scoreCandidate(scoreComponents) {
  assertScoreComponents(scoreComponents);
  return (
    scoreComponents.evidenceStrength * 1e8 +
    scoreComponents.novelty * 1e6 +
    scoreComponents.timeSensitivity * 1e4 +
    scoreComponents.tradabilityConfidence * 1e2 +
    scoreComponents.mappingConfidence
  );
}

export function assertRankingInput(candidates, now) {
  if (!Array.isArray(candidates)) {
    fail("INVALID_CANDIDATE", "candidates must be an array");
  }
  if (typeof now !== "string" || now.length === 0) {
    fail("INVALID_TIME", "now required");
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) {
      fail("INVALID_CANDIDATE", "candidate must be a plain object");
    }
    assertNoOutcome(candidate, "candidate");
    if (typeof candidate.cardRevisionId !== "string" || !candidate.cardRevisionId) {
      fail("INVALID_CANDIDATE", "cardRevisionId required");
    }
    if (seen.has(candidate.cardRevisionId)) {
      fail("INVALID_CANDIDATE", "duplicate cardRevisionId");
    }
    seen.add(candidate.cardRevisionId);
    if (!BUDGETS.includes(candidate.budgetBucket)) {
      fail("INVALID_BUCKET", "budgetBucket must be NEW, WATCH_RETURN, or URGENT");
    }
    assertScoreComponents(candidate.scoreComponents);
    if (
      typeof candidate.systemDecisionAt === "string" &&
      candidate.systemDecisionAt > now
    ) {
      fail("FUTURE_RECORD", "candidate systemDecisionAt is after ranking now", {
        cardRevisionId: candidate.cardRevisionId,
      });
    }
  }
}

export async function loadBudget() {
  const parsed = JSON.parse(await fs.readFile(BUDGET_PATH, "utf8"));
  if (!parsed || parsed.synthetic !== true || parsed.version !== "budget-v1") {
    fail("INVALID_BUDGET", "budget-v1 fixture missing or not synthetic");
  }
  if (
    parsed.buckets?.NEW !== 10 ||
    parsed.buckets?.WATCH_RETURN !== 5 ||
    parsed.buckets?.URGENT !== 3
  ) {
    fail("INVALID_BUDGET", "budget-v1 capacities must be 10/5/3");
  }
  return parsed;
}

export function allocateBudget({ candidates, budget, now }) {
  if (!budget || budget.version !== "budget-v1" || !isPlainObject(budget.buckets)) {
    fail("INVALID_BUDGET", "budget-v1 required");
  }
  assertRankingInput(candidates, now);
  const grouped = {
    NEW: [],
    WATCH_RETURN: [],
    URGENT: [],
  };
  for (const candidate of candidates) {
    grouped[candidate.budgetBucket].push(candidate);
  }
  const allocations = [];
  for (const bucket of BUDGETS) {
    const capacity = budget.buckets[bucket];
    const sorted = [...grouped[bucket]].sort((left, right) => {
      const scoreDelta =
        scoreCandidate(right.scoreComponents) - scoreCandidate(left.scoreComponents);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      if (left.cardRevisionId < right.cardRevisionId) {
        return -1;
      }
      if (left.cardRevisionId > right.cardRevisionId) {
        return 1;
      }
      return 0;
    });
    sorted.forEach((candidate, index) => {
      const rank = index + 1;
      const score = scoreCandidate(candidate.scoreComponents);
      const slotted = index < capacity;
      allocations.push({
        cardRevisionId: candidate.cardRevisionId,
        tier: slotted ? "MUST_REVIEW" : "CANDIDATE_POOL",
        rank,
        score,
        budgetBucket: bucket,
        capacity,
        slot: slotted ? index + 1 : null,
        reasonCode: slotted ? "BUDGET_SLOT_ALLOCATED" : "BUDGET_OVERFLOW",
      });
    });
  }
  return {
    budgetVersion: "budget-v1",
    allocations,
  };
}
