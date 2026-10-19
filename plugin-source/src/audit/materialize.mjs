// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { buildCanonicalDecisionInput } from "../decision/canonical-input.mjs";
import { auditTimeGates } from "../decision/time-gate.mjs";
import {
  loadHorizonCalendar,
  resolveAShareHorizons,
  resolveReactionSearchWindow,
} from "../card/horizon.mjs";
import { engineResultIdOf } from "../card/materialize.mjs";
import { fail } from "./errors.mjs";
import { uniqueWorkflowHead } from "./inclusion.mjs";
import { clockOf, envelope } from "./policy.mjs";
import { deriveRootCause, locateMissPath } from "../miss/locate.mjs";

const ACTOR_ID = "system:demo-runner";
const ACTOR_TYPE = "SYSTEM";
const POLICY_VERSION = "audit-miss-materialization-v1";
const CALENDAR_RULE_VERSION = "a-share-horizon-v1";
const REACTION_SEARCH_RULE_VERSION = "reaction-search-v1";
const AGGREGATION_RULE_VERSION = "judgment-timing-v1";
const DRAFT_VERSION = "audit-miss-draft-v1";

export const AUDIT_MISS_PHASE = Object.freeze({
  context: "materializeAuditMissContext",
  engine: "materializeAuditMissEngine",
  output: "materializeAuditMissOutputs",
});

const calendarPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/calendar/a-share-2026-q3.json",
);

function feedbackJobId({ cardRevisionId, horizon }) {
  return brandedId("fbj_", {
    jobKind: "BASE_CARD",
    cardRevisionId,
    horizon,
    calendarRuleVersion: CALENDAR_RULE_VERSION,
  });
}

