// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { QueryError } from "../http/errors.mjs";
import { projectCardLabelState } from "../label/projection.mjs";
import { basketForCase, RESEARCH_CASES } from "./cases.mjs";
import { curateCaseHighlights } from "./llm-curate.mjs";
import {
  openFreshProjectionDb,
  readProjectionMeta,
} from "./projection.mjs";
import { cardsBoundToCase, hasCommittedOutcomeExposure } from "./timeline.mjs";
import { expandEvidenceQuote } from "./evidence-expansion.mjs";
import { uniqueChainHead } from "../feedback/heads.mjs";
import {
  normalizeCatalystTheme,
  sameCatalystMainline,
} from "../card/catalyst-identity.mjs";

const EVIDENCE_ID = /^evid_[0-9a-f]{64}$/;
const CARD_EVIDENCE_ID = /^ev_[0-9a-f]{64}$/;

function failQuery(code, message, details) {
  throw new QueryError(code, message, details);
}

function shanghaiSessionDate(value) {
  if (typeof value !== "string" || value.length < 10) {
    return null;
  }
  return value.slice(0, 10);
}

function securityNameOf(caseId, securityCode) {
  const basket = basketForCase(caseId);
  if (!basket) {
    return null;
  }
  const hit = basket.securities.find((row) => row.code === securityCode);
  return hit ? hit.name : null;
}

function latestQuoteFromDb(db, securityCode, { asOfSession = null } = {}) {
  if (!db || typeof securityCode !== "string" || !securityCode) {
    return null;
  }
  const row =
    asOfSession == null
      ? db
          .prepare(
            `SELECT session_date, status, reason_code, close_px
             FROM market_observations
             WHERE security_code = ?
             ORDER BY session_date DESC
             LIMIT 1`,
          )
          .get(securityCode)
      : db
          .prepare(
            `SELECT session_date, status, reason_code, close_px
             FROM market_observations
             WHERE security_code = ?
               AND session_date <= ?
             ORDER BY session_date DESC
             LIMIT 1`,
          )
          .get(securityCode, asOfSession);
  if (!row) {
    return null;
  }
  return {
    sessionDate: row.session_date,
    status: row.status,
    reasonCode: row.reason_code,
    close: row.status === "COMPLETE" ? row.close_px : null,
  };
}

function enrichMappingRow(row, { caseId, db, expose }) {
  const caseDef = RESEARCH_CASES.find((item) => item.caseId === caseId);
  const asOfSession = expose
    ? null
    : shanghaiSessionDate(caseDef?.evaluationAnchorAt);
  const quote = latestQuoteFromDb(db, row.securityCode, { asOfSession });
  return {
    ...row,
    securityName: securityNameOf(caseId, row.securityCode),
    quote: quote
      ? {
          sessionDate: quote.sessionDate,
          status: quote.status,
          reasonCode: quote.reasonCode,
          close: quote.close,
          asOfPolicy: expose ? "SNAPSHOT_LATEST" : "ANCHOR_OR_BEFORE",
        }
      : {
          sessionDate: null,
          status: "UNKNOWN",
          reasonCode: "BAR_MISSING",
          close: null,
          asOfPolicy: expose ? "SNAPSHOT_LATEST" : "ANCHOR_OR_BEFORE",
        },
  };
}

function nodeFromRow(row) {
  return {
    id: row.id,
    caseId: row.case_id,
    nodeType: row.node_type,
    title: row.title,
    summary: row.summary,
    eventAt: row.event_at,
    availableAt: row.available_at,
    recordedAt: row.recorded_at,
    timePrecision: row.time_precision,
    evidenceLevel: row.evidence_level,
    sourceType: row.source_type,
    sourceChannel: row.source_channel ?? null,
    resultVisibility: row.result_visibility,
    evidenceIds: JSON.parse(row.evidence_ids_json),
    horizon: row.horizon,
    state: row.state,
  };
}

