// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { buildCanonicalDecisionInput } from "../decision/canonical-input.mjs";
import { auditTimeGates } from "../decision/time-gate.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { CardError } from "./errors.mjs";
import { getAnnouncedCalendar } from "./announced-calendar.mjs";
import {
  normalizeCatalystTheme,
  sameCatalystMainline,
} from "./catalyst-identity.mjs";
import {
  loadHorizonCalendar,
  resolveAShareHorizons,
  resolveReactionSearchWindow,
} from "./horizon.mjs";
import { evaluateScreeningRule, validateRuleOutput } from "./rule-engine.mjs";

const BUILDER_VERSION_CONTEXT = "card-context-v1";
const BUILDER_VERSION_ENGINE = "card-engine-v1";
const BUILDER_VERSION_OUTPUT = "card-output-v2";
const POLICY_VERSION = "card-synthesis-v1";
const RULE_VERSION = "card-screen-rule-v1";
const CALENDAR_RULE_VERSION = "a-share-horizon-v1";
const FERMENTATION_RULE_VERSION = "fermentation-rule-v1";
const MAPPING_RULE_VERSION = "mapping-rule-v1";
const REACTION_SEARCH_RULE_VERSION = "reaction-search-v1";
const CATALYST_CONTINUATION_RELATIONS = new Set([
  "REINFORCES",
  "UPDATES",
  "CONTRADICTS",
]);

export const PHASE_COMMAND = Object.freeze({
  context: "materializeCardContext",
  engine: "materializeCardEngine",
  output: "materializeCardOutputs",
});

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const calendarPath = path.join(
  appRoot,
  "fixtures/calendar/a-share-2026-q3.json",
);
const fermentationPath = path.join(
  appRoot,
  "fixtures/policies/fermentation-rule-v1.json",
);
const mappingPath = path.join(
  appRoot,
  "fixtures/policies/mapping-rule-v1.json",
);
const reactionSearchPath = path.join(
  appRoot,
  "fixtures/policies/reaction-search-v1.json",
);

function fail(code, message, details) {
  throw new CardError(code, message, details);
}

async function loadPolicy(filePath, version) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || parsed.synthetic !== true || parsed.version !== version) {
    fail("INVALID_POLICY", `policy ${version} missing or not synthetic`);
  }
  return parsed;
}

function indexById(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row && typeof row.id === "string") {
      map.set(row.id, row);
    }
  }
  return map;
}

function assertExpectedId(expected, actual, label) {
  if (expected !== undefined && expected !== actual) {
    fail("INPUT_REF_MISMATCH", `${label} id mismatch`, {
      expected,
      actual,
    });
  }
}

function assertExpectedHash(expected, actual, label) {
  if (expected !== undefined && expected !== actual) {
    fail("INPUT_HASH_MISMATCH", `${label} hash mismatch`, { label });
  }
}

function semanticIdempotencyKey({
  phase,
  scanExposureId,
  engineType,
  modelVersion,
  promptVersion,
  modelOutputHash,
}) {
  const parts = [
    "card-v1",
    phase,
    scanExposureId,
    engineType,
    RULE_VERSION,
    CALENDAR_RULE_VERSION,
    FERMENTATION_RULE_VERSION,
    MAPPING_RULE_VERSION,
    REACTION_SEARCH_RULE_VERSION,
  ];
  if (engineType === "MODEL") {
    parts.push(
      modelVersion || "external-model",
      promptVersion || "external-prompt",
      modelOutputHash || "no-output",
    );
  }
  return parts.join(":");
}

function versionsInput() {
  return {
    ruleVersion: RULE_VERSION,
    calendarRuleVersion: CALENDAR_RULE_VERSION,
    fermentationRuleVersion: FERMENTATION_RULE_VERSION,
    mappingRuleVersion: MAPPING_RULE_VERSION,
    reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
  };
}

function engineInvocationIdOf({
  decisionContextId,
  engineType,
  modelVersion,
  promptVersion,
  modelOutputHash,
}) {
  return canonicalHash({
    decisionContextId,
    engineType,
    ruleVersion: engineType === "RULE" ? RULE_VERSION : null,
    modelVersion: engineType === "MODEL" ? modelVersion : null,
    promptVersion: engineType === "MODEL" ? promptVersion : null,
    modelOutputHash: engineType === "MODEL" ? modelOutputHash : null,
  });
}

export function engineResultIdOf({ decisionContextId, engineInvocationId }) {
  return brandedId("der_", { decisionContextId, engineInvocationId });
}

export function feedbackJobIdOf({ cardRevisionId, horizon }) {
  return brandedId("fbj_", {
    jobKind: "BASE_CARD",
    cardRevisionId,
    horizon,
    calendarRuleVersion: CALENDAR_RULE_VERSION,
  });
}

export function reactionSearchJobIdOf({ cardRevisionId }) {
  return brandedId("rsj_", {
    kind: "REACTION_SEARCH",
    cardRevisionId,
    reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
  });
}

async function projectCommitted(runtime) {
  try {
    return await runtime.project();
  } catch (err) {
    fail("LEDGER_CORRUPT", "committed projection unavailable", {
      cause: err && err.code,
    });
  }
}

