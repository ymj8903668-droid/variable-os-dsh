// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import {
  loadHorizonCalendar,
  resolveAShareHorizons,
  resolveReactionSearchWindow,
} from "../card/horizon.mjs";
import { evaluateScreeningRule } from "../card/rule-engine.mjs";
import {
  buildContextMembers,
  buildEngineMembers,
  engineResultIdOf,
} from "../card/materialize.mjs";
import { buildCanonicalDecisionInput } from "../decision/canonical-input.mjs";
import { auditTimeGates } from "../decision/time-gate.mjs";
import { fail } from "./errors.mjs";
import { uniqueChainHead } from "../feedback/heads.mjs";
import {
  deriveRootCause,
  findSourceItem,
  locateMissPath,
} from "./locate.mjs";

const ACTOR_ID = "human:primary-reviewer";
const ACTOR_TYPE = "HUMAN";
const POLICY_VERSION = "human-miss-v1";
const CALENDAR_RULE_VERSION = "a-share-horizon-v1";
const REACTION_SEARCH_RULE_VERSION = "reaction-search-v1";
const AGGREGATION_RULE_VERSION = "judgment-timing-v1";
const BUILDER_VERSION = "human-miss-v1";
const CARD_POLICY_VERSION = "card-synthesis-v1";
const RULE_VERSION = "card-screen-rule-v1";

const calendarPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/calendar/a-share-2026-q3.json",
);

function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

function envelope({ schema, id, now, actorType, actorId, correlationId, targetCommitGroupId, supersedesId, extra }) {
  return {
    schema,
    id,
    createdAt: now,
    recordedAt: now,
    actorType,
    actorId,
    correlationId,
    commitGroupId: targetCommitGroupId,
    supersedesId: supersedesId ?? null,
    policyVersion: POLICY_VERSION,
    ...extra,
  };
}

export function inAiDiscoveryNumerator(card) {
  return Boolean(
    card &&
      card.origin === "AI_DISCOVERED" &&
      typeof card.triggerScanExposureId === "string" &&
      card.triggerScanExposureId.length > 0,
  );
}

function payloadOf(command) {
  return command && command.payload && typeof command.payload === "object"
    ? command.payload
    : {};
}

function requireActor(command) {
  if (command.actorId !== ACTOR_ID || command.actorType !== ACTOR_TYPE) {
    fail("ACTOR_FORBIDDEN", "actor is not on the allowlist");
  }
}

function committedOf(committedProjection) {
  if (!committedProjection || !Array.isArray(committedProjection.events)) {
    fail("LEDGER_CORRUPT", "committed projection unavailable");
  }
  return {
    events: committedProjection.events,
    sourceItems: Array.isArray(committedProjection.sourceItems)
      ? committedProjection.sourceItems
      : [],
  };
}

function draftFromRule(source, clue) {
  try {
    const output = evaluateScreeningRule({
      sourceNamespace: source.sourceNamespace,
      sourceDocumentKey: source.sourceDocumentKey,
      contentHash: source.contentHash,
      fermentationPolicy: { minConstituents: 3 },
    });
    if (output.decision === "CREATE_CARD") {
      return output;
    }
  } catch {
    // fall through to generic draft
  }
  return genericDraft(clue.ref);
}

function genericDraft(ref) {
  const summary = `human miss draft: ${String(ref).slice(0, 80)}`;
  return {
    decision: "CREATE_CARD",
    reasonCode: "NEW_ACTIONABLE_VARIABLE",
    eventSummary: summary,
    variableThesis: "human-submitted miss is not an AI discovery",
    whyTradable: "a human-submitted clue can still form a research variable",
    expectedHorizon: "T5",
    uncertainties: ["human miss draft", "no AI discovery credit"],
    scoreComponents: {
      evidenceStrength: 0.4,
      novelty: 0.5,
      timeSensitivity: 0.4,
      tradabilityConfidence: 0.3,
      mappingConfidence: 0.3,
    },
    theme: {
      themeRef: "theme:human-miss",
      narrative: summary,
      constituentSnapshot: ["DEMO.600000"],
      fermentationEligibility: "NOT_EVALUABLE",
      fermentationEligibilityReason: "CONSTITUENT_COUNT_BELOW_3",
    },
    mappings: [
      {
        securityCode: "DEMO.600000",
        thesis: "human miss draft mapping",
      },
    ],
  };
}

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

