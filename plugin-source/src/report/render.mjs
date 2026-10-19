// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { uniqueChainHead } from "../feedback/heads.mjs";
import { fail } from "./errors.mjs";
import { expandSnapshotWatermark, findSnapshot } from "./build.mjs";
import { assertSameSnapshot, northStarRates } from "./rates.mjs";

const FORBIDDEN = /下单|持仓|买卖|仓位|自动交易|交易建议/;

const VIEW_KEYS = new Set([
  "date",
  "snapshotId",
  "computationStatus",
  "notComputableReasonCodes",
  "northStar",
  "scanHealth",
  "aiDiscoveryCards",
  "humanLabels",
  "misses",
  "fermentation",
  "mapping",
  "topK",
  "latency",
  "limitations",
]);

function latestScan(events) {
  const runs = events.filter((row) => row.schema === "scan-run-v1");
  const receipts = events.filter((row) => row.schema === "scan-receipt-v1");
  const scanRun = runs.length ? runs[runs.length - 1] : null;
  const scanReceipt = scanRun
    ? receipts.find((row) => row.scanRunId === scanRun.id) || null
    : null;
  return { scanRun, scanReceipt };
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function rate(numerator, denominator, extraReasons = []) {
  if (denominator === 0) {
    return {
      status: "NOT_COMPUTABLE",
      reasonCodes: extraReasons.length ? extraReasons : ["NO_QUALIFIED_DENOMINATOR"],
      numerator: null,
      denominator: null,
      rate: null,
    };
  }
  return {
    status: "COMPUTABLE",
    reasonCodes: [],
    numerator,
    denominator,
    rate: numerator / denominator,
  };
}

export function isCleanPreDecision(row) {
  return (
    !row ||
    !row.outcomeExposureStatus ||
    row.outcomeExposureStatus === "NOT_EXPOSED_IN_PRODUCT"
  );
}

export function cleanHumanMetrics(events) {
  const labels = (events || []).filter((row) => row.schema === "human-label-v1");
  const cleanLabels = labels.filter(isCleanPreDecision);
  const reviews = (events || []).filter((row) => row.schema === "mapping-review-v1");
  const cleanReviews = reviews.filter(isCleanPreDecision);
  return {
    labels,
    cleanLabels,
    reviews,
    cleanReviews,
    cleanLabeled: new Set(cleanLabels.map((row) => row.cardRevisionId)).size,
    cleanTradable: cleanLabels.filter((row) => row.label === "TRADABLE").length,
    cleanApprovalNumerator: cleanReviews.filter((row) => row.review === "APPROVED")
      .length,
    cleanApprovalDenominator: cleanReviews.length,
  };
}

export function projectReport({ snapshot, events, sourceItems = [] }) {
  if (!snapshot || snapshot.schema !== "metric-cohort-snapshot-v1") {
    fail("NOT_FOUND", "committed cohort snapshot required");
  }
  const expanded = expandSnapshotWatermark(
    { events, sourceItems },
    snapshot,
  );
  if (!expanded.ok) {
    fail("NOT_COMPUTABLE", expanded.reason || "watermark is not expandable");
  }
  events = expanded.events;
  const north = northStarRates(snapshot);
  assertSameSnapshot(
    { id: north.A.snapshotId, membersHash: north.A.membersHash },
    { id: north.B.snapshotId, membersHash: north.B.membersHash },
  );
  const { scanReceipt } = latestScan(events);
  const cards = events.filter((row) => row.schema === "variable-card-revision-v1");
  const aiCards = cards.filter((row) => row.origin === "AI_DISCOVERED");
  const labels = events.filter((row) => row.schema === "human-label-v1");
  const human = cleanHumanMetrics(events);
  const cleanLabels = human.cleanLabels;
  const labeledCards = new Set(cleanLabels.map((row) => row.cardRevisionId));
  const tradable = cleanLabels.filter((row) => row.label === "TRADABLE");
  const mappingReviews = human.reviews;
  const cleanReviews = human.cleanReviews;
  const cleanApproved = cleanReviews.filter((row) => row.review === "APPROVED");
  const misses = events.filter((row) => row.schema === "miss-report-v1");
  const jobs = events.filter((row) => row.schema === "feedback-job-v1");
  const baseJobs = jobs.filter(
    (row) => row.jobKind === "BASE_CARD" && row.metricUse === "BASE_OUTCOME",
  );
  const supplementJobs = jobs.filter(
    (row) =>
      row.jobKind === "THEME_SUPPLEMENT" || row.jobKind === "MAPPING_SUPPLEMENT",
  );
  const fevs = events.filter((row) => row.schema === "fermentation-evaluation-v1");
  const mevs = events.filter((row) => row.schema === "mapping-evaluation-v1");
  function distFor(jobSet) {
    const rows = [];
    const seen = new Set();
    for (const job of jobSet) {
      for (const themeId of job.themeHypothesisIds || []) {
        const key = `${job.horizon}:${themeId}`;
        if (seen.has(key)) {
          continue;
        }
        let head = null;
        try {
          head = uniqueChainHead(
            fevs.filter(
              (row) =>
                row.feedbackJobId === job.id && row.themeHypothesisId === themeId,
            ),
          );
        } catch {
          continue;
        }
        if (!head) {
          continue;
        }
        seen.add(key);
        rows.push(head);
      }
    }
    return countBy(rows, (row) => row.result);
  }
  const mappingHeads = [];
  const mappingSeen = new Set();
  for (const job of baseJobs) {
    for (const mappingId of job.securityMappingIds || []) {
      const key = `${job.horizon}:${mappingId}`;
      if (mappingSeen.has(key)) {
        continue;
      }
      let head = null;
      try {
        head = uniqueChainHead(
          mevs.filter(
            (row) =>
              row.feedbackJobId === job.id && row.securityMappingId === mappingId,
          ),
        );
      } catch {
        continue;
      }
      if (!head) {
        continue;
      }
      mappingSeen.add(key);
      mappingHeads.push(head);
    }
  }
  const decisions = events.filter(
    (row) => row.schema === "presentation-decision-v1",
  );
  const must = decisions.filter((row) => row.budgetBucket !== "URGENT");
  const mustCardIds = new Set(must.map((row) => row.cardRevisionId));
  const mustLabeled = cleanLabels.filter((row) => mustCardIds.has(row.cardRevisionId));
  const mustTradable = mustLabeled.filter((row) => row.label === "TRADABLE");
  const presented = events.filter(
    (row) =>
      row.schema === "delivery-interaction-v1" && row.eventType === "PRESENTED",
  );
  const labelDelays = [];
  for (const label of labels) {
    const show = presented
      .filter((row) => row.cardRevisionId === label.cardRevisionId)
      .map((row) => row.occurredAt || row.recordedAt)
      .sort();
    if (show[0] && label.labeledAt) {
      labelDelays.push({ presentedAt: show[0], labeledAt: label.labeledAt });
    }
  }
  const view = {
    date: String(snapshot.reportWindowStartAt).slice(0, 10),
    snapshotId: snapshot.id,
    computationStatus: snapshot.computationStatus,
    notComputableReasonCodes: snapshot.notComputableReasonCodes || [],
    northStar: {
      snapshotId: snapshot.id,
      membersHash: snapshot.membersHash,
      A: north.A,
      B: north.B,
      sameSnapshot: north.A.snapshotId === north.B.snapshotId,
    },
    scanHealth: scanReceipt
      ? {
          runHealth: scanReceipt.runHealth,
          contentOutcome: scanReceipt.contentOutcome,
          coverageStatus: scanReceipt.coverageStatus,
          expected: scanReceipt.counts ? scanReceipt.counts.expected : null,
          seen: scanReceipt.counts ? scanReceipt.counts.seen : null,
        }
      : { runHealth: null, coverageStatus: "NOT_COMPUTABLE" },
    aiDiscoveryCards: {
      count: aiCards.length,
      origin: "AI_DISCOVERED",
    },
    humanLabels: {
      labeled: labeledCards.size,
      tradable: tradable.length,
      coverage: rate(labeledCards.size, aiCards.length),
      tradablePrecision: rate(tradable.length, labeledCards.size),
    },
    misses: {
      count: misses.length,
      rootCauses: countBy(misses, (row) => row.rootCause || "UNKNOWN"),
    },
    fermentation: {
      baseCard: distFor(baseJobs),
      supplement: distFor(supplementJobs),
    },
    mapping: {
      baseCard: countBy(mappingHeads, (row) => row.result),
      cleanApprovalRate: rate(cleanApproved.length, cleanReviews.length),
    },
    topK: {
      precision: rate(mustTradable.length, mustLabeled.length),
      labelCoverage: rate(mustLabeled.length, mustCardIds.size || 0),
    },
    latency: {
      enqueuedToLabeled: {
        status: "NOT_AVAILABLE",
        reasonCodes: ["ENQUEUED_NOT_AVAILABLE"],
        sampleSize: 0,
      },
      presentedToLabeled: {
        status: labelDelays.length ? "COMPUTABLE" : "NOT_AVAILABLE",
        reasonCodes: labelDelays.length ? [] : ["NO_PRESENTED_LABEL_PAIRS"],
        sampleSize: labelDelays.length,
      },
    },
    limitations: [
      "A/B 共用同一 OBSERVED_TIMELY_DISCOVERY_BASE snapshot",
      "HUMAN_MISS/AUDIT_SAMPLE_MISS 与 SCREENING_ATTEMPT 盲审永不进入 AI 分子",
      "无真实 ENQUEUED 收据时延迟为 NOT_AVAILABLE，不借用 ranking 时间",
      "缺权威抽样收据、invalidated 或 item/task/adjudication 不一致时 snapshot 为 NOT_COMPUTABLE",
      "外部行情认知依赖裁决人 UNAWARE 声明；系统只能证明平台内 outcome exposure",
    ],
  };
  for (const key of Object.keys(view)) {
    if (!VIEW_KEYS.has(key)) {
      fail("VIEW_POLLUTED", `unexpected report field ${key}`);
    }
  }
  const blob = JSON.stringify(view);
  if (FORBIDDEN.test(blob)) {
    fail("VIEW_POLLUTED", "trading copy leaked");
  }
  return view;
}

export function renderMarkdown(view) {
  const rateLine = (label, row) => {
    if (!row || row.status !== "COMPUTABLE") {
      return `- ${label}：NOT_COMPUTABLE`;
    }
    return `- ${label}：${row.numerator}/${row.denominator}`;
  };
  const lines = [
    `# Variable OS 学习报告 ${view.date}`,
    "",
    `- snapshotId：${view.snapshotId}`,
    `- status：${view.computationStatus}`,
    `- A/B 同源：${view.northStar.sameSnapshot ? "是" : "否"}`,
    "",
    "## 扫描健康",
    `- runHealth：${view.scanHealth.runHealth}`,
    `- coverageStatus：${view.scanHealth.coverageStatus}`,
    "",
    "## 发现",
    `- AI 发现卡：${view.aiDiscoveryCards.count}`,
    rateLine("人工可炒", view.humanLabels.tradablePrecision),
    rateLine("标签覆盖", view.humanLabels.coverage),
    "",
    "## 补漏",
    `- 补漏数：${view.misses.count}`,
    `- 根因：${JSON.stringify(view.misses.rootCauses)}`,
    "",
    "## 题材发酵（BASE_CARD）",
    `${JSON.stringify(view.fermentation.baseCard)}`,
    "",
    "## 题材发酵（supplement）",
    `${JSON.stringify(view.fermentation.supplement)}`,
    "",
    "## 映射分布",
    `${JSON.stringify(view.mapping.baseCard)}`,
    rateLine("清洁认可率", view.mapping.cleanApprovalRate),
    "",
    "## Top-K",
    rateLine("清洁 precision", view.topK.precision),
    rateLine("标签覆盖", view.topK.labelCoverage),
    "",
    "## 延迟",
    `- ENQUEUED→LABELED：${view.latency.enqueuedToLabeled.status}`,
    `- PRESENTED→LABELED：${view.latency.presentedToLabeled.status}`,
    "",
    "## 限制",
    ...view.limitations.map((row) => `- ${row}`),
    "",
  ];
  const text = lines.join("\n");
  if (FORBIDDEN.test(text)) {
    fail("VIEW_POLLUTED", "trading copy leaked");
  }
  return text;
}

export async function renderReport({
  store,
  now,
  date,
  reportsRoot,
  snapshotId,
}) {
  const runtime = new CommandRuntime({
    store,
    now: () => now || new Date().toISOString(),
  });
  const projected = await runtime.project();
  const snapshot = findSnapshot(projected.events, snapshotId);
  if (!snapshot) {
    fail("NOT_FOUND", "committed cohort snapshot required");
  }
  const snapshotDate = String(snapshot.reportWindowStartAt).slice(0, 10);
  if (date && date !== snapshotDate) {
    fail("REPORT_DATE_MISMATCH", "report date does not match snapshot window");
  }
  const view = projectReport({
    snapshot,
    events: projected.events,
    sourceItems: projected.sourceItems,
  });
  const day = snapshotDate;
  const root =
    reportsRoot ||
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../.local-demo/reports",
    );
  await fs.mkdir(root, { recursive: true });
  const jsonPath = path.join(root, `${day}.json`);
  const mdPath = path.join(root, `${day}.md`);
  const json = `${JSON.stringify(view)}\n`;
  const md = renderMarkdown(view);
  await fs.writeFile(jsonPath, json);
  await fs.writeFile(mdPath, md);
  return { view, jsonPath, mdPath };
}

export function defaultReportsRoot() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.local-demo/reports",
  );
}