export function resolveCommittedInputs({
  events,
  sources,
  scanExposureId,
  expectedSourceItemId,
  expectedSourceItemHash,
  expectedDecisionContextId,
  expectedDecisionContextHash,
  expectedTimeGateAuditId,
  expectedTimeGateAuditHash,
  expectedScanExposureHash,
}) {
  if (typeof scanExposureId !== "string" || scanExposureId.length === 0) {
    fail("INPUT_REF_MISMATCH", "scanExposureId required");
  }
  const byId = indexById([...events, ...sources]);
  const exposure = byId.get(scanExposureId);
  if (!exposure || exposure.schema !== "scan-exposure-v1") {
    fail("INPUT_REF_MISMATCH", "scan exposure not committed");
  }
  const source = byId.get(exposure.sourceItemId);
  if (!source || source.schema !== "source-item-v1") {
    fail("INPUT_REF_MISMATCH", "source item not committed");
  }
  const scanAttempt = events.find(
    (row) =>
      row.schema === "screening-attempt-v1" &&
      row.scanExposureId === exposure.id &&
      row.screeningDecisionId === null &&
      (row.failureCode === "CARD_SYNTHESIS_DEFERRED" ||
        row.result === "BLOCKED_TIME_AUDIT"),
  );
  if (!scanAttempt) {
    fail("INPUT_REF_MISMATCH", "scan screening attempt not committed");
  }
  const context = byId.get(scanAttempt.decisionContextId);
  const audit = byId.get(scanAttempt.timeGateAuditId);
  if (!context || context.schema !== "decision-context-v1") {
    fail("INPUT_REF_MISMATCH", "decision context not committed");
  }
  if (!audit || audit.schema !== "time-gate-audit-v1") {
    fail("INPUT_REF_MISMATCH", "time-gate audit not committed");
  }
  if (context.subjectRef?.type !== "SCAN_EXPOSURE") {
    fail("INPUT_REF_MISMATCH", "context subject is not SCAN_EXPOSURE");
  }
  if (context.subjectRef.id !== exposure.id) {
    fail("INPUT_REF_MISMATCH", "context subject does not match exposure");
  }
  if (audit.decisionContextId !== context.id) {
    fail("INPUT_REF_MISMATCH", "audit context foreign key mismatch");
  }
  const focal = Array.isArray(context.contextItems)
    ? context.contextItems[0]
    : null;
  if (!focal || focal.refType !== "SOURCE_ITEM" || focal.refId !== source.id) {
    fail("INPUT_REF_MISMATCH", "context focal source item mismatch");
  }
  if (focal.contentHash !== source.contentHash) {
    fail("INPUT_HASH_MISMATCH", "context contentHash does not match source");
  }
  const rebuilt = buildCanonicalDecisionInput({
    decisionType: context.decisionType,
    subjectRef: context.subjectRef,
    focalEventInstanceId: context.focalEventInstanceId,
    contextCutoffAt: context.contextCutoffAt,
    contextItems: context.contextItems,
    engine: context.engine,
    policyVersion: context.policyVersion,
  });
  if (rebuilt.contextHash !== context.contextHash) {
    fail("INPUT_HASH_MISMATCH", "committed contextHash is not recomputable");
  }
  assertExpectedId(expectedSourceItemId, source.id, "sourceItem");
  assertExpectedId(expectedDecisionContextId, context.id, "decisionContext");
  assertExpectedId(expectedTimeGateAuditId, audit.id, "timeGateAudit");
  assertExpectedHash(
    expectedScanExposureHash,
    canonicalHash(exposure),
    "scanExposure",
  );
  assertExpectedHash(
    expectedSourceItemHash,
    canonicalHash(source),
    "sourceItem",
  );
  assertExpectedHash(
    expectedDecisionContextHash,
    canonicalHash(context),
    "decisionContext",
  );
  assertExpectedHash(
    expectedTimeGateAuditHash,
    canonicalHash(audit),
    "timeGateAudit",
  );
  if (scanAttempt.result === "BLOCKED_TIME_AUDIT" || audit.overallResult !== "PASS") {
    fail("TIME_AUDIT_FAILED", "blocked scan exposure cannot be materialized");
  }
  const structured =
    focal.payload && focal.payload.structuredInput
      ? focal.payload.structuredInput
      : null;
  if (
    !structured ||
    structured.sourceDocumentKey !== source.sourceDocumentKey ||
    structured.contentHash !== source.contentHash
  ) {
    fail("INPUT_REF_MISMATCH", "structured input does not match source item");
  }
  return { exposure, source, scanAttempt, context, audit, structured };
}

function envelope({ schema, id, now, targetCommitGroupId, extra }) {
  return {
    schema,
    id,
    createdAt: now,
    recordedAt: now,
    actorType: "SYSTEM",
    actorId: "system:demo-runner",
    correlationId: extra.correlationId,
    commitGroupId: targetCommitGroupId,
    supersedesId: extra.supersedesId ?? null,
    policyVersion: extra.policyVersion ?? POLICY_VERSION,
    ...extra,
  };
}

function pushEvent(members, record) {
  members.push({ file: "events", record });
}

function normalizedVariableTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

function stableSourceLineageKey(source) {
  const sourceNamespace = String(source?.sourceNamespace || "").trim();
  const sourceDocumentKey = String(source?.sourceDocumentKey || "").trim();
  const match = sourceDocumentKey.match(
    /^(.*)#L(\d+)(?:-L\d+)?(?::[0-9a-f]{12,64})?$/iu,
  );
  if (!sourceNamespace || !match) return null;
  return `${sourceNamespace}:${match[1]}#L${match[2]}`;
}

