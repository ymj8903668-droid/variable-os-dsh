// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHorizonCalendar, resolveAShareHorizons } from "../card/horizon.mjs";
import { projectCardLabelState } from "../label/projection.mjs";
import { brandedId } from "../schema/canonical-json.mjs";
import { RESEARCH_CASES } from "./cases.mjs";

const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DEFAULT_CALENDAR = path.join(
  appRoot,
  "fixtures",
  "calendar",
  "a-share-2026-q3.json",
);

const MAX_NODES = 9;
const MIN_NODES = 5;

function freezeNode(node) {
  return Object.freeze({
    id: node.id,
    caseId: node.caseId,
    nodeType: node.nodeType,
    title: node.title,
    summary: node.summary,
    eventAt: node.eventAt,
    availableAt: node.availableAt,
    recordedAt: node.recordedAt,
    timePrecision: node.timePrecision,
    evidenceLevel: node.evidenceLevel,
    sourceType: node.sourceType,
    sourceChannel: node.sourceChannel ?? null,
    resultVisibility: node.resultVisibility,
    evidenceIds: Object.freeze([...(node.evidenceIds || [])]),
    horizon: node.horizon,
    state: node.state,
  });
}

function fallbackTypeFromPath(sourcePath) {
  if (sourcePath.includes("morning-review")) {
    return { nodeType: "MORNING_HYPOTHESIS", sourceType: "morning_review" };
  }
  if (sourcePath.includes("日复盘")) {
    return { nodeType: "EVENING_VALIDATION", sourceType: "evening_review" };
  }
  if (sourcePath.includes("投研线索") || sourcePath.includes("专家会议")) {
    return { nodeType: "EXPERT_MEETING", sourceType: "expert_meeting" };
  }
  if (sourcePath.startsWith("wiki/")) {
    return { nodeType: "SOURCE_EVENT", sourceType: "wiki" };
  }
  if (sourcePath.includes("judgments.jsonl")) {
    return { nodeType: "SOURCE_EVENT", sourceType: "judgment" };
  }
  if (sourcePath.includes("temporal_edges.jsonl")) {
    return { nodeType: "SOURCE_EVENT", sourceType: "temporal_edge" };
  }
  return { nodeType: "SOURCE_EVENT", sourceType: "fact" };
}

function classifySourceNode(raw, evidence) {
  const sourcePath = evidence?.sourcePath || "";
  const fallback = fallbackTypeFromPath(sourcePath);
  let nodeType = raw.suggestedNodeType || fallback.nodeType;
  let sourceType = raw.sourceKind || raw.sourceType || fallback.sourceType;
  if (
    !raw.suggestedNodeType &&
    /更正|纠正/.test(`${raw.summary || ""} ${evidence?.summary || ""}`)
  ) {
    nodeType = "CORRECTION";
  }
  return {
    nodeType,
    sourceType,
    sourceChannel: raw.sourceChannel || null,
    evidenceLevel: raw.evidenceLevel || "UNSTATED",
    resultVisibility: "PROCESS",
    state: "COMPLETE",
    horizon: null,
  };
}

function titleFor(nodeType, caseDef, horizon) {
  switch (nodeType) {
    case "MORNING_HYPOTHESIS":
      return "晨间假设";
    case "EVENING_VALIDATION":
      return "晚间验证";
    case "EXPERT_MEETING":
      return "专家会议";
    case "CORRECTION":
      return "更正";
    case "MARKET_CLOSE":
      return "收盘观察";
    case "T_CHECKPOINT":
      return `${horizon} 检查点`;
    default:
      return caseDef.title;
  }
}