function reactionJobId({ cardRevisionId }) {
  return brandedId("rsj_", {
    kind: "REACTION_SEARCH",
    cardRevisionId,
    reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
  });
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

function genericDraft(ref) {
  const summary = `audit sample miss draft: ${String(ref).slice(0, 80)}`;
  return {
    decision: "CREATE_CARD",
    reasonCode: "NEW_ACTIONABLE_VARIABLE",
    eventSummary: summary,
    variableThesis: "audit-sample miss is not an AI discovery",
    whyTradable: "a blind TRADABLE replay can still form a research variable",
    expectedHorizon: "T5",
    uncertainties: ["audit sample miss", "no AI discovery credit"],
    scoreComponents: {
      evidenceStrength: 0.4,
      novelty: 0.5,
      timeSensitivity: 0.4,
      tradabilityConfidence: 0.3,
      mappingConfidence: 0.3,
    },
    theme: {
      themeRef: "theme:audit-sample-miss",
      narrative: summary,
      constituentSnapshot: ["DEMO.600000"],
      fermentationEligibility: "NOT_EVALUABLE",
      fermentationEligibilityReason: "CONSTITUENT_COUNT_BELOW_3",
    },
    mappings: [{ securityCode: "DEMO.600000", thesis: "audit sample miss mapping" }],
  };
}

const PAYLOAD_OVERRIDE_KEYS = new Set([
  "failMaterialize",
  "firstHumanClueAt",
  "evaluationAnchorAt",
  "adjudicatedAt",
  "recordedAt",
  "systemDecisionAt",
  "now",
  "draft",
  "validatedOutput",
  "engineResultId",
]);

function testHooksOf(command) {
  return command && command.testHooks && typeof command.testHooks === "object"
    ? command.testHooks
    : {};
}

function missIds(adjudicationId, opportunityId) {
  const contextId = brandedId("ctx_", {
    purpose: "AUDIT_SAMPLE_MISS",
    adjudicationId,
  });
  const engineInvocationId = canonicalHash({
    decisionContextId: contextId,
    engineType: "RULE",
    purpose: "AUDIT_SAMPLE_MISS",
    draftVersion: DRAFT_VERSION,
  });
  return {
    contextId,
    auditId: brandedId("tga_", { purpose: "AUDIT_SAMPLE_MISS", adjudicationId }),
    engineInvocationId,
    engineId: engineResultIdOf({
      decisionContextId: contextId,
      engineInvocationId,
    }),
    variableId: brandedId("var_", { opportunityId, origin: "AUDIT_SAMPLE_MISS" }),
    cardId: brandedId("vcr_", { origin: "AUDIT_SAMPLE_MISS", adjudicationId }),
    clueId: brandedId("hclue_", { adjudicationId, discoveryMode: "AUDIT_SAMPLE" }),
  };
}

function uniqueRecord(events, predicate, code, message) {
  const matches = (events || []).filter(predicate);
  if (matches.length === 0) {
    fail(code, message);
  }
  if (matches.length > 1) {
    fail("INPUT_REF_MISMATCH", `${message}: ambiguous`);
  }
  return matches[0];
}

function resolveGraph(events, sources, adjudicationId) {
  const liveAdj = (events || []).find(
    (row) =>
      row.schema === "opportunity-adjudication-v1" && row.id === adjudicationId,
  );
  if (!liveAdj || liveAdj.mode !== "BLIND_REPLAY") {
    fail("INPUT_REF_MISMATCH", "BLIND_REPLAY adjudication missing");
  }
  if (liveAdj.label !== "TRADABLE") {
    fail("INVALID_COMMAND", "materialize requires TRADABLE blind replay");
  }
  const liveItem = (events || []).find(
    (row) =>
      row.schema === "audit-sample-item-v1" &&
      row.id === liveAdj.sourceAuditSampleItemId,
  );
  if (!liveItem || liveItem.reviewTarget.type !== "SCREENING_ATTEMPT") {
    fail("INPUT_REF_MISMATCH", "SCREENING_ATTEMPT audit item missing");
  }
  const frozen = liveItem.frozenReviewPayload || {};
  const exposure = frozen.exposure;
  const source = exposure
    ? (sources || []).find((row) => row.id === exposure.sourceItemId)
    : null;
  if (!source || !exposure) {
    fail("NO_VERIFIABLE_TRIGGER", "audit miss requires frozen screening exposure");
  }
  const snapshot = (events || []).find(
    (row) => row.id === liveAdj.humanDecisionSnapshotId,
  );
  if (
    !snapshot ||
    snapshot.purpose !== "OPPORTUNITY_BLIND_REPLAY" ||
    snapshot.targetRef?.id !== liveItem.id ||
    snapshot.auditTaskId !== liveItem.reviewTaskId ||
    snapshot.opportunityId !== liveItem.opportunityId ||
    snapshot.actorId !== liveAdj.actorId ||
    snapshot.commitGroupId !== liveAdj.commitGroupId ||
    snapshot.correlationId !== liveAdj.correlationId
  ) {
    fail("INPUT_REF_MISMATCH", "blind snapshot is not committed with the adjudication");
  }
  const task = (events || []).find(
    (row) =>
      row.schema === "review-task-v1" && row.id === liveItem.reviewTaskId,
  );
  if (!task || !task.objectRef || task.objectRef.id !== liveItem.id) {
    fail("INPUT_REF_MISMATCH", "blind review task is not committed");
  }
  const chain = uniqueWorkflowHead(events, task.id);
  if (chain.reason || !chain.head || chain.head.toState !== "COMPLETED") {
    fail("HEAD_CONFLICT", chain.reason || "blind task is not COMPLETED");
  }
  if (
    chain.head.commitGroupId !== liveAdj.commitGroupId ||
    chain.head.correlationId !== liveAdj.correlationId
  ) {
    fail("INPUT_REF_MISMATCH", "COMPLETED state is not in the blind commit group");
  }
  const ref = `${source.sourceNamespace}:${source.sourceDocumentKey}`;
  return {
    liveAdj,
    liveItem,
    snapshot,
    task,
    completed: chain.head,
    frozen,
    exposure,
    source,
    ref,
  };
}

async function executePhase({
  store,
  now,
  phase,
  adjudicationId,
  correlationId,
  calendar,
  failPhase,
  extraInput = {},
}) {
  if (failPhase === phase) {
    fail("MATERIALIZE_FAILED", `intentional ${phase} phase failure`);
  }
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const graph = resolveGraph(
    projected.events,
    projected.sourceItems,
    adjudicationId,
  );
  const ids = missIds(adjudicationId, graph.liveItem.opportunityId);
  const refs = [
    {
      type: "OPPORTUNITY_ADJUDICATION",
      id: graph.liveAdj.id,
      hash: canonicalHash(graph.liveAdj),
    },
    {
      type: "AUDIT_SAMPLE_ITEM",
      id: graph.liveItem.id,
      hash: canonicalHash(graph.liveItem),
    },
    {
      type: "HUMAN_DECISION_SNAPSHOT",
      id: graph.snapshot.id,
      hash: canonicalHash(graph.snapshot),
    },
    {
      type: "REVIEW_TASK",
      id: graph.task.id,
      hash: canonicalHash(graph.task),
    },
    {
      type: "WORKFLOW_STATE_EVENT",
      id: graph.completed.id,
      hash: canonicalHash(graph.completed),
    },
  ];
  if (phase !== "context") {
    const context = uniqueRecord(
      projected.events,
      (row) => row.schema === "decision-context-v1" && row.id === ids.contextId,
      "UNCOMMITTED_CONTEXT",
      "audit miss context is not committed",
    );
    assertMissContext(context);
    if (context.correlationId !== correlationId) {
      fail("INPUT_REF_MISMATCH", "audit miss context correlation mismatch");
    }
    const gate = uniqueRecord(
      projected.events,
      (row) =>
        row.schema === "time-gate-audit-v1" &&
        row.decisionContextId === context.id,
      "TIME_AUDIT_FAILED",
      "audit miss time-gate is not committed",
    );
    if (gate.overallResult !== "PASS") {
      fail("TIME_AUDIT_FAILED", "audit miss time-gate did not pass");
    }
    refs.push(
      {
        type: "DECISION_CONTEXT",
        id: context.id,
        hash: canonicalHash(context),
      },
      {
        type: "TIME_GATE_AUDIT",
        id: gate.id,
        hash: canonicalHash(gate),
      },
    );
  }
  if (phase === "output") {
    const engine = uniqueRecord(
      projected.events,
      (row) =>
        row.schema === "decision-engine-result-v1" && row.id === ids.engineId,
      "UNCOMMITTED_ENGINE",
      "audit miss engine is not committed",
    );
    if (
      engine.decisionContextId !== ids.contextId ||
      engine.engineInvocationId !== ids.engineInvocationId ||
      engine.correlationId !== correlationId ||
      engine.status !== "SUCCEEDED" ||
      engine.outputHash !== canonicalHash(engine.validatedOutput)
    ) {
      fail("INPUT_REF_MISMATCH", "forged or mismatched audit miss engine");
    }
    refs.push({
      type: "DECISION_ENGINE_RESULT",
      id: engine.id,
      hash: canonicalHash(engine),
    });
  }
  const commandType = AUDIT_MISS_PHASE[phase];
  return runtime.execute({
    commandType,
    idempotencyKey: `audit-miss-${phase}-v1:${adjudicationId}`,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      phase,
      adjudicationId,
      ...extraInput,
    },
    immutableInputRefs: refs,
    builderVersion: `audit-miss-${phase}-v1`,
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({
      assignId,
      targetCommitGroupId,
      now: stamped,
      committedProjection,
    }) => {
      const events = committedProjection.events || [];
      const sources = committedProjection.sourceItems || [];
      const graph = resolveGraph(events, sources, adjudicationId);
      const ids = missIds(adjudicationId, graph.liveItem.opportunityId);
      const clueAt = graph.liveAdj.adjudicatedAt;
      if (phase === "context") {
        return buildContextPhase({
          ids,
          graph,
          clueAt,
          stamped,
          targetCommitGroupId,
          correlationId,
        });
      }
      if (phase === "engine") {
        return buildEnginePhase({
          events,
          ids,
          graph,
          stamped,
          targetCommitGroupId,
          correlationId,
        });
      }
      return buildOutputPhase({
        assignId,
        events,
        ids,
        graph,
        clueAt,
        stamped,
        targetCommitGroupId,
        correlationId,
        calendar,
      });
    },
  });
}

