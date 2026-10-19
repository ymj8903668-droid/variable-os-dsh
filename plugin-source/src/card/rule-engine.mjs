// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { CardError } from "./errors.mjs";

const SCORE_KEYS = [
  "evidenceStrength",
  "novelty",
  "timeSensitivity",
  "tradabilityConfidence",
  "mappingConfidence",
];
const REASON_CODES = new Set([
  "NEW_ACTIONABLE_VARIABLE",
  "MATERIAL_UPDATE_TO_EXISTING",
  "NOT_EVENT",
  "LOW_NOVELTY",
  "WEAK_EVIDENCE",
  "ALREADY_PRICED",
  "DUPLICATE_OR_UPDATE",
  "MAPPING_MISSING",
  "OUT_OF_SCOPE",
]);
const FORBIDDEN_COPY = /交易|下单|买卖|仓位/;
const FORBIDDEN_FIELD =
  /^(buy|sell|order|position|quantity|qty|orderId|positionSize)$/i;

const RULE_TABLE = Object.freeze({
  "demo.wechat-group:digest-001-original": Object.freeze({
    decision: "CREATE_CARD",
    reasonCode: "NEW_ACTIONABLE_VARIABLE",
    constituents: Object.freeze(["DEMO.600001", "DEMO.600002"]),
    themeRef: "theme:demo-line-a-delay",
    narrative: "demo-line-A vendor delay may change expected throughput",
    eventSummary:
      "demo.wechat-group digest-001-original records a vendor delay on demo-line-A",
    variableThesis:
      "expected demo-line-A throughput is later than the prior demo baseline",
    whyTradable:
      "a delayed demo-line-A can form a short-horizon variable around plant throughput",
    expectedHorizon: "T5",
    uncertainties: Object.freeze([
      "single demo source",
      "synthetic two-name universe",
    ]),
  }),
  "demo.wechat-group:digest-001-repost": Object.freeze({
    decision: "REJECT",
    reasonCode: "DUPLICATE_OR_UPDATE",
  }),
  "demo.public-account:note-101": Object.freeze({
    decision: "CREATE_CARD",
    reasonCode: "NEW_ACTIONABLE_VARIABLE",
    constituents: Object.freeze(["DEMO.600101", "DEMO.600102", "DEMO.600103"]),
    themeRef: "theme:demo-capacity-plant-b",
    narrative: "demo-capacity check around plant-B",
    eventSummary:
      "demo.public-account note-101 records a demo-capacity check for plant-B",
    variableThesis:
      "plant-B expected capacity is no longer the prior demo baseline",
    whyTradable:
      "plant-B capacity check can form a short-horizon variable around demo-capacity",
    expectedHorizon: "T5",
    uncertainties: Object.freeze([
      "demo public-note coverage",
      "synthetic three-name universe",
    ]),
  }),
  "demo.public-account:note-102": Object.freeze({
    decision: "CREATE_CARD",
    reasonCode: "NEW_ACTIONABLE_VARIABLE",
    constituents: Object.freeze(["DEMO.600201", "DEMO.600202", "DEMO.600203"]),
    themeRef: "theme:demo-export-route-c",
    narrative: "demo-export window around route-C",
    eventSummary:
      "demo.public-account note-102 records a demo-export window for route-C",
    variableThesis:
      "route-C expected export window is no longer the prior demo baseline",
    whyTradable:
      "route-C export window can form a short-horizon variable around demo-export",
    expectedHorizon: "T5",
    uncertainties: Object.freeze([
      "demo public-note coverage",
      "synthetic three-name universe",
    ]),
  }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoTrading(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoTrading(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    const isFrozenEvidenceQuote = /^output\.evidence\[\d+\]\.quote$/.test(path);
    if (
      typeof value === "string" &&
      FORBIDDEN_COPY.test(value) &&
      !isFrozenEvidenceQuote
    ) {
      throw new CardError("OUTPUT_SCHEMA_INVALID", "trading copy forbidden", {
        path,
      });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELD.test(key) || FORBIDDEN_COPY.test(key)) {
      throw new CardError("OUTPUT_SCHEMA_INVALID", "trading field forbidden", {
        path,
        key,
      });
    }
    assertNoTrading(value[key], `${path}.${key}`);
  }
}

function scoresFor(decision, constituentCount) {
  if (decision === "REJECT") {
    return {
      evidenceStrength: 0.2,
      novelty: 0,
      timeSensitivity: 0.1,
      tradabilityConfidence: 0,
      mappingConfidence: 0,
    };
  }
  if (constituentCount < 3) {
    return {
      evidenceStrength: 0.66,
      novelty: 0.7,
      timeSensitivity: 0.62,
      tradabilityConfidence: 0.45,
      mappingConfidence: 0.4,
    };
  }
  return {
    evidenceStrength: 0.72,
    novelty: 0.81,
    timeSensitivity: 0.64,
    tradabilityConfidence: 0.58,
    mappingConfidence: 0.61,
  };
}

export function validateRuleOutput(output) {
  if (!isPlainObject(output)) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "rule output must be object");
  }
  if (output.decision !== "CREATE_CARD" && output.decision !== "REJECT") {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "decision must be CREATE_CARD or REJECT");
  }
  if (!REASON_CODES.has(output.reasonCode)) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "reasonCode invalid");
  }
  if (!isPlainObject(output.scoreComponents)) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "scoreComponents required");
  }
  for (const key of SCORE_KEYS) {
    if (typeof output.scoreComponents[key] !== "number") {
      throw new CardError("OUTPUT_SCHEMA_INVALID", `score ${key} required`);
    }
  }
  assertNoTrading(output, "output");
  if (output.decision === "REJECT") {
    return {
      decision: "REJECT",
      reasonCode: output.reasonCode,
      scoreComponents: output.scoreComponents,
    };
  }
  if (
    typeof output.eventSummary !== "string" ||
    typeof output.variableThesis !== "string" ||
    typeof output.whyTradable !== "string" ||
    !Array.isArray(output.uncertainties) ||
    typeof output.expectedHorizon !== "string"
  ) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "card projection fields required");
  }
  if (typeof output.eventSummary !== "string" || output.eventSummary.includes("SYNTHETIC")) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "raw fixture body forbidden");
  }
  const theme = output.theme;
  if (!isPlainObject(theme) || !Array.isArray(theme.constituentSnapshot)) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "theme snapshot required");
  }
  if (!Array.isArray(output.mappings)) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "mappings required");
  }
  if (theme.constituentSnapshot.length !== output.mappings.length) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "mapping count must follow constituents");
  }
  const minConstituents =
    typeof output.minConstituents === "number" ? output.minConstituents : 3;
  const eligible =
    theme.constituentSnapshot.length >= minConstituents ? "ELIGIBLE" : "NOT_EVALUABLE";
  if (theme.fermentationEligibility !== eligible) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "fermentationEligibility mismatch");
  }
  if (
    eligible === "NOT_EVALUABLE" &&
    (typeof theme.fermentationEligibilityReason !== "string" ||
      theme.fermentationEligibilityReason.length === 0)
  ) {
    throw new CardError(
      "OUTPUT_SCHEMA_INVALID",
      "NOT_EVALUABLE requires a reason",
    );
  }
  if (Object.hasOwn(theme, "mappingResult") || Object.hasOwn(theme, "fermentationResult")) {
    throw new CardError("OUTPUT_SCHEMA_INVALID", "theme must not merge mapping/eval");
  }
  for (const mapping of output.mappings) {
    if (!isPlainObject(mapping) || typeof mapping.securityCode !== "string") {
      throw new CardError("OUTPUT_SCHEMA_INVALID", "mapping.securityCode required");
    }
    if (
      Object.hasOwn(mapping, "fermentationEligibility") ||
      Object.hasOwn(mapping, "fermentationResult") ||
      Object.hasOwn(mapping, "mappingResult")
    ) {
      throw new CardError("OUTPUT_SCHEMA_INVALID", "mapping must not merge theme/eval");
    }
  }
  return output;
}