function resolveVariableRevision(
  events,
  variableTitle,
  scanExposureId,
  source,
  catalystIdentityKey,
  { reasonCode = null, relationToPrior = null } = {},
) {
  const opportunities = new Map(
    events
      .filter((row) => row?.schema === "opportunity-v1")
      .map((row) => [row.id, row]),
  );
  const exposures = new Map(
    events
      .filter((row) => row?.schema === "scan-exposure-v1")
      .map((row) => [row.id, row]),
  );
  const sources = new Map(
    events
      .filter((row) => row?.schema === "source-item-v1")
      .map((row) => [row.id, row]),
  );
  const themes = new Map(
    events
      .filter((row) => row?.schema === "theme-hypothesis-v1")
      .map((row) => [row.id, row]),
  );
  const latestCardForVariable = new Map();
  for (const row of events) {
    if (row?.schema !== "variable-card-revision-v1") continue;
    const previous = latestCardForVariable.get(row.variableId);
    if (
      !previous ||
      Number(row.revision || 0) > Number(previous.revision || 0) ||
      (Number(row.revision || 0) === Number(previous.revision || 0) &&
        String(row.systemDecisionAt || "") > String(previous.systemDecisionAt || ""))
    ) {
      latestCardForVariable.set(row.variableId, row);
    }
  }
  const proposedTitleIdentityKey = normalizedVariableTitle(variableTitle);
  const sourceLineageKey = stableSourceLineageKey(source);
  const explicitCatalystContinuation =
    reasonCode === "MATERIAL_UPDATE_TO_EXISTING" &&
    CATALYST_CONTINUATION_RELATIONS.has(relationToPrior);
  const lineageForVariable = (variable) => {
    if (typeof variable?.sourceLineageKey === "string") {
      return variable.sourceLineageKey;
    }
    const opportunity = opportunities.get(variable?.opportunityId);
    const exposure = exposures.get(opportunity?.triggerScanExposureId);
    return stableSourceLineageKey(sources.get(exposure?.sourceItemId));
  };
  const catalystForVariable = (variable) => {
    if (typeof variable?.catalystIdentityKey === "string") {
      return variable.catalystIdentityKey;
    }
    const card = latestCardForVariable.get(variable?.id);
    const theme = themes.get(card?.themeHypothesisIds?.[0]);
    return normalizeCatalystTheme(theme?.themeRef);
  };
  const matchingVariables = events.filter((row) => {
      if (row?.schema !== "variable-v1") return false;
      const opportunity = opportunities.get(row.opportunityId);
      if (opportunity?.triggerScanExposureId === scanExposureId) return false;
      const sameFrozenSource =
        sourceLineageKey !== null && lineageForVariable(row) === sourceLineageKey;
      const priorCatalystIdentityKey = normalizeCatalystTheme(
        catalystForVariable(row),
      );
      const sameDeclaredCatalyst = Boolean(
        catalystIdentityKey && catalystIdentityKey === priorCatalystIdentityKey,
      );
      const sameCatalyst =
        (explicitCatalystContinuation && sameDeclaredCatalyst) ||
        sameCatalystMainline(
          {
            catalystIdentityKey,
            variableIdentityKey: proposedTitleIdentityKey,
          },
          {
            catalystIdentityKey: priorCatalystIdentityKey,
            variableIdentityKey: row.identityKey || row.canonicalTitle,
          },
        );
      return sameFrozenSource || sameCatalyst;
    });
  const matchingVariableIds = new Set(matchingVariables.map((row) => row.id));
  const latestCardByVariable = new Map();
  for (const row of events) {
    if (
      row?.schema !== "variable-card-revision-v1" ||
      !matchingVariableIds.has(row.variableId) ||
      row.triggerScanExposureId === scanExposureId
    ) {
      continue;
    }
    const previous = latestCardByVariable.get(row.variableId);
    if (
      !previous ||
      Number(row.revision || 0) > Number(previous.revision || 0) ||
      (Number(row.revision || 0) === Number(previous.revision || 0) &&
        String(row.systemDecisionAt || "") > String(previous.systemDecisionAt || ""))
    ) {
      latestCardByVariable.set(row.variableId, row);
    }
  }
  const variable =
    matchingVariables.sort((left, right) => {
      const leftCard = latestCardByVariable.get(left.id);
      const rightCard = latestCardByVariable.get(right.id);
      const time = String(rightCard?.systemDecisionAt || right.createdAt || "").localeCompare(
        String(leftCard?.systemDecisionAt || left.createdAt || ""),
      );
      return time || String(right.id).localeCompare(String(left.id));
    })[0] || null;
  if (!variable) {
    return Object.freeze({
      identityKey: proposedTitleIdentityKey,
      proposedTitleIdentityKey,
      sourceLineageKey,
      catalystIdentityKey,
      variable: null,
      previousCard: null,
      revision: 1,
    });
  }
  const previousCards = events
    .filter(
      (row) =>
        row?.schema === "variable-card-revision-v1" &&
        row.variableId === variable.id &&
        row.triggerScanExposureId !== scanExposureId,
    )
    .sort((left, right) => {
      const revision = Number(right.revision || 0) - Number(left.revision || 0);
      if (revision) return revision;
      return String(right.systemDecisionAt || "").localeCompare(
        String(left.systemDecisionAt || ""),
      );
    });
  const previousCard = previousCards[0] || null;
  return Object.freeze({
    identityKey:
      variable.identityKey || normalizedVariableTitle(variable.canonicalTitle),
    proposedTitleIdentityKey,
    sourceLineageKey,
    catalystIdentityKey,
    variable,
    previousCard,
    revision: Number(previousCard?.revision || 0) + 1,
  });
}

function systemSuggestionForOutput(output) {
  if (
    output?.systemSuggestion?.authority === "SYSTEM_SUGGESTION" &&
    ["TRADABLE", "WATCH", "NOT_TRADABLE"].includes(
      output.systemSuggestion.label,
    )
  ) {
    return output.systemSuggestion;
  }
  const scores = output?.scoreComponents || {};
  const label =
    scores.evidenceStrength >= 0.58 && scores.tradabilityConfidence >= 0.62
      ? "TRADABLE"
      : scores.evidenceStrength >= 0.5 && scores.tradabilityConfidence <= 0.25
        ? "NOT_TRADABLE"
        : "WATCH";
  return {
    authority: "SYSTEM_SUGGESTION",
    label,
    rationale: "规则样本仅提供复核顺序建议，请以冻结证据和人工研判为准。",
    basis: "POLICY_FALLBACK",
  };
}

function outputReceiptFields(records) {
  const sorted = [...records].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const outputRecordIds = sorted.map((row) => row.id);
  const decisionOutputRecordHashes = sorted.map((row) => canonicalHash(row));
  const pairs = sorted.map((row, index) => [
    row.id,
    decisionOutputRecordHashes[index],
  ]);
  return {
    outputRecordIds,
    decisionOutputRecordHashes,
    decisionOutputGroupHash: pairs.length === 0 ? null : canonicalHash(pairs),
  };
}

function buildEngineSpec(
  engineType,
  exposure,
  source,
  { modelVersion, promptVersion, modelOutputHash, horizonCalendar },
) {
  const calendarInput = horizonCalendar ? {
    horizonCalendar: { calendarId: horizonCalendar.calendarId, contentHash: horizonCalendar.contentHash },
  } : {};
  if (engineType === "MODEL") {
    return {
      engineType: "MODEL",
      modelVersion,
      promptVersion,
      canonicalDecisionInput: {
        modelRequest: {
          action: "CARD_SYNTHESIS",
          scanExposureId: exposure.id,
          sourceItemId: source.id,
          modelOutputHash,
          ...calendarInput,
        },
      },
    };
  }
  return {
    engineType: "RULE",
    ruleVersion: RULE_VERSION,
    canonicalDecisionInput: {
      ruleInput: {
        sourceNamespace: source.sourceNamespace,
        sourceDocumentKey: source.sourceDocumentKey,
        contentHash: source.contentHash,
        scanExposureId: exposure.id,
        sourceItemId: source.id,
        ...calendarInput,
      },
    },
  };
}

function buildCanonicalContext({
  engineType,
  exposure,
  source,
  now,
  modelVersion,
  promptVersion,
  modelOutputHash,
  horizonCalendar,
}) {
  const contextItem = {
    id: `ctxi_${source.id}`,
    stream: "FOCAL",
    refType: "SOURCE_ITEM",
    refId: source.id,
    availabilityReceiptId: null,
    resolutionReceiptId: null,
    availableAt: source.availableAt,
    resolvedAt: null,
    contentHash: source.contentHash,
    memberRefs: [],
    payload: {
      structuredInput: {
        sourceNamespace: source.sourceNamespace,
        sourceDocumentKey: source.sourceDocumentKey,
        contentHash: source.contentHash,
        fixtureRef: source.rawUri,
      },
    },
  };
  return buildCanonicalDecisionInput({
    decisionType: "SCREENING",
    subjectRef: { type: "SCAN_EXPOSURE", id: exposure.id },
    focalEventInstanceId: null,
    contextCutoffAt: now,
    contextItems: [contextItem],
    engine: buildEngineSpec(engineType, exposure, source, {
      modelVersion,
      promptVersion,
      modelOutputHash,
      horizonCalendar,
    }),
    policyVersion: POLICY_VERSION,
  });
}

