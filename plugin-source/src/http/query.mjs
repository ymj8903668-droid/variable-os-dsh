// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { projectInboxEmptyState } from "../scan/empty-state.mjs";
import { pageCandidatePool, pageMustReview } from "../presentation/cursor.mjs";
import {
  createCardLabelProjectionIndex,
  projectCardLabelState,
} from "../label/projection.mjs";
import { projectBlindTasks } from "../audit/query.mjs";
import { QueryError } from "./errors.mjs";

const CARD_KEYS = new Set([
  "cardRevisionId",
  "variableId",
  "variableIdentityKey",
  "catalystIdentityKey",
  "revision",
  "previousCardRevisionId",
  "systemSuggestion",
  "suggestionEvidence",
  "suggestionTraceComplete",
  "counterEvidence",
  "invalidationConditions",
  "versionChange",
  "presentationDecisionId",
  "presentationCycleId",
  "tier",
  "rank",
  "score",
  "budgetBucket",
  "slot",
  "eventSummary",
  "expectationGap",
  "whyTradable",
  "expectedHorizon",
  "uncertainties",
  "themeReview",
  "mappingReview",
  "themes",
  "securities",
  "evidence",
  "sourceNamespaces",
  "systemDecisionAt",
  "firstHumanPresentedAt",
  "origin",
  "modelVersion",
  "promptVersion",
  "currentLabel",
  "currentWatchTask",
  "expectedLabelHeadId",
  "expectedExposureHeadId",
  "expectedOpportunityExposureSetHash",
  "presentationInteractionId",
]);

const FORBIDDEN =
  /fermentationResult|mappingEvaluation|marketObservation|returnPct|firstReactionAt|今日无变量/;

function fail(code, message, details) {
  throw new QueryError(code, message, details);
}

export function computeLedgerWatermark(projected) {
  const receipts = projected.events
    .filter((row) => row && row.schema === "commit-group-receipt-v1")
    .map((row) => [row.id, row.groupHash])
    .sort((left, right) => (left[0] < right[0] ? -1 : 1));
  const sources = projected.sourceItems
    .map((row) => row.id)
    .sort();
  return canonicalHash({ receipts, sources });
}

function latestScan(events) {
  const runs = events.filter((row) => row.schema === "scan-run-v1");
  const receipts = events.filter((row) => row.schema === "scan-receipt-v1");
  const scanRun = runs.length ? runs[runs.length - 1] : null;
  const scanReceipt = scanRun
    ? receipts.find((row) => row.scanRunId === scanRun.id) || null
    : null;
  return { scanRun, scanReceipt };
}

function presentedAt(events, cardRevisionId, index = null) {
  if (index) return index.presentedAtByCard.get(cardRevisionId) || null;
  const times = events
    .filter(
      (row) =>
        row.schema === "delivery-interaction-v1" &&
        row.eventType === "PRESENTED" &&
        row.cardRevisionId === cardRevisionId &&
        typeof row.occurredAt === "string",
    )
    .map((row) => row.occurredAt)
    .sort();
  return times[0] || null;
}