function buildContextPhase({
  ids,
  graph,
  clueAt,
  stamped,
  targetCommitGroupId,
  correlationId,
}) {
  const contextItem = {
    id: `ctxi_${ids.clueId}`,
    stream: "FOCAL",
    refType: "SOURCE_ITEM",
    refId: graph.source.id,
    availabilityReceiptId: null,
    resolutionReceiptId: null,
    availableAt: graph.source.availableAt || clueAt,
    resolvedAt: null,
    contentHash: graph.source.contentHash,
    memberRefs: [],
    payload: {
      structuredInput: {
        kind: "SOURCE_ITEM",
        ref: graph.ref,
        origin: "AUDIT_SAMPLE_MISS",
        adjudicationId: graph.liveAdj.id,
      },
    },
  };
  const canonical = buildCanonicalDecisionInput({
    decisionType: "CARD_SYNTHESIS",
    subjectRef: { type: "VARIABLE", id: ids.variableId },
    focalEventInstanceId: null,
    contextCutoffAt: clueAt,
    contextItems: [contextItem],
    engine: {
      engineType: "RULE",
      ruleVersion: DRAFT_VERSION,
      canonicalDecisionInput: {
        ruleInput: { action: "AUDIT_SAMPLE_MISS", adjudicationId: graph.liveAdj.id },
      },
    },
    policyVersion: POLICY_VERSION,
  });
  const audit = auditTimeGates({
    contextCutoffAt: clueAt,
    contextItems: canonical.contextItems,
    decisionTiming: {
      systemDecisionAt: clueAt,
      engineCompletedAt: clueAt,
      enqueuedAt: null,
    },
  });
  return [
    envelope({
      schema: "decision-context-v1",
      id: ids.contextId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
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
    envelope({
      schema: "time-gate-audit-v1",
      id: ids.auditId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        decisionContextId: ids.contextId,
        itemResults: audit.itemResults,
        gates: audit.gates,
        overallResult: audit.overallResult,
        failureCodes: audit.failureCodes,
        auditedAt: stamped,
      },
    }),
  ].map((record) => ({ file: "events", record }));
}

function assertMissContext(context) {
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
    fail("INPUT_HASH_MISMATCH", "audit miss contextHash is not recomputable");
  }
}