function findCardContext(
  events,
  exposureId,
  engineType,
  { modelVersion, promptVersion, modelOutputHash },
) {
  return events.find(
    (row) =>
      row.schema === "decision-context-v1" &&
      row.policyVersion === POLICY_VERSION &&
      row.subjectRef &&
      row.subjectRef.id === exposureId &&
      row.engine &&
      row.engine.engineType === engineType &&
      (engineType !== "MODEL" ||
        (row.engine.modelVersion === modelVersion &&
          row.engine.promptVersion === promptVersion &&
          row.engine.canonicalDecisionInput?.modelRequest?.modelOutputHash ===
            modelOutputHash)),
  );
}

function findCardAudit(events, contextId) {
  return events.find(
    (row) =>
      row.schema === "time-gate-audit-v1" &&
      row.decisionContextId === contextId &&
      row.policyVersion === POLICY_VERSION,
  );
}

function findEngineResult(events, contextId) {
  return events.find(
    (row) =>
      row.schema === "decision-engine-result-v1" &&
      row.decisionContextId === contextId,
  );
}

function assertRecomputableContext(context) {
  const rebuilt = buildCanonicalDecisionInput({
    decisionType: context.decisionType,
    subjectRef: context.subjectRef,
    focalEventInstanceId: context.focalEventInstanceId,
    contextCutoffAt: context.contextCutoffAt,
    contextItems: context.contextItems,
    engine: context.engine,
    policyVersion: context.policyVersion,
  });
  if (rebuilt.contextHash !== context.contextHash) {
    fail("INPUT_HASH_MISMATCH", "card contextHash is not recomputable");
  }
}

function assertRecomputableEngine(engine) {
  const expectedId = engineResultIdOf({
    decisionContextId: engine.decisionContextId,
    engineInvocationId: engine.engineInvocationId,
  });
  if (engine.id !== expectedId) {
    fail("INPUT_HASH_MISMATCH", "engine result id is not recomputable");
  }
  if (engine.status === "SUCCEEDED") {
    if (engine.outputHash !== canonicalHash(engine.validatedOutput)) {
      fail("INPUT_HASH_MISMATCH", "engine outputHash is not recomputable");
    }
  }
}

export function buildContextMembers({
  assignId,
  targetCommitGroupId,
  canonicalCommandInput,
  now,
  committed,
}) {
  const { exposure, source } = committed;
  const engineType = canonicalCommandInput.engineType;
  const correlationId = canonicalCommandInput.correlationId;
  const canonical = buildCanonicalContext({
    engineType,
    exposure,
    source,
    now,
    modelVersion: canonicalCommandInput.modelVersion,
    promptVersion: canonicalCommandInput.promptVersion,
    modelOutputHash: canonicalCommandInput.modelOutputHash,
    horizonCalendar: canonicalCommandInput.horizonCalendar,
  });
  const decisionTiming =
    engineType === "RULE"
      ? { systemDecisionAt: now, engineCompletedAt: now, enqueuedAt: null }
      : null;
  const audit = auditTimeGates({
    contextCutoffAt: now,
    contextItems: canonical.contextItems,
    decisionTiming,
  });
  const contextId = assignId("decision-context-v1", "context");
  const auditId = assignId("time-gate-audit-v1", "audit");
  const members = [];
  pushEvent(
    members,
    envelope({
      schema: "decision-context-v1",
      id: contextId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        decisionType: canonical.decisionType,
        subjectRef: canonical.subjectRef,
        engine: canonical.engine,
        contextCutoffAt: canonical.contextCutoffAt,
        focalEventInstanceId: canonical.focalEventInstanceId,
        contextItems: canonical.contextItems,
        policyVersion: canonical.policyVersion,
        serializationVersion: canonical.serializationVersion,
        hashAlgorithm: "SHA-256",
        contextHash: canonical.contextHash,
      },
    }),
  );
  pushEvent(
    members,
    envelope({
      schema: "time-gate-audit-v1",
      id: auditId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        decisionContextId: contextId,
        itemResults: audit.itemResults,
        gates: audit.gates,
        overallResult: audit.overallResult,
        failureCodes: audit.failureCodes,
        auditedAt: now,
      },
    }),
  );
  return members;
}

export function buildEngineMembers({
  targetCommitGroupId,
  canonicalCommandInput,
  now,
  committed,
  fermentationPolicy,
  committedProjection,
}) {
  const { source } = committed;
  const engineType = canonicalCommandInput.engineType;
  const correlationId = canonicalCommandInput.correlationId;
  const decisionContextId = canonicalCommandInput.cardContextId;
  const engineInvocationId = canonicalCommandInput.engineInvocationId;
  const engineId = engineResultIdOf({
    decisionContextId,
    engineInvocationId,
  });
  let record;
  if (engineType === "MODEL" && canonicalCommandInput.validatedModelOutput) {
    const validatedOutput = validateRuleOutput(
      canonicalCommandInput.validatedModelOutput,
    );
    record = envelope({
      schema: "decision-engine-result-v1",
      id: engineId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        decisionContextId,
        engineInvocationId,
        status: "SUCCEEDED",
        validatedOutput,
        outputHash: canonicalHash(validatedOutput),
        sanitizedFailureCode: null,
        completedAt: now,
      },
    });
  } else if (engineType === "MODEL") {
    record = envelope({
      schema: "decision-engine-result-v1",
      id: engineId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        decisionContextId,
        engineInvocationId,
        status: "FAILED",
        validatedOutput: null,
        outputHash: null,
        sanitizedFailureCode: "ENGINE_FAILED",
        completedAt: now,
      },
    });
  } else {
    const validatedOutput = evaluateScreeningRule({
      sourceNamespace: source.sourceNamespace,
      sourceDocumentKey: source.sourceDocumentKey,
      contentHash: source.contentHash,
      fermentationPolicy,
      events: committedProjection && committedProjection.events,
      sourceItems: committedProjection && committedProjection.sourceItems,
      sourceItemId: source.id,
    });
    record = envelope({
      schema: "decision-engine-result-v1",
      id: engineId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        decisionContextId,
        engineInvocationId,
        status: "SUCCEEDED",
        validatedOutput,
        outputHash: canonicalHash(validatedOutput),
        sanitizedFailureCode: null,
        completedAt: now,
      },
    });
  }
  return [{ file: "events", record }];
}