function emptySetHash() {
  return canonicalHash([]);
}

function engineInvocationIdOf(decisionContextId) {
  return canonicalHash({
    decisionContextId,
    engineType: "RULE",
    ruleVersion: RULE_VERSION,
    modelVersion: null,
    promptVersion: null,
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

function buildUnmatchedContext({
  assignId,
  targetCommitGroupId,
  now,
  actorType,
  actorId,
  correlationId,
  clueId,
  variableId,
  kind,
  ref,
}) {
  const contextId = assignId("decision-context-v1", "context");
  const auditId = assignId("time-gate-audit-v1", "audit");
  const contextItem = {
    id: `ctxi_${clueId}`,
    stream: "FOCAL",
    refType: "JUDGMENT",
    refId: clueId,
    availabilityReceiptId: null,
    resolutionReceiptId: null,
    availableAt: now,
    resolvedAt: null,
    contentHash: canonicalHash({ kind, ref }),
    memberRefs: [],
    payload: {
      structuredInput: { kind, ref, origin: "HUMAN_MISS" },
    },
  };
  const canonical = buildCanonicalDecisionInput({
    decisionType: "CARD_SYNTHESIS",
    subjectRef: { type: "VARIABLE", id: variableId },
    focalEventInstanceId: null,
    contextCutoffAt: now,
    contextItems: [contextItem],
    engine: {
      engineType: "RULE",
      ruleVersion: RULE_VERSION,
      canonicalDecisionInput: {
        ruleInput: { action: "HUMAN_MISS_DRAFT", kind, ref },
      },
    },
    policyVersion: CARD_POLICY_VERSION,
  });
  const audit = auditTimeGates({
    contextCutoffAt: now,
    contextItems: canonical.contextItems,
    decisionTiming: {
      systemDecisionAt: now,
      engineCompletedAt: now,
      enqueuedAt: null,
    },
  });
  const context = envelope({
    schema: "decision-context-v1",
    id: contextId,
    now,
    actorType,
    actorId,
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
  });
  const auditRecord = envelope({
    schema: "time-gate-audit-v1",
    id: auditId,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      decisionContextId: contextId,
      itemResults: audit.itemResults,
      gates: audit.gates,
      overallResult: audit.overallResult,
      failureCodes: audit.failureCodes,
      auditedAt: now,
    },
  });
  return { context, audit: auditRecord };
}

function buildMissDecisionChain({
  assignId,
  targetCommitGroupId,
  now,
  actorType,
  actorId,
  correlationId,
  source,
  exposure,
  clueId,
  variableId,
  kind,
  ref,
  draft,
}) {
  let context;
  let audit;
  let engine;
  if (source && exposure) {
    const contextMembers = buildContextMembers({
      assignId,
      targetCommitGroupId,
      now,
      canonicalCommandInput: { engineType: "RULE", correlationId },
      committed: { exposure, source },
    });
    context = contextMembers.find(
      (row) => row.record.schema === "decision-context-v1",
    ).record;
    audit = contextMembers.find(
      (row) => row.record.schema === "time-gate-audit-v1",
    ).record;
    const engineMembers = buildEngineMembers({
      targetCommitGroupId,
      now,
      canonicalCommandInput: {
        engineType: "RULE",
        correlationId,
        cardContextId: context.id,
        engineInvocationId: engineInvocationIdOf(context.id),
      },
      committed: { source },
      fermentationPolicy: {
        minConstituents: 3,
        ineligibleReason: "CONSTITUENT_COUNT_BELOW_3",
      },
    });
    engine = engineMembers[0].record;
    return {
      records: [context, audit, engine],
      context,
      audit,
      engine,
    };
  }
  const unmatched = buildUnmatchedContext({
    assignId,
    targetCommitGroupId,
    now,
    actorType,
    actorId,
    correlationId,
    clueId,
    variableId,
    kind,
    ref,
  });
  context = unmatched.context;
  audit = unmatched.audit;
  const engineInvocationId = engineInvocationIdOf(context.id);
  const engineId = engineResultIdOf({
    decisionContextId: context.id,
    engineInvocationId,
  });
  const validatedOutput = draft;
  engine = envelope({
    schema: "decision-engine-result-v1",
    id: engineId,
    now,
    actorType,
    actorId,
    correlationId,
    targetCommitGroupId,
    extra: {
      decisionContextId: context.id,
      engineInvocationId,
      status: "SUCCEEDED",
      validatedOutput,
      outputHash: canonicalHash(validatedOutput),
      sanitizedFailureCode: null,
      completedAt: now,
    },
  });
  return { records: [context, audit, engine], context, audit, engine };
}

export async function submitHumanMiss({ store, now, command }) {
  if (!command || command.commandType !== "submitHumanMiss") {
    fail("UNKNOWN_COMMAND", "only submitHumanMiss is allowed");
  }
  requireActor(command);
  const payload = payloadOf(command);
  const kind = payload.kind;
  const ref = payload.ref;
  if (!["SOURCE_ITEM", "RAW_REF", "URL", "TEXT"].includes(kind)) {
    fail("INVALID_COMMAND", "clue kind must be SOURCE_ITEM, RAW_REF, URL, or TEXT");
  }
  if (typeof ref !== "string" || ref.trim().length === 0) {
    fail("INVALID_COMMAND", "clue ref required");
  }
  if (typeof payload.clientActionId !== "string" || !payload.clientActionId) {
    fail("INVALID_COMMAND", "clientActionId required");
  }
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const located = findSourceItem(projected, { kind, ref: ref.trim() });
  const pathInfo = locateMissPath(projected, located.source);
  const rootCause = deriveRootCause({
    resolution: located.resolution,
    path: pathInfo,
    events: projected.events,
  });
  const calendar = await loadHorizonCalendar(calendarPath);
  const clientActionId = payload.clientActionId;
  const semanticKey = `miss-v1:${clientActionId}`;
  const correlationId = `miss:${clientActionId}`;
  const draft = located.source
    ? draftFromRule(located.source, { kind, ref: ref.trim() })
    : genericDraft(ref.trim());

  try {
    return await runtime.execute({
      commandType: "submitHumanMiss",
      idempotencyKey: semanticKey,
      actorType: ACTOR_TYPE,
      actorId: ACTOR_ID,
      correlationId,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        kind,
        ref: ref.trim(),
        clientActionId,
      },
      immutableInputRefs: located.source
        ? [{ type: "SOURCE_ITEM", id: located.source.id, hash: canonicalHash(located.source) }]
        : [],
      builderVersion: BUILDER_VERSION,
      engineResultId: null,
      expectedHeads: Array.isArray(command.expectedHeads) ? command.expectedHeads : [],
      buildMembers: ({
        assignId,
        targetCommitGroupId,
        now: stamped,
        committedProjection,
      }) => {
        const committed = committedOf(committedProjection);
        const liveLocated = findSourceItem(committed, { kind, ref: ref.trim() });
        const livePath = locateMissPath(committed, liveLocated.source);
        const liveCause = deriveRootCause({
          resolution: liveLocated.resolution,
          path: livePath,
          events: committed.events,
        });
        const clueId = brandedId("hclue_", { kind, ref: ref.trim(), clientActionId });
        const missId = brandedId("miss_", { humanClueId: clueId });
        const existingOpp = livePath.opportunity;
        const opportunityId =
          existingOpp && existingOpp.id
            ? existingOpp.id
            : brandedId("opp_", { origin: "HUMAN_MISS", kind, ref: ref.trim() });
        const variableId = brandedId("var_", { opportunityId, origin: "HUMAN_MISS" });
        const cardId = brandedId("vcr_", { origin: "HUMAN_MISS", clientActionId });
        const evidenceId = brandedId("ev_", { cardRevisionId: cardId, role: "FOCAL" });
        const themeId = brandedId("thm_", { cardRevisionId: cardId, kind: "draft" });
        const mappingId = brandedId("smap_", { cardRevisionId: cardId, kind: "draft" });
        const timingId = brandedId("mta_", {
          missReportId: missId,
          timing: "REACTION_UNKNOWN",
        });
        const reflectionId = brandedId("refl_", { missReportId: missId });
        const triggerId =
          livePath.exposure && liveLocated.resolution === "MATCHED_SOURCE_ITEM"
            ? livePath.exposure.id
            : null;
        const eligibleAt = livePath.exposure ? livePath.exposure.eligibleAt : null;
        const runId = assignId("decision-run-receipt-v1", "run");
        const chain = buildMissDecisionChain({
          assignId,
          targetCommitGroupId,
          now: stamped,
          actorType: ACTOR_TYPE,
          actorId: ACTOR_ID,
          correlationId,
          source: liveLocated.source,
          exposure: livePath.exposure,
          clueId,
          variableId,
          kind,
          ref: ref.trim(),
          draft,
        });
        const contextId = chain.context.id;
        const records = [...chain.records];
        if (!existingOpp) {
          records.push(
            envelope({
              schema: "opportunity-v1",
              id: opportunityId,
              now: stamped,
              actorType: ACTOR_TYPE,
              actorId: ACTOR_ID,
              correlationId,
              targetCommitGroupId,
              extra: {
                canonicalFingerprint: canonicalHash({
                  kind,
                  ref: ref.trim(),
                  origin: "HUMAN_MISS",
                }),
                triggerScanExposureId: triggerId,
                opportunityEligibleAt: eligibleAt,
                createdFrom: "HUMAN_CLUE",
              },
            }),
          );
        }
        records.push(
          envelope({
            schema: "human-clue-v1",
            id: clueId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            extra: {
              opportunityId,
              submittedClue: { kind, ref: ref.trim() },
              firstHumanClueAt: stamped,
              intakeResolution: liveLocated.resolution,
              discoveryMode: "USER_SUBMITTED",
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
              humanClueId: clueId,
              originalExposureId: triggerId,
              originalScreeningAttemptId: livePath.attempt ? livePath.attempt.id : null,
              originalDecisionId: livePath.decision ? livePath.decision.id : null,
              rootCause: liveCause,
              expectedDetectedAt: livePath.exposure ? livePath.exposure.eligibleAt : null,
            },
          }),
        );
        records.push(
          envelope({
            schema: "variable-v1",
            id: variableId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            extra: {
              opportunityId,
              canonicalTitle: `human-miss:${kind}:${ref.trim().slice(0, 48)}`,
              firstDetectedAt: stamped,
            },
          }),
        );
        const contentHash = liveLocated.source
          ? liveLocated.source.contentHash
          : canonicalHash({ kind, ref: ref.trim() });
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
              cardRevisionId: cardId,
              target: liveLocated.source
                ? {
                    type: "SOURCE_ITEM",
                    id: liveLocated.source.id,
                    availabilityReceiptId: null,
                  }
                : {
                    type: "JUDGMENT",
                    id: clueId,
                    availabilityReceiptId: null,
                  },
              role: "FOCAL",
              evidenceLevel: "PRIMARY",
              contentHash,
              availableAt: stamped,
            },
          }),
        );
        const theme = draft.theme || genericDraft(ref.trim()).theme;
        const mappings = Array.isArray(draft.mappings) && draft.mappings.length
          ? draft.mappings
          : genericDraft(ref.trim()).mappings;
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
              cardRevisionId: cardId,
              decisionContextId: contextId,
              knowledgeCutoffAt: stamped,
              humanDecisionSnapshotId: null,
              themeRef: theme.themeRef,
              narrative: theme.narrative,
              constituentSnapshot: theme.constituentSnapshot || ["DEMO.600000"],
              origin: "AI_AT_DECISION",
              fermentationEligibility: theme.fermentationEligibility || "NOT_EVALUABLE",
              fermentationEligibilityReason:
                theme.fermentationEligibilityReason || "CONSTITUENT_COUNT_BELOW_3",
            },
          }),
        );
        const mappingIds = [];
        for (const [index, row] of mappings.entries()) {
          const id = index === 0 ? mappingId : brandedId("smap_", { cardRevisionId: cardId, index });
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
                cardRevisionId: cardId,
                knowledgeCutoffAt: stamped,
                humanDecisionSnapshotId: null,
                securityCode: row.securityCode,
                thesis: row.thesis,
                origin: "AI_AT_DECISION",
                validFrom: stamped,
                validUntil: null,
              },
            }),
          );
        }
        const horizons = resolveAShareHorizons({
          evaluationAnchorAt: stamped,
          calendar,
        });
        const frozenSnapshotHash = canonicalHash({
          cardRevisionId: cardId,
          themeHypothesisIds: [themeId],
          securityMappingIds: mappingIds,
        });
        for (const horizon of ["T1", "T3", "T5"]) {
          const slot = horizons.horizons[horizon];
          records.push(
            envelope({
              schema: "feedback-job-v1",
              id: feedbackJobId({ cardRevisionId: cardId, horizon }),
              now: stamped,
              actorType: ACTOR_TYPE,
              actorId: ACTOR_ID,
              correlationId,
              targetCommitGroupId,
              extra: {
                jobKind: "BASE_CARD",
                metricUse: "BASE_OUTCOME",
                opportunityId,
                variableId,
                cardRevisionId: cardId,
                decisionContextId: contextId,
                triggerScanExposureId: triggerId,
                systemDecisionAt: stamped,
                evaluationAnchorAt: stamped,
                anchorSource: { type: "HUMAN_CLUE", humanClueId: clueId },
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
              id: reactionJobId({ cardRevisionId: cardId }),
              now: stamped,
              actorType: ACTOR_TYPE,
              actorId: ACTOR_ID,
              correlationId,
              targetCommitGroupId,
              extra: {
                jobKind: "BASE_CARD",
                opportunityId,
                cardRevisionId: cardId,
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
            id: cardId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            extra: {
              opportunityId,
              variableId,
              decisionContextId: contextId,
              decisionRunReceiptId: runId,
              triggerScanExposureId: triggerId,
              opportunityEligibleAt: eligibleAt,
              revision: 1,
              origin: "HUMAN_MISS",
              eventSummary: draft.eventSummary,
              variableThesis: draft.variableThesis,
              whyTradable: draft.whyTradable,
              expectationGap: null,
              expectedHorizon: draft.expectedHorizon || "T5",
              scoreComponents: draft.scoreComponents,
              uncertainties: draft.uncertainties || [],
              firstDetectedAt: stamped,
              systemDecisionAt: stamped,
              modelVersion: "HUMAN_MISS",
              promptVersion: "human-miss-draft-v1",
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
              marketDataAsOf: stamped,
              sourceReactionSearchAssessmentIds: [],
              sourceReactionAssessmentSetHash: emptySetHash(),
              aggregationRuleVersion: AGGREGATION_RULE_VERSION,
              assessedAt: stamped,
            },
          }),
        );
        records.push(
          envelope({
            schema: "reflection-run-v1",
            id: reflectionId,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId,
            targetCommitGroupId,
            extra: {
              missReportId: missId,
              rootCause: liveCause,
              evidenceRefs: triggerId ? [triggerId] : [clueId],
              similarCaseIds: [],
              proposedAction: "review retrieval, ranking, or source coverage; do not auto-change policy",
              expectedMetric: "live-miss rate",
              risk: "false positive miss labeling",
              policyChange: null,
              status: "CANDIDATE",
            },
          }),
        );
        const outputSchemas = new Set([
          "opportunity-v1",
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
          "reflection-run-v1",
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
              decisionContextId: contextId,
              contextHash: chain.context.contextHash,
              engineResultId: chain.engine.id,
              systemDecisionAt: stamped,
              runStatus: "SUCCEEDED",
              outputRecordIds: outputs.outputRecordIds,
              decisionOutputRecordHashes: outputs.decisionOutputRecordHashes,
              hashAlgorithm: "SHA-256",
              canonicalizationVersion: "canonical-json-v1",
              decisionOutputGroupHash: outputs.decisionOutputGroupHash,
              outputCommitGroupId: targetCommitGroupId,
              completedAt: stamped,
            },
          }),
        );
        void rootCause;
        return records.map((record) => ({ file: "events", record }));
      },
    });
  } catch (err) {
    if (err && err.code === "IDEMPOTENCY_CONFLICT") {
      fail(
        "IDEMPOTENCY_CONFLICT",
        "clientActionId reused with a different payload",
      );
    }
    throw err;
  }
}