export function existingCreateCardForContent({
  events,
  sourceItems,
  contentHash,
  sourceItemId,
}) {
  if (typeof contentHash !== "string" || contentHash.length === 0) {
    return false;
  }
  const others = (sourceItems || []).filter(
    (row) =>
      row &&
      row.schema === "source-item-v1" &&
      row.contentHash === contentHash &&
      row.id !== sourceItemId,
  );
  if (others.length === 0) {
    return false;
  }
  const otherIds = new Set(others.map((row) => row.id));
  const exposures = (events || []).filter(
    (row) =>
      row &&
      row.schema === "scan-exposure-v1" &&
      otherIds.has(row.sourceItemId),
  );
  const exposureIds = new Set(exposures.map((row) => row.id));
  return (events || []).some(
    (row) =>
      row &&
      row.schema === "variable-card-revision-v1" &&
      row.origin === "AI_DISCOVERED" &&
      exposureIds.has(row.triggerScanExposureId),
  );
}

export function evaluateScreeningRule({
  sourceNamespace,
  sourceDocumentKey,
  contentHash,
  fermentationPolicy,
  events = [],
  sourceItems = [],
  sourceItemId = null,
}) {
  if (
    typeof sourceNamespace !== "string" ||
    typeof sourceDocumentKey !== "string" ||
    typeof contentHash !== "string" ||
    contentHash.length === 0
  ) {
    throw new CardError("INPUT_REF_MISMATCH", "rule input identity incomplete");
  }
  const minConstituents =
    fermentationPolicy && typeof fermentationPolicy.minConstituents === "number"
      ? fermentationPolicy.minConstituents
      : 3;
  const ineligibleReason =
    (fermentationPolicy && fermentationPolicy.ineligibleReason) ||
    "CONSTITUENT_COUNT_BELOW_3";
  if (
    existingCreateCardForContent({
      events,
      sourceItems,
      contentHash,
      sourceItemId,
    })
  ) {
    return validateRuleOutput({
      decision: "REJECT",
      reasonCode: "DUPLICATE_OR_UPDATE",
      scoreComponents: scoresFor("REJECT", 0),
    });
  }
  const hit = RULE_TABLE[`${sourceNamespace}:${sourceDocumentKey}`];
  if (!hit) {
    return validateRuleOutput({
      decision: "REJECT",
      reasonCode: "OUT_OF_SCOPE",
      scoreComponents: scoresFor("REJECT", 0),
    });
  }
  if (hit.decision === "REJECT") {
    return validateRuleOutput({
      decision: "REJECT",
      reasonCode: hit.reasonCode,
      scoreComponents: scoresFor("REJECT", 0),
    });
  }
  const constituents = [...hit.constituents];
  const eligible =
    constituents.length >= minConstituents ? "ELIGIBLE" : "NOT_EVALUABLE";
  return validateRuleOutput({
    decision: "CREATE_CARD",
    reasonCode: hit.reasonCode,
    scoreComponents: scoresFor("CREATE_CARD", constituents.length),
    eventSummary: hit.eventSummary,
    variableThesis: hit.variableThesis,
    whyTradable: hit.whyTradable,
    expectedHorizon: hit.expectedHorizon,
    uncertainties: [...hit.uncertainties],
    minConstituents,
    theme: {
      themeRef: hit.themeRef,
      narrative: hit.narrative,
      constituentSnapshot: constituents,
      fermentationEligibility: eligible,
      fermentationEligibilityReason:
        eligible === "NOT_EVALUABLE" ? ineligibleReason : null,
    },
    mappings: constituents.map((securityCode) => ({
      securityCode,
      thesis: `independent mapping for ${securityCode}`,
    })),
  });
}