function compareNodes(left, right) {
  if (left.eventAt !== right.eventAt) {
    return left.eventAt < right.eventAt ? -1 : 1;
  }
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt < right.recordedAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function dueAt(now, scheduledAt) {
  return typeof now === "string" && typeof scheduledAt === "string" && now >= scheduledAt;
}

function completeObservation(market, sessionDate) {
  const rows = Array.isArray(market?.observations) ? market.observations : [];
  return (
    rows.find(
      (row) =>
        row.sessionDate === sessionDate &&
        row.status === "COMPLETE" &&
        row.bar &&
        row.bar.close != null,
    ) || null
  );
}

function checkpointState({ kind, now, scheduledAt, observation }) {
  if (observation) {
    return "COMPLETE";
  }
  if (kind === "LIVE" && !dueAt(now, scheduledAt)) {
    return "PENDING";
  }
  return "UNKNOWN";
}

function processFromEvidence({ caseDef, snapshotCase, evidenceById }) {
  const nodes = [];
  for (const raw of snapshotCase.nodes || []) {
    const evidence = evidenceById.get(raw.evidenceId) || null;
    const classified = classifySourceNode(raw, evidence);
    const payload = {
      caseId: caseDef.caseId,
      nodeType: classified.nodeType,
      evidenceId: raw.evidenceId,
      sourcePath: evidence?.sourcePath || "",
    };
    nodes.push(
      freezeNode({
        id: brandedId("tln_", payload),
        caseId: caseDef.caseId,
        nodeType: classified.nodeType,
        title: titleFor(classified.nodeType, caseDef, null),
        summary: raw.summary || evidence?.summary || caseDef.title,
        eventAt: raw.eventAt,
        availableAt: raw.availableAt,
        recordedAt: raw.recordedAt,
        timePrecision: raw.timePrecision,
        evidenceLevel: classified.evidenceLevel,
        sourceType: classified.sourceType,
        sourceChannel: classified.sourceChannel,
        resultVisibility: classified.resultVisibility,
        evidenceIds: raw.evidenceId ? [raw.evidenceId] : [],
        horizon: classified.horizon,
        state: classified.state,
      }),
    );
  }
  return nodes;
}

function outcomeNodes({ caseDef, now, market, calendar }) {
  const nodes = [];
  let horizons = null;
  try {
    horizons = resolveAShareHorizons({
      evaluationAnchorAt: caseDef.evaluationAnchorAt,
      calendar,
    });
  } catch {
    horizons = null;
  }
  const wallDate = String(caseDef.evaluationAnchorAt || "").slice(0, 10);
  const closeAt = `${wallDate}T15:00:00+08:00`;
  const closeObservation = completeObservation(market, wallDate);
  const closeState = checkpointState({
    kind: caseDef.kind,
    now,
    scheduledAt: closeAt,
    observation: closeObservation,
  });
  nodes.push(
    freezeNode({
      id: brandedId("tln_", {
        caseId: caseDef.caseId,
        nodeType: "MARKET_CLOSE",
        sessionDate: wallDate,
      }),
      caseId: caseDef.caseId,
      nodeType: "MARKET_CLOSE",
      title: titleFor("MARKET_CLOSE", caseDef, null),
      summary:
        closeState === "COMPLETE"
          ? "frozen daily bar recorded at session close"
          : closeState === "PENDING"
            ? "session close is not yet due"
            : "no frozen daily bar; UNKNOWN",
      eventAt: wallDate,
      availableAt: closeAt,
      recordedAt: closeAt,
      timePrecision: "MINUTE",
      evidenceLevel: "MARKET",
      sourceType: "daily_bar",
      resultVisibility: "OUTCOME",
      evidenceIds: [],
      horizon: null,
      state: closeState,
    }),
  );
  const slots = [
    ["T+1", horizons?.horizons?.T1],
    ["T+3", horizons?.horizons?.T3],
    ["T+5", horizons?.horizons?.T5],
  ];
  for (const [horizon, slot] of slots) {
    const sessionDate = slot?.scheduledSession || null;
    const scheduledAt = slot?.scheduledAt || null;
    if (!sessionDate || !scheduledAt) {
      continue;
    }
    const observation = completeObservation(market, sessionDate);
    const state = checkpointState({
      kind: caseDef.kind,
      now,
      scheduledAt,
      observation,
    });
    nodes.push(
      freezeNode({
        id: brandedId("tln_", {
          caseId: caseDef.caseId,
          nodeType: "T_CHECKPOINT",
          horizon,
        }),
        caseId: caseDef.caseId,
        nodeType: "T_CHECKPOINT",
        title: titleFor("T_CHECKPOINT", caseDef, horizon),
        summary:
          state === "COMPLETE"
            ? "frozen daily bar recorded for checkpoint"
            : state === "PENDING"
              ? "checkpoint not yet due"
              : "no frozen daily bar; UNKNOWN",
        eventAt: sessionDate,
        availableAt: scheduledAt,
        recordedAt: scheduledAt,
        timePrecision: "MINUTE",
        evidenceLevel: "MARKET",
        sourceType: "daily_bar",
        resultVisibility: "OUTCOME",
        evidenceIds: [],
        horizon,
        state,
      }),
    );
  }
  return nodes;
}

function boundNodes(nodes) {
  const sorted = [...nodes].sort(compareNodes);
  if (sorted.length <= MAX_NODES) {
    return sorted;
  }
  const outcome = sorted.filter((node) => node.resultVisibility === "OUTCOME");
  const process = sorted.filter((node) => node.resultVisibility !== "OUTCOME");
  const room = Math.max(0, MAX_NODES - outcome.length);
  let keptProcess = process;
  if (process.length > room) {
    const dropRanked = [...process].sort((left, right) => {
      const rank = (node) => (node.nodeType === "SOURCE_EVENT" ? 0 : 1);
      if (rank(left) !== rank(right)) {
        return rank(left) - rank(right);
      }
      return compareNodes(left, right);
    });
    const dropped = new Set(
      dropRanked.slice(0, process.length - room).map((node) => node.id),
    );
    keptProcess = process.filter((node) => !dropped.has(node.id));
  }
  return [...keptProcess, ...outcome].sort(compareNodes).slice(0, MAX_NODES);
}

function caseNeedles(caseDef) {
  return [caseDef.caseId, caseDef.title, ...caseDef.names];
}

export function cardsBoundToCase(events, caseDef) {
  const cards = (events || []).filter(
    (row) => row && row.schema === "variable-card-revision-v1",
  );
  const explicit = cards.filter(
    (row) =>
      typeof row.researchCaseId === "string" &&
      row.researchCaseId === caseDef.caseId,
  );
  if (explicit.length > 0) {
    return explicit;
  }
  const needles = caseNeedles(caseDef);
  return cards.filter((row) => {
    if (typeof row.researchCaseId === "string" && row.researchCaseId.length > 0) {
      return false;
    }
    const blob = `${row.eventSummary || ""} ${row.variableThesis || ""} ${row.whyTradable || ""}`;
    return needles.some((needle) => blob.includes(needle));
  });
}

function reviewAndWatch(events, caseDef) {
  const cards = cardsBoundToCase(events, caseDef);
  if (cards.length === 0) {
    return { mappingReview: "UNREVIEWED", watch: null, mappingRows: [], watchRows: [] };
  }
  const mappingRows = [];
  const watchRows = [];
  let mappingReview = "UNREVIEWED";
  let watch = null;
  for (const card of cards) {
    const state = projectCardLabelState(events, card);
    if (state.mappingReview && state.mappingReview !== "UNREVIEWED") {
      mappingReview = state.mappingReview;
    }
    for (const security of state.securities || []) {
      mappingRows.push({
        caseId: caseDef.caseId,
        cardRevisionId: card.id,
        targetId: security.id,
        targetType: "SECURITY_MAPPING",
        review: security.review,
        securityCode: security.securityCode,
      });
    }
    if (state.currentWatchTask && !watch) {
      watch = {
        taskId: state.currentWatchTask.id,
        state: state.currentWatchTask.state,
        reviewDueAt: state.currentWatchTask.reviewDueAt,
        cardRevisionId: card.id,
      };
      watchRows.push({
        caseId: caseDef.caseId,
        cardRevisionId: card.id,
        taskId: state.currentWatchTask.id,
        state: state.currentWatchTask.state,
        reviewDueAt: state.currentWatchTask.reviewDueAt,
        horizon: null,
      });
    }
  }
  return { mappingReview, watch, mappingRows, watchRows };
}

export function hasCommittedOutcomeExposure(events, caseDef) {
  const cards = cardsBoundToCase(events, caseDef);
  if (cards.length === 0) {
    return false;
  }
  const ids = new Set(cards.map((row) => row.id));
  return (events || []).some(
    (row) =>
      row &&
      row.schema === "delivery-interaction-v1" &&
      row.eventType === "OUTCOME_EXPOSED" &&
      ids.has(row.cardRevisionId),
  );
}

export async function loadResearchCalendar(calendarPath = DEFAULT_CALENDAR) {
  return loadHorizonCalendar(calendarPath);
}

export async function buildCaseTimelines({
  snapshot,
  evidenceRecords,
  now,
  projected = { events: [], sourceItems: [] },
  calendar = null,
}) {
  const snapshotCases = new Map((snapshot.cases || []).map((row) => [row.caseId, row]));
  const cases = RESEARCH_CASES.filter(caseDef => snapshotCases.has(caseDef.caseId));
  // Personal snapshots do not depend on the reference cases' demo calendar.
  if (!cases.length) return [];
  const loadedCalendar = calendar || (await loadResearchCalendar());
  const evidenceById = new Map((evidenceRecords || []).map((row) => [row.id, row]));
  const events = projected.events || [];
  return cases.map((caseDef) => {
    const snapshotCase = snapshotCases.get(caseDef.caseId);
    const process = processFromEvidence({
      caseDef,
      snapshotCase,
      evidenceById,
    });
    const outcomes = outcomeNodes({
      caseDef,
      now,
      market: snapshot.market || {},
      calendar: loadedCalendar,
    });
    let nodes = boundNodes([...process, ...outcomes]);
    if (nodes.length > MAX_NODES) {
      nodes = nodes.slice(-MAX_NODES);
    }
    if (nodes.length < MIN_NODES && process.length + outcomes.length >= MIN_NODES) {
      nodes = boundNodes([...process, ...outcomes]);
    }
    const label = reviewAndWatch(events, caseDef);
    return Object.freeze({
      caseId: caseDef.caseId,
      title: caseDef.title,
      kind: caseDef.kind,
      mappingReview: label.mappingReview,
      watch: label.watch,
      mappingRows: label.mappingRows,
      watchRows: label.watchRows,
      nodes: Object.freeze(nodes),
    });
  });
}