function requireWatermark(asOfWatermark) {
  if (
    asOfWatermark === undefined ||
    asOfWatermark === null ||
    asOfWatermark === ""
  ) {
    failQuery("WATERMARK_REQUIRED", "asOfWatermark is required");
  }
}

async function openForQuery({ derivedRoot, store, now, asOfWatermark, snapshot, live }) {
  const opened = await openFreshProjectionDb({ derivedRoot, store, now, live });
  if (
    asOfWatermark !== undefined &&
    asOfWatermark !== "latest" &&
    asOfWatermark !== opened.live.watermark
  ) {
    opened.db.close();
    failQuery("WATERMARK_MISMATCH", "asOfWatermark does not match frozen ledger");
  }
  if (snapshot && snapshot !== opened.meta.snapshotId) {
    opened.db.close();
    failQuery("NOT_FOUND", "snapshot is not the active research snapshot", {
      snapshot,
    });
  }
  return opened;
}

function resolveCaseRow(db, card, projected) {
  const rows = db.prepare("SELECT * FROM cases ORDER BY case_id").all();
  const byId = rows.find((row) => row.case_id === card);
  if (byId) {
    return byId;
  }
  const byTitle = rows.find((row) => row.title === card);
  if (byTitle) {
    return byTitle;
  }
  const events = projected?.events || [];
  for (const caseDef of RESEARCH_CASES) {
    const bound = cardsBoundToCase(events, caseDef);
    if (bound.some((row) => row.id === card)) {
      return rows.find((row) => row.case_id === caseDef.caseId) || null;
    }
  }
  return null;
}

function loadNodes(db, caseId) {
  return db
    .prepare(
      "SELECT * FROM timeline_nodes WHERE case_id = ? ORDER BY ordinal ASC",
    )
    .all(caseId)
    .map(nodeFromRow);
}

/**
 * Before committed reveal, keep future T+/close checkpoints as schedule shells.
 * Never leak OUTCOME resultVisibility, bars, or frozen market payloads.
 */
export function toScheduleShell(node) {
  const pending = node.state === "PENDING";
  return {
    id: node.id,
    caseId: node.caseId,
    nodeType: node.nodeType,
    title: node.title,
    summary: pending
      ? "检查点尚未到期；揭晓前不展示行情结果"
      : "检查点已排期；揭晓后才展开冻结行情与发酵结果",
    eventAt: node.eventAt,
    availableAt: node.availableAt,
    recordedAt: node.recordedAt,
    timePrecision: node.timePrecision,
    evidenceLevel: "UNSTATED",
    sourceType: node.sourceType,
    resultVisibility: "SCHEDULED",
    evidenceIds: [],
    horizon: node.horizon,
    state: pending ? "PENDING" : "SCHEDULED",
  };
}

