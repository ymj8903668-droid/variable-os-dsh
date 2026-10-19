// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { computeLedgerWatermark } from "../http/query.mjs";
import { QueryError } from "../http/errors.mjs";
import { loadRevealedSnapshotNodes } from "../research/query.mjs";
import { openFreshProjectionDb } from "../research/projection.mjs";
import { resolvePresentationDecision, uniqueChainHead } from "./heads.mjs";

const FORBIDDEN =
  /fermentationResult|mappingEvaluation|marketObservation|returnPct|firstReactionAt|下单|持仓|买卖|仓位|自动交易/;

function fail(code, message, details) {
  throw new QueryError(code, message, details);
}

function hasReveal(events, cardRevisionId, actorId) {
  return events.some(
    (row) =>
      row.schema === "delivery-interaction-v1" &&
      row.eventType === "OUTCOME_EXPOSED" &&
      row.cardRevisionId === cardRevisionId &&
      row.actorId === actorId,
  );
}

function uniqueEvalHead(rows, keyFn) {
  try {
    return uniqueChainHead(rows.filter(keyFn));
  } catch (err) {
    if (err && err.code === "HEAD_AMBIGUOUS") {
      fail("HEAD_AMBIGUOUS", "multiple current evaluation heads");
    }
    throw err;
  }
}

async function loadFrozenMarket({ researchRoot, store, now }) {
  if (!researchRoot) {
    return null;
  }
  try {
    const opened = await openFreshProjectionDb({
      derivedRoot: researchRoot,
      store,
      now,
    });
    try {
      return frozenMarketFromProjection(opened);
    } finally {
      opened.db.close();
    }
  } catch (err) {
    if (err && err.code === "PROJECTION_STALE") {
      return null;
    }
    throw err;
  }
}

/** Same frozen market fields as the original DSH query, from one read handle. */
export function frozenMarketFromProjection(opened) {
      const rows = opened.db
        .prepare(
          `SELECT security_code, session_date, status, reason_code, close_px
           FROM market_observations
           ORDER BY session_date ASC, security_code ASC`,
        )
        .all();
      const complete = rows.filter((row) => row.status === "COMPLETE").length;
      const unknown = rows.filter((row) => row.status !== "COMPLETE").length;
      return {
        cutoff: opened.meta.marketCutoff ?? null,
        status: opened.meta.marketStatus ?? null,
        reasonCode: opened.meta.marketReasonCode ?? null,
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

export async function queryFeedback({
  store,
  asOfWatermark,
  cardId,
  presentationDecisionId,
  now,
  actorId = "human:primary-reviewer",
  researchRoot = null,
}) {
  if (asOfWatermark === undefined || asOfWatermark === null || asOfWatermark === "") {
    fail("WATERMARK_REQUIRED", "asOfWatermark is required");
  }
  const runtime = new CommandRuntime({ store, now: () => now });
  const projected = await runtime.project();
  const watermark = computeLedgerWatermark(projected);
  if (asOfWatermark !== "latest" && asOfWatermark !== watermark) {
    fail("WATERMARK_MISMATCH", "asOfWatermark does not match frozen ledger");
  }
  const card = cardId
    ? projected.events.find(
        (row) =>
          row.schema === "variable-card-revision-v1" && row.id === cardId,
      )
    : projected.events.filter((row) => row.schema === "variable-card-revision-v1").at(-1);
  if (!card) {
    fail("NOT_FOUND", "card not found");
  }
  let decision;
  try {
    decision = resolvePresentationDecision(
      projected.events,
      card.id,
      presentationDecisionId,
    );
  } catch (err) {
    if (
      err &&
      (err.code === "PRESENTATION_DECISION_REQUIRED" ||
        err.code === "INVALID_PRESENTATION" ||
        err.code === "HEAD_AMBIGUOUS")
    ) {
      fail(err.code, err.message);
    }
    throw err;
  }
  const revealed = hasReveal(projected.events, card.id, actorId);
  if (!revealed) {
    const hidden = {
      asOfWatermark: watermark,
      outcomeVisibility: "HIDDEN",
      surface: "feedback",
      message: "待盲标/结果隐藏",
      cardRevisionId: card.id,
      presentationDecisionId: decision ? decision.id : null,
      exposed: false,
    };
    if (
      FORBIDDEN.test(JSON.stringify(hidden)) ||
      Object.prototype.hasOwnProperty.call(hidden, "fermentation") ||
      Object.prototype.hasOwnProperty.call(hidden, "mapping")
    ) {
      fail("VIEW_POLLUTED", "outcome fields leaked into hidden feedback");
    }
    return hidden;
  }
  const themes = projected.events.filter(
    (row) =>
      row.schema === "theme-hypothesis-v1" && row.cardRevisionId === card.id,
  );
  const mappings = projected.events.filter(
    (row) =>
      row.schema === "security-mapping-v1" && row.cardRevisionId === card.id,
  );
  const jobs = projected.events.filter(
    (row) => row.schema === "feedback-job-v1" && row.cardRevisionId === card.id,
  );
  const fermentation = [];
  for (const theme of themes) {
    for (const job of jobs) {
      const head = uniqueEvalHead(
        projected.events.filter((row) => row.schema === "fermentation-evaluation-v1"),
        (row) =>
          row.themeHypothesisId === theme.id && row.feedbackJobId === job.id,
      );
      if (!head) {
        continue;
      }
      fermentation.push({
        themeRef: theme.themeRef,
        horizon: job.horizon,
        result: head.result,
        reason: head.reason,
        reviewDisposition: head.reviewDisposition,
      });
    }
  }
  const mapping = [];
  for (const sec of mappings) {
    for (const job of jobs) {
      const head = uniqueEvalHead(
        projected.events.filter((row) => row.schema === "mapping-evaluation-v1"),
        (row) =>
          row.securityMappingId === sec.id && row.feedbackJobId === job.id,
      );
      if (!head) {
        continue;
      }
      mapping.push({
        securityCode: sec.securityCode,
        horizon: job.horizon,
        result: head.result,
        reason: head.reason,
        reviewDisposition: head.reviewDisposition,
        directCounterevidenceRefs: head.directCounterevidenceRefs || [],
      });
    }
  }
  let snapshotNodes = null;
  if (researchRoot) {
    try {
      snapshotNodes = await loadRevealedSnapshotNodes({
        derivedRoot: researchRoot,
        store,
        cardId: card.id,
        now,
      });
    } catch (err) {
      if (!err || err.code !== "PROJECTION_STALE") {
        throw err;
      }
      snapshotNodes = [];
    }
  }
  const frozenMarket = await loadFrozenMarket({
    researchRoot,
    store,
    now,
  });
  const view = {
    asOfWatermark: watermark,
    outcomeVisibility: "REVEALED",
    surface: "feedback",
    message: "已曝光",
    cardRevisionId: card.id,
    presentationDecisionId: decision ? decision.id : null,
    exposed: true,
    fermentation,
    mapping,
    ...(snapshotNodes ? { snapshotNodes } : {}),
    ...(frozenMarket ? { frozenMarket } : {}),
  };
  const blob = JSON.stringify(view);
  if (/下单|持仓|买卖|仓位|自动交易/.test(blob)) {
    fail("VIEW_POLLUTED", "trading copy leaked");
  }
  return view;
}