export function buildOutputMembers({
  assignId,
  targetCommitGroupId,
  canonicalCommandInput,
  now,
  committed,
  cardContext,
  engine,
  calendar,
  fermentationPolicy,
  mappingPolicy,
}) {
  if (canonicalCommandInput.horizonCalendar &&
    canonicalHash(canonicalCommandInput.horizonCalendar) !== canonicalHash(calendar)) {
    fail("INPUT_HASH_MISMATCH", "output calendar differs from the frozen command input");
  }
  const { exposure, source } = committed;
  const correlationId = canonicalCommandInput.correlationId;
  const contextId = cardContext.id;
  const auditId = canonicalCommandInput.cardAuditId;
  const engineId = engine.id;
  const runId = assignId("decision-run-receipt-v1", "run");
  const attemptId = assignId("screening-attempt-v1", "attempt");
  const members = [];
  const failed = engine.status !== "SUCCEEDED";
  if (failed) {
    const attempt = envelope({
      schema: "screening-attempt-v1",
      id: attemptId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        scanExposureId: exposure.id,
        decisionContextId: contextId,
        timeGateAuditId: auditId,
        result: "ENGINE_FAILED",
        screeningDecisionId: null,
        failureCode: engine.sanitizedFailureCode || "ENGINE_FAILED",
        terminalAt: now,
      },
    });
    const receipt = envelope({
      schema: "decision-run-receipt-v1",
      id: runId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        decisionContextId: contextId,
        contextHash: cardContext.contextHash,
        engineResultId: engineId,
        systemDecisionAt: null,
        runStatus: "ENGINE_FAILED",
        outputRecordIds: [],
        decisionOutputRecordHashes: [],
        hashAlgorithm: "SHA-256",
        canonicalizationVersion: "canonical-json-v1",
        decisionOutputGroupHash: null,
        outputCommitGroupId: null,
        completedAt: now,
      },
    });
    pushEvent(members, attempt);
    pushEvent(members, receipt);
    return members;
  }

  const validatedOutput = engine.validatedOutput;
  if (engine.outputHash !== canonicalHash(validatedOutput)) {
    fail("INPUT_HASH_MISMATCH", "C refuses to rescore a drifted engine output");
  }
  const decisionId = assignId("screening-decision-v1", "decision");
  const decision = envelope({
    schema: "screening-decision-v1",
    id: decisionId,
    now,
    targetCommitGroupId,
    extra: {
      correlationId,
      scanExposureId: exposure.id,
      decisionContextId: contextId,
      decision: validatedOutput.decision,
      reasonCode: validatedOutput.reasonCode,
      scoreComponents: validatedOutput.scoreComponents,
    },
  });
  const attempt = envelope({
    schema: "screening-attempt-v1",
    id: attemptId,
    now,
    targetCommitGroupId,
    extra: {
      correlationId,
      scanExposureId: exposure.id,
      decisionContextId: contextId,
      timeGateAuditId: auditId,
      result: "DECIDED",
      screeningDecisionId: decisionId,
      failureCode: null,
      terminalAt: now,
    },
  });
  const business = [decision];

  if (validatedOutput.decision === "CREATE_CARD") {
    const systemSuggestion = systemSuggestionForOutput(validatedOutput);
    const variableTitle =
      validatedOutput.variableTitle ||
      `${source.sourceNamespace}:${source.sourceDocumentKey}`;
    const variableRevision = canonicalCommandInput.variableIdentity;
    const proposedTitleIdentityKey = normalizedVariableTitle(variableTitle);
    const catalystIdentityKey = normalizeCatalystTheme(
      validatedOutput.theme?.themeRef,
    );
    if (
      !variableRevision ||
      (variableRevision.proposedTitleIdentityKey ||
        variableRevision.identityKey) !== proposedTitleIdentityKey ||
      (!variableRevision.variableId &&
        variableRevision.identityKey !== proposedTitleIdentityKey) ||
      variableRevision.catalystIdentityKey !== catalystIdentityKey ||
      !Number.isInteger(variableRevision.revision) ||
      variableRevision.revision < 1
    ) {
      fail("INPUT_REF_MISMATCH", "frozen variable identity is invalid");
    }
    const eventId = assignId("event-instance-v1", "event");
    const opportunityId = assignId("opportunity-v1", "opportunity");
    const variableId =
      variableRevision.variableId || assignId("variable-v1", "variable");
    const cardId = assignId("variable-card-revision-v1", "card");
    const evidenceItems = Array.isArray(validatedOutput.evidence) && validatedOutput.evidence.length
      ? validatedOutput.evidence
      : [{ role: "FOCAL", quote: null }];
    const evidenceIds = evidenceItems.map((_, index) =>
      assignId("card-evidence-v1", `evidence:${index}`),
    );
    const themeId = assignId("theme-hypothesis-v1", "theme:0");
    const horizons = resolveAShareHorizons({
      evaluationAnchorAt: now,
      calendar,
    });
    const searchWindow = resolveReactionSearchWindow({
      opportunityEligibleAt: exposure.eligibleAt,
      t5CloseAt: horizons.horizons.T5.scheduledAt,
      calendar,
    });
    const eventRecord = envelope({
      schema: "event-instance-v1",
      id: eventId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        dedupKey: `src:${source.contentHash}`,
        sourceItemIds: [source.id],
        factIds: [],
        judgmentIds: [],
        eventTimeRef: null,
        availableAt: source.availableAt,
      },
    });
    const opportunity = envelope({
      schema: "opportunity-v1",
      id: opportunityId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        canonicalFingerprint: canonicalHash({
          sourceNamespace: source.sourceNamespace,
          sourceDocumentKey: source.sourceDocumentKey,
          contentHash: source.contentHash,
        }),
        triggerScanExposureId: exposure.id,
        opportunityEligibleAt: exposure.eligibleAt,
        createdFrom: "AI_DISCOVERY",
      },
    });
    const variable = variableRevision.variableId
      ? null
      : envelope({
          schema: "variable-v1",
          id: variableId,
          now,
          targetCommitGroupId,
          extra: {
            correlationId,
            opportunityId,
            canonicalTitle: variableTitle,
            identityKey: variableRevision.identityKey,
            sourceLineageKey: variableRevision.sourceLineageKey || null,
            catalystIdentityKey,
            firstDetectedAt: now,
          },
        });
    const evidenceRecords = evidenceItems.map((item, index) => {
      const retrieved =
        typeof item.sourceRef === "string" && item.sourceRef !== "SEED";
      const evidenceContentHash =
        retrieved && /^[0-9a-f]{64}$/.test(item.sourceContentHash || "")
          ? item.sourceContentHash
          : source.contentHash;
      return envelope({
        schema: "card-evidence-v1",
        id: evidenceIds[index],
        now,
        targetCommitGroupId,
        extra: {
          correlationId,
          cardRevisionId: cardId,
          target: retrieved
            ? {
                type: "RETRIEVAL_REF",
                id: item.sourceRef,
                availabilityReceiptId: null,
              }
            : {
                type: "SOURCE_ITEM",
                id: source.id,
                availabilityReceiptId: null,
              },
          role: item.role || "SUPPORT",
    evidenceLevel: ["published-excerpt", "ima-wiki-excerpt"].includes(source.sourceKind) ? "UNKNOWN" : "PRIMARY",
          contentHash: evidenceContentHash,
          availableAt: source.availableAt,
          quote: item.quote || null,
          retrievalRef: item.sourceRef || null,
          retrievalSourceType: item.sourceType || null,
          sourcePath: item.sourcePath || null,
        },
      });
    });
    const evidenceSetHash = canonicalHash(
      evidenceRecords.map((record) => ({
        id: record.id,
        contentHash: record.contentHash,
      })),
    );
    const theme = envelope({
      schema: "theme-hypothesis-v1",
      id: themeId,
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        cardRevisionId: cardId,
        decisionContextId: contextId,
        knowledgeCutoffAt: now,
        humanDecisionSnapshotId: null,
        themeRef: validatedOutput.theme.themeRef,
        narrative: validatedOutput.theme.narrative,
        constituentSnapshot: validatedOutput.theme.constituentSnapshot,
        benchmarkSnapshot: fermentationPolicy.benchmarkSnapshot,
        confidence:
          validatedOutput.theme.fermentationEligibility === "ELIGIBLE"
            ? 0.7
            : 0.45,
        evidenceIds,
        origin: "AI_AT_DECISION",
        fermentationEligibility: validatedOutput.theme.fermentationEligibility,
        fermentationEligibilityReason:
          validatedOutput.theme.fermentationEligibilityReason,
      },
    });
    const mappings = validatedOutput.mappings.map((row) => {
      const mappingId = assignId(
        "security-mapping-v1",
        `mapping:${row.securityCode}`,
      );
      return envelope({
        schema: "security-mapping-v1",
        id: mappingId,
        now,
        targetCommitGroupId,
        extra: {
          correlationId,
          themeHypothesisId: themeId,
          cardRevisionId: cardId,
          knowledgeCutoffAt: now,
          humanDecisionSnapshotId: null,
          securityCode: row.securityCode,
          securityName: row.securityName || null,
          thesis: row.thesis,
          evidenceIds,
          comparisonUniverseSnapshot:
            validatedOutput.theme.constituentSnapshot.filter(
              (code) => code !== row.securityCode,
            ),
          benchmarkSnapshot: mappingPolicy.benchmarkSnapshot,
          confidence: 0.5,
          validFrom: now,
          validUntil: null,
          origin: "AI_AT_DECISION",
        },
      });
    });
    const mappingIds = mappings.map((row) => row.id);
    const frozenSnapshotHash = canonicalHash({
      cardRevisionId: cardId,
      themeHypothesisIds: [themeId],
      securityMappingIds: mappingIds,
      fermentationRuleVersion: FERMENTATION_RULE_VERSION,
      mappingRuleVersion: MAPPING_RULE_VERSION,
      reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
      calendarRuleVersion: CALENDAR_RULE_VERSION,
    });
    const reaction = envelope({
      schema: "reaction-search-job-v1",
      id: reactionSearchJobIdOf({ cardRevisionId: cardId }),
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        jobKind: "BASE_CARD",
        opportunityId,
        cardRevisionId: cardId,
        sourceMappingReviewId: null,
        triggerScanExposureId: exposure.id,
        themeHypothesisIds: [themeId],
        reactionSearchStartAt: searchWindow.reactionSearchStartAt,
        reactionSearchEndAt: searchWindow.reactionSearchEndAt,
        reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
        frozenSnapshotHash,
      },
    });
    const feedbackJobs = ["T1", "T3", "T5"].map((horizon) => {
      const slot = horizons.horizons[horizon];
      return envelope({
        schema: "feedback-job-v1",
        id: feedbackJobIdOf({ cardRevisionId: cardId, horizon }),
        now,
        targetCommitGroupId,
        extra: {
          correlationId,
          jobKind: "BASE_CARD",
          metricUse: "BASE_OUTCOME",
          opportunityId,
          variableId,
          cardRevisionId: cardId,
          decisionContextId: contextId,
          triggerScanExposureId: exposure.id,
          systemDecisionAt: now,
          evaluationAnchorAt: now,
          anchorSource: {
            type: "CARD_SYSTEM_DECISION",
            decisionRunReceiptId: runId,
          },
          horizon,
          themeHypothesisIds: [themeId],
          securityMappingIds: mappingIds,
          replacementTargetId: null,
          frozenSnapshotHash,
          anchorSession: horizons.anchorSession,
          scheduledSession: slot.scheduledSession,
          calendarRuleVersion: CALENDAR_RULE_VERSION,
        },
      });
    });
    const card = envelope({
      schema: "variable-card-revision-v1",
      id: cardId,
      now,
      targetCommitGroupId,
      extra: {
        supersedesId: variableRevision.previousCardRevisionId,
        correlationId,
        opportunityId,
        variableId,
        decisionContextId: contextId,
        decisionRunReceiptId: runId,
        triggerScanExposureId: exposure.id,
        opportunityEligibleAt: exposure.eligibleAt,
        revision: variableRevision.revision,
        previousCardRevisionId: variableRevision.previousCardRevisionId,
        origin: "AI_DISCOVERED",
        variableTitle,
        variableIdentityKey: variableRevision.identityKey,
        observedTitleIdentityKey: proposedTitleIdentityKey,
        sourceLineageKey: variableRevision.sourceLineageKey || null,
        catalystIdentityKey,
        variableEventLinkIds: [],
        eventSummary: validatedOutput.eventSummary,
        variableThesis: validatedOutput.variableThesis,
        whyTradable: validatedOutput.whyTradable,
        expectationGap: validatedOutput.variableThesis,
        expectedHorizon: validatedOutput.expectedHorizon,
        scoreComponents: validatedOutput.scoreComponents,
        relationToPrior: validatedOutput.relationToPrior || null,
        counterEvidence: validatedOutput.counterEvidence || [],
        uncertainties: validatedOutput.uncertainties,
        invalidationConditions:
          validatedOutput.invalidationConditions || ["demo fixture withdrawn"],
        cardEvidenceIds: evidenceIds,
        systemSuggestion: {
          authority: "SYSTEM_SUGGESTION",
          label: systemSuggestion.label,
          rationale: systemSuggestion.rationale,
          basis: systemSuggestion.basis,
          evidenceIds,
          suggestedAt: now,
          modelVersion:
            canonicalCommandInput.engineType === "MODEL"
              ? canonicalCommandInput.modelVersion
              : "RULE",
          promptVersion:
            canonicalCommandInput.engineType === "MODEL"
              ? canonicalCommandInput.promptVersion
              : RULE_VERSION,
        },
        evidenceSetHash,
        firstDetectedAt: now,
        systemDecisionAt: now,
        modelVersion:
          canonicalCommandInput.engineType === "MODEL"
            ? canonicalCommandInput.modelVersion
            : "RULE",
        promptVersion:
          canonicalCommandInput.engineType === "MODEL"
            ? canonicalCommandInput.promptVersion
            : RULE_VERSION,
        policyVersion: POLICY_VERSION,
      },
    });
    business.push(
      eventRecord,
      opportunity,
      ...(variable ? [variable] : []),
      ...evidenceRecords,
      theme,
      ...mappings,
      reaction,
      ...feedbackJobs,
      card,
    );
  }

  const outputs = outputReceiptFields(business);
  const receipt = envelope({
    schema: "decision-run-receipt-v1",
    id: runId,
    now,
    targetCommitGroupId,
    extra: {
      correlationId,
      decisionContextId: contextId,
      contextHash: cardContext.contextHash,
      engineResultId: engineId,
      systemDecisionAt: now,
      runStatus: "SUCCEEDED",
      outputRecordIds: outputs.outputRecordIds,
      decisionOutputRecordHashes: outputs.decisionOutputRecordHashes,
      hashAlgorithm: "SHA-256",
      canonicalizationVersion: "canonical-json-v1",
      decisionOutputGroupHash: outputs.decisionOutputGroupHash,
      outputCommitGroupId: targetCommitGroupId,
      completedAt: now,
    },
  });
  for (const record of business) {
    pushEvent(members, record);
  }
  pushEvent(members, attempt);
  pushEvent(members, receipt);
  return members;
}