export function projectCasefileNodes(nodes, { expose }) {
  const rows = Array.isArray(nodes) ? nodes : [];
  if (expose) {
    return rows;
  }
  const process = rows.filter((node) => node.resultVisibility !== "OUTCOME");
  const shells = rows
    .filter(
      (node) =>
        node.resultVisibility === "OUTCOME" &&
        (node.nodeType === "T_CHECKPOINT" || node.nodeType === "MARKET_CLOSE"),
    )
    .map(toScheduleShell);
  return [...process, ...shells].sort((left, right) => {
    if (left.eventAt !== right.eventAt) {
      return left.eventAt < right.eventAt ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function loadEvidence(db, ids) {
  if (!ids.length) {
    return [];
  }
  const stmt = db.prepare(
    "SELECT id, source_path, sha256, line_number, access_level, summary FROM evidence WHERE id = ?",
  );
  const rows = [];
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) {
      rows.push({
        id: row.id,
        sourcePath: row.source_path,
        sha256: row.sha256,
        lineNumber: row.line_number,
        accessLevel: row.access_level,
        summary: row.summary,
      });
    }
  }
  return rows;
}

function liveSourceNodeType(source) {
  const namespace = String(source?.sourceNamespace || "");
  if (namespace.includes("liudu")) {
    return { nodeType: "EXPERT_MEETING", sourceChannel: "LIUDU" };
  }
  if (namespace.includes("gangtise")) {
    return { nodeType: "GANGTISE_CLUE", sourceChannel: "GANGTISE" };
  }
  if (namespace.includes("wechat")) {
    return { nodeType: "WECHAT_DIGEST", sourceChannel: "WECHAT" };
  }
  return { nodeType: "SOURCE_EVENT", sourceChannel: "LOCAL" };
}

function horizonLabel(value) {
  const match = /^T(1|3|5)$/.exec(String(value || ""));
  return match ? `T+${match[1]}` : String(value || "");
}

function liveCatalystIdentity(rows, card) {
  const frozen = normalizeCatalystTheme(card?.catalystIdentityKey);
  if (frozen) return frozen;
  const themeIds = new Set(Array.isArray(card?.themeHypothesisIds)
    ? card.themeHypothesisIds
    : []);
  const refs = [...new Set(
    rows
      .filter(
        (row) =>
          row?.schema === "theme-hypothesis-v1" &&
          (row.cardRevisionId === card?.id || themeIds.has(row.id)),
      )
      .map((row) => normalizeCatalystTheme(row.themeRef))
      .filter(Boolean),
  )].sort();
  return refs.length ? refs.join(" | ") : null;
}

function liveRevisionChain(rows, card) {
  const cards = new Map(
    rows
      .filter((row) => row?.schema === "variable-card-revision-v1")
      .map((row) => [row.id, row]),
  );
  const strictChain = [];
  const visited = new Set();
  let cursor = card;
  while (
    cursor &&
    cursor.variableId === card.variableId &&
    !visited.has(cursor.id)
  ) {
    strictChain.push(cursor);
    visited.add(cursor.id);
    cursor = cursor.previousCardRevisionId
      ? cards.get(cursor.previousCardRevisionId)
      : null;
  }
  strictChain.reverse();

  const catalystIdentityKey = liveCatalystIdentity(rows, card);
  if (catalystIdentityKey) {
    const currentIdentity = {
      ...card,
      catalystIdentityKey,
    };
    const semanticCards = [...cards.values()].filter(
        (candidate) =>
          candidate.origin === "AI_DISCOVERED" &&
          sameCatalystMainline(currentIdentity, {
            ...candidate,
            catalystIdentityKey: liveCatalystIdentity(rows, candidate),
          }),
      );
    const mainline = [...new Map(
      [...strictChain, ...semanticCards].map((candidate) => [candidate.id, candidate]),
    ).values()]
      .sort((left, right) => {
        const time = String(left.systemDecisionAt || left.recordedAt || "").localeCompare(
          String(right.systemDecisionAt || right.recordedAt || ""),
        );
        return time || String(left.id).localeCompare(String(right.id));
      });
    const currentIndex = mainline.findIndex((candidate) => candidate.id === card.id);
    if (currentIndex >= 0) {
      return mainline.slice(0, currentIndex + 1).map((candidate, index) => ({
        ...candidate,
        revision: index + 1,
      }));
    }
  }
  return strictChain;
}

function liveEvidenceRows(rows, sources, revisionCard) {
  return rows
    .filter(
      (row) =>
        row?.schema === "card-evidence-v1" &&
        row.cardRevisionId === revisionCard.id,
    )
    .map((row) => {
      const source = sources.find((item) => item.id === row.target?.id);
      return {
        source,
        evidence: {
          id: row.id,
          cardRevisionId: revisionCard.id,
          revision: Number(revisionCard.revision || 1),
          role: row.role || null,
          sourceRef: row.retrievalRef || null,
          sourceType: row.retrievalSourceType || source?.sourceKind || null,
          sourcePath: row.sourcePath || source?.rawUri || "本地冻结资料",
          sha256: row.contentHash || source?.contentHash || null,
          lineNumber: source?.quoteSpan?.start || null,
          accessLevel: source?.sensitivity || "RESTRICTED",
          summary: row.quote || source?.excerpt || revisionCard.eventSummary,
        },
      };
    });
}

function liveRevisionNode(revisionCard, evidenceRows, currentCard) {
  const primarySource = evidenceRows[0]?.source || null;
  const ima = primarySource?.sourceKind === "ima-wiki-excerpt";
  const sourceShape = liveSourceNodeType(primarySource);
  const sourceAvailableAt =
    primarySource?.availableAt ||
    primarySource?.firstRetrievedAt ||
    revisionCard.systemDecisionAt;
  const sourceEventAt = primarySource?.declaredPublishedAt || sourceAvailableAt;
  const sourceTimePrecision = primarySource?.declaredPublishedAt
    ? /T00:00:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        primarySource.declaredPublishedAt,
      )
      ? "DAY"
      : "SECOND"
    : "SECOND";
  return {
    id: `live:${currentCard.id}:revision:${revisionCard.id}`,
    caseId: `live:${currentCard.id}`,
    cardRevisionId: revisionCard.id,
    revision: Number(revisionCard.revision || 1),
    relationToPrior: revisionCard.relationToPrior || "NEW",
    isCurrent: revisionCard.id === currentCard.id,
    ...sourceShape,
    title: ima ? "IMA 资料观测" : sourceShape.nodeType === "EXPERT_MEETING" ? "专家会议" : "源事件",
    summary: revisionCard.eventSummary,
    eventAt: ima ? null : sourceEventAt,
    availableAt: ima ? null : sourceAvailableAt,
    ...(ima ? { observedAt: primarySource.firstRetrievedAt, versionId: null } : {}),
    recordedAt: revisionCard.systemDecisionAt,
    timePrecision: ima ? "UNKNOWN" : sourceTimePrecision,
    evidenceLevel: ["published-excerpt", "ima-wiki-excerpt"].includes(primarySource?.sourceKind) ? "UNKNOWN" : "PRIMARY",
    sourceType: primarySource?.sourceKind || "local-document",
    resultVisibility: "PROCESS",
    evidenceIds: evidenceRows.map((row) => row.evidence.id),
    horizon: null,
    state: "COMPLETE",
  };
}

function liveOutcomeExposed(rows, cardId, presentationIds) {
  return rows.some(
    (row) =>
      row?.schema === "delivery-interaction-v1" &&
      row.eventType === "OUTCOME_EXPOSED" &&
      row.cardRevisionId === cardId &&
      presentationIds.has(row.presentationDecisionId),
  );
}

function liveEvaluationOutcomes(rows, card, job) {
  const outcomes = [];
  const themes = rows.filter(
    (row) =>
      row?.schema === "theme-hypothesis-v1" &&
      row.cardRevisionId === card.id,
  );
  for (const theme of themes) {
    const head = uniqueChainHead(
      rows.filter(
        (row) =>
          row?.schema === "fermentation-evaluation-v1" &&
          row.feedbackJobId === job.id &&
          row.themeHypothesisId === theme.id,
      ),
    );
    if (head) {
      outcomes.push({
        kind: "THEME",
        target: theme.themeRef,
        result: head.result,
        reason: head.reason,
        reviewDisposition: head.reviewDisposition,
        recordedAt: head.recordedAt || head.createdAt || null,
      });
    }
  }
  const mappings = rows.filter(
    (row) =>
      row?.schema === "security-mapping-v1" &&
      row.cardRevisionId === card.id,
  );
  for (const mapping of mappings) {
    const head = uniqueChainHead(
      rows.filter(
        (row) =>
          row?.schema === "mapping-evaluation-v1" &&
          row.feedbackJobId === job.id &&
          row.securityMappingId === mapping.id,
      ),
    );
    if (head) {
      outcomes.push({
        kind: "SECURITY",
        target: mapping.securityCode,
        result: head.result,
        reason: head.reason,
        reviewDisposition: head.reviewDisposition,
        directCounterevidenceRefs: head.directCounterevidenceRefs || [],
        recordedAt: head.recordedAt || head.createdAt || null,
      });
    }
  }
  return outcomes;
}

export function buildLiveCasefile({
  events,
  sourceItems,
  cardId,
  watermark,
  snapshotId,
}) {
  const rows = Array.isArray(events) ? events : [];
  const sources = Array.isArray(sourceItems) ? sourceItems : [];
  const card = rows.find(
    (row) => row?.schema === "variable-card-revision-v1" && row.id === cardId,
  );
  if (!card || card.origin !== "AI_DISCOVERED") return null;
  const variable = rows.find(
    (row) => row?.schema === "variable-v1" && row.id === card.variableId,
  );
  const presentations = rows.filter(
    (row) => row?.schema === "presentation-decision-v1" && row.cardRevisionId === card.id,
  );
  const presentation = presentations.at(-1) || null;
  const outcomeExposed = liveOutcomeExposed(
    rows,
    card.id,
    new Set(presentations.map((row) => row.id)),
  );
  const state = projectCardLabelState(rows, card);
  const revisionRows = liveRevisionChain(rows, card).map((revisionCard) => ({
    card: revisionCard,
    evidenceRows: liveEvidenceRows(rows, sources, revisionCard),
  }));
  const evidence = revisionRows.flatMap((row) =>
    row.evidenceRows.map((item) => item.evidence),
  );
  const nodes = [
    ...revisionRows.map((row) =>
      liveRevisionNode(row.card, row.evidenceRows, card),
    ),
    {
      id: `live:${card.id}:close`,
      caseId: `live:${card.id}`,
      nodeType: "MARKET_CLOSE",
      title: "收盘观察",
      summary: "检查点已排期；揭晓后才展开冻结行情与发酵结果",
      eventAt: `${String(card.systemDecisionAt).slice(0, 10)}T15:00:00+08:00`,
      availableAt: card.systemDecisionAt,
      recordedAt: card.systemDecisionAt,
      timePrecision: "SESSION",
      evidenceLevel: "UNSTATED",
      sourceType: "daily_bar",
      sourceChannel: null,
      resultVisibility: "SCHEDULED",
      evidenceIds: [],
      horizon: null,
      state: "SCHEDULED",
    },
  ];
  const feedbackJobs = rows
    .filter((row) => row?.schema === "feedback-job-v1" && row.cardRevisionId === card.id)
    .sort((left, right) => String(left.horizon).localeCompare(String(right.horizon)));
  for (const job of feedbackJobs) {
    const horizon = horizonLabel(job.horizon);
    const scheduledAt = job.scheduledSession
      ? `${job.scheduledSession}T15:00:00+08:00`
      : card.systemDecisionAt;
    const rawOutcomes = outcomeExposed
      ? liveEvaluationOutcomes(rows, card, job)
      : [];
    const completed = rawOutcomes.length > 0;
    const recordedAt = rawOutcomes
      .map((row) => row.recordedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || card.systemDecisionAt;
    const outcomes = rawOutcomes.map(({ recordedAt: _recordedAt, ...row }) => row);
    nodes.push({
      id: `live:${card.id}:${String(job.horizon).toLowerCase()}`,
      caseId: `live:${card.id}`,
      nodeType: "T_CHECKPOINT",
      title: horizon,
      summary: completed
        ? "真实反馈评估已完成；结果需结合冻结依据人工复核"
        : "检查点尚未到期；揭晓前不展示行情结果",
      eventAt: scheduledAt,
      availableAt: completed ? recordedAt : scheduledAt,
      recordedAt,
      timePrecision: "SESSION",
      evidenceLevel: "UNSTATED",
      sourceType: "daily_bar",
      sourceChannel: null,
      resultVisibility: completed ? "OUTCOME" : "SCHEDULED",
      evidenceIds: [],
      horizon,
      state: completed ? "COMPLETE" : "PENDING",
      ...(completed ? { outcomes } : {}),
    });
  }
  const rawMappings = new Map(
    rows
      .filter((row) => row?.schema === "security-mapping-v1" && row.cardRevisionId === card.id)
      .map((row) => [row.id, row]),
  );
  const mappings = state.securities.map((mapping) => {
    const raw = rawMappings.get(mapping.id);
    return {
      ...mapping,
      targetType: "SECURITY",
      securityName: raw?.securityName || mapping.securityCode,
      quote: {
        sessionDate: null,
        status: "UNKNOWN",
        reasonCode: "BAR_MISSING",
        close: null,
        asOfPolicy: "ANCHOR_OR_BEFORE",
      },
    };
  });
  const title = card.variableTitle || variable?.canonicalTitle || card.eventSummary;
  return {
    asOfWatermark: watermark,
    snapshotId,
    outcomeVisibility: outcomeExposed ? "REVEALED" : "HIDDEN",
    cardRevisionId: card.id,
    presentationDecisionId: presentation?.id || null,
    case: {
      caseId: `live:${card.id}`,
      title,
      kind: "LIVE",
      mappingReview: state.mappingReview,
      mappings,
      watch: state.currentWatchTask,
      nodes,
    },
    evidence,
    derivedCuration: {
      headline: title,
      bullets: [card.eventSummary, card.variableThesis, card.whyTradable].filter(Boolean),
      caution: Array.isArray(card.uncertainties)
        ? card.uncertainties.join("；")
        : "仍需人工复核。",
      provider: "frozen-card",
    },
  };
}

export async function querySnapshots({ derivedRoot, store, now, snapshot, live } = {}) {
  const opened = await openForQuery({
    derivedRoot,
    store,
    now,
    snapshot,
    live,
  });
  try {
    const cases = opened.db
      .prepare("SELECT case_id, title, kind FROM cases ORDER BY case_id")
      .all();
    return {
      activeSnapshotId: opened.meta.snapshotId,
      ledgerWatermark: opened.live.watermark,
      projectionDigest: opened.meta.projectionDigest,
      market: {
        cutoff: opened.meta.marketCutoff ?? null,
        status: opened.meta.marketStatus ?? null,
        reasonCode: opened.meta.marketReasonCode ?? null,
      },
      snapshots: [
        {
          id: opened.meta.snapshotId,
          status: opened.meta.buildStatus,
          builderVersion: opened.meta.snapshotBuilderVersion || opened.meta.builderVersion,
          createdAt: opened.meta.snapshotCreatedAt || opened.meta.builtAt,
          cases: cases.map((row) => ({
            caseId: row.case_id,
            title: row.title,
            kind: row.kind,
          })),
        },
      ],
    };
  } finally {
    opened.db.close();
  }
}

function loadMappings(db, caseId) {
  return db
    .prepare(
      `SELECT target_id, target_type, review, security_code, card_revision_id
       FROM mapping_review
       WHERE case_id = ?
       ORDER BY security_code ASC, target_id ASC`,
    )
    .all(caseId)
    .map((row) => ({
      id: row.target_id,
      targetType: row.target_type,
      review: row.review,
      securityCode: row.security_code,
      cardRevisionId: row.card_revision_id,
    }));
}

function boundCardAndDecision(events, caseDef) {
  const bound = cardsBoundToCase(events, caseDef);
  const card = bound[0] || null;
  if (!card) {
    return { card: null, decision: null, mappings: [] };
  }
  const decision =
    events.find(
      (row) =>
        row &&
        row.schema === "presentation-decision-v1" &&
        row.cardRevisionId === card.id,
    ) || null;
  const state = projectCardLabelState(events, card);
  return {
    card,
    decision,
    mappings: (state.securities || []).map((row) => ({
      id: row.id,
      securityCode: row.securityCode,
      review: row.review,
      themeHypothesisId: row.themeHypothesisId,
    })),
  };
}

function frozenMarketFromDb(db, meta, { expose }) {
  if (!expose) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT security_code, session_date, status, reason_code, close_px
       FROM market_observations
       ORDER BY session_date ASC, security_code ASC`,
    )
    .all();
  const complete = rows.filter((row) => row.status === "COMPLETE").length;
  const unknown = rows.filter((row) => row.status !== "COMPLETE").length;
  return {
    cutoff: meta.marketCutoff ?? null,
    status: meta.marketStatus ?? null,
    reasonCode: meta.marketReasonCode ?? null,
    note: "Basket closes are individual securities, not a theme index",
    coverage: {
      complete,
      unknown,
      total: rows.length,
    },
    observations: rows.map((row) => ({
      securityCode: row.security_code,
      sessionDate: row.session_date,
      status: row.status,
      reasonCode: row.reason_code,
      close: row.close_px,
    })),
  };
}

export async function queryCasefile({
  derivedRoot,
  store,
  card,
  snapshot,
  asOfWatermark,
  revealed,
  now,
  live,
} = {}) {
  void revealed;
  requireWatermark(asOfWatermark);
  if (typeof card !== "string" || card.length === 0) {
    failQuery("NOT_FOUND", "card is required");
  }
  const opened = await openForQuery({
    derivedRoot,
    store,
    now,
    asOfWatermark,
    snapshot,
    live,
  });
  try {
    const caseRow = resolveCaseRow(opened.db, card, opened.projected);
    if (!caseRow) {
      const live = buildLiveCasefile({
        events: opened.projected.events,
        sourceItems: opened.projected.sourceItems,
        cardId: card,
        watermark: opened.live.watermark,
        snapshotId: opened.meta.snapshotId,
      });
      if (live) return live;
      failQuery("NOT_FOUND", "research case not found");
    }
    const caseDef = RESEARCH_CASES.find((row) => row.caseId === caseRow.case_id);
    const expose =
      caseDef && hasCommittedOutcomeExposure(opened.projected.events, caseDef);
    const bound = caseDef
      ? boundCardAndDecision(opened.projected.events, caseDef)
      : { card: null, decision: null, mappings: [] };
    const mappings =
      bound.mappings.length > 0
        ? bound.mappings
        : loadMappings(opened.db, caseRow.case_id);
    const enrichedMappings = mappings.map((row) =>
      enrichMappingRow(row, {
        caseId: caseRow.case_id,
        db: opened.db,
        expose,
      }),
    );
    const nodes = projectCasefileNodes(loadNodes(opened.db, caseRow.case_id), {
      expose,
    });
    const evidenceIds = [
      ...new Set(
        nodes
          .filter((node) => node.resultVisibility !== "SCHEDULED")
          .flatMap((node) => node.evidenceIds),
      ),
    ];
    const watch = opened.db
      .prepare(
        "SELECT task_id, state, review_due_at, card_revision_id FROM watch_state WHERE case_id = ? LIMIT 1",
      )
      .get(caseRow.case_id);
    const body = {
      asOfWatermark: opened.live.watermark,
      snapshotId: opened.meta.snapshotId,
      outcomeVisibility: expose ? "REVEALED" : "HIDDEN",
      cardRevisionId: bound.card ? bound.card.id : null,
      presentationDecisionId: bound.decision ? bound.decision.id : null,
      case: {
        caseId: caseRow.case_id,
        title: caseRow.title,
        kind: caseRow.kind,
        mappingReview: caseRow.mapping_review,
        mappings: enrichedMappings,
        watch: watch
          ? {
              id: watch.task_id,
              state: watch.state,
              reviewDueAt: watch.review_due_at,
              cardRevisionId: watch.card_revision_id,
            }
          : null,
        nodes,
      },
      evidence: loadEvidence(opened.db, evidenceIds),
    };
    const processSummaries = nodes
      .filter((node) => node.resultVisibility === "PROCESS")
      .map((node) => node.summary)
      .filter(Boolean);
    body.derivedCuration = await curateCaseHighlights({
      caseTitle: caseRow.title,
      processSummaries,
      knownThenNote: expose
        ? "揭晓后仍可回看事前摘要；行情见 frozenMarket。"
        : "仅事前过程材料；未揭晓结果与行情。",
    });
    if (expose) {
      body.frozenMarket = frozenMarketFromDb(opened.db, opened.meta, {
        expose: true,
      });
    }
    return body;
  } finally {
    opened.db.close();
  }
}


export async function queryEvidence({
  derivedRoot,
  store,
  id,
  snapshot,
  now,
  sourceRoots,
  live,
  expandEvidence = expandEvidenceQuote,
} = {}) {
  if (
    typeof id !== "string" ||
    (!EVIDENCE_ID.test(id) && !CARD_EVIDENCE_ID.test(id))
  ) {
    failQuery("EVIDENCE_ID_INVALID", "evidence id is not a registered evidence hash");
  }
  const opened = await openForQuery({
    derivedRoot,
    store,
    now,
    snapshot,
    live,
  });
  try {
    if (CARD_EVIDENCE_ID.test(id)) {
      const evidence = (opened.projected?.events || []).find(
        (row) => row?.schema === "card-evidence-v1" && row.id === id,
      );
      if (!evidence) {
        failQuery("EVIDENCE_NOT_REGISTERED", "card evidence id is not registered");
      }
      const expansion = await expandEvidence({
        sourceRoots,
        sourcePath: evidence.sourcePath,
        frozenQuote: evidence.quote,
      });
      return {
        schema: "evidence-detail-v1",
        id: evidence.id,
        snapshotId: opened.meta.snapshotId,
        sourcePath: evidence.sourcePath,
        sha256: evidence.contentHash || null,
        lineNumber: null,
        accessLevel: "RESTRICTED",
        sourceRef: evidence.retrievalRef || null,
        sourceType: evidence.retrievalSourceType || null,
        summary: evidence.quote,
        fullQuote: expansion.fullQuote,
        expansion: {
          matchKind: expansion.matchKind,
          sourceFileHash: expansion.sourceFileHash,
        },
      };
    }
    const row = opened.db
      .prepare(
        "SELECT id, source_path, sha256, line_number, access_level, summary FROM evidence WHERE id = ?",
      )
      .get(id);
    if (!row) {
      failQuery("EVIDENCE_NOT_REGISTERED", "evidence id is not registered");
    }
    return {
      schema: "evidence-detail-v1",
      id: row.id,
      snapshotId: opened.meta.snapshotId,
      sourcePath: row.source_path,
      sha256: row.sha256,
      lineNumber: row.line_number,
      accessLevel: row.access_level,
      summary: row.summary,
    };
  } finally {
    opened.db.close();
  }
}

export async function loadRevealedSnapshotNodes({
  derivedRoot,
  store,
  cardId,
  now,
}) {
  if (!derivedRoot) {
    return [];
  }
  const opened = await openFreshProjectionDb({ derivedRoot, store, now });
  try {
    return revealedSnapshotNodesFromProjection(opened, cardId);
  } finally {
    opened.db.close();
  }
}

/** Read from the caller-owned, already verified projection connection. */
export function revealedSnapshotNodesFromProjection(opened, cardId) {
    const caseRow = resolveCaseRow(opened.db, cardId, opened.projected);
    if (!caseRow) {
      return [];
    }
    const caseDef = RESEARCH_CASES.find((row) => row.caseId === caseRow.case_id);
    if (!caseDef || !hasCommittedOutcomeExposure(opened.projected.events, caseDef)) {
      return [];
    }
    return loadNodes(opened.db, caseRow.case_id);
}

export { readProjectionMeta };