function buildEnginePhase({
  events,
  ids,
  graph,
  stamped,
  targetCommitGroupId,
  correlationId,
}) {
  const context = uniqueRecord(
    events,
    (row) => row.schema === "decision-context-v1" && row.id === ids.contextId,
    "UNCOMMITTED_CONTEXT",
    "audit miss context is not committed",
  );
  if (context.correlationId !== correlationId) {
    fail("INPUT_REF_MISMATCH", "audit miss context correlation mismatch");
  }
  assertMissContext(context);
  const gate = uniqueRecord(
    events,
    (row) =>
      row.schema === "time-gate-audit-v1" &&
      row.decisionContextId === context.id,
    "TIME_AUDIT_FAILED",
    "audit miss time-gate is not committed",
  );
  if (gate.overallResult !== "PASS") {
    fail("TIME_AUDIT_FAILED", "audit miss time-gate did not pass");
  }
  const draft = genericDraft(graph.ref);
  if (draft.decision !== "CREATE_CARD") {
    fail("ENGINE_FAILED", "audit miss engine must emit CREATE_CARD");
  }
  return [
    envelope({
      schema: "decision-engine-result-v1",
      id: ids.engineId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        decisionContextId: ids.contextId,
        engineInvocationId: ids.engineInvocationId,
        status: "SUCCEEDED",
        validatedOutput: draft,
        outputHash: canonicalHash(draft),
        sanitizedFailureCode: null,
        completedAt: stamped,
      },
    }),
  ].map((record) => ({ file: "events", record }));
}