function scanInputRefs(committed) {
  return [
    {
      type: "SCAN_EXPOSURE",
      id: committed.exposure.id,
      hash: canonicalHash(committed.exposure),
    },
    {
      type: "SOURCE_ITEM",
      id: committed.source.id,
      hash: canonicalHash(committed.source),
    },
    {
      type: "DECISION_CONTEXT",
      id: committed.context.id,
      hash: canonicalHash(committed.context),
    },
    {
      type: "TIME_GATE_AUDIT",
      id: committed.audit.id,
      hash: canonicalHash(committed.audit),
    },
  ];
}

function crashAfterMembers(crashAfterPhase, phase) {
  if (crashAfterPhase === `${phase}-members`) {
    return "members";
  }
  return undefined;
}

function summarize(executed, events) {
  const group = events.filter(
    (row) => row.commitGroupId === executed.commitGroupId,
  );
  const decision = group.find((row) => row.schema === "screening-decision-v1");
  const receipt = group.find((row) => row.schema === "decision-run-receipt-v1");
  const card = group.find((row) => row.schema === "variable-card-revision-v1");
  return {
    commitGroupId: executed.commitGroupId,
    reused: executed.reused,
    memberRecordIds: executed.memberRecordIds,
    decision: decision ? decision.decision : null,
    runStatus: receipt ? receipt.runStatus : null,
    cardRevisionId: card ? card.id : null,
  };
}

