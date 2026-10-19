// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { buildCanonicalDecisionInput } from "../decision/canonical-input.mjs";
import { auditTimeGates } from "../decision/time-gate.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { PresentationError } from "./errors.mjs";
import { allocateBudget, loadBudget } from "./rank.mjs";

const POLICY_VERSION = "budget-v1";
const RULE_VERSION = "presentation-rank-v1";
const BUILDER_CONTEXT = "presentation-context-v1";
const BUILDER_OUTPUT = "presentation-output-v1";
const BUDGET_VERSION = "budget-v1";

function fail(code, message, details) {
  throw new PresentationError(code, message, details);
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

function periodExpiry(budgetPeriodId) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(budgetPeriodId);
  if (!match) {
    fail("INVALID_PERIOD", "budgetPeriodId must be YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const yyyy = String(next.getUTCFullYear()).padStart(4, "0");
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00+08:00`;
}

function semanticKey(phase, budgetPeriodId) {
  return ["presentation-v1", phase, budgetPeriodId, BUDGET_VERSION].join(":");
}

function incrementalSemanticKey(phase, budgetPeriodId, candidateSnapshotHash) {
  return [
    "presentation-incremental-v1",
    phase,
    budgetPeriodId,
    candidateSnapshotHash,
    BUDGET_VERSION,
  ].join(":");
}

function asSnapshotConflict(err) {
  if (err && err.code === "IDEMPOTENCY_CONFLICT") {
    fail(
      "SNAPSHOT_CONFLICT",
      "budgetPeriod already allocated for a different candidate snapshot",
    );
  }
  throw err;
}

function rankingRuleInput(row) {
  return (
    row &&
    row.engine &&
    row.engine.canonicalDecisionInput &&
    row.engine.canonicalDecisionInput.ruleInput
  );
}

function findRankingContext(
  events,
  { budgetPeriodId, candidateSnapshotHash, presentationCycleId },
) {
  return events.find((row) => {
    if (
      !row ||
      row.schema !== "decision-context-v1" ||
      row.decisionType !== "PRESENTATION_RANKING"
    ) {
      return false;
    }
    const ruleInput = rankingRuleInput(row);
    if (!ruleInput) {
      return false;
    }
    return (
      row.subjectRef &&
      row.subjectRef.id === presentationCycleId &&
      ruleInput.budgetPeriodId === budgetPeriodId &&
      ruleInput.candidateSnapshotHash === candidateSnapshotHash &&
      ruleInput.presentationCycleId === presentationCycleId
    );
  });
}

function freezeCandidates(projectedEvents, inputs) {
  const cards = new Map();
  for (const row of projectedEvents) {
    if (row && row.schema === "variable-card-revision-v1") {
      cards.set(row.id, row);
    }
  }
  const frozen = [];
  for (const input of inputs) {
    if (!input || typeof input.cardRevisionId !== "string") {
      fail("INPUT_REF_MISMATCH", "candidate cardRevisionId required");
    }
    const card = cards.get(input.cardRevisionId);
    if (!card) {
      fail("INPUT_REF_MISMATCH", "card revision not in committed projection", {
        cardRevisionId: input.cardRevisionId,
      });
    }
    frozen.push({
      cardRevisionId: card.id,
      budgetBucket: input.budgetBucket,
      systemDecisionAt: card.systemDecisionAt,
      scoreComponents: card.scoreComponents,
      cardHash: canonicalHash(card),
    });
  }
  frozen.sort((left, right) =>
    left.cardRevisionId < right.cardRevisionId
      ? -1
      : left.cardRevisionId > right.cardRevisionId
        ? 1
        : 0,
  );
  return frozen;
}

function snapshotMembers(frozen) {
  return frozen.map((row) => ({
    cardRevisionId: row.cardRevisionId,
    budgetBucket: row.budgetBucket,
    systemDecisionAt: row.systemDecisionAt,
    scoreComponents: row.scoreComponents,
    cardHash: row.cardHash,
  }));
}

function existingSnapshotHash(events, budgetPeriodId) {
  const decisions = events.filter(
    (row) =>
      row.schema === "presentation-decision-v1" &&
      row.budgetPeriodId === budgetPeriodId,
  );
  if (decisions.length === 0) {
    return null;
  }
  const context = events.find(
    (row) =>
      row.schema === "decision-context-v1" &&
      row.id === decisions[0].rankingDecisionContextId,
  );
  const hash =
    context &&
    context.engine &&
    context.engine.canonicalDecisionInput &&
    context.engine.canonicalDecisionInput.ruleInput &&
    context.engine.canonicalDecisionInput.ruleInput.candidateSnapshotHash;
  if (typeof hash !== "string") {
    fail("LEDGER_CORRUPT", "existing presentation context snapshot missing");
  }
  return hash;
}

function buildCanonicalRankingContext({
  presentationCycleId,
  budgetPeriodId,
  candidateSnapshotHash,
  members,
  now,
}) {
  const contextItem = {
    id: `ctxi_${candidateSnapshotHash.slice(0, 16)}`,
    stream: "FOCAL",
    refType: "FACT",
    refId: `fact_${candidateSnapshotHash}`,
    availabilityReceiptId: null,
    resolutionReceiptId: null,
    availableAt: now,
    resolvedAt: null,
    contentHash: candidateSnapshotHash,
    memberRefs: [],
    payload: {
      structuredInput: {
        candidateSnapshotHash,
        budgetVersion: BUDGET_VERSION,
        budgetPeriodId,
        presentationCycleId,
      },
    },
  };
  return buildCanonicalDecisionInput({
    decisionType: "PRESENTATION_RANKING",
    subjectRef: { type: "VARIABLE", id: presentationCycleId },
    focalEventInstanceId: null,
    contextCutoffAt: now,
    contextItems: [contextItem],
    engine: {
      engineType: "RULE",
      ruleVersion: RULE_VERSION,
      canonicalDecisionInput: {
        ruleInput: {
          budgetVersion: BUDGET_VERSION,
          budgetPeriodId,
          candidateSnapshotHash,
          presentationCycleId,
          candidates: members,
        },
      },
    },
    policyVersion: POLICY_VERSION,
  });
}

function assertRecomputableRankingContext(context) {
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
    fail("INPUT_HASH_MISMATCH", "ranking contextHash is not recomputable");
  }
}

export function presentationDecisionIdOf({
  cardRevisionId,
  presentationCycleId,
  budgetPeriodId,
}) {
  return brandedId("pdec_", {
    cardRevisionId,
    presentationCycleId,
    budgetPeriodId,
    budgetVersion: BUDGET_VERSION,
  });
}

function buildContextMembers({
  assignId,
  targetCommitGroupId,
  canonicalCommandInput,
  now,
}) {
  const correlationId = canonicalCommandInput.correlationId;
  const canonical = buildCanonicalRankingContext({
    presentationCycleId: canonicalCommandInput.presentationCycleId,
    budgetPeriodId: canonicalCommandInput.budgetPeriodId,
    candidateSnapshotHash: canonicalCommandInput.candidateSnapshotHash,
    members: canonicalCommandInput.candidates,
    now,
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
  const contextId = assignId("decision-context-v1", "context");
  const auditId = assignId("time-gate-audit-v1", "audit");
  return [
    {
      file: "events",
      record: envelope({
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
    },
    {
      file: "events",
      record: envelope({
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
    },
  ];
}

function buildDecisionMembers({
  targetCommitGroupId,
  canonicalCommandInput,
  now,
}) {
  const correlationId = canonicalCommandInput.correlationId;
  const expiresAt = periodExpiry(canonicalCommandInput.budgetPeriodId);
  return canonicalCommandInput.allocations.map((row) => ({
    file: "events",
    record: envelope({
      schema: "presentation-decision-v1",
      id: presentationDecisionIdOf({
        cardRevisionId: row.cardRevisionId,
        presentationCycleId: canonicalCommandInput.presentationCycleId,
        budgetPeriodId: canonicalCommandInput.budgetPeriodId,
      }),
      now,
      targetCommitGroupId,
      extra: {
        correlationId,
        cardRevisionId: row.cardRevisionId,
        rankingDecisionContextId: canonicalCommandInput.rankingContextId,
        presentationCycleId: canonicalCommandInput.presentationCycleId,
        tier: row.tier,
        rank: row.rank,
        score: row.score,
        budgetBucket: row.budgetBucket,
        budgetVersion: BUDGET_VERSION,
        budgetPeriodId: canonicalCommandInput.budgetPeriodId,
        capacity: row.capacity,
        slot: row.slot,
        reasonCode: row.reasonCode,
        decisionAt: now,
        expiresAt,
      },
    }),
  }));
}

export async function presentCommittedCards({
  store,
  now = () => new Date().toISOString(),
  callerKey,
  budgetPeriodId,
  candidates,
}) {
  if (typeof callerKey !== "string" || callerKey.length === 0) {
    fail("INVALID_COMMAND", "callerKey required");
  }
  if (typeof budgetPeriodId !== "string" || budgetPeriodId.length === 0) {
    fail("INVALID_PERIOD", "budgetPeriodId required");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail("INVALID_CANDIDATE", "candidates required");
  }
  const clock = typeof now === "function" ? now() : now;
  const runtime = new CommandRuntime({
    store,
    now: typeof now === "function" ? now : () => now,
  });
  let projected = await projectCommitted(runtime);
  const frozen = freezeCandidates(projected.events, candidates);
  const members = snapshotMembers(frozen);
  const candidateSnapshotHash = canonicalHash(members);
  const priorHash = existingSnapshotHash(projected.events, budgetPeriodId);
  // Only the selected cards and budget facts cross a publication phase.
  // Release full history before the next locked verification allocates it.
  projected = null;
  if (priorHash && priorHash !== candidateSnapshotHash) {
    fail(
      "SNAPSHOT_CONFLICT",
      "budgetPeriod already allocated for a different candidate snapshot",
    );
  }
  const budget = await loadBudget();
  const ranked = allocateBudget({
    candidates: frozen,
    budget,
    now: clock,
  });
  const presentationCycleId = `cycle:${budgetPeriodId}:${candidateSnapshotHash}`;
  const correlationId = `presentation:${budgetPeriodId}`;
  const common = {
    budgetPeriodId,
    budgetVersion: BUDGET_VERSION,
    candidateSnapshotHash,
    presentationCycleId,
    correlationId,
    candidates: members,
  };

  try {
    await runtime.execute({
      commandType: "rankPresentationContext",
      idempotencyKey: semanticKey("context", budgetPeriodId),
      actorType: "SYSTEM",
      actorId: "system:demo-runner",
      correlationId,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        ...common,
        phase: "context",
      },
      immutableInputRefs: frozen.map((row) => ({
        type: "CARD_REVISION",
        id: row.cardRevisionId,
        hash: row.cardHash,
      })),
      builderVersion: BUILDER_CONTEXT,
      engineResultId: null,
      expectedHeads: [],
      buildMembers: (args) => buildContextMembers(args),
    });
  } catch (err) {
    asSnapshotConflict(err);
  }

  let afterContext = await projectCommitted(runtime);
  const context = findRankingContext(afterContext.events, {
    budgetPeriodId,
    candidateSnapshotHash,
    presentationCycleId,
  });
  const audit = context
    ? afterContext.events.find(
        (row) =>
          row.schema === "time-gate-audit-v1" &&
          row.decisionContextId === context.id,
      )
    : null;
  afterContext = null;
  if (!context || !audit) {
    fail("INPUT_REF_MISMATCH", "ranking context/audit not committed");
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
    fail("INPUT_HASH_MISMATCH", "ranking contextHash is not recomputable");
  }
  if (audit.overallResult !== "PASS") {
    fail("TIME_AUDIT_FAILED", "ranking time-gate audit did not pass");
  }

  let executed;
  try {
    executed = await runtime.execute({
      commandType: "rankPresentationOutputs",
      idempotencyKey: semanticKey("output", budgetPeriodId),
      actorType: "SYSTEM",
      actorId: "system:demo-runner",
      correlationId,
      policyVersion: POLICY_VERSION,
      canonicalCommandInput: {
        ...common,
        phase: "output",
        rankingContextId: context.id,
        rankingContextHash: canonicalHash(context),
        allocations: ranked.allocations,
      },
      immutableInputRefs: [
        {
          type: "DECISION_CONTEXT",
          id: context.id,
          hash: canonicalHash(context),
        },
        {
          type: "TIME_GATE_AUDIT",
          id: audit.id,
          hash: canonicalHash(audit),
        },
      ],
      builderVersion: BUILDER_OUTPUT,
      engineResultId: null,
      expectedHeads: [],
      buildMembers: (args) => buildDecisionMembers(args),
    });
  } catch (err) {
    asSnapshotConflict(err);
  }

  const afterOutput = await projectCommitted(runtime);
  const decisions = afterOutput.events.filter(
    (row) =>
      row.schema === "presentation-decision-v1" &&
      row.commitGroupId === executed.commitGroupId,
  );
  return {
    commitGroupId: executed.commitGroupId,
    reused: executed.reused,
    allocations: decisions,
    rankingDecisionContextId: context.id,
  };
}

/**
 * Append a bounded presentation cycle for cards discovered after the day's
 * initial frozen snapshot. Existing slots are immutable; new cards consume
 * only the remaining capacity and overflow into the candidate pool.
 */
export async function presentIncrementalCards({
  store,
  now = () => new Date().toISOString(),
  callerKey,
  budgetPeriodId,
  candidates,
}) {
  if (typeof callerKey !== "string" || callerKey.length === 0) {
    fail("INVALID_COMMAND", "callerKey required");
  }
  if (typeof budgetPeriodId !== "string" || budgetPeriodId.length === 0) {
    fail("INVALID_PERIOD", "budgetPeriodId required");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail("INVALID_CANDIDATE", "candidates required");
  }
  const clock = typeof now === "function" ? now() : now;
  const runtime = new CommandRuntime({
    store,
    now: typeof now === "function" ? now : () => now,
    cooperativeWrites: true,
  });
  let projected = await projectCommitted(runtime);
  const alreadyPresented = new Set(
    projected.events
      .filter(
        (row) =>
          row.schema === "presentation-decision-v1" &&
          row.budgetPeriodId === budgetPeriodId,
      )
      .map((row) => row.cardRevisionId),
  );
  const remaining = candidates.filter(
    (candidate) => !alreadyPresented.has(candidate?.cardRevisionId),
  );
  if (remaining.length === 0) return null;

  const frozen = freezeCandidates(projected.events, remaining);
  const members = snapshotMembers(frozen);
  const candidateSnapshotHash = canonicalHash(members);
  const budget = await loadBudget();
  const ranked = allocateBudget({ candidates: frozen, budget, now: clock });
  const existing = projected.events.filter(
    (row) =>
      row.schema === "presentation-decision-v1" &&
      row.budgetPeriodId === budgetPeriodId,
  );
  projected = null;
  const allocations = ranked.allocations.map((allocation) => {
    const inBucket = existing.filter(
      (row) => row.budgetBucket === allocation.budgetBucket,
    );
    const occupied = inBucket.filter(
      (row) => row.tier === "MUST_REVIEW" && Number.isInteger(row.slot),
    ).length;
    const rankOffset = inBucket.reduce(
      (max, row) => Math.max(max, Number(row.rank) || 0),
      0,
    );
    const remainingCapacity = Math.max(0, allocation.capacity - occupied);
    const slotted = allocation.rank <= remainingCapacity;
    return {
      ...allocation,
      tier: slotted ? "MUST_REVIEW" : "CANDIDATE_POOL",
      rank: rankOffset + allocation.rank,
      slot: slotted ? occupied + allocation.rank : null,
      reasonCode: slotted ? "BUDGET_SLOT_ALLOCATED" : "BUDGET_OVERFLOW",
    };
  });
  const presentationCycleId =
    `cycle:${budgetPeriodId}:incremental:${candidateSnapshotHash}`;
  const correlationId = `presentation:${budgetPeriodId}:incremental`;
  const common = {
    budgetPeriodId,
    budgetVersion: BUDGET_VERSION,
    candidateSnapshotHash,
    presentationCycleId,
    correlationId,
    candidates: members,
  };

  await runtime.execute({
    commandType: "rankIncrementalPresentationContext",
    idempotencyKey: incrementalSemanticKey(
      "context",
      budgetPeriodId,
      candidateSnapshotHash,
    ),
    actorType: "SYSTEM",
    actorId: "system:source-worker",
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: { ...common, phase: "context", callerKey },
    immutableInputRefs: frozen.map((row) => ({
      type: "CARD_REVISION",
      id: row.cardRevisionId,
      hash: row.cardHash,
    })),
    builderVersion: BUILDER_CONTEXT,
    engineResultId: null,
    expectedHeads: [],
    buildMembers: (args) => buildContextMembers(args),
  });

  let afterContext = await projectCommitted(runtime);
  const context = findRankingContext(afterContext.events, {
    budgetPeriodId,
    candidateSnapshotHash,
    presentationCycleId,
  });
  const audit = context
    ? afterContext.events.find(
        (row) =>
          row.schema === "time-gate-audit-v1" &&
          row.decisionContextId === context.id,
      )
    : null;
  afterContext = null;
  if (!context || !audit) {
    fail("INPUT_REF_MISMATCH", "incremental ranking context/audit not committed");
  }
  assertRecomputableRankingContext(context);
  if (audit.overallResult !== "PASS") {
    fail("TIME_AUDIT_FAILED", "incremental ranking time-gate audit did not pass");
  }

  const executed = await runtime.execute({
    commandType: "rankIncrementalPresentationOutputs",
    idempotencyKey: incrementalSemanticKey(
      "output",
      budgetPeriodId,
      candidateSnapshotHash,
    ),
    actorType: "SYSTEM",
    actorId: "system:source-worker",
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      ...common,
      phase: "output",
      callerKey,
      rankingContextId: context.id,
      rankingContextHash: canonicalHash(context),
      allocations,
    },
    immutableInputRefs: [
      { type: "DECISION_CONTEXT", id: context.id, hash: canonicalHash(context) },
      { type: "TIME_GATE_AUDIT", id: audit.id, hash: canonicalHash(audit) },
    ],
    builderVersion: BUILDER_OUTPUT,
    engineResultId: null,
    expectedHeads: [],
    buildMembers: (args) => buildDecisionMembers(args),
  });
  const afterOutput = await projectCommitted(runtime);
  return {
    commitGroupId: executed.commitGroupId,
    reused: executed.reused,
    allocations: afterOutput.events.filter(
      (row) =>
        row.schema === "presentation-decision-v1" &&
        row.commitGroupId === executed.commitGroupId,
    ),
    rankingDecisionContextId: context.id,
  };
}