function variableIdentityKey(card) {
  if (typeof card.variableIdentityKey === "string" && card.variableIdentityKey) {
    return card.variableIdentityKey;
  }
  const title = String(card.variableTitle || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
  return title || null;
}

function normalizedIdentity(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

function catalystIdentityKey(card, themes) {
  const frozen = normalizedIdentity(card?.catalystIdentityKey);
  if (frozen) return frozen;
  const refs = [...new Set(
    (Array.isArray(themes) ? themes : [])
      .map((theme) => normalizedIdentity(theme?.themeRef))
      .filter(Boolean),
  )].sort();
  return refs.length ? refs.join(" | ") : null;
}

function legacySystemSuggestion(card, evidence) {
  const scores = card?.scoreComponents || {};
  const evidenceStrength = Number(scores.evidenceStrength);
  const tradabilityConfidence = Number(scores.tradabilityConfidence);
  const label =
    evidenceStrength >= 0.58 && tradabilityConfidence >= 0.62
      ? "TRADABLE"
      : evidenceStrength >= 0.5 && tradabilityConfidence <= 0.25
        ? "NOT_TRADABLE"
        : "WATCH";
  const rationale =
    label === "TRADABLE"
      ? "历史卷宗按既有结构评分补位：证据与发酵条件相对完整，仍须人工核对冻结引用。"
      : label === "NOT_TRADABLE"
        ? "历史卷宗按既有结构评分补位：当前证据尚不足以支持持续发酵，仍须人工复核。"
        : "历史卷宗按既有结构评分补位：仍有关键未知项，建议等待后续节点验证。";
  return {
    authority: "SYSTEM_SUGGESTION",
    label,
    rationale,
    basis: "LEGACY_POLICY_FALLBACK",
    evidenceIds: evidence.map((row) => row.id),
    suggestedAt: card.systemDecisionAt || null,
    modelVersion: card.modelVersion || "RULE",
    promptVersion: card.promptVersion || "legacy-policy-fallback-v1",
  };
}

function cardEvidence(events, cardRevisionId, index = null) {
  const rows = index
    ? index.evidenceByCard.get(cardRevisionId) || []
    : events;
  return rows
    .filter(
      (row) =>
        row.schema === "card-evidence-v1" && row.cardRevisionId === cardRevisionId,
    )
    .map((row) => ({
      id: row.id,
      role: row.role,
      contentHash: row.contentHash,
      sourceRef: row.retrievalRef || null,
      sourceType: row.retrievalSourceType || null,
      sourcePath: row.sourcePath || null,
    }));
}

// Read only the channels of linked, already-available source items. Do not infer
// intake ownership from a model-written summary, retrieved path or media name.
function cardSourceNamespaces(card, index) {
  const ids = [index.sourceByExposure.get(card.triggerScanExposureId)];
  for (const evidence of index.evidenceByCard.get(card.id) || []) {
    if (evidence.target?.type === "SOURCE_ITEM") ids.push(evidence.target.id);
  }
  const cutoff = Date.parse(card.systemDecisionAt);
  return [...new Set(ids.map((id) => index.sources.get(id)).filter((source) =>
    source && typeof source.sourceNamespace === "string" &&
    Date.parse(source.availableAt) <= cutoff,
  ).map((source) => source.sourceNamespace))].sort();
}

function systemSuggestionFor(card, evidence) {
  return card.systemSuggestion?.authority === "SYSTEM_SUGGESTION"
    ? card.systemSuggestion
    : legacySystemSuggestion(card, evidence);
}

function suggestionLabel(label) {
  return {
    TRADABLE: "可炒",
    WATCH: "继续观察",
    NOT_TRADABLE: "不可炒",
  }[label] || "待预判";
}

function revisionChange(card, cards, events, currentSuggestion, currentEvidence, index) {
  const previous = card.previousCardRevisionId
    ? cards.get(card.previousCardRevisionId) || null
    : null;
  if (!previous) {
    return {
      kind: "NEW",
      previousCardRevisionId: null,
      labelChanged: false,
      previousLabel: null,
      currentLabel: currentSuggestion.label,
      evidenceAdded: currentEvidence.length,
      evidenceRemoved: 0,
      uncertaintyDelta: Array.isArray(card.uncertainties) ? card.uncertainties.length : 0,
      summary: "首次进入变量台，等待人工建立研判基线。",
    };
  }
  const previousEvidence = cardEvidence(events, previous.id, index);
  const previousSuggestion = systemSuggestionFor(previous, previousEvidence);
  const currentHashes = new Set(currentEvidence.map((row) => row.contentHash).filter(Boolean));
  const previousHashes = new Set(previousEvidence.map((row) => row.contentHash).filter(Boolean));
  const evidenceAdded = [...currentHashes].filter((hash) => !previousHashes.has(hash)).length;
  const evidenceRemoved = [...previousHashes].filter((hash) => !currentHashes.has(hash)).length;
  const uncertaintyDelta =
    (Array.isArray(card.uncertainties) ? card.uncertainties.length : 0) -
    (Array.isArray(previous.uncertainties) ? previous.uncertainties.length : 0);
  const labelChanged = previousSuggestion.label !== currentSuggestion.label;
  const changes = [
    `新增 ${evidenceAdded} 条、移除 ${evidenceRemoved} 条冻结引用`,
    labelChanged
      ? `系统预判由${suggestionLabel(previousSuggestion.label)}调整为${suggestionLabel(currentSuggestion.label)}`
      : `系统预判维持${suggestionLabel(currentSuggestion.label)}`,
    uncertaintyDelta === 0
      ? "显式未知项数量未变"
      : `显式未知项${uncertaintyDelta > 0 ? "增加" : "减少"} ${Math.abs(uncertaintyDelta)} 项`,
  ];
  return {
    kind: "UPDATED",
    previousCardRevisionId: previous.id,
    labelChanged,
    previousLabel: previousSuggestion.label,
    currentLabel: currentSuggestion.label,
    evidenceAdded,
    evidenceRemoved,
    uncertaintyDelta,
    summary: `第 ${Number.isInteger(card.revision) ? card.revision : 1} 版：${changes.join("；")}。`,
  };
}

function cardView(card, decision, events, cards, index) {
  const labelState = projectCardLabelState(events, card, undefined, index.labels);
  const evidence = cardEvidence(events, card.id, index);
  const systemSuggestion = systemSuggestionFor(card, evidence);
  const suggestionIds = Array.isArray(systemSuggestion.evidenceIds)
    ? systemSuggestion.evidenceIds
    : [];
  const suggestionIdSet = new Set(suggestionIds);
  const suggestionEvidence = evidence.filter((row) => suggestionIdSet.has(row.id));
  const view = {
    cardRevisionId: card.id,
    variableId: card.variableId || null,
    variableIdentityKey: variableIdentityKey(card),
    catalystIdentityKey: catalystIdentityKey(card, labelState.themes),
    revision: Number.isInteger(card.revision) ? card.revision : 1,
    previousCardRevisionId: card.previousCardRevisionId || null,
    systemSuggestion,
    suggestionEvidence,
    suggestionTraceComplete:
      suggestionIds.length > 0 && suggestionEvidence.length === suggestionIds.length,
    counterEvidence: Array.isArray(card.counterEvidence) ? card.counterEvidence : [],
    invalidationConditions: Array.isArray(card.invalidationConditions)
      ? card.invalidationConditions
      : [],
    versionChange: revisionChange(card, cards, events, systemSuggestion, evidence, index),
    presentationDecisionId: decision.id,
    presentationCycleId: decision.presentationCycleId,
    tier: decision.tier,
    rank: decision.rank,
    score: decision.score,
    budgetBucket: decision.budgetBucket,
    slot: decision.slot,
    eventSummary: card.eventSummary,
    expectationGap: card.expectationGap ?? null,
    whyTradable: card.whyTradable,
    expectedHorizon: card.expectedHorizon,
    uncertainties: Array.isArray(card.uncertainties) ? card.uncertainties : [],
    themeReview: labelState.themeReview,
    mappingReview: labelState.mappingReview,
    themes: labelState.themes,
    securities: labelState.securities,
    evidence,
    sourceNamespaces: cardSourceNamespaces(card, index),
    systemDecisionAt: card.systemDecisionAt,
    firstHumanPresentedAt: presentedAt(events, card.id, index),
    origin: card.origin ?? null,
    modelVersion: card.modelVersion ?? null,
    promptVersion: card.promptVersion ?? null,
    currentLabel: labelState.currentLabel,
    currentWatchTask: labelState.currentWatchTask,
    expectedLabelHeadId: labelState.expectedLabelHeadId,
    expectedExposureHeadId: labelState.expectedExposureHeadId,
    expectedOpportunityExposureSetHash:
      labelState.expectedOpportunityExposureSetHash,
    presentationInteractionId: labelState.presentationInteractionId,
  };
  for (const key of Object.keys(view)) {
    if (!CARD_KEYS.has(key)) {
      fail("VIEW_POLLUTED", `unexpected card view field ${key}`);
    }
  }
  return view;
}

function assertClean(view) {
  const blob = JSON.stringify(view);
  if (FORBIDDEN.test(blob)) {
    fail("VIEW_POLLUTED", "outcome fields leaked into inbox view");
  }
  if (blob.includes("outcome-panel")) {
    fail("VIEW_POLLUTED", "outcome panel leaked into inbox view");
  }
}

export async function queryInbox({
  store,
  asOfWatermark,
  cardId = null,
  now,
  mode = null,
  taskId = null,
  live = null,
}) {
  if (asOfWatermark === undefined || asOfWatermark === null || asOfWatermark === "") {
    fail("WATERMARK_REQUIRED", "asOfWatermark is required");
  }
  const projected = live?.projected || await new CommandRuntime({ store, now: () => now }).project();
  const watermark = live?.watermark || computeLedgerWatermark(projected);
  if (asOfWatermark !== "latest" && asOfWatermark !== watermark) {
    fail("WATERMARK_MISMATCH", "asOfWatermark does not match frozen ledger");
  }
  const { scanRun, scanReceipt } = latestScan(projected.events);
  const empty = projectInboxEmptyState({ scanRun, scanReceipt });
  const cards = new Map(
    projected.events
      .filter((row) => row.schema === "variable-card-revision-v1")
      .map((row) => [row.id, row]),
  );
  const evidenceByCard = new Map();
  const presentedAtByCard = new Map();
  const sourceByExposure = new Map();
  for (const row of projected.events) {
    if (row.schema === "scan-exposure-v1") sourceByExposure.set(row.id, row.sourceItemId);
    if (row.schema === "card-evidence-v1") {
      const evidence = evidenceByCard.get(row.cardRevisionId) || [];
      evidence.push(row);
      evidenceByCard.set(row.cardRevisionId, evidence);
    }
    if (
      row.schema === "delivery-interaction-v1" &&
      row.eventType === "PRESENTED" &&
      typeof row.occurredAt === "string"
    ) {
      const previous = presentedAtByCard.get(row.cardRevisionId);
      if (!previous || row.occurredAt < previous) {
        presentedAtByCard.set(row.cardRevisionId, row.occurredAt);
      }
    }
  }
  const index = {
    evidenceByCard,
    presentedAtByCard,
    sourceByExposure,
    sources: new Map(projected.sourceItems.map((source) => [source.id, source])),
    labels: createCardLabelProjectionIndex(projected.events),
  };
  const decisions = projected.events.filter(
    (row) => row.schema === "presentation-decision-v1",
  );
  const mustPage = pageMustReview({
    decisions: decisions.filter((row) => row.budgetBucket !== "URGENT"),
    cursor: null,
    limit: 1000,
    now,
  });
  const urgentPage = pageMustReview({
    decisions: decisions.filter((row) => row.budgetBucket === "URGENT"),
    cursor: null,
    limit: 1000,
    now,
  });
  const poolPage = pageCandidatePool({
    decisions,
    cursor: null,
    limit: 1000,
    now,
  });
  const toViews = (rows) =>
    rows
      .map((decision) => {
        const card = cards.get(decision.cardRevisionId);
        if (!card) {
          return null;
        }
        return cardView(card, decision, projected.events, cards, index);
      })
      .filter(Boolean);
  const mustReview = toViews(mustPage.items);
  const urgent = toViews(urgentPage.items);
  const candidatePool = toViews(poolPage.items);
  let selected = null;
  if (cardId) {
    selected =
      urgent.find((row) => row.cardRevisionId === cardId) ||
      mustReview.find((row) => row.cardRevisionId === cardId) ||
      candidatePool.find((row) => row.cardRevisionId === cardId) ||
      null;
  }
  const clues = projected.events.filter((row) => row.schema === "human-clue-v1");
  const latestClue = clues.length ? clues[clues.length - 1] : null;
  const latestMissReport = latestClue
    ? projected.events.find(
        (row) =>
          row.schema === "miss-report-v1" && row.humanClueId === latestClue.id,
      )
    : null;
  const latestMissCard = latestClue
    ? projected.events.find(
        (row) =>
          row.schema === "variable-card-revision-v1" &&
          row.origin === "HUMAN_MISS" &&
          row.opportunityId === latestClue.opportunityId,
      )
    : null;
  const latestMiss = latestClue
    ? {
        humanClueId: latestClue.id,
        intakeResolution: latestClue.intakeResolution,
        submittedKind: latestClue.submittedClue ? latestClue.submittedClue.kind : null,
        missReportId: latestMissReport ? latestMissReport.id : null,
        rootCause: latestMissReport ? latestMissReport.rootCause : null,
        cardRevisionId: latestMissCard ? latestMissCard.id : null,
        origin: latestMissCard ? latestMissCard.origin : null,
        opportunityId: latestClue.opportunityId,
      }
    : null;
  if (mode === "blind") {
    const blind = projectBlindTasks(projected.events, { taskId, now });
    const blindView = {
      asOfWatermark: watermark,
      outcomeVisibility: "HIDDEN",
      surface: "inbox",
      dataMode: "blind",
      health: {
        state: empty.state,
        message: empty.message,
        runHealth: scanReceipt ? scanReceipt.runHealth : null,
        contentOutcome: scanReceipt ? scanReceipt.contentOutcome : null,
        coverageStatus: scanReceipt ? scanReceipt.coverageStatus : null,
        counts: scanReceipt ? scanReceipt.counts : null,
        failures: scanReceipt ? scanReceipt.sourceFailures || [] : [],
        completedAt: scanReceipt ? scanReceipt.completedAt : null,
      },
      blindTasks: blind.tasks,
      selected: blind.selected,
    };
    assertClean(blindView);
    if (JSON.stringify(blindView).includes("latestMiss") || JSON.stringify(blindView).includes("HUMAN_MISS")) {
      fail("VIEW_POLLUTED", "miss identity leaked into blind view");
    }
    return blindView;
  }
  const view = {
    asOfWatermark: watermark,
    outcomeVisibility: "HIDDEN",
    surface: "inbox",
    latestMiss,
    health: {
      state: empty.state,
      message: empty.message,
      runHealth: scanReceipt ? scanReceipt.runHealth : null,
      contentOutcome: scanReceipt ? scanReceipt.contentOutcome : null,
      coverageStatus: scanReceipt ? scanReceipt.coverageStatus : null,
      counts: scanReceipt ? scanReceipt.counts : null,
      failures: scanReceipt ? scanReceipt.sourceFailures || [] : [],
      completedAt: scanReceipt ? scanReceipt.completedAt : null,
    },
    urgent,
    mustReview,
    candidatePool,
    selected,
  };
  assertClean(view);
  return view;
}