function buildOutputPhase({
  assignId,
  events,
  ids,
  graph,
  clueAt,
  stamped,
  targetCommitGroupId,
  correlationId,
  calendar,
}) {
  const context = uniqueRecord(
    events,
    (row) => row.schema === "decision-context-v1" && row.id === ids.contextId,
    "UNCOMMITTED_CONTEXT",
    "audit miss context is not committed",
  );
  const engine = uniqueRecord(
    events,
    (row) =>
      row.schema === "decision-engine-result-v1" && row.id === ids.engineId,
    "UNCOMMITTED_ENGINE",
    "audit miss engine is not committed",
  );
  if (context.commitGroupId === targetCommitGroupId) {
    fail("UNCOMMITTED_CONTEXT", "output cannot self-certify context");
  }
  if (engine.commitGroupId === targetCommitGroupId) {
    fail("UNCOMMITTED_ENGINE", "output cannot self-certify engine");
  }
  if (context.correlationId !== correlationId || engine.correlationId !== correlationId) {
    fail("INPUT_REF_MISMATCH", "audit miss phase correlation mismatch");
  }
  assertMissContext(context);
  const gate = uniqueRecord(
    events,
    (row) =>
      row.schema === "time-gate-audit-v1" &&
      row.decisionContextId === context.id,
    "TIME_AUDIT_FAILED",
    "audit miss time-gate is not committed",
  );
  if (gate.overallResult !== "PASS") {
    fail("TIME_AUDIT_FAILED", "audit miss time-gate did not pass");
  }
  if (engine.decisionContextId !== context.id) {
    fail("INPUT_REF_MISMATCH", "engine does not reference miss context");
  }
  if (engine.engineInvocationId !== ids.engineInvocationId) {
    fail("INPUT_REF_MISMATCH", "engine invocation does not match miss context");
  }
  if (engine.status !== "SUCCEEDED" || !engine.validatedOutput) {
    fail("ENGINE_FAILED", "audit miss engine did not succeed");
  }
  if (engine.validatedOutput.decision !== "CREATE_CARD") {
    fail("ENGINE_FAILED", "audit miss engine must emit CREATE_CARD");
  }
  if (engine.outputHash !== canonicalHash(engine.validatedOutput)) {
    fail("INPUT_HASH_MISMATCH", "audit miss engine outputHash mismatch");
  }
  const screeningEngine = events.find(
    (row) =>
      row.schema === "decision-engine-result-v1" &&
      row.decisionContextId === graph.frozen.context?.id,
  );
  if (screeningEngine && engine.id === screeningEngine.id) {
    fail("INPUT_REF_MISMATCH", "REJECT screening engine cannot certify miss card");
  }
  const draft = engine.validatedOutput;
  const pathInfo = locateMissPath(
    { events, sourceItems: [] },
    graph.source,
  );
  const rootCause = deriveRootCause({
    resolution: "MATCHED_SOURCE_ITEM",
    path: pathInfo,
    events,
  });
  const opportunityId = graph.liveItem.opportunityId;
  const missId = brandedId("miss_", { humanClueId: ids.clueId });
  const evidenceId = brandedId("ev_", { cardRevisionId: ids.cardId, role: "FOCAL" });
  const themeId = brandedId("thm_", { cardRevisionId: ids.cardId, kind: "draft" });
  const mappingId = brandedId("smap_", { cardRevisionId: ids.cardId, kind: "draft" });
  const timingId = brandedId("mta_", { missReportId: missId, timing: "REACTION_UNKNOWN" });
  const runId = assignId("decision-run-receipt-v1", "run");
  const records = [];
  const triggerId = graph.exposure.id;
  const eligibleAt = graph.exposure.eligibleAt || null;
  records.push(
    envelope({
      schema: "human-clue-v1",
      id: ids.clueId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        opportunityId,
        submittedClue: { kind: "SOURCE_ITEM", ref: graph.ref },
        firstHumanClueAt: clueAt,
        intakeResolution: "MATCHED_SOURCE_ITEM",
        discoveryMode: "AUDIT_SAMPLE",
      },
    }),
  );
  records.push(
    envelope({
      schema: "miss-report-v1",
      id: missId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        opportunityId,
        humanClueId: ids.clueId,
        originalExposureId: triggerId,
        originalScreeningAttemptId: graph.frozen.attempt
          ? graph.frozen.attempt.id
          : graph.liveItem.reviewTarget.screeningAttemptId,
        originalDecisionId: graph.frozen.decision ? graph.frozen.decision.id : null,
        rootCause,
        expectedDetectedAt: eligibleAt,
      },
    }),
  );
  records.push(
    envelope({
      schema: "variable-v1",
      id: ids.variableId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        opportunityId,
        canonicalTitle: `audit-sample-miss:${graph.ref}`.slice(0, 96),
        firstDetectedAt: clueAt,
      },
    }),
  );
  records.push(
    envelope({
      schema: "card-evidence-v1",
      id: evidenceId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        cardRevisionId: ids.cardId,
        target: {
          type: "SOURCE_ITEM",
          id: graph.source.id,
          availabilityReceiptId: null,
        },
        role: "FOCAL",
        evidenceLevel: "PRIMARY",
        contentHash: graph.source.contentHash,
        availableAt: graph.source.availableAt || clueAt,
      },
    }),
  );
  records.push(
    envelope({
      schema: "theme-hypothesis-v1",
      id: themeId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        cardRevisionId: ids.cardId,
        decisionContextId: context.id,
        knowledgeCutoffAt: clueAt,
        humanDecisionSnapshotId: null,
        themeRef: draft.theme.themeRef,
        narrative: draft.theme.narrative,
        constituentSnapshot: draft.theme.constituentSnapshot,
        origin: "AI_AT_DECISION",
        fermentationEligibility: draft.theme.fermentationEligibility,
        fermentationEligibilityReason: draft.theme.fermentationEligibilityReason,
      },
    }),
  );
  const mappingIds = [];
  for (const [index, row] of draft.mappings.entries()) {
    const id =
      index === 0 ? mappingId : brandedId("smap_", { cardRevisionId: ids.cardId, index });
    mappingIds.push(id);
    records.push(
      envelope({
        schema: "security-mapping-v1",
        id,
        now: stamped,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        targetCommitGroupId,
        extra: {
          themeHypothesisId: themeId,
          cardRevisionId: ids.cardId,
          knowledgeCutoffAt: clueAt,
          humanDecisionSnapshotId: null,
          securityCode: row.securityCode,
          thesis: row.thesis,
          origin: "AI_AT_DECISION",
          validFrom: clueAt,
          validUntil: null,
        },
      }),
    );
  }
  const horizons = resolveAShareHorizons({
    evaluationAnchorAt: clueAt,
    calendar,
  });
  const frozenSnapshotHash = canonicalHash({
    cardRevisionId: ids.cardId,
    themeHypothesisIds: [themeId],
    securityMappingIds: mappingIds,
  });
  for (const horizon of ["T1", "T3", "T5"]) {
    const slot = horizons.horizons[horizon];
    records.push(
      envelope({
        schema: "feedback-job-v1",
        id: feedbackJobId({ cardRevisionId: ids.cardId, horizon }),
        now: stamped,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        targetCommitGroupId,
        extra: {
          jobKind: "BASE_CARD",
          metricUse: "BASE_OUTCOME",
          opportunityId,
          variableId: ids.variableId,
          cardRevisionId: ids.cardId,
          decisionContextId: context.id,
          triggerScanExposureId: triggerId,
          systemDecisionAt: clueAt,
          evaluationAnchorAt: clueAt,
          anchorSource: { type: "HUMAN_CLUE", humanClueId: ids.clueId },
          horizon,
          themeHypothesisIds: [themeId],
          securityMappingIds: mappingIds,
          replacementTargetId: null,
          frozenSnapshotHash,
          anchorSession: horizons.anchorSession,
          scheduledSession: slot.scheduledSession,
          calendarRuleVersion: CALENDAR_RULE_VERSION,
        },
      }),
    );
  }
  if (triggerId && eligibleAt) {
    const window = resolveReactionSearchWindow({
      opportunityEligibleAt: eligibleAt,
      t5CloseAt: horizons.horizons.T5.scheduledAt,
      calendar,
    });
    records.push(
      envelope({
        schema: "reaction-search-job-v1",
        id: reactionJobId({ cardRevisionId: ids.cardId }),
        now: stamped,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        targetCommitGroupId,
        extra: {
          jobKind: "BASE_CARD",
          opportunityId,
          cardRevisionId: ids.cardId,
          sourceMappingReviewId: null,
          triggerScanExposureId: triggerId,
          themeHypothesisIds: [themeId],
          reactionSearchStartAt: window.reactionSearchStartAt,
          reactionSearchEndAt: window.reactionSearchEndAt,
          reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
          frozenSnapshotHash,
        },
      }),
    );
  }
  records.push(
    envelope({
      schema: "variable-card-revision-v1",
      id: ids.cardId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        opportunityId,
        variableId: ids.variableId,
        decisionContextId: context.id,
        decisionRunReceiptId: runId,
        triggerScanExposureId: triggerId,
        opportunityEligibleAt: eligibleAt,
        revision: 1,
        origin: "AUDIT_SAMPLE_MISS",
        eventSummary: draft.eventSummary,
        variableThesis: draft.variableThesis,
        whyTradable: draft.whyTradable,
        expectationGap: null,
        expectedHorizon: draft.expectedHorizon,
        scoreComponents: draft.scoreComponents,
        uncertainties: draft.uncertainties,
        firstDetectedAt: clueAt,
        systemDecisionAt: clueAt,
        modelVersion: "AUDIT_SAMPLE_MISS",
        promptVersion: DRAFT_VERSION,
      },
    }),
  );
  records.push(
    envelope({
      schema: "miss-timing-assessment-v1",
      id: timingId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        missReportId: missId,
        timing: "REACTION_UNKNOWN",
        reactionAtUsed: null,
        reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
        marketDataAsOf: clueAt,
        sourceReactionSearchAssessmentIds: [],
        sourceReactionAssessmentSetHash: canonicalHash([]),
        aggregationRuleVersion: AGGREGATION_RULE_VERSION,
        assessedAt: stamped,
        supersedesId: null,
      },
    }),
  );
  const outputSchemas = new Set([
    "human-clue-v1",
    "miss-report-v1",
    "variable-v1",
    "card-evidence-v1",
    "theme-hypothesis-v1",
    "security-mapping-v1",
    "feedback-job-v1",
    "reaction-search-job-v1",
    "variable-card-revision-v1",
    "miss-timing-assessment-v1",
  ]);
  const outputs = outputReceiptFields(
    records.filter((row) => outputSchemas.has(row.schema)),
  );
  records.push(
    envelope({
      schema: "decision-run-receipt-v1",
      id: runId,
      now: stamped,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      targetCommitGroupId,
      extra: {
        decisionContextId: context.id,
        contextHash: context.contextHash,
        engineResultId: engine.id,
        systemDecisionAt: clueAt,
        runStatus: "SUCCEEDED",
        ...outputs,
        hashAlgorithm: "SHA-256",
        canonicalizationVersion: "canonical-json-v1",
        outputCommitGroupId: targetCommitGroupId,
        completedAt: stamped,
      },
    }),
  );
  return records.map((record) => ({ file: "events", record }));
}

