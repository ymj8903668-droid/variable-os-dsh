// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const WATCH_POLICY_VERSION = "catalyst-watch-v1";
export const WATCH_IMPORTANCE_RULE_VERSION = "catalyst-watch-importance-v1";
export const WATCH_EVIDENCE_RULE_VERSION = "catalyst-watch-evidence-v1";

export const REJECT_DISPOSITIONS = Object.freeze([
  "WATCH_CATALYST",
  "DISCARD",
]);

export const WATCH_CATALYST_ARCHETYPES = Object.freeze([
  "FINANCIAL_REPORT",
  "ORDER_CONTRACT",
  "PRICE_CHANGE",
  "CAPACITY_CHANGE",
  "REGULATORY",
  "TECHNOLOGY",
  "SUPPLY_CHAIN",
  "DEMAND_CHANGE",
  "CORPORATE_ACTION",
  "OTHER",
]);

export const WATCH_HORIZONS = Object.freeze(["T1", "T3", "T5"]);

const IMPORTANCE_KEYS = Object.freeze([
  "impactSpace",
  "surprise",
  "timeSensitivity",
  "transmissionBreadth",
  "measurability",
]);

const EVIDENCE_KEYS = Object.freeze([
  "primarySource",
  "independentVerification",
  "numericBaseline",
  "timeBoundary",
  "mappingBasis",
]);

const SOURCE_REF = /^[A-Z][A-Z0-9_-]{0,31}$/;
const EVIDENCE_REF = /^([A-Z][A-Z0-9_-]{0,31})\.Q([1-9]\d{0,2})$/;
const FORBIDDEN_RECOMMENDATION =
  /买入|卖出|下单|加仓|减仓|清仓|满仓|目标价|交易建议|建议交易|交易策略|建议仓位|仓位(?:为|至|控制|提高|降低|[：:]\s*\d)/;

function watchError(message, details = {}) {
  const error = new Error(message);
  error.code = "LLM_OUTPUT_INVALID";
  Object.assign(error, details);
  return error;
}

function plainObject(value, fieldPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw watchError(`${fieldPath} object required`, { fieldPath });
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw watchError(`${fieldPath} plain object required`, { fieldPath });
  }
  return value;
}

function scoreSet(value, keys, ruleVersion, fieldPath) {
  plainObject(value, fieldPath);
  const result = {};
  let sum = 0;
  for (const key of keys) {
    const score = Number(value[key]);
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw watchError(`${fieldPath}.${key} invalid`, {
        fieldPath: `${fieldPath}.${key}`,
      });
    }
    result[key] = score;
    sum += score;
  }
  result.totalScore = Number((sum / keys.length).toFixed(2));
  result.ruleVersion = ruleVersion;
  return Object.freeze(result);
}

function neutralText(value, fieldPath) {
  if (typeof value !== "string" || !value.trim()) {
    throw watchError(`${fieldPath} non-empty string required`, { fieldPath });
  }
  const text = value.trim();
  if (text.length > 240) {
    throw watchError(`${fieldPath} exceeded limit`, { fieldPath });
  }
  if (FORBIDDEN_RECOMMENDATION.test(text)) {
    throw watchError(`${fieldPath} contains recommendation`, { fieldPath });
  }
  return text
    .replace(/市场交易关注度/g, "市场关注度")
    .replace(/交易关注度/g, "市场关注度")
    .replace(/交易拥挤度/g, "市场拥挤度")
    .replace(/可交易/g, "可研究")
    .replace(/交易/g, "市场行为");
}

function textList(value, fieldPath, { required = true } = {}) {
  if (!Array.isArray(value) || value.length > 8 || (required && value.length === 0)) {
    throw watchError(`${fieldPath} bounded array required`, { fieldPath });
  }
  return Object.freeze(
    value.map((entry, index) => neutralText(entry, `${fieldPath}[${index}]`)),
  );
}

function uniqueRefs(value, fieldPath, pattern, { availableRefs = null } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw watchError(`${fieldPath} bounded refs required`, { fieldPath });
  }
  const refs = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const ref = value[index];
    if (typeof ref !== "string" || !pattern.test(ref) || seen.has(ref)) {
      throw watchError(`${fieldPath}[${index}] invalid`, {
        fieldPath: `${fieldPath}[${index}]`,
      });
    }
    if (availableRefs && !availableRefs.has(ref)) {
      throw watchError(`${fieldPath}[${index}] is not frozen input`, {
        fieldPath: `${fieldPath}[${index}]`,
      });
    }
    seen.add(ref);
    refs.push(ref);
  }
  return Object.freeze(refs);
}

export function normalizeWatchAssessment(
  value,
  { availableSourceRefs = new Set(["SEED"]), availableEvidenceRefs = null } = {},
) {
  const watch = plainObject(value, "watch");
  if (!WATCH_CATALYST_ARCHETYPES.includes(watch.catalystArchetype)) {
    throw watchError("watch.catalystArchetype invalid", {
      fieldPath: "watch.catalystArchetype",
    });
  }
  if (!WATCH_HORIZONS.includes(watch.expectedHorizon)) {
    throw watchError("watch.expectedHorizon invalid", {
      fieldPath: "watch.expectedHorizon",
    });
  }
  const sourceRefs = uniqueRefs(watch.sourceRefs, "watch.sourceRefs", SOURCE_REF, {
    availableRefs: availableSourceRefs,
  });
  const evidenceRefs = uniqueRefs(
    watch.evidenceRefs,
    "watch.evidenceRefs",
    EVIDENCE_REF,
    { availableRefs: availableEvidenceRefs },
  );
  const sourceSet = new Set(sourceRefs);
  for (const ref of evidenceRefs) {
    const sourceRef = EVIDENCE_REF.exec(ref)?.[1];
    if (!sourceSet.has(sourceRef)) {
      throw watchError("watch.evidenceRefs must belong to sourceRefs", {
        fieldPath: "watch.evidenceRefs",
      });
    }
  }
  return Object.freeze({
    catalystArchetype: watch.catalystArchetype,
    expectedHorizon: watch.expectedHorizon,
    importance: scoreSet(
      watch.importance,
      IMPORTANCE_KEYS,
      WATCH_IMPORTANCE_RULE_VERSION,
      "watch.importance",
    ),
    evidenceMaturity: scoreSet(
      watch.evidenceMaturity,
      EVIDENCE_KEYS,
      WATCH_EVIDENCE_RULE_VERSION,
      "watch.evidenceMaturity",
    ),
    sourceRefs,
    evidenceRefs,
    missingEvidence: textList(watch.missingEvidence, "watch.missingEvidence"),
    verificationPlan: textList(watch.verificationPlan, "watch.verificationPlan"),
    invalidationConditions: textList(
      watch.invalidationConditions,
      "watch.invalidationConditions",
    ),
  });
}

export function watchExpiresAt(analyzedAt, expectedHorizon) {
  const started = Date.parse(analyzedAt);
  if (!Number.isFinite(started) || !WATCH_HORIZONS.includes(expectedHorizon)) {
    const error = new Error("valid analyzedAt and expectedHorizon required");
    error.code = "WATCH_INPUT_INVALID";
    throw error;
  }
  const hours = { T1: 24, T3: 72, T5: 120 }[expectedHorizon];
  return new Date(started + hours * 60 * 60 * 1_000).toISOString();
}