function rsaHeadForJob(events, job) {
  if (!job) {
    return null;
  }
  const rsaRows = (events || []).filter(
    (row) =>
      row.schema === "reaction-search-assessment-v1" &&
      row.reactionSearchJobId === job.id,
  );
  try {
    return uniqueChainHead(rsaRows);
  } catch {
    return null;
  }
}

function resolveMissTiming({ events, miss }) {
  const clue = (events || []).find(
    (row) => row.schema === "human-clue-v1" && row.id === miss.humanClueId,
  );
  const card = (events || []).find(
    (row) =>
      row.schema === "variable-card-revision-v1" &&
      row.origin === "HUMAN_MISS" &&
      row.opportunityId === miss.opportunityId,
  );
  const missJob = card
    ? (events || []).find(
        (row) =>
          row.schema === "reaction-search-job-v1" &&
          row.cardRevisionId === card.id,
      )
    : null;
  const originalExposure = miss.originalExposureId
    ? (events || []).find((row) => row.id === miss.originalExposureId)
    : null;
  const originCard = originalExposure
    ? (events || []).find(
        (row) =>
          row.schema === "variable-card-revision-v1" &&
          row.origin === "AI_DISCOVERED" &&
          row.triggerScanExposureId === originalExposure.id,
      )
    : null;
  const originJob = originCard
    ? (events || []).find(
        (row) =>
          row.schema === "reaction-search-job-v1" &&
          row.cardRevisionId === originCard.id,
      )
    : null;
  let rsa = rsaHeadForJob(events, missJob);
  if (!rsa || !rsa.firstReactionAt) {
    rsa = rsaHeadForJob(events, originJob);
  }
  const firstReactionAt = rsa && rsa.firstReactionAt ? rsa.firstReactionAt : null;
  const firstHumanClueAt = clue
    ? clue.firstHumanClueAt || clue.recordedAt
    : null;
  if (!firstReactionAt) {
    return {
      timing: "REACTION_UNKNOWN",
      reactionAtUsed: null,
      sourceIds: [],
    };
  }
  const live =
    firstHumanClueAt && firstHumanClueAt < firstReactionAt
      ? "LIVE_MISS"
      : "RETROSPECTIVE";
  return {
    timing: live,
    reactionAtUsed: firstReactionAt,
    sourceIds: rsa ? [rsa.id] : [],
  };
}