export async function materializeFromExposure({
  store,
  now = () => new Date().toISOString(),
  scanExposureId,
  engineType = "RULE",
  validatedModelOutput,
  modelVersion = "external-model",
  promptVersion = "external-prompt",
  idempotencyKey,
  expectedSourceItemId,
  expectedSourceItemHash,
  expectedDecisionContextId,
  expectedDecisionContextHash,
  expectedTimeGateAuditId,
  expectedTimeGateAuditHash,
  expectedScanExposureHash,
  crashAfterPhase,
  horizonCalendarId,
}) {
  if (engineType !== "RULE" && engineType !== "MODEL") {
    fail("INVALID_ENGINE", "engineType must be RULE or MODEL");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    fail("INVALID_COMMAND", "idempotencyKey required");
  }
  const normalizedModelOutput =
    engineType === "MODEL" && validatedModelOutput
      ? validateRuleOutput(validatedModelOutput)
      : null;
  const modelOutputHash = normalizedModelOutput
    ? canonicalHash(normalizedModelOutput)
    : null;
  const runtime = new CommandRuntime({ store, now, cooperativeWrites: true });
  let projected = await projectCommitted(runtime);
  const committed = resolveCommittedInputs({
    events: projected.events,
    sources: projected.sourceItems,
    scanExposureId,
    expectedSourceItemId,
    expectedSourceItemHash,
    expectedDecisionContextId,
    expectedDecisionContextHash,
    expectedTimeGateAuditId,
    expectedTimeGateAuditHash,
    expectedScanExposureHash,
  });
  // Keep only the referenced input records across phases, not every historical
  // record in this async frame while the next full ledger is being verified.
  projected = null;
  const calendar = horizonCalendarId === undefined
    ? await loadHorizonCalendar(calendarPath)
    : getAnnouncedCalendar(horizonCalendarId);
  const fermentationPolicy = await loadPolicy(
    fermentationPath,
    FERMENTATION_RULE_VERSION,
  );
  const mappingPolicy = await loadPolicy(mappingPath, MAPPING_RULE_VERSION);
  await loadPolicy(reactionSearchPath, REACTION_SEARCH_RULE_VERSION);
  const correlationId = `card:${committed.exposure.id}:${engineType}`;
  const commonInput = {
    scanExposureId: committed.exposure.id,
    sourceItemId: committed.source.id,
    sourceItemHash: canonicalHash(committed.source),
    scanDecisionContextId: committed.context.id,
    scanDecisionContextHash: canonicalHash(committed.context),
    scanTimeGateAuditId: committed.audit.id,
    scanTimeGateAuditHash: canonicalHash(committed.audit),
    engineType,
    modelVersion: engineType === "MODEL" ? modelVersion : null,
    promptVersion: engineType === "MODEL" ? promptVersion : null,
    modelOutputHash: engineType === "MODEL" ? modelOutputHash : null,
    correlationId,
    ...versionsInput(),
    // Keep legacy command/context hashes byte-compatible when not selected.
    ...(horizonCalendarId === undefined ? {} : { horizonCalendar: calendar }),
  };

  await runtime.execute({
    commandType: PHASE_COMMAND.context,
    idempotencyKey: semanticIdempotencyKey({
      phase: "context",
      scanExposureId: committed.exposure.id,
      engineType,
      modelVersion,
      promptVersion,
      modelOutputHash,
    }),
    actorType: "SYSTEM",
    actorId: "system:demo-runner",
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      ...commonInput,
      phase: "context",
      correlationId,
    },
    immutableInputRefs: scanInputRefs(committed),
    builderVersion: BUILDER_VERSION_CONTEXT,
    engineResultId: null,
    expectedHeads: [],
    crashAfter: crashAfterMembers(crashAfterPhase, "context"),
    buildMembers: (args) =>
      buildContextMembers({
        ...args,
        committed,
      }),
  });

  let afterContext = await projectCommitted(runtime);
  const cardContext = findCardContext(
    afterContext.events,
    committed.exposure.id,
    engineType,
    { modelVersion, promptVersion, modelOutputHash },
  );
  const cardAudit = cardContext
    ? findCardAudit(afterContext.events, cardContext.id)
    : null;
  afterContext = null;
  if (!cardContext || !cardAudit) {
    fail("INPUT_REF_MISMATCH", "phase A context/audit not committed");
  }
  assertRecomputableContext(cardContext);
  if (cardAudit.overallResult !== "PASS") {
    fail("TIME_AUDIT_FAILED", "card time-gate audit did not pass");
  }
  const engineInvocationId = engineInvocationIdOf({
    decisionContextId: cardContext.id,
    engineType,
    modelVersion,
    promptVersion,
    modelOutputHash,
  });

  await runtime.execute({
    commandType: PHASE_COMMAND.engine,
    idempotencyKey: semanticIdempotencyKey({
      phase: "engine",
      scanExposureId: committed.exposure.id,
      engineType,
      modelVersion,
      promptVersion,
      modelOutputHash,
    }),
    actorType: "SYSTEM",
    actorId: "system:demo-runner",
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      ...commonInput,
      phase: "engine",
      correlationId,
      cardContextId: cardContext.id,
      cardContextHash: canonicalHash(cardContext),
      cardAuditId: cardAudit.id,
      cardAuditHash: canonicalHash(cardAudit),
      engineInvocationId,
      validatedModelOutput: normalizedModelOutput,
    },
    immutableInputRefs: [
      {
        type: "DECISION_CONTEXT",
        id: cardContext.id,
        hash: canonicalHash(cardContext),
      },
      {
        type: "TIME_GATE_AUDIT",
        id: cardAudit.id,
        hash: canonicalHash(cardAudit),
      },
    ],
    builderVersion: BUILDER_VERSION_ENGINE,
    engineResultId: null,
    expectedHeads: [],
    crashAfter: crashAfterMembers(crashAfterPhase, "engine"),
    buildMembers: (args) =>
      buildEngineMembers({
        ...args,
        committed,
        fermentationPolicy,
      }),
  });

  let afterEngine = await projectCommitted(runtime);
  const engine = findEngineResult(afterEngine.events, cardContext.id);
  if (!engine) {
    fail("INPUT_REF_MISMATCH", "phase B engine result not committed");
  }
  assertRecomputableEngine(engine);
  if (engine.decisionContextId !== cardContext.id) {
    fail("INPUT_REF_MISMATCH", "engine result does not reference phase A context");
  }
  const legacyOutputIdempotencyKey = semanticIdempotencyKey({
    phase: "output",
    scanExposureId: committed.exposure.id,
    engineType,
    modelVersion,
    promptVersion,
    modelOutputHash,
  });
  const legacyOutputIntent = afterEngine.events.find(
    (row) =>
      row.schema === "command-intent-v1" &&
      row.commandType === PHASE_COMMAND.output &&
      row.idempotencyKey === legacyOutputIdempotencyKey,
  );
  if (
    legacyOutputIntent &&
    !legacyOutputIntent.canonicalCommandInput?.variableIdentity &&
    afterEngine.events.some(
      (row) =>
        row.schema === "decision-run-receipt-v1" &&
        row.commitGroupId === legacyOutputIntent.targetCommitGroupId,
    )
  ) {
    return summarize(
      {
        commitGroupId: legacyOutputIntent.targetCommitGroupId,
        reused: true,
        memberRecordIds: legacyOutputIntent.memberRecordIds,
      },
      afterEngine.events,
    );
  }
  const outputIdempotencyKey =
    legacyOutputIntent &&
    !legacyOutputIntent.canonicalCommandInput?.variableIdentity
      ? `${legacyOutputIdempotencyKey}:${BUILDER_VERSION_OUTPUT}`
      : legacyOutputIdempotencyKey;
  afterEngine = null;
  const executed = await runtime.executeResolved(
    ({ committedProjection, existingIntent }) => {
      let variableIdentity =
        existingIntent(outputIdempotencyKey)?.canonicalCommandInput
          ?.variableIdentity || null;
      if (
        !variableIdentity &&
        engine.status === "SUCCEEDED" &&
        engine.validatedOutput?.decision === "CREATE_CARD"
      ) {
        const variableTitle =
          engine.validatedOutput.variableTitle ||
          `${committed.source.sourceNamespace}:${committed.source.sourceDocumentKey}`;
        const resolved = resolveVariableRevision(
          committedProjection.events,
          variableTitle,
          committed.exposure.id,
          committed.source,
          normalizeCatalystTheme(engine.validatedOutput.theme?.themeRef),
          {
            reasonCode: engine.validatedOutput.reasonCode,
            relationToPrior: engine.validatedOutput.relationToPrior,
          },
        );
        variableIdentity = {
          identityKey: resolved.identityKey,
          proposedTitleIdentityKey: resolved.proposedTitleIdentityKey,
          sourceLineageKey: resolved.sourceLineageKey,
          catalystIdentityKey: resolved.catalystIdentityKey,
          variableId: resolved.variable?.id || null,
          previousCardRevisionId: resolved.previousCard?.id || null,
          revision: resolved.revision,
        };
      }
      return {
        commandType: PHASE_COMMAND.output,
        idempotencyKey: outputIdempotencyKey,
        actorType: "SYSTEM",
        actorId: "system:demo-runner",
        correlationId,
        policyVersion: POLICY_VERSION,
        canonicalCommandInput: {
          ...commonInput,
          phase: "output",
          correlationId,
          cardContextId: cardContext.id,
          cardContextHash: canonicalHash(cardContext),
          cardAuditId: cardAudit.id,
          cardAuditHash: canonicalHash(cardAudit),
          engineResultId: engine.id,
          engineResultHash: canonicalHash(engine),
          outputHash: engine.outputHash,
          variableIdentity,
        },
        immutableInputRefs: [
          {
            type: "DECISION_CONTEXT",
            id: cardContext.id,
            hash: canonicalHash(cardContext),
          },
          {
            type: "TIME_GATE_AUDIT",
            id: cardAudit.id,
            hash: canonicalHash(cardAudit),
          },
          {
            type: "DECISION_ENGINE_RESULT",
            id: engine.id,
            hash: canonicalHash(engine),
          },
          {
            type: "SCAN_EXPOSURE",
            id: committed.exposure.id,
            hash: canonicalHash(committed.exposure),
          },
          {
            type: "SOURCE_ITEM",
            id: committed.source.id,
            hash: canonicalHash(committed.source),
          },
        ],
        builderVersion: BUILDER_VERSION_OUTPUT,
        engineResultId: engine.id,
        expectedHeads: [],
        crashAfter: crashAfterMembers(crashAfterPhase, "output"),
        buildMembers: (args) =>
          buildOutputMembers({
            ...args,
            committed,
            cardContext,
            engine,
            calendar,
            fermentationPolicy,
            mappingPolicy,
          }),
      };
    },
  );
  const afterOutput = await projectCommitted(runtime);
  return summarize(executed, afterOutput.events);
}