export async function materializeAuditMiss({ store, now, command = {} }) {
  const payload = command.payload || {};
  for (const key of Object.keys(payload)) {
    if (PAYLOAD_OVERRIDE_KEYS.has(key)) {
      fail("OVERRIDE_FORBIDDEN", `${key} cannot be overridden by caller`);
    }
  }
  const hooks = testHooksOf(command);
  if (hooks.failMaterialize) {
    fail("MATERIALIZE_FAILED", "intentional materialize failure");
  }
  const adjudicationId = payload.adjudicationId;
  if (typeof adjudicationId !== "string" || !adjudicationId) {
    fail("INVALID_COMMAND", "adjudicationId required");
  }
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  resolveGraph(projected.events, projected.sourceItems, adjudicationId);
  const calendar = await loadHorizonCalendar(calendarPath);
  const correlationId = `audit-miss:${adjudicationId}`;
  const failPhase = hooks.failPhase || null;
  await executePhase({
    store,
    now,
    phase: "context",
    adjudicationId,
    correlationId,
    calendar,
    failPhase,
  });
  await executePhase({
    store,
    now,
    phase: "engine",
    adjudicationId,
    correlationId,
    calendar,
    failPhase,
  });
  return executePhase({
    store,
    now,
    phase: "output",
    adjudicationId,
    correlationId,
    calendar,
    failPhase,
  });
}