export async function assessMissTiming({ store, now, missReportId }) {
  if (typeof missReportId !== "string" || !missReportId) {
    fail("INVALID_COMMAND", "missReportId required");
  }
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const miss = projected.events.find(
    (row) => row.schema === "miss-report-v1" && row.id === missReportId,
  );
  if (!miss) {
    fail("INPUT_REF_MISMATCH", "miss report is not committed");
  }
  const existing = projected.events.filter(
    (row) =>
      row.schema === "miss-timing-assessment-v1" &&
      row.missReportId === missReportId,
  );
  let head = null;
  try {
    head = uniqueChainHead(existing);
  } catch {
    fail("HEAD_AMBIGUOUS", "miss timing chain is forked");
  }
  const resolved = resolveMissTiming({ events: projected.events, miss });
  if (head && head.timing === resolved.timing) {
    return {
      commitGroupId: head.commitGroupId,
      reused: true,
      memberRecordIds: [head.id],
    };
  }
  const semanticKey = `miss-timing-v1:${missReportId}:${resolved.timing}`;
  return runtime.execute({
    commandType: "assessMissTiming",
    idempotencyKey: semanticKey,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId: `miss-timing:${missReportId}:${resolved.timing}`,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      missReportId,
      timing: resolved.timing,
    },
    immutableInputRefs: [{ type: "MISS_REPORT", id: miss.id }],
    builderVersion: "miss-timing-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({ assignId, targetCommitGroupId, now: stamped, committedProjection }) => {
      const events = committedOf(committedProjection).events;
      const live = events.find(
        (row) => row.schema === "miss-report-v1" && row.id === missReportId,
      );
      if (!live) {
        fail("INPUT_REF_MISMATCH", "miss report is not committed");
      }
      const prior = events.filter(
        (row) =>
          row.schema === "miss-timing-assessment-v1" &&
          row.missReportId === missReportId,
      );
      const priorHead = uniqueChainHead(prior);
      const next = resolveMissTiming({ events, miss: live });
      return [
        {
          file: "events",
          record: envelope({
            schema: "miss-timing-assessment-v1",
            id: assignId("miss-timing-assessment-v1", next.timing.toLowerCase()),
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId: `miss-timing:${missReportId}:${next.timing}`,
            targetCommitGroupId,
            supersedesId: priorHead ? priorHead.id : null,
            extra: {
              missReportId,
              timing: next.timing,
              reactionAtUsed: next.reactionAtUsed,
              reactionSearchRuleVersion: REACTION_SEARCH_RULE_VERSION,
              marketDataAsOf: stamped,
              sourceReactionSearchAssessmentIds: next.sourceIds,
              sourceReactionAssessmentSetHash: canonicalHash(next.sourceIds),
              aggregationRuleVersion: AGGREGATION_RULE_VERSION,
              assessedAt: stamped,
            },
          }),
        },
      ];
    },
  });
}
