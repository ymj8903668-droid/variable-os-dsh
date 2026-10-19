// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import {
  normalizeCatalystTheme,
  sameCatalystMainline,
} from "../../../src/card/catalyst-identity.mjs";
import { summarizeResearchHostLatency } from "./research-host-voice-runtime.mjs";

export const DESK_RPC_METHODS = new Set([
  "bootstrap",
  "health",
  "casefile",
  "evidence",
  "feedback",
  "catalystWatchList",
  "catalystWatchDetail",
  "catalystAuditOverview",
  "catalystSourceList",
  "sourceHealth",
  "marketPulse",
  "wechatRawSearch",
  "liveSync",
  "repairProjection",
  "refresh",
  "sourceSync",
  "deepResearchStatus",
  "deepResearch",
  "wikiSourceStatus",
  "wikiSourceConfigure",
  "wikiSourceCredentials",
  "wikiSourceCheck",
  "wikiSourceBrowse",
  "autoJudgment",
  "narration",
  "command",
  "wechatSync",
]);

export const MUTATING_RPC_METHODS = new Set([
  "liveSync",
  "repairProjection",
  "refresh",
  "sourceSync",
  "deepResearch",
  "wikiSourceConfigure",
  "wikiSourceCredentials",
  "wikiSourceCheck",
  "wikiSourceBrowse",
  "autoJudgment",
  "narration",
  "command",
  "wechatSync",
]);

const ACTOR = Object.freeze({ actorType: "HUMAN", actorId: "human:primary-reviewer" });
const LABELS = new Set(["TRADABLE", "WATCH", "NOT_TRADABLE"]);
const MAPPING_REVIEWS = new Set(["APPROVED", "REJECTED", "CORRECTED"]);
const CATALYST_FUNNEL_MODES = new Set(["ALL", "FORMAL", "WATCH", "DISCARDED"]);
const CATALYST_WATCH_FILTERS = new Set([
  "source",
  "archetype",
  "freshness",
  "status",
]);

export function createCatalystWatchUiState() {
  return {
    mode: "FORMAL",
    filters: {
      source: "",
      archetype: "",
      freshness: "",
      status: "OPEN",
    },
    selectedWatchId: null,
    selectedSourceItemId: null,
    expandedReferences: [],
    scrollTop: 0,
    drafts: {},
  };
}

export function catalystWatchUiReducer(
  current = createCatalystWatchUiState(),
  action = {},
) {
  switch (action.type) {
    case "select-funnel":
      if (!CATALYST_FUNNEL_MODES.has(action.mode)) return current;
      return {
        ...current,
        mode: action.mode,
        filters: {
          ...current.filters,
          status:
            action.mode === "WATCH"
              ? (current.filters.status || "OPEN")
              : action.mode === "ALL"
                ? ""
                : current.filters.status,
        },
      };
    case "set-filter":
      return CATALYST_WATCH_FILTERS.has(action.name)
        ? {
            ...current,
            filters: {
              ...current.filters,
              [action.name]: String(action.value || "").slice(0, 120),
            },
          }
        : current;
    case "hydrate-list": {
      const ids = (Array.isArray(action.items) ? action.items : [])
        .map((item) => item?.watchId)
        .filter((id) => typeof id === "string" && id);
      return {
        ...current,
        selectedWatchId: ids.includes(current.selectedWatchId)
          ? current.selectedWatchId
          : ids[0] || null,
      };
    }
    case "hydrate-source-list": {
      const ids = (Array.isArray(action.items) ? action.items : [])
        .map((item) => item?.sourceItemId)
        .filter((id) => typeof id === "string" && id);
      return {
        ...current,
        selectedSourceItemId: ids.includes(current.selectedSourceItemId)
          ? current.selectedSourceItemId
          : ids[0] || null,
      };
    }
    case "select-watch":
      return typeof action.watchId === "string" && action.watchId
        ? { ...current, selectedWatchId: action.watchId }
        : current;
    case "select-source":
      return typeof action.sourceItemId === "string" && action.sourceItemId
        ? { ...current, selectedSourceItemId: action.sourceItemId }
        : current;
    case "toggle-reference": {
      const ref = String(action.ref || "").slice(0, 80);
      if (!ref) return current;
      return {
        ...current,
        expandedReferences: current.expandedReferences.includes(ref)
          ? current.expandedReferences.filter((item) => item !== ref)
          : [...current.expandedReferences, ref],
      };
    }
    case "set-scroll":
      return {
        ...current,
        scrollTop: Number.isFinite(Number(action.scrollTop))
          ? Math.max(0, Math.round(Number(action.scrollTop)))
          : current.scrollTop,
      };
    case "set-draft": {
      const watchId = String(action.watchId || "").slice(0, 100);
      if (!watchId) return current;
      return {
        ...current,
        drafts: {
          ...current.drafts,
          [watchId]: String(action.value || "").slice(0, 500),
        },
      };
    }
    default:
      return current;
  }
}

export function hydrateCatalystWatchUiState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createCatalystWatchUiState();
  }
  let next = createCatalystWatchUiState();
  next = catalystWatchUiReducer(next, {
    type: "select-funnel",
    mode: value.mode,
  });
  for (const name of CATALYST_WATCH_FILTERS) {
    next = catalystWatchUiReducer(next, {
      type: "set-filter",
      name,
      value: value.filters?.[name],
    });
  }
  next = catalystWatchUiReducer(next, {
    type: "select-watch",
    watchId: value.selectedWatchId,
  });
  next = catalystWatchUiReducer(next, {
    type: "select-source",
    sourceItemId: value.selectedSourceItemId,
  });
  for (const ref of (Array.isArray(value.expandedReferences)
    ? value.expandedReferences
    : []).slice(0, 40)) {
    next = catalystWatchUiReducer(next, { type: "toggle-reference", ref });
  }
  next = catalystWatchUiReducer(next, {
    type: "set-scroll",
    scrollTop: value.scrollTop,
  });
  for (const [watchId, draft] of Object.entries(value.drafts || {}).slice(0, 20)) {
    next = catalystWatchUiReducer(next, {
      type: "set-draft",
      watchId,
      value: draft,
    });
  }
  return next;
}

export function catalystWatchQualityLabel(funnel = {}) {
  const count = Math.max(0, Number(funnel.watchCatalysts) || 0);
  return count === 0
    ? "线上质量尚待验证"
    : `自然观察样本 ${count} 条，质量仍需五日盲审`;
}

const CATALYST_SOURCE_NAMESPACE_LABELS = Object.freeze({
  "local.evening-review": "晚间复盘",
  "local.morning-review": "晨间复盘",
  "local.wechat": "微信",
  "local.gangtise": "冈底斯",
  "local.ima": "IMA",
});

/**
 * Return a human-readable source label without exposing an internal namespace.
 * Unknown namespaces intentionally use a generic label; the raw namespace is
 * still available to the server-side audit, never as the page heading.
 */
export function formatCatalystSourceNamespace(value) {
  const namespace = String(value || "").trim();
  return CATALYST_SOURCE_NAMESPACE_LABELS[namespace]
    || (namespace.startsWith("local.") ? "本地来源" : "来源");
}

function sourceDocumentToken(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  const documentPart = key.split("#", 1)[0] || "";
  const basename = documentPart.replaceAll("\\", "/").split("/").pop() || "";
  return basename
    .replace(/:[a-f0-9]{8,}$/iu, "")
    .replace(/\.(?:md|markdown|txt|jsonl)$/iu, "")
    .trim();
}

function sourceLineLabel(value) {
  const fragment = String(value || "").split("#")[1] || "";
  const match = fragment.match(/L?(\d+)(?:-L?(\d+))?/iu);
  if (!match) return "";
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "";
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

/**
 * Convert a frozen source key such as `2026-09-01-复盘.md#L76-L76:hash`
 * into a readable heading. Paths and hash suffixes are intentionally removed.
 */
export function formatCatalystSourceTitle(item = {}) {
  const source = sourceDocumentToken(item?.sourceDocumentKey);
  const fallback = formatCatalystSourceNamespace(item?.sourceNamespace);
  if (!source || /^[a-f0-9]{12,}$/iu.test(source)) return `${fallback}新增`;
  const dateMatch = source.match(/^(20\d{2})[-_](\d{2})[-_](\d{2})(.*)$/u);
  let title = source;
  if (dateMatch) {
    const suffix = String(dateMatch[4] || "").replace(/^[\s_·-]+/u, "").trim();
    title = suffix ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${suffix}` : `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
  }
  const line = sourceLineLabel(item?.sourceDocumentKey);
  return line ? `${title}（${line}）` : title;
}

/**
 * Keep the content hash useful for audit without making a long opaque string
 * dominate the readable source detail.
 */
export function formatCatalystSourceFingerprint(item = {}) {
  const value = String(item?.contentHash || item?.sha256 || "").trim();
  if (!/^[a-f0-9]{12,}$/iu.test(value)) return "不可用";
  return `${value.slice(0, 12)}…`;
}

function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function actionId(prefix, value) {
  return `desk:${prefix}:${fingerprint(value)}`;
}

function requireCard(card) {
  const id = cardId(card);
  if (!id) throw new TypeError("cardRevisionId required");
  return id;
}

export function buildPresentationCommand(card) {
  const cardRevisionId = requireCard(card);
  const presentationDecisionId = String(card?.presentationDecisionId || "");
  if (!presentationDecisionId) {
    throw new TypeError("当前卷宗缺少展示决策，暂不能正式提交");
  }
  const clientEventId = actionId("presented", {
    cardRevisionId,
    presentationDecisionId,
  });
  return {
    commandType: "recordDeliveryInteraction",
    idempotencyKey: clientEventId,
    expectedHeads: [],
    ...ACTOR,
    payload: {
      eventType: "PRESENTED",
      cardRevisionId,
      presentationDecisionId,
      clientEventId,
      channel: "INBOX",
      surface: "inbox-detail",
      visibilityRatio: 1,
      visibleDurationMs: 300,
    },
  };
}

export function buildHumanLabelCommand(card, local = {}) {
  const cardRevisionId = requireCard(card);
  const label = String(local.label || "").toUpperCase();
  if (!LABELS.has(label)) throw new TypeError("请先选择变量判断");
  const reviewNote = String(local.note || "").trim().slice(0, 300);
  const selectedEvidenceIds = [...new Set(array(local.evidenceIds).filter((id) => typeof id === "string" && id))];
  if (selectedEvidenceIds.length === 0) {
    throw new TypeError("至少选择 1 条判断依据");
  }
  if (reviewNote.length < 6) {
    throw new TypeError("研判说明至少需要 6 个字");
  }
  const semantic = {
    cardRevisionId,
    expectedLabelHeadId: card.expectedLabelHeadId ?? null,
    label,
    reviewNote,
    selectedEvidenceIds,
  };
  const clientActionId = actionId("label", semantic);
  return {
    commandType: "submitHumanLabel",
    idempotencyKey: clientActionId,
    expectedHeads: [
      {
        chainType: "human-label",
        objectId: cardRevisionId,
        expectedHeadId: card.expectedLabelHeadId ?? null,
      },
    ],
    ...ACTOR,
    payload: {
      cardRevisionId,
      label,
      reasonCodes: [],
      reviewNote,
      selectedEvidenceIds,
      ...(label === "WATCH" ? { watchHorizonSessions: 1 } : {}),
      clientActionId,
      expectedLabelHeadId: card.expectedLabelHeadId ?? null,
      supersedesId: card.expectedLabelHeadId ?? null,
      expectedExposureHeadId: card.expectedExposureHeadId ?? null,
      expectedOpportunityExposureSetHash:
        card.expectedOpportunityExposureSetHash || "",
      presentationInteractionId: card.presentationInteractionId || null,
    },
  };
}

export function buildMappingReviewCommand(card, mapping, reviewValue, correction = "") {
  const cardRevisionId = requireCard(card);
  const review = String(reviewValue || "").toUpperCase();
  if (!MAPPING_REVIEWS.has(review)) throw new TypeError("valid mapping review required");
  if (!mapping || typeof mapping.id !== "string" || !mapping.id) {
    throw new TypeError("mapping id required");
  }
  const targetType = mapping.kind === "题材" || mapping.themeRef
    ? "THEME_HYPOTHESIS"
    : "SECURITY_MAPPING";
  const replacementValue = String(correction || "").trim();
  if (review === "CORRECTED" && !replacementValue) {
    throw new TypeError("corrected mapping requires a replacement");
  }
  const replacement = review === "CORRECTED"
    ? targetType === "THEME_HYPOTHESIS"
      ? { themeRef: replacementValue }
      : { securityCode: replacementValue }
    : null;
  const semantic = {
    cardRevisionId,
    targetId: mapping.id,
    expectedReviewHeadId: mapping.expectedReviewHeadId ?? null,
    review,
    replacement,
  };
  const clientActionId = actionId("mapping", semantic);
  return {
    commandType: "submitMappingReview",
    idempotencyKey: clientActionId,
    expectedHeads: [
      {
        chainType: "mapping-review",
        objectId: mapping.id,
        expectedHeadId: mapping.expectedReviewHeadId ?? null,
      },
    ],
    ...ACTOR,
    payload: {
      cardRevisionId,
      target: { type: targetType, id: mapping.id },
      review,
      replacement,
      clientActionId,
      expectedReviewHeadId: mapping.expectedReviewHeadId ?? null,
      expectedExposureHeadId: card.expectedExposureHeadId ?? null,
      expectedOpportunityExposureSetHash:
        card.expectedOpportunityExposureSetHash || "",
      presentationInteractionId: card.presentationInteractionId || null,
    },
  };
}

export function buildRevealCommand(card) {
  const cardRevisionId = requireCard(card);
  if (!card.presentationDecisionId) {
    throw new TypeError("presentationDecisionId required");
  }
  const clientEventId = actionId("reveal", {
    cardRevisionId,
    presentationDecisionId: card.presentationDecisionId,
  });
  return {
    commandType: "revealOutcome",
    idempotencyKey: clientEventId,
    expectedHeads: [],
    ...ACTOR,
    payload: {
      cardRevisionId,
      presentationDecisionId: card.presentationDecisionId,
      clientEventId,
    },
  };
}

const STATUS_LABELS = Object.freeze({
  COMPLETE: "投影正常",
  PROJECTION_REFRESHING: "投影更新中",
  PARTIAL: "部分覆盖",
  PROJECTION_STALE: "投影滞后",
  UNLABELED: "未研判",
  HIDDEN: "待揭晓",
  APPROVED: "已复核",
  UNREVIEWED: "待复核",
  REJECTED: "已驳回",
  CORRECTED: "已纠正",
  TRADABLE: "可炒",
  WATCH: "继续观察",
  NOT_TRADABLE: "不可炒",
  SCHEDULED: "已排期",
  PENDING: "待到期",
  PROCESS: "整理中",
  LIVE: "跟踪中",
  HISTORICAL: "历史样本",
  RESTRICTED: "受限引用",
  TEAM: "团队引用",
});

const TIMELINE_STAGES = Object.freeze([
  { id: "source", label: "源事件", hint: "最初进入卷宗的线索" },
  { id: "expert", label: "专家会议", hint: "专家与产业信息交叉核对" },
  { id: "close", label: "收盘观察", hint: "冻结行情观察节点" },
  { id: "t1", label: "T+1", hint: "短窗发酵检查" },
  { id: "t3", label: "T+3", hint: "中窗持续性检查" },
  { id: "t5", label: "T+5", hint: "长窗站稳或消退检查" },
]);

const FINISHED_STATES = new Set(["COMPLETE", "DONE", "REVEALED"]);

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function stageIdOf(node = {}) {
  const horizon = String(node.horizon || "").toUpperCase();
  const title = String(node.title || "").toUpperCase();
  if (horizon === "T+1" || title.includes("T+1")) return "t1";
  if (horizon === "T+3" || title.includes("T+3")) return "t3";
  if (horizon === "T+5" || title.includes("T+5")) return "t5";
  if (node.nodeType === "MARKET_CLOSE") return "close";
  if (node.nodeType === "EXPERT_MEETING") return "expert";
  return "source";
}

function stageState(nodes) {
  if (!nodes.length) return "locked";
  if (nodes.some((node) => FINISHED_STATES.has(node.state))) return "complete";
  if (nodes.some((node) => node.state === "SCHEDULED")) return "scheduled";
  return "pending";
}

export function translateStatus(value) {
  return STATUS_LABELS[String(value || "").toUpperCase()] || "待确认";
}

const RESEARCH_HOST_VOICE_LOG_LABELS = Object.freeze({
  cancellation: "取消",
  cancelled: "已取消",
  "not-active": "未运行",
  "tool-call": "工具调用",
  "tool-result": "工具结果",
  user: "你",
  assistant: "小美",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
});

export function researchHostVoiceLogLabel(value) {
  const key = String(value || "");
  return RESEARCH_HOST_VOICE_LOG_LABELS[key] || key;
}

export function deskConnectionStatus({ phase = "idle", projectionStatus = null, error = null } = {}) {
  const errorCode = typeof error === "string" ? error : error?.code;
  const connectionError = errorCode === "RPC_UNREACHABLE" || errorCode === "INVALID_RPC_RESPONSE";
  if (phase === "error" || connectionError) return Object.freeze({ state: "error", label: "连接失败" });
  if (String(projectionStatus || "").toUpperCase() === "PROJECTION_STALE") {
    return Object.freeze({ state: "stale", label: "投影滞后" });
  }
  if (String(projectionStatus || "").toUpperCase() === "PROJECTION_REFRESHING") {
    return Object.freeze({ state: "refreshing", label: "正在更新" });
  }
  if (String(projectionStatus || "").toUpperCase() === "COMPLETE") {
    return Object.freeze({ state: "ready", label: "连接正常" });
  }
  if (phase === "idle" || phase === "loading") {
    return Object.freeze({ state: "connecting", label: "正在连接" });
  }
  if (phase === "ready" && String(projectionStatus || "").toUpperCase() === "COMPLETE") {
    return Object.freeze({ state: "ready", label: "连接正常" });
  }
  return Object.freeze({ state: "unknown", label: "连接待确认" });
}

export function sourceConnectionLabel(connection) {
  if (connection === "NOT_CHECKED") return "尚未检查";
  if (connection === "CHECKING") return "正在检查";
  if (connection === "CONNECTED") return "连接正常";
  if (connection === "FAILED") return "连接失败";
  return "状态未确认";
}

export function personalSourceStatus({ cardSource, source } = {}) {
  const published = cardSource === "published", api = cardSource === "api" || published, ima = cardSource === "ima";
  const matches = source && typeof source === "object" && !Array.isArray(source)
    && (ima ? source.kind === "ima" : api && (source.kind === undefined || source.kind === "api"));
  const ownership = matches && source.ready === true ? source.ownership : null;
  const label = published ? "业主发布卡" : ima ? "IMA 知识库" : !api ? "信源待确认"
    : ownership === "provided" ? "提供的信源" : ownership === "self" ? "自配信源" : "API 信源";
  const connection = sourceConnectionLabel(matches ? source.connection : null);
  return Object.freeze({ label, connection });
}

function shanghaiClock(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "稍后";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour && minute ? `${hour}:${minute}` : "稍后";
}

function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 10_000) return String(Math.round(tokens));
  const wan = Math.round((tokens / 10_000) * 10) / 10;
  return `${wan} 万`;
}

function analysisAuthWarning(circuit) {
  if (circuit?.status !== "OPEN") return null;
  return ({
    LLM_GROK_AUTH_REQUIRED: "模型登录已失效，分析暂停，请重新登录 Grok",
    LLM_GROK_AUTH_CHECK_FAILED: "模型登录状态核验失败，分析暂停",
    LLM_GROK_AUTH_CHECK_TIMEOUT: "模型登录状态核验超时，分析暂停",
  })[circuit.lastErrorCode] || null;
}

export function analysisCircuitLabel(circuit) {
  if (!circuit) return "尚未读取";
  const authWarning = analysisAuthWarning(circuit);
  if (authWarning) return authWarning;
  const failures = Number(circuit.consecutiveFailures || 0);
  if (circuit.status === "OPEN") {
    return `已暂停 · 连续失败 ${failures} 次 · ${shanghaiClock(circuit.retryAt)} 后试探恢复`;
  }
  if (circuit.status === "HALF_OPEN") {
    return `正在试探恢复 · 此前连续失败 ${failures} 次`;
  }
  return failures > 0 ? `正常 · 近期连续失败 ${failures} 次` : "正常";
}

export function analysisTokenBudgetLabel(budget) {
  if (!budget) return "尚未读取";
  const used = compactTokens(budget.totalTokens);
  const limit = compactTokens(budget.limitTokens);
  if (budget.status === "EXHAUSTED") {
    return `今日预算已用完 · ${used} / ${limit}`;
  }
  return `今日 ${used} / ${limit} · 余 ${compactTokens(budget.remainingTokens)}`;
}

function workerStorageWarning(runtime) {
  return runtime?.workerStorage?.status === "MISMATCH" ? "存储状态不一致"
    : runtime?.workerStorage?.status === "UNAVAILABLE" ? "worker 存储未核验" : null;
}

export function sourceRuntimeLabel(runtime) {
  const storageWarning = workerStorageWarning(runtime);
  if (storageWarning) return runtime.workerStorage.status === "MISMATCH" ? `${storageWarning} · 需检查 worker` : storageWarning;
  if (!runtime || runtime.status === "NOT_STARTED") return "信源待启动";
  if (runtime.status === "NOT_CONFIGURED") return "信源未配置";
  if (runtime.status === "UNAVAILABLE") return "信源不可用";
  if (runtime.status === "DISABLED") {
    const failed = Number(runtime.queue?.failed || 0);
    return `信源已停用${failed > 0 ? ` · 历史失败 ${failed} 条` : ""}`;
  }
  const authWarning = analysisAuthWarning(runtime.analysisCircuit);
  if (authWarning) return authWarning;
  if (runtime.analysisCircuit?.status === "OPEN") return "模型分析已暂停，等待自动恢复";
  if (runtime.analysisTokenBudget?.status === "EXHAUSTED") {
    return "今日分析预算已用完";
  }
  const circuitPrefix = runtime.analysisCircuit?.status === "HALF_OPEN"
    ? "模型分析试探恢复中 · "
    : "";
  const failed = Number(runtime.queue?.failed || 0);
  const running = Number(runtime.queue?.running || 0);
  const queued = Number(runtime.queue?.pending || 0) + Number(runtime.queue?.retry || 0);
  const queuedLabel = queued > 0 ? ` · 待分析 ${queued} 条` : "";
  if (running > 0) {
    return `${circuitPrefix}正在分析 ${running} 条${queuedLabel}${failed > 0 ? ` · 历史失败 ${failed} 条` : ""}`;
  }
  if (queued > 0) {
    return `${circuitPrefix}待分析 ${queued} 条${failed > 0 ? ` · 历史失败 ${failed} 条` : ""}`;
  }
  if (failed > 0) return `${circuitPrefix}${failed} 条历史分析失败`;
  if (circuitPrefix) return "模型分析试探恢复中";
  if (runtime.status === "DEGRADED" || runtime.latestRun?.status === "DEGRADED") {
    return "信源需检查";
  }
  return "信源已同步";
}

export function sourceQueueLabel(queue) {
  if (!queue) return "尚未读取";
  const count = (value) => Math.max(0, Number(value) || 0);
  return [
    `待处理 ${count(queue.pending)}`,
    `运行中 ${count(queue.running)}`,
    `重试 ${count(queue.retry)}`,
    `失败 ${count(queue.failed)}`,
  ].join(" · ");
}

export function sourceLatestRunLabel(run) {
  if (run?.status === "RUNNING") return "运行中";
  return run?.completedAt || "尚未运行";
}

function formatDurationMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis < 0) return null;
  if (millis < 1_000) return `${Math.round(millis)}ms`;
  return `${(millis / 1_000).toFixed(millis >= 10_000 ? 1 : 2)}s`;
}

export function sourceCycleTimingsLabel(run) {
  const timings = run?.timings;
  if (!timings || typeof timings !== "object") return "尚未记录";
  const labels = [
    ["发现", timings.discoveryMs],
    ["分析", timings.analysisMs],
    ["发布", timings.publishMs],
    ["投影", timings.projectionMs],
    ["总计", timings.totalMs],
  ];
  const parts = labels.map(([label, value]) => {
    const formatted = formatDurationMs(value);
    return formatted ? `${label} ${formatted}` : null;
  }).filter(Boolean);
  return parts.length ? parts.join(" · ") : "尚未记录";
}

export function sourceAnalysisLatencyLabel(analysis) {
  const latency = formatDurationMs(analysis?.latencyMs);
  return latency ? `模型 ${latency}` : "尚未记录";
}

const SOURCE_PIPELINES = Object.freeze([
  ["wechat", "微信"],
  ["gangtise", "冈底斯"],
  ["morning-review", "晨报"],
  ["evening-review", "晚报"],
  ["liudu", "六度"],
]);

function timestampAgeMs(value, now) {
  const at = Date.parse(String(value || ""));
  const current = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  if (!Number.isFinite(at) || !Number.isFinite(current)) return null;
  return Math.max(0, current - at);
}

export function relativeAgeLabel(value, now = new Date()) {
  const age = timestampAgeMs(value, now);
  if (age === null) return "暂无资料";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function sourcePipelineHealth(runtime, now = new Date()) {
  const analysisLabel = workerStorageWarning(runtime) || (runtime?.analysisTokenBudget?.status === "EXHAUSTED"
    || runtime?.analysisCircuit?.status === "OPEN"
    ? "分析暂停"
    : runtime?.analysisCircuit?.status === "HALF_OPEN"
      ? "分析试探恢复"
      : null);
  const analysisBlocked = Boolean(analysisLabel);
  const connectors = new Map(
    array(runtime?.connectors)
      .filter((connector) => typeof connector?.id === "string" && connector.id)
      .map((connector) => [connector.id, connector]),
  );
  const known = new Set(SOURCE_PIPELINES.map(([id]) => id));
  const rows = [
    ...SOURCE_PIPELINES,
    ...[...connectors.keys()]
      .filter((id) => !known.has(id))
      .sort()
      .map((id) => [id, id]),
  ];
  return rows.map(([id, name]) => {
    const connector = connectors.get(id) || null;
    const checkedAgeMs = timestampAgeMs(connector?.lastCheckedAt, now);
    const delayThresholdMs = Math.max(
      180_000,
      Number(connector?.pollIntervalSeconds || 60) * 3_000,
    );
    const connectorState = connector?.enabled === false
      ? "disabled"
      : !connector?.lastCheckedAt
      ? "idle"
      : connector.lastErrorCode
        ? "failed"
        : checkedAgeMs !== null && checkedAgeMs > delayThresholdMs
          ? "delayed"
          : "healthy";
    const state = connectorState === "healthy" && analysisBlocked
      ? "analysis-blocked"
      : connectorState;
    const checkLabel = state === "disabled"
      ? "已停用"
      : state === "healthy"
      ? "管线正常"
      : state === "analysis-blocked"
        ? analysisLabel
      : state === "failed"
        ? "读取失败"
        : state === "delayed"
          ? "检查延迟"
          : "尚未检查";
    const checkedAgeLabel = relativeAgeLabel(connector?.lastCheckedAt, now);
    const scanLabel = connectorState === "disabled"
      ? "已停用"
      : connectorState === "healthy"
      ? `${checkedAgeLabel}扫描`
      : connectorState === "failed"
        ? "读取失败"
        : connectorState === "delayed"
          ? "检查延迟"
          : "尚未扫描";
    return Object.freeze({
      id,
      name,
      state,
      checkLabel,
      scanLabel,
      sourceAgeLabel: relativeAgeLabel(connector?.lastSourceAt, now),
      lastCheckedAt: connector?.lastCheckedAt || null,
      lastSourceAt: connector?.lastSourceAt || null,
      errorCode: connector?.lastErrorCode || null,
      analysisBlocked: state === "analysis-blocked",
      analysisLabel: state === "analysis-blocked" ? analysisLabel : null,
    });
  });
}

export function publishedSyncLabel(status) {
  if (status === "NOT_CONFIGURED") return "请先配置发布卡信源";
  if (status === "SYNCED") return "发布卡自动更新已连接";
  if (status === "CONNECTING") return "正在连接发布卡更新";
  if (status === "DISCONNECTED") return "发布卡更新已断开";
  return "发布卡更新待确认";
}

export function liveSyncLabel(liveSync, now = new Date()) {
  if (liveSync?.running || liveSync?.lastStatus === "RUNNING") return "正在实时同步";
  const seconds = Number(liveSync?.intervalSeconds || 0);
  const interval = seconds > 0
    ? seconds % 60 === 0
      ? `${seconds / 60} 分钟`
      : `${seconds} 秒`
    : "未启用";
  const prefix = liveSync?.enabled ? `自动同步 ${interval}` : "自动同步未启用";
  if (liveSync?.lastStatus === "DEGRADED") return `${prefix} · 上轮有异常`;
  if (liveSync?.lastStatus === "SUCCEEDED" && liveSync?.lastCompletedAt) {
    return `${prefix} · ${relativeAgeLabel(liveSync.lastCompletedAt, now)}完成`;
  }
  return prefix;
}

export function mergeSourceRuntimeSnapshot(previous, incoming) {
  if (!incoming) return previous || null;
  if (incoming.liveSync || !previous?.liveSync) return incoming;
  return { ...incoming, liveSync: previous.liveSync };
}

export function sourceSyncActivity(result = {}) {
  const discovered = Number(result.discoveredCount || 0);
  const analyzed = Number(result.analyzedCount || 0);
  const published = Number(result.publishedCount || 0);
  const failed = Number(result.failedCount || 0);
  if (failed > 0) return `本轮有 ${failed} 条分析失败，请查看信源诊断`;
  if (published > 0) {
    const prefix = discovered > 0 ? `发现 ${discovered} 条新增信源，` : "";
    return `${prefix}后台 Grok 已分析 ${analyzed} 条，形成 ${published} 条新卷宗`;
  }
  if (analyzed > 0) return `后台 Grok 已分析 ${analyzed} 条，均未达到成卡门槛`;
  return "已读到最新信源，当前没有待分析增量";
}

export function cleanDisplayText(value, fallback = "待补充") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const exact = {
    "research snapshot evidence vs market consensus": "快照证据与市场共识之间的预期差",
    "research case is not a trading signal": "研究案例不是交易信号",
    "待盲标/结果隐藏": "后续结果仍保持隐藏；本地研判尚未写入权威账本。",
  };
  if (exact[text]) return exact[text];
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const claim = String(parsed?.claim || "").trim();
      if (claim) return claim;
    } catch {
      const claim = text.match(/"claim"\s*:\s*"([\s\S]*)/i)?.[1]
        ?.replace(/"\s*[,}]\s*$/u, "")
        .replace(/\\"/g, '"')
        .trim();
      if (claim) return claim;
    }
  }
  const meetingRecord = text.match(/^#{1,6}\s*(\d+)\.\s*记录\s*(\d+)$/);
  if (meetingRecord) return `会议记录 ${meetingRecord[1]} · 编号 ${meetingRecord[2]}`;
  return text
    .replace(/\s+bounded research case$/i, "")
    .replace(/\s+dossier for human review only;?\s*not a recommendation$/i, " · 仅供人工复核")
    .replace(/^#{1,6}\s*/, "会议记录 · ")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .trim() || fallback;
}

export function buildDeepResearchTopic(view = {}) {
  const title = cleanDisplayText(view.title, "变量线索");
  const companies = array(view.mappings)
    .filter((mapping) => mapping?.kind === "公司")
    .map((mapping) => cleanDisplayText(mapping.name, ""))
    .filter(Boolean)
    .slice(0, 4);
  return [
    title,
    companies.length ? `相关公司 ${companies.join("、")}` : "",
    "最新催化、反证、官方披露与市场预期差",
  ]
    .filter(Boolean)
    .join("；")
    .slice(0, 200);
}

const DEEP_RESEARCH_SOURCE_LABELS = Object.freeze({
  "published-card": "原卡证据",
  web: "联网资料",
  navigation: "研究导航",
  wiki: "研究库",
  raw: "原始信源",
  graph: "关系图谱",
  fact: "时序事实",
  invalidated_fact: "已失效事实",
  brain: "纠错记忆",
  stock_daily: "行情资料",
});

function safeResearchHref(value) {
  try {
    const parsed = new URL(String(value || ""));
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.startsWith("[") ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname) ||
      /^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(hostname)
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeLocalResearchPath(value) {
  const candidate = String(value || "").trim();
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    candidate.split("/").some((part) => !part || part === "." || part === "..")
  ) return null;
  return candidate.slice(0, 1_024);
}

function cleanResearchAnswer(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, "")
    .replace(/^```[^\n]*$/gmu, "")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/\*\*/g, "")
    .replace(/[\p{Cf}\u0000]/gu, "")
    .trim()
    .slice(0, 8_000);
}

function deepResearchModelLabel(model) {
  const value = String(model?.model || "").toLowerCase();
  if (value === "deepseek-v4-pro") return "DeepSeek-V4-Pro 综合";
  if (value === "deepseek-v4-flash") return "DeepSeek-V4-Flash 综合";
  return "DeepSeek 综合";
}

export function normalizeDeepResearchProposal(value) {
  if (
    value?.schema !== "deep-research-proposal-v1" ||
    value?.authority !== "proposal"
  ) return null;
  const remote = value.provider === "remote";
  if (remote && (value.writePolicy?.readOnly !== true || value.writePolicy?.wroteArtifacts !== false
    || !["done", "partial"].includes(value.status) || typeof value.synthesisMarkdown !== "string"
    || !Array.isArray(value.refs))) return null;
  const reviewedPublished = remote && value.readScope?.coverage === "REVIEWED_PUBLISHED_CARD";
  const originalScope = value.readScope;
  const originalId = item => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item);
  const originalHash = item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
  const originalTime = item => typeof item === "string" && Number.isFinite(Date.parse(item))
    && Date.parse(item) <= Date.parse(originalScope?.knownAt);
  if (reviewedPublished && (!originalId(originalScope.cardId) || !originalId(originalScope.cardRevisionId)
    || !originalId(originalScope.datasetId) || !originalHash(originalScope.contentHash)
    || !Number.isSafeInteger(originalScope.revision) || originalScope.revision < 1
    || ![originalScope.knownAt, originalScope.availableAt, originalScope.recordedAt].every(originalTime)
    || originalScope.historyComplete !== false || value.status !== "partial" || value.cacheable !== false
    || value.writePolicy.exportAllowed !== false || value.refs.length > 48)) return null;
  const observation = value.webObservation;
  const ownWeb = value.webService?.mode === "own" && typeof value.webService.revision === "string"
    && /^[a-f0-9]{64}$/.test(value.webService.revision)
    && observation?.historicalAvailability === "UNKNOWN" && observation.revalidated === false
    && typeof observation.observedAt === "string"
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observation.observedAt)
    && Number.isFinite(Date.parse(observation.observedAt))
    && new Date(observation.observedAt).toISOString() === observation.observedAt;
  if (remote && value.webService !== undefined && !ownWeb) return null;
  const evidence = [];
  for (const item of array(remote ? value.refs : value.evidenceRefs).slice(0, reviewedPublished ? 48 : 16)) {
    const sourceType = remote && item?.sourceType === "facts" ? "fact" : String(item?.sourceType || "");
    const ref = String(item?.ref || "").trim();
    if (!Object.hasOwn(DEEP_RESEARCH_SOURCE_LABELS, sourceType)) continue;
    if (!/^[A-Z]{1,3}[1-9][0-9]{0,4}$/.test(ref)) continue;
    if (sourceType === "published-card") {
      if (!reviewedPublished || item.datasetId !== originalScope.datasetId || !originalId(item.evidenceId)
        || !originalId(item.sourceItemId) || !originalHash(item.contentHash) || !originalHash(item.sourceRecordHash)
        || ![item.availableAt, item.recordedAt, item.knownAt].every(originalTime)
        || item.knownAt !== originalScope.knownAt || typeof item.excerpt !== "string"
        || item.originalRetrievalRef !== undefined && !originalId(item.originalRetrievalRef)) return null;
      evidence.push(Object.freeze({ ref, sourceType, sourceLabel: "原卡证据",
        title: cleanDisplayText(String(item.title || "").slice(0, 300), ref),
        excerpt: cleanDisplayText(item.excerpt.slice(0, 4_096), "原卡未提供摘录"),
        sourcePath: item.evidenceId, href: null, stateLabel: `业主原卡 · 第 ${originalScope.revision} 版`, invalidated: false,
        contentHash: item.contentHash, sourceItemId: item.sourceItemId, sourceRecordHash: item.sourceRecordHash,
        ...(item.originalRetrievalRef ? { originalRetrievalRef: item.originalRetrievalRef } : {}),
      }));
      continue;
    }
    if (sourceType === "wiki" && /^wiki:ima:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(item.evidenceId ?? "")
      && item.path === item.evidenceId && item.exportAllowed === false && /^[a-f0-9]{64}$/.test(item.contentHash ?? "")
      && item.versionId === null && Number.isFinite(Date.parse(item.observedAt))) {
      evidence.push(Object.freeze({
        ref, sourceType, sourceLabel: "IMA", title: cleanDisplayText(String(item.title || "").slice(0, 300), ref),
        excerpt: "", sourcePath: item.evidenceId, href: null, stateLabel: "当前观察", invalidated: false,
        contentHash: item.contentHash, versionId: null, observedAt: item.observedAt,
      }));
      continue;
    }
    const href = sourceType === "web" ? safeResearchHref(remote ? item.url : item.path) : null;
    const sourcePath = sourceType === "web" ? href : safeLocalResearchPath(item.path);
    if (!sourcePath) continue;
    const invalidated = sourceType === "invalidated_fact";
    if (!remote && (
      (invalidated && item.evidenceState !== "invalidated") ||
      (!invalidated && item.evidenceState !== "active")
    )) continue;
    evidence.push(Object.freeze({
      ref,
      sourceType,
      sourceLabel: remote && sourceType === "raw" ? "授权摘录" : DEEP_RESEARCH_SOURCE_LABELS[sourceType],
      title: cleanDisplayText(String(item.title || "").slice(0, 300), ref),
      excerpt: cleanDisplayText(String(item.excerpt || "").slice(0, 1_200), "摘录待补充"),
      sourcePath,
      href,
      stateLabel: remote ? sourceType === "web" ? "联网候选" : "授权发布 · UNKNOWN"
        : invalidated ? "历史已失效" : "当前候选",
      invalidated,
    }));
  }
  const count = (key) => remote
    ? Number.isSafeInteger(value.counts?.[key]) && value.counts[key] >= 0 ? value.counts[key] : null
    : Math.max(0, Math.floor(Number(value.counts?.[key]) || 0));
  const selectedIma = remote && value.readScope?.coverage === "SELECTED_IMA_DOCUMENT";
  const libraryIma = remote && value.readScope?.coverage === "IMA_LIBRARY_SEARCH";
  if (remote && value.readScope && !selectedIma && !libraryIma && !reviewedPublished) return null;
  if (reviewedPublished) {
    const originalRefs = value.refs.filter(item => item.sourceType === "published-card");
    if (!originalRefs.length || originalRefs.length > 32 || evidence.length !== value.refs.length
      || new Set(value.refs.map(item => item.ref)).size !== value.refs.length
      || new Set(originalRefs.map(item => item.evidenceId)).size !== originalRefs.length) return null;
  }
  if (selectedIma && (value.readScope.historyComplete !== false || value.readScope.version !== null
    || value.wiki?.mode !== "ima" || value.wiki.complete !== false || value.wiki.matched !== null
    || value.wiki.included !== 1 || value.web?.status !== "off" || value.status !== "partial"
    || evidence.length !== 1 || evidence[0].sourceLabel !== "IMA"
    || evidence[0].sourcePath !== value.readScope.evidenceId
    || value.readScope.datasetId !== value.readScope.evidenceId.split(":").slice(0, 3).join(":"))) return null;
  if (libraryIma) {
    const scope = value.readScope, wiki = value.wiki;
    if (!/^wiki:ima:[A-Za-z0-9_-]+$/.test(scope.datasetId ?? "") ||
      typeof scope.query !== "string" || scope.query.length < 2 || scope.query.length > 200 || scope.query !== value.topic ||
      !Number.isSafeInteger(scope.matched) || scope.matched < 0 || ![0, 1].includes(scope.included) ||
      scope.included !== Math.min(1, scope.matched) || scope.omitted !== scope.matched - scope.included ||
      scope.complete !== (scope.omitted === 0) || scope.historyComplete !== false || scope.version !== null ||
      typeof scope.apiSupplementAllowed !== "boolean" || typeof scope.webSearchAllowed !== "boolean" ||
      scope.webSearchAllowed && !scope.apiSupplementAllowed &&
        (value.web?.status !== "off" || value.web?.results?.length ||
          value.refs.some(ref => ref.sourceType === "web")) && !ownWeb ||
      !scope.webSearchAllowed && value.web?.status !== "off" ||
      value.status !== "partial" || value.cacheable !== false || value.writePolicy.exportAllowed !== false ||
      wiki?.mode !== "ima" || wiki.matched !== scope.matched || wiki.included !== scope.included ||
      wiki.omitted !== scope.omitted || wiki.complete !== scope.complete ||
      wiki.status !== (scope.included ? "partial" : "empty") ||
      count("wikiMatches") !== scope.matched || value.refs.length !== evidence.length ||
      new Set(value.refs.map(ref => ref.ref)).size !== value.refs.length ||
      value.refs.filter(ref => ref.sourceType === "wiki").length !== scope.included ||
      value.refs.some(ref => ref.sourceType === "wiki"
        ? ref.datasetId !== scope.datasetId || ref.evidenceId?.split(":").slice(0, 3).join(":") !== scope.datasetId || ref.ref !== "W1"
        : ref.sourceType === "web" ? !scope.webSearchAllowed
          : !scope.apiSupplementAllowed || !["raw", "facts", "brain"].includes(ref.sourceType))) return null;
  }
  return Object.freeze({
    answer: cleanResearchAnswer(remote ? value.synthesisMarkdown : value.answer) || "本轮没有形成可展示的综合结论。",
    topic: cleanDisplayText(String(value.topic || "").slice(0, 200), "联网补证"),
    generatedLabel: dateLabel(value.generatedAt),
    modelLabel: remote ? `${cleanDisplayText(String(value.model?.model || ""), "用户模型")} 综合` : deepResearchModelLabel(value.model),
    ...(remote ? { status: value.status, webStatus: value.web?.status ?? "UNKNOWN" } : {}),
    boundaryLabel: reviewedPublished ? "业主原卡的个人研究 · 不改写原卡 · 覆盖不完整"
      : selectedIma ? "所选 IMA 资料 · 未检索全库或网页 · 不属于事前冻结证据"
      : libraryIma ? "IMA 库内查询 · 限额读取 · 历史覆盖 UNKNOWN · 不属于事前冻结证据" : "当前联网补证 · 不属于事前冻结证据",
    ...(selectedIma ? { readScope: Object.freeze({ coverage: "SELECTED_IMA_DOCUMENT",
      evidenceId: value.readScope.evidenceId, datasetId: value.readScope.datasetId,
      historyComplete: false, version: null }) } : {}),
    ...(reviewedPublished ? { readScope: Object.freeze({ coverage: "REVIEWED_PUBLISHED_CARD",
      cardId: originalScope.cardId, cardRevisionId: originalScope.cardRevisionId, datasetId: originalScope.datasetId,
      revision: originalScope.revision, contentHash: originalScope.contentHash,
      availableAt: originalScope.availableAt, recordedAt: originalScope.recordedAt, knownAt: originalScope.knownAt,
      historyComplete: false }) } : {}),
    ...(libraryIma ? { readScope: Object.freeze({
      coverage: "IMA_LIBRARY_SEARCH", datasetId: value.readScope.datasetId, query: value.readScope.query,
      matched: value.readScope.matched, included: value.readScope.included, omitted: value.readScope.omitted,
      complete: value.readScope.complete, historyComplete: false, version: null,
      apiSupplementAllowed: value.readScope.apiSupplementAllowed, webSearchAllowed: value.readScope.webSearchAllowed,
    }) } : {}),
    counts: Object.freeze({
      web: count("webMatches"),
      wiki: count("wikiMatches"),
      raw: count("rawMatches"),
      graph: count("graphMatches"),
      facts: count("factsMatches"),
      brain: count("brainMatches"),
    }),
    evidence: Object.freeze(evidence),
    ...(value.wiki && ["ima", "none"].includes(value.wiki.mode)
      && ["done", "partial", "empty", "model-use-denied", "off"].includes(value.wiki.status) ? {
        wiki: Object.freeze({ mode: value.wiki.mode, status: value.wiki.status,
          complete: value.wiki.complete === true,
          ...(libraryIma ? { matched: value.wiki.matched, omitted: value.wiki.omitted } : {}),
          included: Number.isSafeInteger(value.wiki.included) && value.wiki.included >= 0 ? value.wiki.included : null }),
      } : {}),
  });
}

function autoJudgmentModelLabel(model) {
  const value = String(model?.model || "").toLowerCase();
  const name = value === "deepseek-v4-flash"
    ? "DeepSeek-V4-Flash"
    : value === "deepseek-v4-pro"
      ? "DeepSeek-V4-Pro"
      : "DeepSeek";
  const effort = String(model?.reasoningEffort || "").toLowerCase();
  const effortLabel = {
    max: "Max",
    high: "High",
    low: "Low",
    off: "Off",
  }[effort];
  return effortLabel ? `${name} · ${effortLabel}` : name;
}

export function normalizeAutoJudgmentDraft(value, allowedEvidenceIds = []) {
  if (
    value?.schema !== "auto-judgment-draft-v1" ||
    value?.authority !== "draft" ||
    value?.writePolicy?.wroteLedger !== false ||
    value?.writePolicy?.submittedJudgment !== false ||
    value?.writePolicy?.reviewedMappings !== false
  ) return null;
  const label = String(value?.draft?.label || "").toUpperCase();
  const note = String(value?.draft?.note || "")
    .replace(/[\p{Cf}\u0000]/gu, "")
    .trim()
    .slice(0, 300);
  const allowed = new Set(array(allowedEvidenceIds));
  const evidenceIds = [...new Set(array(value?.draft?.evidenceIds))];
  if (
    !LABELS.has(label) ||
    note.length < 6 ||
    evidenceIds.length < 1 ||
    evidenceIds.length > 6 ||
    evidenceIds.some((id) => typeof id !== "string" || !allowed.has(id))
  ) return null;
  return Object.freeze({
    schema: "auto-judgment-draft-v1",
    authority: "draft",
    draft: Object.freeze({
      label,
      note,
      evidenceIds: Object.freeze(evidenceIds),
    }),
    writePolicy: Object.freeze({
      wroteLedger: false,
      submittedJudgment: false,
      reviewedMappings: false,
    }),
    modelLabel: ["SELECTED_IMA_DOCUMENT", "CURRENT_CARD_PUBLISHED_INPUTS"].includes(value.readScope?.coverage)
      ? cleanDisplayText(String(value.model?.model || "").slice(0, 120), "用户模型")
      : autoJudgmentModelLabel(value.model),
  });
}

export const RADAR_SOURCE_FILTERS = Object.freeze([
  { id: "all", label: "全部来源" },
  { id: "wechat", label: "微信", namespace: "local.wechat" },
  { id: "gangtise", label: "冈底斯", namespace: "local.gangtise" },
  { id: "morning-review", label: "晨报", namespace: "local.morning-review" },
  { id: "evening-review", label: "晚报", namespace: "local.evening-review" },
  { id: "liudu", label: "六度", namespace: "local.liudu" },
  { id: "x", label: "X", namespace: "notion.x-radar" },
  { id: "unknown", label: "来源待确认" },
]);

function radarCardSources(card) {
  const namespaces = new Set(array(card?.sourceNamespaces));
  return RADAR_SOURCE_FILTERS.filter((source) => source.namespace && namespaces.has(source.namespace));
}

export function radarCardSourceLabel(card) {
  return radarCardSources(card).map((source) => source.label).join(" · ") || "来源待确认";
}

export function filterRadarCardsBySource(cards, sourceFilter = "all") {
  if (sourceFilter === "all") return array(cards);
  return array(cards).filter((card) => {
    const sources = radarCardSources(card);
    return sourceFilter === "unknown" ? sources.length === 0 : sources.some((source) => source.id === sourceFilter);
  });
}

function withRadarSources(winner, other) {
  return { ...winner, sourceNamespaces: [...new Set([
    ...array(winner?.sourceNamespaces), ...array(other?.sourceNamespaces),
  ])].sort() };
}

export function collectCards(inbox) {
  if (!inbox) return [];
  if (inbox.stateAuthority === "PUBLISHED_READ_MODEL") {
    // These identities and revisions belong to the publisher. Local model
    // filters and semantic merging must not turn them into different cards.
    return array(inbox.candidatePool).filter(card =>
      card?.publication?.cardId === card.cardRevisionId &&
      typeof card.publication.datasetId === "string" &&
      /^[a-f0-9]{64}$/.test(card.publication.contentHash ?? ""));
  }
  const accepted = [
    ...array(inbox.urgent),
    ...array(inbox.mustReview),
    ...array(inbox.candidatePool),
  ].filter((card) => {
    if (card?.modelVersion === "RULE") return true;
    return String(card?.promptVersion || "").startsWith("evidence-catalyst-v3-ask");
  });
  const latestByVariable = new Map();
  for (const card of accepted) {
    const key = card?.variableId || cardId(card);
    const previous = latestByVariable.get(key);
    const revision = Number(card?.revision || 1);
    const previousRevision = Number(previous?.revision || 1);
    if (
      !previous ||
      revision > previousRevision ||
      (revision === previousRevision && compareRadarCardFreshness(card, previous) > 0)
    ) {
      latestByVariable.set(key, withRadarSources(card, previous));
    } else {
      latestByVariable.set(key, withRadarSources(previous, card));
    }
  }
  const mainlines = [];
  for (const card of latestByVariable.values()) {
    const index = mainlines.findIndex((current) =>
      sameCatalystMainline(current, card),
    );
    if (index < 0) {
      mainlines.push(card);
      continue;
    }
    const previous = mainlines[index];
    if (compareRadarCardFreshness(card, previous) > 0) {
      mainlines[index] = withRadarSources(card, previous);
    } else {
      mainlines[index] = withRadarSources(previous, card);
    }
  }
  return mainlines;
}

function radarEvidenceHashes(value) {
  if (Array.isArray(value?.evidenceHashes)) {
    return [...new Set(value.evidenceHashes
      .map((hash) => String(hash || "").trim().toLowerCase())
      .filter((hash) => /^[a-f0-9]{64}$/u.test(hash)))]
      .sort();
  }
  return [...new Set([
    ...array(value?.evidence),
    ...array(value?.suggestionEvidence),
  ]
    .map((item) => String(item?.contentHash || item?.sha256 || "").trim().toLowerCase())
    .filter((hash) => /^[a-f0-9]{64}$/u.test(hash)))]
    .sort();
}

function latestResearchInstant(values) {
  return array(values)
    .map((value) => String(value || "").trim())
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function radarMaterialAt(card) {
  return latestResearchInstant([
    ...array(card?.evidence).flatMap((item) => [
      item?.materialAt,
      item?.availableAt,
      item?.sourceAt,
      item?.publishedAt,
    ]),
    ...array(card?.suggestionEvidence).flatMap((item) => [
      item?.materialAt,
      item?.availableAt,
      item?.sourceAt,
      item?.publishedAt,
    ]),
  ]);
}

function compareRadarCardFreshness(left, right) {
  const leftTime = Date.parse(left?.systemDecisionAt || left?.recordedAt || "");
  const rightTime = Date.parse(right?.systemDecisionAt || right?.recordedAt || "");
  const leftFinite = Number.isFinite(leftTime);
  const rightFinite = Number.isFinite(rightTime);
  if (leftFinite !== rightFinite) return leftFinite ? 1 : -1;
  if (leftFinite && leftTime !== rightTime) return leftTime - rightTime;
  const revision = Number(left?.revision || 1) - Number(right?.revision || 1);
  if (revision) return revision;
  const evidence = radarEvidenceHashes(left).length - radarEvidenceHashes(right).length;
  if (evidence) return evidence;
  return String(cardId(left) || "").localeCompare(String(cardId(right) || ""));
}

export function radarEventIdentity(value) {
  const catalyst = normalizeCatalystTheme(value?.catalystIdentityKey)
    || String(value?.variableId || value?.variableIdentityKey || value?.id || cardId(value) || "")
      .trim()
      .toLocaleLowerCase("zh-CN");
  const revision = Number.isFinite(Number(value?.revision))
    ? Math.max(1, Math.floor(Number(value.revision)))
    : 1;
  const hashes = radarEvidenceHashes(value);
  return catalyst
    ? `${catalyst}|r${revision}|${hashes.join(",") || "evidence-unknown"}`
    : "";
}

const RADAR_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const RADAR_DATE_ID_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function radarTodayDateId(value = new Date()) {
  return RADAR_DATE_ID_FORMATTER.format(value);
}

function radarTimeParts(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return Object.fromEntries(
    RADAR_TIME_FORMATTER.formatToParts(parsed)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function cardTimeMeta(card) {
  for (const value of [card?.systemDecisionAt, card?.firstHumanPresentedAt]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const parts = radarTimeParts(value);
    if (!parts) continue;
    const revision = Number(card?.revision || 1);
    return Object.freeze({
      iso: value,
      label: `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
      accessibleLabel: revision > 1
        ? `同一变量第 ${revision} 版最近更新时间：${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`
        : `进入雷达时间：${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`,
      missing: false,
    });
  }
  return Object.freeze({
    iso: null,
    label: "时间待确认",
    accessibleLabel: "进入雷达时间待确认",
    missing: true,
  });
}

function radarDayMeta(card) {
  const time = cardTimeMeta(card);
  const parts = time.iso ? radarTimeParts(time.iso) : null;
  if (!parts) {
    return Object.freeze({ id: "missing", label: "时间待确认", missing: true });
  }
  return Object.freeze({
    id: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.month}月${parts.day}日`,
    missing: false,
  });
}

export function radarDateOptions(cards, direction = "newest") {
  const counts = new Map();
  for (const card of array(cards)) {
    const day = radarDayMeta(card);
    const current = counts.get(day.id);
    counts.set(day.id, current
      ? { ...current, count: current.count + 1 }
      : { id: day.id, label: day.label, count: 1, missing: day.missing });
  }
  const factor = direction === "oldest" ? 1 : -1;
  return [...counts.values()]
    .sort((left, right) => {
      if (left.missing !== right.missing) return left.missing ? 1 : -1;
      return left.id.localeCompare(right.id) * factor;
    })
    .map(({ id, label, count }) => Object.freeze({ id, label, count }));
}

export function filterRadarCardsByDate(cards, dateId = "all") {
  if (dateId === "all") return array(cards);
  return array(cards).filter((card) => radarDayMeta(card).id === dateId);
}

export function radarDisplayCountLabel(visibleCount, scopeCount) {
  const visible = Math.max(0, Number(visibleCount) || 0);
  const scope = Math.max(0, Number(scopeCount) || 0);
  return `显示 ${visible}/${scope}`;
}

export function radarHeadingLabel({ dateFilter = "all", dateOptions = [], todayDate = "" } = {}) {
  if (dateFilter === "all") return "全部雷达";
  if (todayDate && dateFilter === todayDate) return "今日雷达";
  const option = array(dateOptions).find((item) => item?.id === dateFilter);
  return option?.label ? `雷达 · ${option.label}` : "雷达";
}

export function radarLoadingLabel({ dateFilter = "all", todayDate = "" } = {}) {
  if (typeof dateFilter === "string" && dateFilter !== "all" && dateFilter !== todayDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateFilter);
    if (match) return `正在展开雷达 · ${match[2]}月${match[3]}日`;
  }
  return "正在展开今日变量";
}

export function radarEmptyLabel({
  cards = [],
  datedCards = [],
  visibleCards = [],
  emptyLabel = "今天暂时没有进入人工复核的变量。",
} = {}) {
  if (array(visibleCards).length) return "";
  if (!array(cards).length) return emptyLabel;
  if (!array(datedCards).length) return "所选日期没有可读变量。";
  return "当前筛选没有可读变量。";
}

export function deskColumnEmptyLabel({ column = "timeline", projectionBlocked = false, busy = false } = {}) {
  if (projectionBlocked) {
    return column === "decision" ? "投影恢复后再开始研判" : "投影恢复后再展开冻结卷宗";
  }
  if (busy) return column === "decision" ? "正在准备研判区" : "正在铺开冻结卷宗";
  return column === "decision" ? "当前筛选没有可研判的变量。" : "当前筛选没有可展开的卷宗。";
}

export function radarCardIndicatorLabel({ selected = false, viewReady = false } = {}) {
  if (viewReady) return null;
  return selected ? "正在读取雷达指标" : "点击查看雷达指标";
}

export function radarCardSummaryLabel({ selected = false, view = null } = {}) {
  const summary = view?.uncertainties?.[0] || view?.expectationGap;
  if (summary) return summary;
  return selected ? "正在整理事前边界" : "点击查看事前边界";
}

export function shouldResetRadarDateFilter({ dateFilter, dateOptions, dataReady = true } = {}) {
  if (!dataReady || dateFilter === "all") return false;
  return !array(dateOptions).some((option) => option?.id === dateFilter);
}

export function filterRadarCardsByJudgment(cards, label = "all") {
  if (label === "all") return array(cards);
  return array(cards).filter(
    (card) =>
      card?.systemSuggestion?.authority === "SYSTEM_SUGGESTION" &&
      card.systemSuggestion.label === label,
  );
}

export function filterRadarCardsByRedTeam(cards, enabled = false) {
  if (!enabled) return array(cards);
  return array(cards).filter((card) => array(card?.counterEvidence).length > 0);
}

const RADAR_JUDGMENT_FILTERS = new Set(["all", "TRADABLE", "WATCH", "NOT_TRADABLE"]);

export function createRadarUiState() {
  return Object.freeze({
    sortDirection: "newest",
    dateFilter: "all",
    judgmentFilter: "all",
    sourceFilter: "all",
    redTeamOnly: false,
  });
}

export function hydrateRadarUiState(value) {
  const source = value && typeof value === "object" ? value : {};
  const sortDirection = source.sortDirection === "oldest" ? "oldest" : "newest";
  const rawDateFilter = String(source.dateFilter || "");
  const dateFilter = rawDateFilter === "all" || /^\d{4}-\d{2}-\d{2}$/u.test(rawDateFilter)
    ? rawDateFilter
    : "all";
  const judgmentFilter = RADAR_JUDGMENT_FILTERS.has(source.judgmentFilter)
    ? source.judgmentFilter
    : "all";
  return Object.freeze({
    sortDirection,
    dateFilter,
    judgmentFilter,
    sourceFilter: RADAR_SOURCE_FILTERS.some((option) => option.id === source.sourceFilter) ? source.sourceFilter : "all",
    redTeamOnly: source.redTeamOnly === true,
  });
}

export function radarUiReducer(current, action = {}) {
  const state = hydrateRadarUiState(current);
  if (action.type === "set-sort") {
    return hydrateRadarUiState({ ...state, sortDirection: action.value });
  }
  if (action.type === "set-date") {
    return hydrateRadarUiState({ ...state, dateFilter: action.value });
  }
  if (action.type === "set-judgment") {
    return hydrateRadarUiState({ ...state, judgmentFilter: action.value });
  }
  if (action.type === "set-source") {
    return hydrateRadarUiState({ ...state, sourceFilter: action.value });
  }
  if (action.type === "toggle-red-team") {
    return hydrateRadarUiState({ ...state, redTeamOnly: !state.redTeamOnly });
  }
  return state;
}

export function sortRadarCards(cards, pinnedIds = [], direction = "newest") {
  const pinned = new Set(pinnedIds);
  const factor = direction === "oldest" ? 1 : -1;
  return array(cards)
    .map((card, index) => ({
      card,
      index,
      pinned: pinned.has(cardId(card)),
      time: Date.parse(cardTimeMeta(card).iso || ""),
    }))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      const leftMissing = !Number.isFinite(left.time);
      const rightMissing = !Number.isFinite(right.time);
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (!leftMissing && left.time !== right.time) return (left.time - right.time) * factor;
      const rankDifference = Number(left.card?.rank || 0) - Number(right.card?.rank || 0);
      return rankDifference || left.index - right.index;
    })
    .map(({ card }) => card);
}

function boundedRadarLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

export function buildResearchHostRadarIndex(cards, {
  watermark = null,
  scannedAt = null,
} = {}) {
  return Object.freeze(sortRadarCards(array(cards), [], "newest")
    .map((card) => {
      const id = cardId(card);
      if (!id) return null;
      const time = cardTimeMeta(card);
      const summary = cleanDisplayText(card?.eventSummary, "变量摘要待补充").slice(0, 240);
      const title = cleanDisplayText(
        card?.variableIdentityKey || card?.variableTitle || card?.title || summary,
        "变量卷宗",
      ).slice(0, 120);
      const suggestion = card?.systemSuggestion?.authority === "SYSTEM_SUGGESTION"
        ? String(card.systemSuggestion.label || "").toUpperCase()
        : "UNCLASSIFIED";
      const keywords = [
        title,
        summary,
        card?.variableId,
        card?.variableIdentityKey,
        card?.catalystIdentityKey,
        card?.expectationGap,
        card?.whyTradable,
        ...array(card?.uncertainties),
        ...array(card?.counterEvidence),
        ...array(card?.themes).flatMap((theme) => [theme?.narrative, theme?.themeRef]),
        ...array(card?.securities).flatMap((security) => [
          security?.securityName,
          security?.name,
          security?.securityCode,
          security?.code,
        ]),
      ]
        .map((value) => cleanDisplayText(value, "").slice(0, 160))
        .filter(Boolean);
      return Object.freeze({
        cardId: String(id),
        title,
        summary,
        updatedAt: time.iso,
        timeLabel: time.label,
        variableId: String(card?.variableId || "") || null,
        variableIdentityKey: cleanDisplayText(
          card?.variableIdentityKey || card?.variableTitle || title,
          title,
        ).slice(0, 240),
        catalystIdentityKey: cleanDisplayText(card?.catalystIdentityKey, "").slice(0, 240) || null,
        revision: Number.isFinite(Number(card?.revision))
          ? Math.max(1, Math.floor(Number(card.revision)))
          : 1,
        evidenceHashes: Object.freeze(radarEvidenceHashes(card).slice(0, 16)),
        eventKey: radarEventIdentity(card),
        watermark: String(card?.asOfWatermark || watermark || "").slice(0, 256) || null,
        materialAt: radarMaterialAt(card),
        scannedAt: time.iso || latestResearchInstant([scannedAt]),
        suggestion,
        suggestionLabel: suggestion === "UNCLASSIFIED" ? "待确认" : translateStatus(suggestion),
        searchText: keywords.join(" ").toLocaleLowerCase("zh-CN").slice(0, 2_000),
        sourceNamespaces: Object.freeze(array(card?.sourceNamespaces).filter(value => typeof value === "string")),
        tier: card?.tier === "MUST_REVIEW" ? "MUST_REVIEW" : "NORMAL",
      });
    })
    .filter(Boolean));
}

const RESEARCH_HOST_AGENT_RADAR_MAX_ITEMS = 20;
const RESEARCH_HOST_AGENT_RADAR_MAX_BYTES = 24 * 1024;

function compactResearchHostAgentRadarEntry(entry) {
  const cardId = cleanDisplayText(entry?.cardId, "").slice(0, 200);
  const title = cleanDisplayText(entry?.title, "").slice(0, 160);
  if (!cardId || !title) return null;
  return Object.freeze({
    cardId,
    title,
    summary: cleanDisplayText(entry?.summary, "").slice(0, 400),
    updatedAt: cleanDisplayText(entry?.updatedAt, "").slice(0, 80) || null,
    timeLabel: cleanDisplayText(entry?.timeLabel, "").slice(0, 80) || null,
    suggestion: cleanDisplayText(entry?.suggestion, "").slice(0, 40) || "UNCLASSIFIED",
    suggestionLabel: cleanDisplayText(entry?.suggestionLabel, "").slice(0, 80) || "待确认",
    variableId: cleanDisplayText(entry?.variableId, "").slice(0, 200) || null,
    variableIdentityKey: cleanDisplayText(entry?.variableIdentityKey || title, title).slice(0, 240),
    catalystIdentityKey: cleanDisplayText(entry?.catalystIdentityKey, "").slice(0, 240) || null,
    revision: Number.isFinite(Number(entry?.revision))
      ? Math.max(1, Math.floor(Number(entry.revision)))
      : 1,
    evidenceHashes: Object.freeze(array(entry?.evidenceHashes)
      .map((hash) => String(hash || "").toLowerCase())
      .filter((hash) => /^[a-f0-9]{64}$/u.test(hash))
      .slice(0, 16)),
    watermark: cleanDisplayText(entry?.watermark, "").slice(0, 256) || null,
    materialAt: cleanDisplayText(entry?.materialAt, "").slice(0, 80) || null,
    scannedAt: cleanDisplayText(entry?.scannedAt || entry?.updatedAt, "").slice(0, 80) || null,
  });
}

export function buildResearchHostAgentRadarContext(radarIndex, {
  currentCardId = null,
} = {}) {
  const source = array(radarIndex);
  const currentId = cleanDisplayText(currentCardId, "").slice(0, 200);
  const current = currentId
    ? source.find((entry) => String(entry?.cardId || "") === currentId)
    : null;
  const candidates = current ? [current, ...source] : source;
  const selected = [];
  const seen = new Set();
  const encoder = new TextEncoder();
  for (const candidate of candidates) {
    const compact = compactResearchHostAgentRadarEntry(candidate);
    if (!compact || seen.has(compact.cardId)) continue;
    const nextBytes = encoder.encode(JSON.stringify([...selected, compact])).byteLength;
    if (nextBytes > RESEARCH_HOST_AGENT_RADAR_MAX_BYTES) continue;
    selected.push(compact);
    seen.add(compact.cardId);
    if (selected.length >= RESEARCH_HOST_AGENT_RADAR_MAX_ITEMS) break;
  }
  const sourceOrder = new Map(source.map((entry, index) => [String(entry?.cardId || ""), index]));
  selected.sort((left, right) => (
    (sourceOrder.get(left.cardId) ?? Number.MAX_SAFE_INTEGER)
    - (sourceOrder.get(right.cardId) ?? Number.MAX_SAFE_INTEGER)
  ));
  return Object.freeze(selected);
}

export function getResearchHostRadarOverview(radarIndex, { limit = 3 } = {}) {
  const index = array(radarIndex);
  const latestLimit = boundedRadarLimit(limit, 3, 10);
  const suggestionCounts = {
    TRADABLE: 0,
    WATCH: 0,
    NOT_TRADABLE: 0,
    UNCLASSIFIED: 0,
  };
  for (const entry of index) {
    const label = Object.hasOwn(suggestionCounts, entry?.suggestion)
      ? entry.suggestion
      : "UNCLASSIFIED";
    suggestionCounts[label] += 1;
  }
  return Object.freeze({
    total: index.length,
    latest: Object.freeze(index.slice(0, latestLimit)),
    suggestionCounts: Object.freeze(suggestionCounts),
  });
}

function radarSearchTerms(value) {
  return cleanDisplayText(value, "")
    .toLocaleLowerCase("zh-CN")
    .replace(/(?:或者|或|、|，|,|\/)/gu, " ")
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8);
}

export function searchResearchHostRadar(radarIndex, { query = "", limit = 8 } = {}) {
  const terms = radarSearchTerms(String(query).slice(0, 80));
  if (!terms.length) return Object.freeze([]);
  const resultLimit = boundedRadarLimit(limit, 8, 10);
  return Object.freeze(array(radarIndex)
    .map((entry, index) => {
      const title = String(entry?.title || "").toLocaleLowerCase("zh-CN");
      const summary = String(entry?.summary || "").toLocaleLowerCase("zh-CN");
      const searchText = String(entry?.searchText || "").toLocaleLowerCase("zh-CN");
      let score = 0;
      for (const term of terms) {
        if (!searchText.includes(term)) continue;
        score += title.includes(term) ? 6 : summary.includes(term) ? 4 : 2;
      }
      return { entry, index, score };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, resultLimit)
    .map(({ entry }) => entry));
}

export function resolveResearchHostDossierTarget(
  radarIndex,
  { query = "", preferLatest = false } = {},
) {
  const normalizedQuery = cleanDisplayText(query, "").slice(0, 80);
  const matches = searchResearchHostRadar(radarIndex, {
    query: normalizedQuery,
    limit: 10,
  });
  if (!matches.length) {
    return Object.freeze({
      status: "NOT_FOUND",
      target: null,
      candidates: Object.freeze([]),
    });
  }
  const exactTitleMatches = matches.filter((entry) => (
    String(entry?.title || "").toLocaleLowerCase("zh-CN") ===
    normalizedQuery.toLocaleLowerCase("zh-CN")
  ));
  const target = exactTitleMatches.length === 1
    ? exactTitleMatches[0]
    : matches.length === 1 || preferLatest === true
      ? matches[0]
      : null;
  return Object.freeze({
    status: target ? "MATCH" : "AMBIGUOUS",
    target,
    candidates: Object.freeze((target ? [target] : matches.slice(0, 5))),
  });
}

export function cardId(card) {
  return card?.cardRevisionId || card?.taskId || card?.itemId || card?.id || null;
}

export function normalizeNarrationPreference(value = {}) {
  return Object.freeze({
    enabled: value?.enabled === true,
    scope: value?.scope === "must-review" ? "must-review" : "all",
  });
}

export function resolveNarrationBackend({ hostAvailable = false, browserAvailable = false, hostBackend = "macos-say" } = {}) {
  if (hostAvailable === true) return hostBackend === "kokoro-local" ? "kokoro-local" : "macos-say";
  if (browserAvailable === true) return "browser";
  return null;
}

function parseResearchHostInline(value) {
  const source = String(value || "");
  const tokens = [];
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/giu;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = Number(match.index || 0);
    if (index > cursor) tokens.push({ type: "text", text: source.slice(cursor, index) });
    if (match[1] !== undefined) tokens.push({ type: "strong", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: "code", text: match[2] });
    else tokens.push({ type: "link", text: match[3], href: match[4] });
    cursor = index + match[0].length;
  }
  if (cursor < source.length) tokens.push({ type: "text", text: source.slice(cursor) });
  return tokens.length ? tokens : [{ type: "text", text: source }];
}

function researchHostMarkdownLineType(line) {
  if (/^\s{0,3}#{1,3}\s+\S/u.test(line)) return "heading";
  if (/^\s{0,3}[-*+]\s+\S/u.test(line)) return "unordered-list";
  if (/^\s{0,3}\d+[.)]\s+\S/u.test(line)) return "ordered-list";
  if (/^\s{0,3}>\s?\S/u.test(line)) return "blockquote";
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) return "separator";
  return "paragraph";
}

function researchTableCells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = []; let cell = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; }
    else if (text[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += text[i];
  }
  cells.push(cell.trim()); return cells;
}
function researchTableStart(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const head = researchTableCells(lines[index]), rule = researchTableCells(lines[index + 1]);
  return head.length > 1 && head.length === rule.length && rule.every(c => /^:?-{3,}:?$/.test(c));
}

export function parseResearchHostMarkdown(value) {
  const lines = String(value || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (researchTableStart(lines, index)) {
      const head = researchTableCells(line), rule = researchTableCells(lines[index + 1]);
      const rows = []; index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|') && researchHostMarkdownLineType(lines[index]) === 'paragraph') {
        const cells = researchTableCells(lines[index++]);
        rows.push(head.map((_, i) => parseResearchHostInline(cells[i] || '')));
      }
      blocks.push({ type: 'table', header: head.map(parseResearchHostInline), align: rule.map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'), rows });
      continue;
    }
    const type = researchHostMarkdownLineType(line);
    if (type === "heading") {
      const match = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/u);
      blocks.push({
        type,
        level: match[1].length,
        content: parseResearchHostInline(match[2]),
      });
      index += 1;
      continue;
    }
    if (type === "unordered-list" || type === "ordered-list") {
      const items = [];
      const matcher = type === "unordered-list"
        ? /^\s{0,3}[-*+]\s+(.+)$/u
        : /^\s{0,3}\d+[.)]\s+(.+)$/u;
      while (index < lines.length) {
        const match = lines[index].match(matcher);
        if (!match) break;
        items.push(parseResearchHostInline(match[1].trim()));
        index += 1;
      }
      blocks.push({ type, items });
      continue;
    }
    if (type === "blockquote") {
      const quoted = [];
      while (index < lines.length && researchHostMarkdownLineType(lines[index]) === "blockquote") {
        quoted.push(lines[index].replace(/^\s{0,3}>\s?/u, "").trim());
        index += 1;
      }
      blocks.push({ type, content: parseResearchHostInline(quoted.join(" ")) });
      continue;
    }
    if (type === "separator") {
      blocks.push({ type });
      index += 1;
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length
      && lines[index].trim()
      && researchHostMarkdownLineType(lines[index]) === "paragraph"
      && !researchTableStart(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", content: parseResearchHostInline(paragraph.join(" ")) });
  }
  return blocks;
}

export function normalizeResearchHostPresentation(value, fallbackText = "", final = false) {
  const supplied = value && typeof value === "object";
  const text = String(supplied ? typeof value.text === "string" ? value.text : "" : fallbackText)
    .replace(/[\p{Cf}\u0000]/gu, "");
  const spokenText = supplied && typeof value.spokenText === "string" ? value.spokenText.trim() : "";
  const ready = value?.version === 1 && value?.speechStatus === "ready"
    && Boolean(text.trim()) && spokenText.length > 0 && spokenText.length <= 600;
  return Object.freeze({ version: 1, text, spokenText: ready ? spokenText : "",
    speechStatus: ready ? "ready" : !final && value?.version === 1 && value?.speechStatus === "pending"
      ? "pending" : "unavailable" });
}

// Recovery never borrows an older answer for a newer unanswered question.
export function researchHostRecoveryState(host = {}, voice = {}, narration = {}) {
  const log = array(host.sessionLog);
  const userIndex = log.findLastIndex(item => item.kind === "user");
  const question = voice.question || log[userIndex]?.text || "";
  const assistant = userIndex < 0 ? null : log.slice(userIndex + 1).findLast(item => item.kind === "assistant");
  const answer = voice.question ? voice.answer || "" : assistant?.text || "";
  const activeSpeechMode = voice.question && voice.speechMode || host.speechMode || voice.speechMode;
  const speechMode = activeSpeechMode === "contextual-v1" ? "contextual-v1" : "legacy";
  const presentation = voice.question
    ? normalizeResearchHostPresentation({ version: 1, text: answer, spokenText: voice.spokenAnswer,
      speechStatus: voice.speechStatus })
    : normalizeResearchHostPresentation(assistant?.presentation, answer, true);
  const spokenAnswer = speechMode === "contextual-v1" ? presentation.spokenText : answer;
  const speechStatus = speechMode === "contextual-v1" ? presentation.speechStatus : answer ? "ready" : "unavailable";
  const busy = Boolean(host.nativeActive || host.pendingTool
    || ["listening", "thinking", "answering"].includes(voice.phase)
    || log.at(-1)?.status === "cancel-requested");
  const audioActive = Boolean(narration.active || narration.queue?.length
    || ["speaking", "paused", "stopping"].includes(narration.status));
  return { question, answer, spokenAnswer, speechMode, speechStatus, audioActive,
    canContinue: Boolean(host.sessionId && question && !busy && !audioActive),
    canReplay: Boolean(spokenAnswer && !busy && !audioActive && narration.supported) };
}

export function splitResearchHostSpeechChunks(value) {
  const chunks = [];
  let chunk = "";
  for (const character of String(value || "")) {
    if (chunk.length + character.length > 800) { chunks.push(chunk); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const SPEECH_DIGITS = "零一二三四五六七八九";
const speechDigits = text => [...text].map(digit => SPEECH_DIGITS[Number(digit)]).join("");

function speechInteger(text) {
  let value = Number(text);
  if (value === 0) return "零";
  const groups = [];
  while (value) { groups.unshift(value % 10000); value = Math.floor(value / 10000); }
  let words = "";
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    if (words && (group < 1000 || groups[index - 1] === 0)) words += "零";
    let section = "", pendingZero = false;
    for (let power = 3; power >= 0; power -= 1) {
      const digit = Math.floor(group / 10 ** power) % 10;
      if (!digit) { if (section) pendingZero = true; continue; }
      if (pendingZero) section += "零";
      section += SPEECH_DIGITS[digit] + ["", "十", "百", "千"][power];
      pendingZero = false;
    }
    words += section + ["", "万", "亿"][groups.length - index - 1];
  }
  return words.replace(/^一十/u, "十");
}

// Speech-only, context-bound normalization; never rewrite evidence or guess a
// security name's pronunciation with homophone characters. Decimal digits stay exact.
export function researchHostChineseSpeechText(value) {
  const number = (raw) => {
    const sign = raw.startsWith("-") ? "负" : raw.startsWith("+") ? "正" : "";
    const [integer, fraction] = raw.replace(/^[+-]/u, "").replaceAll(",", "").split(".");
    if (integer.length > 12) return null;
    return sign + speechInteger(integer) + (fraction ? `点${speechDigits(fraction)}` : "");
  };
  return String(value || "")
    .replace(/(?<![a-z0-9_])(sh|sz|bj)(\d{6})(?![a-z0-9_])/giu,
      (_, exchange, code) => `${{ sh: "沪市", sz: "深市", bj: "北交所" }[exchange.toLowerCase()]}代码${speechDigits(code)}`)
    .replace(/((?:股票|证券)代码[：: ]*)(\d{6})(?!\d)/gu, (_, label, code) => label + speechDigits(code))
    .replace(/(?<![\w.,+-])([+-]?\d{1,12}(?:\.\d{1,8})?)%/gu, (match, raw) => {
      const spoken = number(raw);
      return spoken ? spoken.replace(/^([正负]?)(.*)$/u, "$1百分之$2") : match;
    })
    .replace(/(?<![\w.,+-])([+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.\d{1,8})?)\s*(万亿元|亿元|万元|元|倍|个百分点|百分点)/gu,
      (match, raw, unit) => { const spoken = number(raw); return spoken ? spoken + unit : match; });
}

export function researchHostSpeechText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/giu, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
    .replace(/^\s{0,3}[-*+]\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/[\*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function narrationCardMatchesScope(card, scope = "all") {
  if (!cardId(card)) return false;
  return scope !== "must-review" || card?.tier === "MUST_REVIEW";
}

export function newestNarrationCard(cards) {
  return array(cards)
    .map((card, index) => ({
      card,
      index,
      time: Date.parse(cardTimeMeta(card).iso || ""),
    }))
    .filter(({ card }) => Boolean(cardId(card)))
    .sort((left, right) => {
      const leftMissing = !Number.isFinite(left.time);
      const rightMissing = !Number.isFinite(right.time);
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (!leftMissing && left.time !== right.time) return right.time - left.time;
      return left.index - right.index;
    })[0]?.card || null;
}

function variableIdentityOf(card) {
  return card?.variableId || cardId(card);
}

export function resolveRadarSelection(nextCards, previousCards, selectedCardId) {
  const next = array(nextCards);
  if (!next.length) return null;
  const exact = next.find((card) => cardId(card) === selectedCardId);
  if (exact) return cardId(exact);
  const previous = array(previousCards).find(
    (card) => cardId(card) === selectedCardId,
  );
  const previousIdentity = variableIdentityOf(previous);
  if (previousIdentity) {
    const sameVariable = next.find(
      (card) => variableIdentityOf(card) === previousIdentity,
    );
    if (sameVariable) return cardId(sameVariable);
  }
  const sameCatalyst = next.find((card) =>
    sameCatalystMainline(previous, card),
  );
  if (sameCatalyst) return cardId(sameCatalyst);
  return cardId(next[0]);
}

export function resolveRadarFilterSelection(visibleCards, selectedCardId) {
  const visible = array(visibleCards);
  if (selectedCardId && visible.some((card) => cardId(card) === selectedCardId)) {
    return selectedCardId;
  }
  return cardId(visible[0]);
}

export function groupTimeline(nodes) {
  const grouped = new Map(TIMELINE_STAGES.map((stage) => [stage.id, []]));
  for (const node of array(nodes)) {
    grouped.get(stageIdOf(node)).push(node);
  }
  return TIMELINE_STAGES.map((stage) => {
    const stageNodes = grouped.get(stage.id);
    const first = stageNodes[0] || null;
    return {
      ...stage,
      nodes: stageNodes,
      state: stageState(stageNodes),
      date: first?.eventAt || null,
      statusLabel: stageNodes.length
        ? first.state === "COMPLETE"
          ? "已完成"
          : first.state === "SCHEDULED"
            ? "已排期"
            : first.state === "PENDING"
              ? "待到期"
              : "整理中"
        : "待补证据",
    };
  });
}

export function selectTimelineEvidence(view, activeStageId, activeNodeId = null) {
  const stages = array(view?.stages);
  const stage = stages.find((item) => item.id === activeStageId) || stages[0] || {
    id: "source",
    label: "源事件",
    nodes: [],
  };
  const activeNode = array(stage.nodes).find((node) => node.id === activeNodeId) || null;
  const selectedNodes = activeNode ? [activeNode] : array(stage.nodes);
  const linkedIds = new Set(
    selectedNodes.flatMap((node) => array(node.evidenceIds)),
  );
  const evidence = array(view?.evidence).filter((item) => linkedIds.has(item.id));
  const states = new Set(selectedNodes.map((node) => node.state));
  const emptyLabel = states.has("PENDING")
    ? `${stage.label} 检查点尚未到期；不会重复展示旧证据。`
    : states.has("SCHEDULED")
      ? `${stage.label}已排期；正式揭晓后显示冻结结果。`
      : `${stage.label}阶段尚无冻结引用。`;
  return { stage, activeNode, evidence, emptyLabel };
}

export function buildResearchHostContext({
  view,
  local = {},
  radarIndex = [],
  activeStageId,
  activeTimelineNodeId = null,
  projectionStatus = null,
  allowGlobal = false,
  readScope = null,
  personal = false,
} = {}) {
  const normalizedProjectionStatus = String(projectionStatus || "UNKNOWN");
  const ima = readScope?.coverage === "SELECTED_IMA_DOCUMENT";
  const radar = getResearchHostRadarOverview(radarIndex, { limit: 3 });
  if (!view?.id) {
    if (!allowGlobal) return null;
    const scopeKey = [
      "global",
      ...(personal ? ["personal"] : []),
      normalizedProjectionStatus,
      radar.total,
      radar.latest.map((entry) => entry.cardId).join(","),
      ...(ima ? [readScope.evidenceId] : []),
    ].join(":");
    return Object.freeze({
      schema: "research-host-context-v1",
      ...(personal ? { personal: true } : {}),
      ...(ima ? { readScope } : {}),
      scopeKey,
      contextKey: `${scopeKey}:global-read-only`,
      cardId: "global",
      variableTitle: ima ? "所选 IMA 资料" : personal ? "个人研究" : "全局研究",
      variableId: null,
      variableIdentityKey: "global-research",
      catalystIdentityKey: null,
      revision: 1,
      evidenceHashes: Object.freeze([]),
      watermark: null,
      materialAt: null,
      scannedAt: null,
      stage: Object.freeze({ id: "source", label: personal ? "个人研究" : "全局研究", statusLabel: "只读检索" }),
      timelineNode: null,
      visibleEvidenceIds: Object.freeze([]),
      visibleEvidenceCount: 0,
      includedEvidenceIds: Object.freeze([]),
      includedEvidenceCount: 0,
      radar,
      projectionStatus: normalizedProjectionStatus,
      summary: ima ? `所选 IMA 资料共形成 ${radar.total} 个个人变量；历史版本未知。`
        : personal ? `尚未选择参考卡片；个人雷达共 ${radar.total} 个变量。`
          : `已建立全局研究上下文；全局雷达共 ${radar.total} 个变量，可检索未成卡的原始微信舆情。`,
    });
  }
  const { stage, activeNode, evidence } = selectTimelineEvidence(
    view,
    activeStageId,
    activeTimelineNodeId,
  );
  const visibleEvidenceIds = array(evidence)
    .map((item) => String(item?.id || ""))
    .filter(Boolean);
  const includedEvidenceIds = new Set(array(local?.evidenceIds).map(String));
  const includedVisibleEvidenceIds = visibleEvidenceIds.filter((id) => includedEvidenceIds.has(id));
  const includedEvidenceCount = includedVisibleEvidenceIds.length;
  const variableTitle = cleanDisplayText(view.title, "当前变量");
  const stageLabel = cleanDisplayText(stage?.label, "当前阶段");
  const nodeLabel = activeNode
    ? cleanDisplayText(
      activeNode.title || activeNode.label || activeNode.eventLabel || activeNode.nodeType,
      `${stageLabel}节点`,
    )
    : `${stageLabel}全部节点`;
  const timelineNode = activeNode ? Object.freeze({
    id: String(activeNode.id),
    label: nodeLabel,
    dateLabel: cleanDisplayText(
      activeNode.dateLabel || activeNode.eventAt || activeNode.availableAt || activeNode.recordedAt,
      "时间待确认",
    ),
  }) : null;
  const scopeKey = [
    view.id,
    view.eventIdentity || "identity-unknown",
    stage?.id || "source",
    timelineNode?.id || "all",
    normalizedProjectionStatus,
    visibleEvidenceIds.join(","),
    ...(ima ? [readScope.evidenceId] : []),
  ].join(":");
  const contextKey = [
    scopeKey,
    includedVisibleEvidenceIds.join(","),
    radar.total,
    radar.latest.map((entry) => entry.cardId).join(","),
  ].join(":");
  return Object.freeze({
    schema: "research-host-context-v1",
    ...(personal ? { personal: true } : {}),
    ...(ima ? { readScope } : {}),
    scopeKey,
    contextKey,
    cardId: String(view.id),
    variableTitle,
    variableId: String(view.variableId || "") || null,
    variableIdentityKey: cleanDisplayText(view.variableIdentityKey || variableTitle, variableTitle),
    catalystIdentityKey: cleanDisplayText(view.catalystIdentityKey, "") || null,
    revision: Number.isFinite(Number(view.revision))
      ? Math.max(1, Math.floor(Number(view.revision)))
      : 1,
    evidenceHashes: Object.freeze(radarEvidenceHashes(view).slice(0, 16)),
    watermark: String(view.watermark || "").slice(0, 256) || null,
    materialAt: latestResearchInstant([view.materialAt]),
    scannedAt: latestResearchInstant([view.scannedAt]),
    stage: Object.freeze({
      id: String(stage?.id || "source"),
      label: stageLabel,
      statusLabel: cleanDisplayText(stage?.statusLabel || stage?.hint, "待确认"),
    }),
    timelineNode,
    visibleEvidenceIds: Object.freeze(visibleEvidenceIds),
    visibleEvidenceCount: visibleEvidenceIds.length,
    includedEvidenceIds: Object.freeze(includedVisibleEvidenceIds),
    includedEvidenceCount,
    radar,
    projectionStatus: normalizedProjectionStatus,
    summary: `已读取${variableTitle}，当前位于${stageLabel}${activeNode ? `的${nodeLabel}` : ""}，可见 ${visibleEvidenceIds.length} 条证据${ima ? `；所选 IMA 资料共形成 ${radar.total} 个个人变量，历史版本未知` : radar.total ? `；全局雷达共 ${radar.total} 个变量` : ""}。`,
  });
}

// Only deliberate navigation invalidates an active conversation. Projection and
// evidence refreshes still invalidate write confirmations through scopeKey.
export function researchHostConversationKey({ selectedCardId, stageId, nodeId } = {}) {
  return JSON.stringify([selectedCardId || "global", stageId || "source", nodeId || null]);
}

export function scopeResearchHostQuestionContext(context = {}) {
  if (context.projectionStatus === "COMPLETE") return context;
  return {
    cardId: "global", title: "全局研究", stageId: "source", stageLabel: "全局研究",
    projectionStatus: context.projectionStatus || "UNKNOWN", evidence: [],
    ...(context.watchMemory ? { watchMemory: context.watchMemory } : {}),
    summary: "投影暂不可用，不引用缓存卷宗。仍可查询独立的微信舆情、本地资料和公开网络；卷宗研判及映射暂停。",
  };
}

export const RESEARCH_HOST_TOOL_POLICIES = Object.freeze({
  draftWatch: Object.freeze({ authority: "READ_ONLY", label: "准备关注草案", runningLabel: "正在准备关注草案，等待页面确认启用" }),
  vos_ask: Object.freeze({ authority: "READ_ONLY", label: "检索本地研究资料", runningLabel: "DSH 正在检索本地多源资料" }),
  vos_liudu_search: Object.freeze({ authority: "READ_ONLY", label: "检索六度资料", runningLabel: "DSH 正在检索六度资料" }),
  web_search: Object.freeze({ authority: "READ_ONLY", label: "联网搜索", runningLabel: "DSH 正在搜索公开网络资料" }),
  web_fetch: Object.freeze({ authority: "READ_ONLY", label: "读取网页原文", runningLabel: "DSH 正在读取网页原文" }),
  radarOverview: Object.freeze({
    authority: "READ_ONLY",
    label: "读取全局雷达",
    runningLabel: "正在汇总全局雷达与最新变量",
  }),
  searchRadar: Object.freeze({
    authority: "READ_ONLY",
    label: "搜索全局卷宗",
    runningLabel: "正在跨卷宗搜索股票、主题和变量",
  }),
  wechatRawSearch: Object.freeze({
    authority: "READ_ONLY",
    label: "检索微信舆情",
    runningLabel: "正在检索微信整理文件与本机 Radar",
  }),
  openDossier: Object.freeze({
    authority: "READ_ONLY",
    label: "打开指定卷宗",
    runningLabel: "正在定位并打开指定变量卷宗",
  }),
  marketPulse: Object.freeze({
    authority: "READ_ONLY",
    label: "读取实时行情",
    runningLabel: "正在读取实时价格、涨跌幅与分时异动",
  }),
  expandEvidence: Object.freeze({
    authority: "READ_ONLY",
    label: "展开当前引用",
    runningLabel: "正在读取完整受控引用",
  }),
  switchCard: Object.freeze({
    authority: "READ_ONLY",
    label: "切换下一卷",
    runningLabel: "正在切换变量卷宗",
  }),
  deepResearch: Object.freeze({
    authority: "READ_ONLY",
    label: "联网补证",
    runningLabel: "正在调用 Trading Wiki Deep Research",
  }),
  draftJudgment: Object.freeze({
    authority: "CONFIRM_BEFORE_RUN",
    label: "生成研判草稿",
    runningLabel: "正在生成可编辑研判草稿",
  }),
});

const WECHAT_RADAR_INTENT = /(?:微信\s*(?:Radar|雷达)|Radar\s*(?:舆情|微信)|雷达舆情|本机(?:的)?微信舆情)/iu;
const WECHAT_RAW_INTENT = /(?:原始(?:聊天|微信)|整理后的(?:微信)?(?:聊天|文件)|微信聊天文件|raw)/iu;
const WECHAT_BOTH_INTENT = /(?:两个|两边|两种|都查|同时|对比|合并).*(?:微信|舆情|聊天)|(?:微信|舆情|聊天).*(?:两个|两边|两种|都查|同时|对比|合并)/iu;
const WECHAT_RESEARCH_TOPIC = /(?:微信|wechat)\s*概念(?:股|板块)?/giu;

export function detectResearchHostWechatChannel(question) {
  // Keep topic mentions out of source routing, in parity with the Host guard.
  const text = cleanDisplayText(question, "").slice(0, 500).replace(WECHAT_RESEARCH_TOPIC, " ");
  if (!text || !/(?:微信|wechat|舆情|聊天)/iu.test(text)) return null;
  if (WECHAT_BOTH_INTENT.test(text) || (WECHAT_RADAR_INTENT.test(text) && WECHAT_RAW_INTENT.test(text))) {
    return "both";
  }
  if (WECHAT_RADAR_INTENT.test(text)) return "radar";
  if (WECHAT_RAW_INTENT.test(text)) return "raw";
  if (/(?:微信|wechat|舆情)/iu.test(text)) return "both";
  return null;
}

export function extractResearchHostWechatQuery(question) {
  const text = cleanDisplayText(question, "").slice(0, 500);
  return text
    .replace(/(?:帮我|请|直接|查一下|查询|查|搜索|看看|读取|读一下|找一下|里面|里|的|中的|我的)/gu, " ")
    .replace(/(?:微信(?!\s*概念)\s*(?:Radar|雷达)?\s*(?:舆情|聊天|原始文件)?|Radar\s*(?:舆情|微信)?|雷达舆情|原始(?:聊天|微信)(?:文件|数据)?|整理后的(?:微信)?(?:聊天|文件)?|微信聊天文件|raw)/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120) || text;
}

export function createResearchHostToolRequest({
  toolId,
  context,
  requestId,
  args = {},
} = {}) {
  const policy = RESEARCH_HOST_TOOL_POLICIES[toolId];
  if (!policy) throw new TypeError(`${String(toolId || "未知工具")}不在研究主持人工具白名单`);
  if (!context?.contextKey || !context?.cardId) throw new TypeError("研究主持人缺少当前卷宗上下文");
  const id = String(requestId || "").trim();
  if (!id) throw new TypeError("研究主持人工具请求缺少 requestId");
  const normalizedArgs = toolId === "switchCard"
    ? Object.freeze({ direction: args?.direction === "previous" ? "previous" : "next" })
    : toolId === "radarOverview"
      ? Object.freeze({ limit: boundedRadarLimit(args?.limit, 3, 10) })
        : toolId === "searchRadar"
          ? Object.freeze({
              query: cleanDisplayText(args?.query, "").slice(0, 80),
              limit: boundedRadarLimit(args?.limit, 8, 10),
            })
          : toolId === "wechatRawSearch"
            ? Object.freeze({
                query: cleanDisplayText(args?.query, "").slice(0, 120),
                channel: args?.channel === "radar" || args?.channel === "both" ? args.channel : "raw",
                limit: boundedRadarLimit(args?.limit, 5, 8),
                ...(typeof args?.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(args.dateFrom)
                  ? { dateFrom: args.dateFrom }
                  : {}),
                ...(typeof args?.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(args.dateTo)
                  ? { dateTo: args.dateTo }
                  : {}),
              })
          : toolId === "openDossier"
          ? Object.freeze({
              query: cleanDisplayText(args?.query, "").slice(0, 80),
              preferLatest: args?.preferLatest === true,
            })
          : toolId === "marketPulse"
            ? Object.freeze({ query: cleanDisplayText(args?.query, "").slice(0, 80) })
            : Object.freeze({});
  return Object.freeze({
    id,
    toolId,
    label: policy.label,
    runningLabel: policy.runningLabel,
    authority: policy.authority,
    contextKey: context.contextKey,
    scopeKey: context.scopeKey || context.contextKey,
    cardId: String(context.cardId),
    args: normalizedArgs,
  });
}

function replaceResearchHostReceipt(receipts, requestId, next) {
  return Object.freeze(array(receipts).map((receipt) => receipt.id === requestId
    ? Object.freeze({ ...receipt, ...next })
    : receipt));
}

function appendResearchHostReceipt(receipts, receipt) {
  return Object.freeze([...array(receipts).slice(-5), Object.freeze(receipt)]);
}

function upsertResearchHostReceipt(receipts, receipt) {
  return array(receipts).some((item) => item.id === receipt.id)
    ? replaceResearchHostReceipt(receipts, receipt.id, receipt)
    : appendResearchHostReceipt(receipts, receipt);
}

function appendResearchHostSessionLog(entries, entry) {
  const next = array(entries).filter((item) => item.id !== entry.id);
  return Object.freeze([...next.slice(-79), Object.freeze(entry)]);
}

export function createResearchHostNativeNavigationGuard({
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  settleMs = 450,
  maxMs = 4_000,
} = {}) {
  let targetCardId = null;
  let settleTimer = null;
  let maxTimer = null;
  let generation = 0;
  let targetSeen = false;

  const clear = () => {
    generation += 1;
    targetCardId = null;
    targetSeen = false;
    if (settleTimer !== null) clearTimer(settleTimer);
    if (maxTimer !== null) clearTimer(maxTimer);
    settleTimer = null;
    maxTimer = null;
  };

  return Object.freeze({
    begin(cardId) {
      clear();
      targetCardId = cleanDisplayText(cardId, "");
      if (!targetCardId) return;
      const activeGeneration = generation;
      maxTimer = setTimer(() => {
        if (activeGeneration === generation) clear();
      }, maxMs);
    },
    shouldSuppress(cardId) {
      if (!targetCardId) return false;
      const currentCardId = cleanDisplayText(cardId, "");
      if (currentCardId && currentCardId !== targetCardId) {
        if (targetSeen) {
          clear();
          return false;
        }
        return true;
      }
      if (currentCardId === targetCardId) {
        targetSeen = true;
        if (settleTimer !== null) clearTimer(settleTimer);
        const activeGeneration = generation;
        settleTimer = setTimer(() => {
          if (activeGeneration === generation) clear();
        }, settleMs);
      }
      return true;
    },
    clear,
  });
}

export function researchHostContextChangeAction({
  recognitionActive = false,
  modelActive = false,
  runningToolCount = 0,
  voicePhase = "idle",
  ttsActive = false,
  navigationSuppressed = false,
} = {}) {
  if (
    recognitionActive
    || modelActive
    || Number(runningToolCount) > 0
  ) return "cancel";
  if (navigationSuppressed) return "suppress";
  if (ttsActive) return "stop-tts";
  if (["thinking", "answering"].includes(voicePhase)) return "cancel";
  return "none";
}

export function createResearchHostState() {
  return Object.freeze({
    phase: "idle",
    expanded: false,
    contextKey: null,
    context: null,
    message: "正在等待当前卷宗",
    pendingTool: null,
    nativeApprovalControl: null,
    receipts: Object.freeze([]),
    sessionId: null,
    sessionLog: Object.freeze([]),
    nativeActive: false,
    finalAnswer: "",
    model: null,
  });
}

function matchesNativeApproval(pending, value) {
  const identityMatches = pending?.approvalId
    ? pending.approvalId === value.approvalId
    : pending?.requestGeneration === undefined && value.type === "approval"
      && !value.approvalId && pending?.id === cleanDisplayText(value.callId, "native-approval")
      && pending?.toolId === value.toolId;
  return pending?.native === true && identityMatches
    && pending.sessionId === value.sessionId
    && pending.requestGeneration === value.requestGeneration
    && (value.cardId === undefined || pending.cardId === value.cardId)
    && (value.scopeKey === undefined || pending.scopeKey === value.scopeKey);
}

export function researchHostReducer(current = createResearchHostState(), action = {}) {
  if (action.type === "native-approval-deciding") {
    if (current.phase !== "awaiting-confirmation"
      || !Number.isSafeInteger(action.requestGeneration) || action.requestGeneration < 0
      || !["allowed-once", "rejected"].includes(action.outcome)
      || !matchesNativeApproval(current.pendingTool, action)) return current;
    const message = action.outcome === "rejected"
      ? "正在发送拒绝决定，等待 Host 回执。"
      : "正在发送确认决定，等待 Host 回执。";
    return Object.freeze({
      ...current,
      phase: "approval-pending",
      message,
      receipts: replaceResearchHostReceipt(current.receipts, current.pendingTool.id, {
        status: "AWAITING_CONFIRMATION", message,
      }),
    });
  }
  if (action.type === "native-approval-failed") {
    if (!matchesNativeApproval(current.pendingTool, action)) return current;
    const message = cleanDisplayText(action.message, "确认回执未送达，本次调用已停止，人工草稿保持不变。");
    return Object.freeze({
      ...current,
      phase: current.context?.projectionStatus === "COMPLETE" ? "ready" : "blocked",
      nativeActive: false,
      pendingTool: null,
      nativeApprovalControl: null,
      message,
      receipts: replaceResearchHostReceipt(current.receipts, current.pendingTool.id, {
        status: "FAILED", message,
      }),
    });
  }
  if (action.type === "native-event") {
    const event = action.event && typeof action.event === "object" ? action.event : {};
    if (event.type === "session") {
      if (current.pendingTool?.native && event.sessionId
        && event.sessionId !== current.pendingTool.sessionId) return current;
      return Object.freeze({
        ...current,
        sessionId: cleanDisplayText(event.sessionId, current.sessionId || "") || current.sessionId,
        speechMode: event.speechMode === "contextual-v1" ? "contextual-v1" : current.speechMode,
        model: event.model && typeof event.model === "object" ? Object.freeze({ ...event.model }) : current.model,
        nativeActive: true,
        phase: current.pendingTool ? current.phase
          : current.context?.projectionStatus === "COMPLETE" ? "agent-running" : "blocked",
        message: current.pendingTool ? current.message
          : event.resumed ? "正在恢复小美 Session Log" : "小美正在按受控工具循环核对",
      });
    }
    if (event.type === "user" || event.type === "assistant") {
      const presentation = event.type === "assistant" && event.presentation
        ? normalizeResearchHostPresentation(event.presentation, "", true) : null;
      const text = presentation ? presentation.text : cleanDisplayText(event.text, "");
      if (!text) return current;
      const kind = event.type;
      return Object.freeze({
        ...current,
        finalAnswer: kind === "assistant" ? text : current.finalAnswer,
        sessionLog: appendResearchHostSessionLog(current.sessionLog, {
          id: `${kind}:${event.seq ?? `${event.time || 0}:${text}`}`,
          kind,
          seq: Number.isSafeInteger(event.seq) ? event.seq : null,
          time: Number.isFinite(event.time) ? event.time : null,
          text,
          ...(presentation ? { presentation } : {}),
          interrupted: event.interrupted === true,
        }),
      });
    }
    if (event.type === "tool-call") {
      const policy = RESEARCH_HOST_TOOL_POLICIES[event.toolId] || {
        label: cleanDisplayText(event.toolId, "未知工具"),
        runningLabel: "工具正在运行",
      };
      const callId = cleanDisplayText(event.callId, `tool-call:${event.seq ?? current.sessionLog.length}`);
      const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
        ? Object.freeze({ ...event.args })
        : Object.freeze({});
      return Object.freeze({
        ...current,
        phase: "tool-running",
        message: policy.runningLabel,
        receipts: upsertResearchHostReceipt(current.receipts, {
          id: callId,
          toolId: event.toolId,
          label: policy.label,
          status: "RUNNING",
          message: policy.runningLabel,
          args,
          native: true,
        }),
        sessionLog: appendResearchHostSessionLog(current.sessionLog, {
          id: `tool-call:${callId}`,
          kind: "tool-call",
          seq: Number.isSafeInteger(event.seq) ? event.seq : null,
          time: Number.isFinite(event.time) ? event.time : null,
          callId,
          toolId: event.toolId,
          label: policy.label,
          args,
          status: "RUNNING",
        }),
      });
    }
    if (event.type === "tool-result") {
      const policy = RESEARCH_HOST_TOOL_POLICIES[event.toolId] || {
        label: cleanDisplayText(event.toolId, "未知工具"),
      };
      const suppliedCallId = cleanDisplayText(event.callId, "");
      const correlatedReceipt = suppliedCallId
        ? null
        : [...array(current.receipts)].reverse().find((receipt) => (
            receipt.native === true
            && receipt.toolId === event.toolId
            && ["RUNNING", "AWAITING_CONFIRMATION"].includes(receipt.status)
          ));
      const callId = suppliedCallId
        || correlatedReceipt?.id
        || `tool-result:${event.seq ?? current.sessionLog.length}`;
      const succeeded = event.status === "success";
      const summary = cleanDisplayText(
        event.summary,
        succeeded ? `${policy.label}已完成` : `${policy.label}未完成`,
      );
      return Object.freeze({
        ...current,
        phase: current.nativeActive ? "agent-running" : current.phase,
        pendingTool: current.pendingTool?.id === callId ? null : current.pendingTool,
        nativeApprovalControl: suppliedCallId === current.nativeApprovalControl?.id
          && event.toolId === current.nativeApprovalControl?.toolId ? null : current.nativeApprovalControl,
        message: summary,
        receipts: upsertResearchHostReceipt(current.receipts, {
          id: callId,
          toolId: event.toolId,
          label: policy.label,
          status: succeeded ? "SUCCEEDED" : "FAILED",
          message: summary,
          args: current.receipts.find((receipt) => receipt.id === callId)?.args || Object.freeze({}),
          native: true,
        }),
        sessionLog: appendResearchHostSessionLog(current.sessionLog, {
          id: `tool-result:${callId}`,
          kind: "tool-result",
          seq: Number.isSafeInteger(event.seq) ? event.seq : null,
          time: Number.isFinite(event.time) ? event.time : null,
          callId,
          toolId: event.toolId,
          label: policy.label,
          status: succeeded ? "SUCCEEDED" : "FAILED",
          text: summary,
          errorCode: event.errorCode || null,
        }),
      });
    }
    if (event.type === "approval") {
      if (event.status === "awaiting-confirmation") {
        if (current.pendingTool) return current;
        const bound = event.requestGeneration !== undefined;
        const sessionId = event.sessionId ?? current.sessionId;
        const cardId = event.cardId ?? current.context?.cardId;
        const scopeKey = event.scopeKey ?? current.context?.scopeKey ?? current.context?.contextKey;
        const approvalId = cleanDisplayText(event.approvalId, "");
        if (bound && (
          !approvalId || !Number.isSafeInteger(event.requestGeneration) || event.requestGeneration < 0
          || [event.sessionId, event.cardId, event.scopeKey].some(value => typeof value !== "string" || !value)
          || current.context && (cardId !== current.context.cardId
            || scopeKey !== (current.context.scopeKey || current.context.contextKey))
        )) return current;
        if (approvalId && current.receipts.some(receipt => receipt.approvalId === approvalId
          && receipt.sessionId === sessionId)) return current;
        const policy = RESEARCH_HOST_TOOL_POLICIES[event.toolId] || {
          label: cleanDisplayText(event.toolId, "受控工具"),
          runningLabel: "工具正在运行",
        };
        const callId = cleanDisplayText(event.callId, event.approvalId || "native-approval");
        const pendingTool = Object.freeze({
          id: callId,
          approvalId,
          toolId: event.toolId,
          label: policy.label,
          runningLabel: policy.runningLabel,
          authority: "CONFIRM_BEFORE_RUN",
          native: true,
          sessionId,
          scopeKey,
          cardId,
          ...(bound ? { requestGeneration: event.requestGeneration } : {}),
          args: current.receipts.find((receipt) => receipt.id === callId)?.args || Object.freeze({}),
        });
        return Object.freeze({
          ...current,
          phase: "awaiting-confirmation",
          sessionId,
          nativeActive: bound ? true : current.nativeActive,
          pendingTool,
          nativeApprovalControl: pendingTool,
          message: event.reason || `请确认是否调用“${policy.label}”`,
          receipts: upsertResearchHostReceipt(current.receipts, {
            id: callId,
            toolId: event.toolId,
            label: policy.label,
            status: "AWAITING_CONFIRMATION",
            message: "等待你的确认",
            args: pendingTool.args,
            native: true,
            approvalId,
            sessionId,
          }),
        });
      }
      // Local rejection clears the dialog optimistically. Keep its control
      // identity until the original stream settles it or another call replaces it.
      const pending = current.pendingTool || current.nativeApprovalControl;
      if (!["allowed-once", "rejected", "cancelled"].includes(event.status)
        || !matchesNativeApproval(pending, {
          ...event,
          sessionId: event.sessionId ?? (pending?.requestGeneration === undefined ? current.sessionId : undefined),
        })) return current;
      if (!current.pendingTool) return Object.freeze({ ...current, nativeApprovalControl: null });
      const allowed = event.status === "allowed-once";
      return Object.freeze({
        ...current,
        phase: allowed ? "tool-running" : current.nativeActive ? "agent-running" : current.phase,
        pendingTool: null,
        nativeApprovalControl: null,
        message: allowed ? pending?.runningLabel || "已确认，工具正在运行" : "已拒绝本次工具调用",
        receipts: pending ? replaceResearchHostReceipt(current.receipts, pending.id, {
          status: allowed ? "RUNNING" : event.status === "cancelled" ? "CANCELED" : "FAILED",
          message: allowed ? pending.runningLabel : event.status === "cancelled" ? "已取消" : "已拒绝",
        }) : current.receipts,
      });
    }
    if (event.type === "cancellation") {
      const source = event.receipt && typeof event.receipt === "object" ? event.receipt : event;
      const receiptId = cleanDisplayText(
        source.receiptId,
        `dsh-cancel-${event.seq ?? current.sessionLog.length}`,
      );
      const components = Object.freeze({
        recognition: cleanDisplayText(source.components?.recognition, "not-active"),
        model: cleanDisplayText(source.components?.model, "not-active"),
        tool: cleanDisplayText(source.components?.tool, "not-active"),
        tts: cleanDisplayText(source.components?.tts, "not-active"),
      });
      const status = cleanDisplayText(source.status, event.cancelled === false ? "not-active" : "cancelled");
      const cancelledReceipts = Object.freeze(array(current.receipts).map((receipt) => (
        ["RUNNING", "AWAITING_CONFIRMATION"].includes(receipt.status)
          ? Object.freeze({ ...receipt, status: "CANCELED", message: "已由语音打断取消" })
          : receipt
      )));
      return Object.freeze({
        ...current,
        nativeActive: false,
        phase: current.context?.projectionStatus === "COMPLETE" ? "ready" : "blocked",
        pendingTool: null,
        nativeApprovalControl: null,
        message: status === "cancelled"
          ? "已完成本次打断；识别、模型、在途工具与播报均有取消回执。"
          : "当前没有仍在运行的小美回合。",
        receipts: cancelledReceipts,
        sessionLog: appendResearchHostSessionLog(current.sessionLog, {
          id: `cancellation:${receiptId}`,
          kind: "cancellation",
          seq: Number.isSafeInteger(event.seq) ? event.seq : null,
          time: Number.isFinite(event.time) ? event.time : null,
          trigger: cleanDisplayText(source.trigger, "user"),
          status,
          latencyMs: Number.isFinite(Number(source.latencyMs))
            ? Math.max(0, Math.round(Number(source.latencyMs)))
            : null,
          localStopLatencyMs: components.tts !== "not-active"
            && source.localStopLatencyMs !== null
            && source.localStopLatencyMs !== undefined
            && Number.isFinite(Number(source.localStopLatencyMs))
            ? Math.max(0, Math.round(Number(source.localStopLatencyMs)))
            : null,
          cancellationConvergenceMs: source.cancellationConvergenceMs !== null
            && source.cancellationConvergenceMs !== undefined
            && Number.isFinite(Number(source.cancellationConvergenceMs))
            ? Math.max(0, Math.round(Number(source.cancellationConvergenceMs)))
            : null,
          components,
        }),
      });
    }
    if (event.type === "done") {
      const finalAnswer = cleanDisplayText(event.finalText, current.finalAnswer);
      return Object.freeze({
        ...current,
        nativeActive: false,
        phase: current.context?.projectionStatus === "COMPLETE" ? "ready" : "blocked",
        pendingTool: null,
        nativeApprovalControl: null,
        finalAnswer,
        message: finalAnswer || current.context?.summary || current.message,
      });
    }
    if (event.type === "error") {
      const message = cleanDisplayText(event.error?.message, "小美暂时无法继续，当前卷宗没有变化。");
      return Object.freeze({
        ...current,
        nativeActive: false,
        phase: current.context?.projectionStatus === "COMPLETE" ? "ready" : "blocked",
        pendingTool: null,
        nativeApprovalControl: null,
        message,
      });
    }
    return current;
  }
  if (action.type === "toggle-expanded") {
    return Object.freeze({ ...current, expanded: !current.expanded });
  }
  if (action.type === "request-tool") {
    const request = action.request;
    if (!request?.id || current.pendingTool) return current;
    const needsConfirmation = request.authority === "CONFIRM_BEFORE_RUN";
    return Object.freeze({
      ...current,
      phase: needsConfirmation ? "awaiting-confirmation" : "tool-running",
      pendingTool: request,
      nativeApprovalControl: null,
      message: needsConfirmation
        ? `请确认是否调用“${request.label}”`
        : request.runningLabel,
      receipts: appendResearchHostReceipt(current.receipts, {
        id: request.id,
        toolId: request.toolId,
        label: request.label,
        status: needsConfirmation ? "AWAITING_CONFIRMATION" : "RUNNING",
        message: needsConfirmation ? "等待你的确认" : request.runningLabel,
      }),
    });
  }
  if (action.type === "confirm-tool") {
    const request = current.pendingTool;
    if (!request || request.id !== action.requestId || current.phase !== "awaiting-confirmation") return current;
    return Object.freeze({
      ...current,
      phase: "tool-running",
      message: request.runningLabel,
      receipts: replaceResearchHostReceipt(current.receipts, request.id, {
        status: "RUNNING",
        message: request.runningLabel,
      }),
    });
  }
  if (action.type === "cancel-tool") {
    const request = current.pendingTool;
    if (!request || request.id !== action.requestId) return current;
    return Object.freeze({
      ...current,
      phase: current.context?.projectionStatus === "COMPLETE" ? "ready" : "blocked",
      pendingTool: null,
      message: "已取消工具调用，当前卷宗没有变化。",
      receipts: replaceResearchHostReceipt(current.receipts, request.id, {
        status: "CANCELED",
        message: "已由你取消",
      }),
    });
  }
  if (action.type === "tool-succeeded" || action.type === "tool-failed") {
    const request = current.pendingTool;
    if (!request || request.id !== action.requestId) return current;
    const succeeded = action.type === "tool-succeeded";
    const resultLabel = cleanDisplayText(
      action.resultLabel,
      succeeded ? `${request.label}已完成` : `${request.label}未完成`,
    );
    return Object.freeze({
      ...current,
      phase: current.context?.projectionStatus === "COMPLETE" ? "ready" : "blocked",
      pendingTool: null,
      message: resultLabel,
      receipts: replaceResearchHostReceipt(current.receipts, request.id, {
        status: succeeded ? "SUCCEEDED" : "FAILED",
        message: resultLabel,
      }),
    });
  }
  if (action.type !== "sync-context") return current;
  const context = action.context || null;
  if (!context) {
    return Object.freeze({
      ...current,
      phase: current.nativeActive || current.pendingTool ? current.phase : "idle",
      contextKey: null,
      context: null,
      message: current.nativeActive || current.pendingTool
        ? current.message
        : current.finalAnswer || "正在等待当前卷宗",
    });
  }
  const blocked = context.projectionStatus !== "COMPLETE";
  const stalePending = current.pendingTool
    && (context.scopeKey || context.contextKey) !== current.pendingTool.scopeKey;
  const receipts = stalePending
    ? replaceResearchHostReceipt(current.receipts, current.pendingTool.id, {
      status: "CANCELED",
      message: "上下文已变化，调用已取消",
    })
    : current.receipts;
  return Object.freeze({
    ...current,
    phase: stalePending || !current.pendingTool
      ? blocked ? "blocked" : "ready"
      : current.phase,
    contextKey: context.contextKey,
    context,
    pendingTool: stalePending ? null : current.pendingTool,
    nativeApprovalControl: current.nativeApprovalControl
      && (context.scopeKey || context.contextKey) !== current.nativeApprovalControl.scopeKey
      ? null : current.nativeApprovalControl,
    receipts,
    message: stalePending
      ? "上下文已变化，上一项工具调用已取消。"
      : current.pendingTool
        ? current.message
        : blocked
          ? context.personal === true
            ? "当前信源暂无可读证据，卡片研究、研判与映射已暂停。"
            : "投影暂不可用；卷宗操作暂停，仍可查询微信舆情、本地资料和公开网络。"
          : context.summary,
  });
}

export function researchHostToolFromUtterance(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text || /提交|批准|驳回|正式研判|映射复核|揭晓/u.test(text)) return null;
  if (/(?:微信|微信群|聊天记录|原始舆情|群里).{0,40}(?:查|找|搜|提到|有没有|怎么说|说了什么|消息)|(?:查|找|搜).{0,40}(?:微信|微信群|聊天记录|原始舆情)/u.test(text.replace(WECHAT_RESEARCH_TOPIC, " "))) return "wechatRawSearch";
  if (/(?:现价|实时价格|多少钱|涨跌幅|涨幅|跌幅|分时|盘中.{0,4}异动|股价|行情)/u.test(text)) return "marketPulse";
  if (/展开.{0,8}(?:引用|证据)|(?:引用|证据).{0,8}展开|(?:完整|全部).{0,4}引用/u.test(text)) return "expandEvidence";
  if (/(?:切换|打开|查看).{0,8}(?:下一|下一个|下一份).{0,6}(?:卷宗|变量)|下一份卷/u.test(text)) return "switchCard";
  if (/(?:打开|切换到|查看).{1,80}(?:卷宗|变量)/u.test(text)) return "openDossier";
  if (/(?:今天|今日|当前)?(?:全局)?雷达.{0,18}(?:一共|总共|多少|概览|最新)|(?:一共|总共|多少).{0,12}(?:变量|卷宗)/u.test(text)) return "radarOverview";
  if (
    /(?:找出|查找|搜索|找|看看|有哪些).{0,80}(?:卷宗|变量|雷达)/u.test(text)
    || /(?:有没有|是否有|还有没有).{0,16}(?:别的|其他|相关)?(?:卷宗|变量|雷达)/u.test(text)
  ) return "searchRadar";
  if (/联网补证|深度研究|Deep Research|联网.{0,6}(?:查|搜|研究|补证)/iu.test(text)) return "deepResearch";
  if (/(?:生成|起草|写).{0,8}研判草稿|研判.{0,6}草稿/u.test(text)) return "draftJudgment";
  return null;
}

export function researchHostMayNeedPlanning(value) {
  const text = cleanDisplayText(value, "");
  if (!text || /提交|批准|驳回|正式研判|映射复核|揭晓|交易|下单|持仓/u.test(text)) {
    return false;
  }
  return /微信|微信群|聊天记录|原始舆情|群里|全局|雷达|有没有|还有没有|别的|其他|找|搜|查|打开|切换|实时|行情|股价|价格|涨跌|分时|联网|补证|引用|证据|草稿/u.test(text);
}

export function researchHostRadarQueryFromUtterance(value) {
  return cleanDisplayText(value, "")
    .replace(/^小美(?:[，,。.!！?？、:\s]+)?/u, "")
    .replace(/^(?:请|帮我|麻烦)?(?:找出|查找|搜索|找|看看)(?:一下)?(?:所有)?/u, "")
    .replace(/(?:相关的?)?(?:卷宗|变量|雷达)(?:有哪些|是什么)?[？?。.!！]*$/u, "")
    .replace(/(?:主题)?(?:最近|当前)?(?:有没有|是否有|还有没有)(?:别的|其他|相关)?$/u, "")
    .replace(/^(?:这个|当前)$/u, "")
    .replace(/\s*(?:或者|或)\s*/gu, " 或 ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

export function researchHostDossierQueryFromUtterance(value) {
  const text = cleanDisplayText(value, "");
  const preferLatest = /(?:最新|最近|刚刚)/u.test(text);
  const query = text
    .replace(/^小美(?:[，,。.!！?？、:\s]+)?/u, "")
    .replace(/^(?:请|帮我|麻烦)?(?:打开|切换到|查看)(?:一下)?/u, "")
    .replace(/(?:最新|最近|刚刚)/gu, "")
    .replace(/(?:相关的?)?(?:卷宗|变量)[？?。.!！]*$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return Object.freeze({ query, preferLatest });
}

export function researchHostMarketQueryFromUtterance(value) {
  const text = String(value || "")
    .replace(/^小美(?:[，,。.!！?？、:\s]+)?/u, "")
    .replace(/(?:请|帮我|麻烦)?(?:查一下|查查|看看|查询|告诉我|说一下)/gu, " ")
    .replace(/(?:现在|当前|今天|盘中)?(?:的)?(?:现价|实时价格|价格|多少钱|涨跌幅|涨幅|跌幅|分时异动|盘中异动|股价|行情)/gu, " ")
    .replace(/(?:有没有|是否|怎么样|多少|如何|情况)/gu, " ")
    .replace(/(?:盘中|分时|异动)/gu, " ")
    .replace(/(?:以及|还有|并且|和)/gu, " ")
    .replace(/[，,。.!！?？、:：的\s]+/gu, " ")
    .trim();
  const code = String(value || "").match(/(?:(?:SH|SZ|BJ)\s*)?\d{6}(?:\.(?:SH|SZ|BJ))?/iu)?.[0];
  return cleanDisplayText(code || text, "").slice(0, 40);
}

export function resolveResearchHostMarketQuery(value, view = {}) {
  const extracted = researchHostMarketQueryFromUtterance(value);
  if (extracted && !/^(?:当前|这只|该只)?(?:股票|公司|标的)?$/u.test(extracted)) return extracted;
  const company = array(view?.mappings).find((mapping) => mapping?.kind === "公司" && (mapping?.code || mapping?.name));
  return cleanDisplayText(company?.code || company?.name, "").slice(0, 40);
}

export function researchHostWakeCommand(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  const match = text.match(/^小美(?:[，,。.!！?？、:\s]+)?(.*)$/u);
  if (!match) return Object.freeze({ matched: false, command: "" });
  const command = cleanDisplayText(match[1], "").slice(0, 500);
  if (/提交|批准|驳回|正式研判|映射复核|揭晓/u.test(command)) {
    return Object.freeze({ matched: true, command: "" });
  }
  return Object.freeze({ matched: true, command });
}

export function normalizeResearchHostWakePreference(value = {}) {
  return Object.freeze({
    enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
  });
}

export function createResearchHostVoiceState({ recognitionSupported = false, wakePreferred = true, speechMode = "legacy" } = {}) {
  const latencySamples = Object.freeze({
    firstVoiceMs: Object.freeze([]),
    localInterruptionMs: Object.freeze([]),
    cancellationConvergenceMs: Object.freeze([]),
  });
  return Object.freeze({
    recognitionSupported: Boolean(recognitionSupported),
    wakePreferred: Boolean(wakePreferred),
    wakeArmed: false,
    wakeListening: false,
    wakeAwaiting: false,
    phase: "idle",
    transcript: "",
    recognitionStopping: false,
    recognitionDiagnostics: Object.freeze([]),
    recoverableTranscript: "",
    interimTranscript: "",
    question: "",
    answer: "",
    spokenAnswer: "",
    speechMode,
    speechStatus: "unavailable",
    model: null,
    error: null,
    interrupted: false,
    latencySamples,
    latency: summarizeResearchHostLatency(latencySamples),
  });
}

export function researchHostVoiceReducer(current = createResearchHostVoiceState(), action = {}) {
  if (action.type === "conversation-reset") {
    return createResearchHostVoiceState({ speechMode: current.speechMode, wakePreferred: false });
  }
  if (action.type === "recognition-observed") {
    const attempts = current.recognitionDiagnostics || [];
    const observation = action.observation;
    return Object.freeze({ ...current, recognitionDiagnostics: Object.freeze([
      ...attempts.filter(item => item.id !== observation.id), observation,
    ].slice(-6)) });
  }
  if (action.type === "support-changed") {
    return Object.freeze({ ...current, recognitionSupported: Boolean(action.supported) });
  }
  if (action.type === "listen-started") {
    return Object.freeze({
      ...current,
      phase: "listening",
      recognitionStopping: false,
      recoverableTranscript: "",
      transcript: "",
      interimTranscript: "",
      error: null,
      interrupted: false,
    });
  }
  if (action.type === "wake-preference") {
    return Object.freeze({
      ...current,
      wakePreferred: Boolean(action.enabled),
    });
  }
  if (action.type === "listen-stopping") {
    return current.phase === "listening" ? Object.freeze({ ...current, recognitionStopping: true }) : current;
  }
  if (action.type === "listen-timeout") {
    return Object.freeze({
      ...current,
      phase: "error",
      recognitionStopping: false,
      recoverableTranscript: current.interimTranscript || current.transcript,
      interimTranscript: "",
      error: "语音识别未能正常结束，已停止本轮接收；未发送问题。可检查转写后发送，或按住重说。",
    });
  }
  if (action.type === "wake-armed") {
    const wakeArmed = Boolean(action.enabled) && current.recognitionSupported;
    return Object.freeze({
      ...current,
      wakeArmed,
      wakeListening: false,
      wakeAwaiting: false,
      error: wakeArmed ? null : current.error,
    });
  }
  if (action.type === "wake-listening") {
    return Object.freeze({
      ...current,
      wakeListening: current.wakeArmed && Boolean(action.listening),
    });
  }
  if (action.type === "wake-heard") {
    return Object.freeze({
      ...current,
      wakeListening: false,
      wakeAwaiting: current.wakeArmed && Boolean(action.awaiting),
    });
  }
  if (action.type === "transcript") {
    const text = cleanDisplayText(action.text, "").slice(0, 500);
    return Object.freeze({
      ...current,
      transcript: action.final ? text : current.transcript,
      interimTranscript: action.final ? "" : text,
    });
  }
  if (action.type === "question-submitted") {
    const question = cleanDisplayText(action.text, "").slice(0, 500);
    if (!question) return current;
    return Object.freeze({
      ...current,
      phase: "thinking",
      transcript: question,
      recoverableTranscript: "",
      interimTranscript: "",
      question,
      answer: "",
      spokenAnswer: "",
      speechMode: action.speechMode || current.speechMode || "legacy",
      speechStatus: "pending",
      model: null,
      error: null,
      interrupted: false,
    });
  }
  if (action.type === "model-selected") {
    return Object.freeze({ ...current, model: action.model || null });
  }
  if (action.type === "latency-sample") {
    const sample = Number(action.latencyMs);
    const metrics = {
      firstVoice: "firstVoiceMs",
      localInterruption: "localInterruptionMs",
      cancellationConvergence: "cancellationConvergenceMs",
    };
    const key = metrics[action.metric];
    if (!Number.isFinite(sample) || sample < 0 || !key) {
      return current;
    }
    const latencySamples = Object.freeze({
      firstVoiceMs: Object.freeze([
        ...array(current.latencySamples?.firstVoiceMs),
        ...(key === "firstVoiceMs" ? [Math.round(sample)] : []),
      ].slice(-100)),
      localInterruptionMs: Object.freeze([
        ...array(current.latencySamples?.localInterruptionMs),
        ...(key === "localInterruptionMs" ? [Math.round(sample)] : []),
      ].slice(-100)),
      cancellationConvergenceMs: Object.freeze([
        ...array(current.latencySamples?.cancellationConvergenceMs),
        ...(key === "cancellationConvergenceMs" ? [Math.round(sample)] : []),
      ].slice(-100)),
    });
    return Object.freeze({
      ...current,
      latencySamples,
      latency: summarizeResearchHostLatency(latencySamples),
    });
  }
  if (action.type === "answer-presentation") {
    const presentation = normalizeResearchHostPresentation(action.presentation, "", action.final === true);
    return Object.freeze({ ...current, phase: "answering", answer: presentation.text,
      spokenAnswer: presentation.spokenText, speechMode: "contextual-v1", speechStatus: presentation.speechStatus });
  }
  if (action.type === "answer-delta") {
    const text = String(action.text || "").replace(/[\p{Cf}\u0000]/gu, "");
    return Object.freeze({
      ...current,
      phase: "answering",
      speechMode: action.speechMode || current.speechMode,
      answer: `${current.answer}${text}`.slice(0, 6_000),
    });
  }
  if (action.type === "answer-finished") {
    return Object.freeze({ ...current, phase: "idle", interimTranscript: "" });
  }
  if (action.type === "interrupted") {
    return Object.freeze({
      ...current,
      phase: "idle",
      interimTranscript: "",
      error: null,
      interrupted: true,
    });
  }
  if (action.type === "failed") {
    return Object.freeze({
      ...current,
      phase: "error",
      interimTranscript: "",
      error: cleanDisplayText(action.message, "研究主持人暂时无法回答。"),
    });
  }
  return current;
}

export function splitResearchHostSentences(value, final = false) {
  const text = String(value || "").replace(/[\p{Cf}\u0000]/gu, "");
  const sentences = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？!?；;\n]/u.test(text[index])) continue;
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }
  let remainder = text.slice(start).trimStart();
  if (final && remainder.trim()) {
    sentences.push(remainder.trim());
    remainder = "";
  }
  return Object.freeze({
    sentences: Object.freeze(sentences),
    remainder,
  });
}

const REVISION_CHANGE_LABELS = Object.freeze({
  NEW: "首次发现",
  REINFORCES: "证据强化",
  UPDATES: "信息更新",
  CONTRADICTS: "出现反证",
});

function buildRevisionTrail(nodes) {
  return array(nodes)
    .filter((node) => node?.cardRevisionId && Number.isFinite(Number(node.revision)))
    .sort((left, right) => {
      const revisionDifference = Number(left.revision) - Number(right.revision);
      if (revisionDifference) return revisionDifference;
      return String(left.eventAt || "").localeCompare(String(right.eventAt || ""));
    })
    .map((node) => ({
      id: node.id,
      cardRevisionId: node.cardRevisionId,
      revision: Number(node.revision),
      label: `第 ${Number(node.revision)} 版`,
      changeLabel: REVISION_CHANGE_LABELS[node.relationToPrior] || "信息更新",
      dateLabel: dateLabel(node.eventAt || node.availableAt || node.recordedAt),
      stageId: stageIdOf(node),
      evidenceIds: array(node.evidenceIds),
      current: Boolean(node.isCurrent),
    }));
}

const FEEDBACK_RESULT_LABELS = Object.freeze({
  STRONG: "强发酵",
  WEAK: "弱发酵",
  NARRATIVE_ONLY: "仅叙事升温",
  NO_FERMENTATION: "未形成发酵",
  COUNTEREVIDENCE: "出现反证",
  NOT_EVALUABLE: "暂不可评估",
  CONFOUNDED: "存在混杂因素",
  HIT: "映射命中",
  PARTIAL_HIT: "部分命中",
  MISS: "映射未命中",
  NO_SIGNAL: "暂无有效映射信号",
});

const FEEDBACK_REASON_LABELS = Object.freeze({
  CONSTITUENT_COUNT_BELOW_3: "样本数不足三项，暂不评估",
  MARKET_DATA_CONFLICTED: "冻结行情存在冲突，需要人工复核",
  MARKET_DATA_INCOMPLETE: "冻结行情不完整，暂不评估",
  "independent-catalyst": "存在独立催化，需人工区分",
  "theme-drawdown": "题材相对表现走弱",
  "theme-excess-and-participation": "相对强度与参与度同时达到阈值",
  "theme-weak-threshold": "仅达到弱发酵阈值",
  "mention-growth-without-price": "讨论升温但价格尚未验证",
  "no-threshold-met": "尚未达到发酵阈值",
  "direct-refutation": "出现直接反证",
  "beats-market-and-industry": "同时跑赢市场与行业基准",
  "beats-one-benchmark": "仅跑赢一项基准",
  "lags-theme-median": "落后于题材样本中位数",
  "dead-zone-or-no-rule": "处于无信号区间",
});

function outcomeTargetLabel(outcome) {
  const raw = String(outcome?.target || "待确认");
  if (outcome?.kind === "SECURITY") {
    return `公司 · ${raw.replace(/^SH|^SZ/, "")}`;
  }
  return `题材 · ${raw.replace(/^theme:/, "")}`;
}

function buildOutcomeTimeline(nodes, revealed) {
  if (!revealed) return [];
  return array(nodes).flatMap((node) =>
    array(node?.outcomes).map((outcome, index) => ({
      id: `${node.id}:${index}`,
      nodeId: node.id,
      stageId: stageIdOf(node),
      horizon: node.horizon || node.title || "后续核对",
      targetLabel: outcomeTargetLabel(outcome),
      resultLabel: FEEDBACK_RESULT_LABELS[outcome?.result] || "结果待确认",
      reasonLabel: FEEDBACK_REASON_LABELS[outcome?.reason] || "原因待人工复核",
      reviewLabel: outcome?.reviewDisposition === "REVIEW_REQUIRED"
        ? "需要人工复核"
        : "已完成规则核对",
    })),
  );
}

function joinedMappings(card, casefile) {
  const themes = array(card?.themes).map((target) => ({
    ...target,
    kind: "题材",
    name: cleanDisplayText(casefile?.case?.title || String(target.themeRef || "").replace(/^theme:/, ""), "未命名题材"),
    code: null,
    quote: null,
  }));
  const caseMappings = new Map(
    array(casefile?.case?.mappings).map((target) => [target.id, target]),
  );
  const securities = array(card?.securities).map((target) => {
    const detail = caseMappings.get(target.id) || target;
    return {
      ...target,
      ...detail,
      kind: "公司",
      name: detail.securityName || detail.securityCode || "未命名公司",
      code: detail.securityCode || null,
      quote: detail.quote || null,
    };
  });
  return [...themes, ...securities];
}

function sourceLabel(evidence, nodes) {
  const linked = array(nodes).find((node) => array(node.evidenceIds).includes(evidence.id));
  const sourcePath = String(evidence.sourcePath || "");
  const sourceType = String(evidence.sourceType || "");
  if (sourceType === "invalidated-facts") return "已失效事实";
  if (sourceType === "facts") return "时序事实";
  if (sourceType === "brain") return "纠错记忆";
  if (sourceType === "graph") return "关系图谱";
  if (sourceType === "stock-price") return "冻结行情";
  if (sourceType === "wiki") return "研究库";
  if (linked?.sourceChannel === "LIUDU") return "六度会议";
  if (linked?.sourceChannel === "GANGTISE" || sourcePath.includes("投研线索")) return "冈底斯线索";
  if (linked?.nodeType === "WECHAT_DIGEST" || sourcePath.includes("微信聊天")) return "微信舆情";
  if (linked?.nodeType === "EXPERT_MEETING") return "专家会议";
  if (linked?.nodeType === "MARKET_CLOSE") return "收盘行情";
  return "冻结资料";
}

function dateLabel(value) {
  const text = String(value || "");
  if (!text) return "时间待确认";
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!match) return text;
  const [, , month, day, hour, minute] = match;
  return `${month}-${day}${hour ? ` ${hour}:${minute}` : ""}`;
}

function evidenceDisplayScore(item, linkedNode) {
  const text = cleanDisplayText(item?.summary, "");
  const roleWeight = { FOCAL: 1_000, SUPPORT: 200, COUNTER: 100 }[
    String(item?.role || "").toUpperCase()
  ] || 0;
  if (/^会议记录\s+\d+\s+·\s+编号\s+\d+$/.test(text)) {
    return roleWeight - 1_000;
  }
  let score = roleWeight + Math.min(text.length, 160);
  if (/^[|｜]/.test(text)) score -= 120;
  if (/^\d+\.\s/.test(text)) score -= 40;
  if (/[。；]/.test(text)) score += 12;
  score += Math.min(
    48,
    (text.match(/待核验|不能|未确认|未知|风险|预期|主要终点|公告|订单|收入|收益率|走弱|催化/g) || []).length * 8,
  );
  if (
    /失败|风险|下修|不及预期|放缓|延迟|取消|恶化/.test(text) &&
    /待核验|未确认|不能|未知|尚无|缺少/.test(text)
  ) {
    score += 36;
  }
  if (linkedNode?.sourceChannel === "LIUDU") score += 12;
  return score;
}

function radarMetrics(card, casefile, mappings, stages) {
  const evidence = array(casefile?.evidence);
  const uncertainties = array(card?.uncertainties);
  const nodes = array(casefile?.case?.nodes);
  const sources = new Set(
    [
      ...nodes.map((node) => node.sourceType || node.sourceChannel),
      ...evidence.map((item) => item.sourceType),
    ]
      .filter(Boolean),
  );
  const reviewed = mappings.filter((target) => target.review && target.review !== "UNREVIEWED").length;
  const securities = mappings.filter((target) => target.kind === "公司");
  const quoted = securities.filter((target) => Number.isFinite(Number(target.quote?.close))).length;
  const nextCheckpoint = stages.find(
    (stage) => ["t1", "t3", "t5"].includes(stage.id) && stage.state !== "complete",
  );
  const proximity = { t1: 100, t3: 70, t5: 40 }[nextCheckpoint?.id] || 0;
  const unknownDenominator = evidence.length + uncertainties.length;

  return [
    { id: "evidence", label: "证据充分", value: clampPercent((evidence.length / 5) * 100), detail: `${evidence.length} 条冻结引用` },
    { id: "sources", label: "来源多样", value: clampPercent((sources.size / 4) * 100), detail: `${sources.size} 类来源` },
    { id: "unknown", label: "未知暴露", value: clampPercent(unknownDenominator ? (uncertainties.length / unknownDenominator) * 100 : 0), detail: `${uncertainties.length} 项显式未知` },
    { id: "mapping", label: "映射复核", value: clampPercent(mappings.length ? (reviewed / mappings.length) * 100 : 0), detail: `${reviewed}/${mappings.length} 项已复核` },
    { id: "catalyst", label: "催化临近", value: proximity, detail: nextCheckpoint ? `${nextCheckpoint.label} 为下一检查点` : "暂无待到期节点" },
    { id: "market", label: "行情完备", value: clampPercent(securities.length ? (quoted / securities.length) * 100 : 0), detail: `${quoted}/${securities.length} 家有冻结行情` },
  ];
}

export function buildCaseViewModel(card, casefile) {
  const nodes = array(casefile?.case?.nodes);
  const stages = groupTimeline(nodes);
  const revisionTrail = buildRevisionTrail(nodes);
  const outcomeTimeline = buildOutcomeTimeline(
    nodes,
    casefile?.outcomeVisibility === "REVEALED",
  );
  const activeRevision = revisionTrail.find((item) => item.current) || revisionTrail.at(-1) || null;
  const mappings = joinedMappings(card, casefile);
  const evidence = array(casefile?.evidence)
    .map((item, sourceIndex) => {
      const linkedNode = nodes.find((node) => array(node.evidenceIds).includes(item.id));
      return {
        ...item,
        sourceIndex,
        summary: cleanDisplayText(item.summary),
        accessLabel: translateStatus(item.accessLevel),
        sourceLabel: sourceLabel(item, nodes),
        timeLabel: dateLabel(linkedNode?.availableAt),
        materialAt: latestResearchInstant([linkedNode?.availableAt]),
        displayScore: evidenceDisplayScore(item, linkedNode),
      };
    })
    .sort((left, right) => right.displayScore - left.displayScore || left.sourceIndex - right.sourceIndex)
    .map(({ displayScore, sourceIndex, ...item }, index) => ({
      ...item,
      ordinal: index + 1,
      label: index === 0 ? "核心引述" : `佐证 ${index}`,
    }));
  const title = cleanDisplayText(casefile?.case?.title || card?.eventSummary, "变量卷宗");
  const evidenceHashes = radarEvidenceHashes({
    evidence: [
      ...array(card?.evidence),
      ...array(card?.suggestionEvidence),
      ...array(casefile?.evidence),
    ],
  }).slice(0, 16);
  const variableIdentityKey = cleanDisplayText(
    card?.variableIdentityKey || card?.variableTitle || title,
    title,
  );
  const catalystIdentityKey = cleanDisplayText(card?.catalystIdentityKey, "") || null;
  const revision = Number.isFinite(Number(card?.revision))
    ? Math.max(1, Math.floor(Number(card.revision)))
    : 1;
  const watermark = String(casefile?.asOfWatermark || card?.asOfWatermark || "").slice(0, 256) || null;
  const evidenceTimelineNodes = nodes.filter((node) => array(node?.evidenceIds).length > 0);
  const materialAt = latestResearchInstant(evidenceTimelineNodes.map((node) => node?.availableAt));
  const scannedAt = latestResearchInstant([
    card?.systemDecisionAt,
    ...evidenceTimelineNodes.map((node) => node?.recordedAt),
  ]);
  const systemSuggestion = card?.systemSuggestion?.authority === "SYSTEM_SUGGESTION"
    ? {
        ...card.systemSuggestion,
        labelText: translateStatus(card.systemSuggestion.label),
        sourceText: card.systemSuggestion.basis === "MODEL" ? "模型预判" : "规则预判",
        rationale: cleanDisplayText(card.systemSuggestion.rationale, "预判理由待补充"),
      }
    : null;
  const suggestionIds = new Set(array(card?.suggestionEvidence).map((item) => item?.id).filter(Boolean));
  const suggestionEvidence = evidence.filter((item) => suggestionIds.has(item.id));
  const counterEvidence = array(card?.counterEvidence)
    .map((item) => cleanDisplayText(item))
    .filter(Boolean);
  const invalidationConditions = array(card?.invalidationConditions)
    .map((item) => {
      const text = cleanDisplayText(item);
      if (/demo fixture withdrawn/i.test(text)) {
        return "示例资料被撤回或来源失效";
      }
      if (/source watermark moves without re-sync/i.test(text)) {
        return "信源水位变化但尚未重新同步";
      }
      return text;
    })
    .filter(Boolean);
  return {
    id: cardId(card),
    title,
    publishedCard: ['published-card-v1','published-card-v2','published-card-v3','published-card-v4'].includes(casefile?.publishedCard?.schema)
      && casefile.publishedCard.variableId === card?.variableId
      && casefile.publishedCard.cardRevisionId === card?.upstreamCardRevisionId
      && casefile.publishedCard.revision === card?.revision
      && card?.publication?.contentHash === casefile?.publication?.contentHash
      && typeof card?.publication?.contentHash === "string"
      ? casefile.publishedCard : null,
    publication: card?.publication ?? null,
    variableId: String(card?.variableId || "") || null,
    variableIdentityKey,
    catalystIdentityKey,
    revision,
    evidenceHashes,
    eventIdentity: radarEventIdentity({
      id: cardId(card),
      variableId: card?.variableId,
      variableIdentityKey,
      catalystIdentityKey,
      revision,
      evidenceHashes,
    }),
    watermark,
    materialAt,
    scannedAt,
    summary: cleanDisplayText(card?.eventSummary, title),
    expectationGap: cleanDisplayText(card?.expectationGap, "预期差待补充"),
    whyTradable: cleanDisplayText(card?.whyTradable, "仅供人工复核"),
    urgency: card?.tier === "MUST_REVIEW" ? "必须复核" : "等待复核",
    score: Number(card?.score || 0),
    currentLabel: translateStatus(card?.currentLabel?.state),
    currentLabelState: card?.currentLabel?.state || "UNLABELED",
    currentLabelId: card?.currentLabel?.id || null,
    committedReviewNote: String(card?.currentLabel?.reviewNote || ""),
    committedEvidenceIds: array(card?.currentLabel?.selectedEvidenceIds),
    outcomeLabel: translateStatus(casefile?.outcomeVisibility),
    kindLabel: translateStatus(casefile?.case?.kind),
    uncertainties: array(card?.uncertainties).map((item) => cleanDisplayText(item)),
    evidence,
    systemSuggestion,
    suggestionEvidence,
    suggestionTraceComplete: Boolean(
      card?.suggestionTraceComplete &&
      suggestionEvidence.length === array(card?.suggestionEvidence).length,
    ),
    counterEvidence,
    invalidationConditions,
    versionChange: card?.versionChange
      ? {
          ...card.versionChange,
          summary: cleanDisplayText(card.versionChange.summary, "版本变化待整理"),
        }
      : null,
    stages,
    revisionTrail,
    outcomeTimeline,
    activeTimelineNodeId: activeRevision?.id || null,
    activeStageId: activeRevision?.stageId || (
      stages.some((stage) => stage.id === "expert" && stage.nodes.length)
        ? "expert"
        : stages.find((stage) => stage.nodes.length)?.id || "source"
    ),
    mappings,
    radar: radarMetrics(card, casefile, mappings, stages),
    curation: casefile?.derivedCuration
      ? {
          headline: cleanDisplayText(casefile.derivedCuration.headline),
          bullets: array(casefile.derivedCuration.bullets).map((item) => cleanDisplayText(item)),
          caution: cleanDisplayText(casefile.derivedCuration.caution),
        }
      : null,
  };
}

const NARRATION_LABELS = {
  TRADABLE: "可炒",
  WATCH: "继续观察",
  NOT_TRADABLE: "不可炒",
};

function narrationSentence(value, fallback = "") {
  return cleanDisplayText(value, fallback)
    .replace(/[\r\n]+/g, "，")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildNarrationScript(view, local = {}) {
  const key = String(view?.id || "").trim();
  const title = narrationSentence(view?.title, "当前变量");
  const evidence = array(view?.evidence).slice(0, 3);
  const uncertainties = array(view?.uncertainties)
    .map((item) => narrationSentence(item))
    .filter(Boolean)
    .slice(0, 2);
  const parts = [
    `变量播报。${title}。`,
    `进入雷达后，冻结引用共 ${array(view?.evidence).length} 条。事前预期差：${narrationSentence(view?.expectationGap, "等待补充")}。`,
  ];

  evidence.forEach((item, index) => {
    const role = index === 0 ? "核心证据" : `佐证 ${index}`;
    const source = narrationSentence(item?.sourceLabel, "冻结资料");
    const time = narrationSentence(item?.timeLabel, "时间待确认");
    const summary = narrationSentence(item?.summary, "引用内容待确认");
    parts.push(`${role}，来源 ${source}，${time}，${summary}。`);
  });

  if (uncertainties.length) {
    parts.push(`仍待核验：${uncertainties.join("；")}。`);
  }
  const label = NARRATION_LABELS[local?.label];
  if (label) {
    parts.push(`当前人工草稿选择：${label}。`);
  }
  const note = narrationSentence(local?.note);
  if (note) {
    parts.push(`研判说明：${note}。`);
  }

  const boundary = "研究线索，仅供人工复核，不构成交易建议。";
  const bodyLimit = 900 - boundary.length - 1;
  const body = parts.join(" ").slice(0, bodyLimit).trim();
  return {
    key,
    title,
    text: `${body} ${boundary}`.trim(),
  };
}

export function buildRadarShortNarration(view) {
  const eventKey = String(view?.eventIdentity || radarEventIdentity(view)).trim();
  const title = narrationSentence(view?.title, "当前变量");
  const suggestion = narrationSentence(view?.systemSuggestion?.labelText, "等待系统预判");
  const uncertainty = narrationSentence(
    array(view?.uncertainties)[0],
    "关键事实仍待核验",
  );
  const compact = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text;
  const source = narrationSentence(view?.sourceLabel, "来源待确认");
  const importance = narrationSentence(view?.expectationGap, "重要性仍待核实");
  const boundary = "仅供人工复核。";
  // Reserve room for the risk: a long title must never truncate it away.
  const lead = `新雷达。来源：${compact(source, 22)}。${compact(title, 95)}。关注：${compact(importance, 62)}。系统预判：${compact(suggestion, 16)}。关键不确定性：${compact(uncertainty, 60)}。`;
  return Object.freeze({
    key: eventKey ? `radar-short:${eventKey}` : "",
    title,
    text: `${lead.slice(0, 320 - boundary.length)}${boundary}`,
  });
}

export function enqueueNarrationItem(queue, item, options = {}) {
  const current = array(queue);
  const key = String(item?.key || "").trim();
  const text = String(item?.text || "").trim();
  if (!key || !text) return [...current];
  if (!options.force && current.some((entry) => entry?.key === key)) {
    return [...current];
  }
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 3));
  const next = [...current, { ...item, key, text }];
  return next.slice(-limit);
}

function emptyCaseState() {
  return {
    draftRevision: 0,
    note: "",
    label: null,
    committedLabelId: null,
    dirty: false,
    submitState: "idle",
    canReveal: false,
    needsCompletion: false,
    evidenceIds: [],
    mappingReviews: {},
    corrections: {},
    recordEditorOpen: false,
    feedback: null,
    revealState: "idle",
    autoJudgmentState: "idle",
    autoJudgmentError: null,
    autoJudgmentModel: null,
  };
}

function ensureCase(state, cardIdValue) {
  if (!cardIdValue || state.cases[cardIdValue]) return state;
  return {
    ...state,
    cases: { ...state.cases, [cardIdValue]: emptyCaseState() },
  };
}

function hydrateCaseState(caseState, action) {
  if (caseState.dirty || caseState.submitState === "submitting") return caseState;
  const note = String(action.note || "").slice(0, 300);
  const label = action.label && action.label !== "UNLABELED" ? action.label : null;
  const evidenceIds = [...new Set(array(action.evidenceIds))];
  const complete = Boolean(label && note.trim().length >= 6 && evidenceIds.length > 0);
  return {
    ...caseState,
    note,
    label,
    committedLabelId: complete ? action.labelId || null : null,
    evidenceIds,
    dirty: false,
    submitState: "idle",
    canReveal: complete,
    needsCompletion: Boolean(action.labelId && label && !complete),
  };
}

export function createPrototypeState() {
  return {
    selectedCardId: null,
    pinnedIds: [],
    activeStages: {},
    activeTimelineNodes: {},
    cases: {},
    activity: "正在读取冻结卷宗，不替你下结论",
    activityTone: "idle",
  };
}

export function capturePersonalDraftTarget(prototypeState, cardId) {
  if (!cardId || prototypeState?.selectedCardId !== cardId) return null;
  const draft = prototypeState.cases?.[cardId] || emptyCaseState();
  if (draft.note || draft.label || array(draft.evidenceIds).length || draft.dirty
    || draft.submitState === "submitting" || draft.autoJudgmentState === "loading") return null;
  return Object.freeze({ cardId, revision: draft.draftRevision || 0 });
}

export function prototypeReducer(current, action) {
  let state = current || createPrototypeState();
  if (action.type === "apply-personal-native-draft") {
    const target = capturePersonalDraftTarget(state, action.cardId);
    if (!target || action.target?.cardId !== target.cardId || action.target?.revision !== target.revision) {
      return { ...state, activity: "个人研判草稿未自动填充，已保留当前人工内容与卷宗选择。", activityTone: "idle" };
    }
    const proposal = action.result?.card === action.cardId
      ? normalizeAutoJudgmentDraft(action.result, action.allowedEvidenceIds) : null;
    if (!proposal) {
      return { ...state, activity: "个人研判草稿未通过卷宗、引用或草稿权限校验，人工内容保持不变。", activityTone: "error" };
    }
    return prototypeReducer(state, {
      type: "apply-auto-judgment", cardId: action.cardId, draft: proposal.draft,
      personal: true, modelLabel: "我的 Host 模型",
    });
  }
  const cardIdValue = action.cardId || state.selectedCardId;
  state = ensureCase(state, cardIdValue);
  const caseState = cardIdValue ? state.cases[cardIdValue] : null;

  switch (action.type) {
    case "select-card":
      return { ...state, selectedCardId: action.cardId };
    case "toggle-pin": {
      const hasPin = state.pinnedIds.includes(action.cardId);
      return {
        ...state,
        pinnedIds: hasPin
          ? state.pinnedIds.filter((id) => id !== action.cardId)
          : [action.cardId, ...state.pinnedIds],
      };
    }
    case "select-stage":
      return {
        ...state,
        activeStages: { ...state.activeStages, [cardIdValue]: action.stageId },
        activeTimelineNodes: {
          ...state.activeTimelineNodes,
          [cardIdValue]: action.nodeId || null,
        },
      };
    case "set-note":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            note: String(action.note || "").slice(0, 300),
            draftRevision: (caseState.draftRevision || 0) + 1,
            dirty: true,
            autoJudgmentState: caseState.autoJudgmentState === "ready" ? "edited" : caseState.autoJudgmentState,
          },
        },
      };
    case "hydrate-case": {
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: hydrateCaseState(caseState, action),
        },
      };
    }
    case "hydrate-cases": {
      let changed = false;
      const cases = { ...state.cases };
      for (const item of array(action.items)) {
        const id = item?.cardId;
        if (!id) continue;
        const currentCase = cases[id] || emptyCaseState();
        const hydrated = hydrateCaseState(currentCase, item);
        if (!Object.hasOwn(cases, id) || hydrated !== currentCase) {
          cases[id] = hydrated;
          changed = true;
        }
      }
      return changed ? { ...state, cases } : state;
    }
    case "set-label":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            label: action.label,
            draftRevision: (caseState.draftRevision || 0) + 1,
            dirty: true,
            canReveal: false,
            autoJudgmentState: caseState.autoJudgmentState === "ready" ? "edited" : caseState.autoJudgmentState,
          },
        },
        activity: "研判草稿已更新，提交后才会写入权威账本",
        activityTone: "active",
      };
    case "add-evidence":
      return caseState.evidenceIds.includes(action.evidenceId)
        ? state
        : {
            ...state,
            cases: {
              ...state.cases,
              [cardIdValue]: {
                ...caseState,
                evidenceIds: [...caseState.evidenceIds, action.evidenceId],
                draftRevision: (caseState.draftRevision || 0) + 1,
                dirty: true,
                autoJudgmentState: caseState.autoJudgmentState === "ready" ? "edited" : caseState.autoJudgmentState,
              },
            },
            activity: "已将冻结引用纳入判断依据",
            activityTone: "active",
          };
    case "remove-evidence":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            evidenceIds: caseState.evidenceIds.filter((id) => id !== action.evidenceId),
            draftRevision: (caseState.draftRevision || 0) + 1,
            dirty: true,
            autoJudgmentState: caseState.autoJudgmentState === "ready" ? "edited" : caseState.autoJudgmentState,
          },
        },
      };
    case "move-evidence": {
      const ids = [...caseState.evidenceIds];
      const from = ids.indexOf(action.evidenceId);
      const to = Math.max(0, Math.min(ids.length - 1, action.toIndex));
      if (from < 0 || from === to) return state;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            evidenceIds: ids,
            draftRevision: (caseState.draftRevision || 0) + 1,
            dirty: true,
            autoJudgmentState: caseState.autoJudgmentState === "ready" ? "edited" : caseState.autoJudgmentState,
          },
        },
      };
    }
    case "mark-auto-judging":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            autoJudgmentState: "loading",
            autoJudgmentError: null,
          },
        },
        activity: `${action.personal ? "我的 Host 模型" : "DeepSeek"} 正在核对冻结证据并起草研判`,
        activityTone: "active",
      };
    case "apply-auto-judgment":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            label: action.draft?.label || null,
            draftRevision: (caseState.draftRevision || 0) + 1,
            note: String(action.draft?.note || "").slice(0, 300),
            evidenceIds: [...new Set(array(action.draft?.evidenceIds))],
            dirty: true,
            canReveal: false,
            autoJudgmentState: "ready",
            autoJudgmentError: null,
            autoJudgmentModel: action.modelLabel || "DeepSeek",
          },
        },
        activity: `${action.personal ? action.modelLabel || "我的 Host 模型" : "DeepSeek"} 自动研判草稿已填充，确认或调整后再正式提交`,
        activityTone: "success",
      };
    case "mark-auto-judgment-error":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            autoJudgmentState: "error",
            autoJudgmentError: action.message || "自动研判未完成",
          },
        },
        activity: action.message || "自动研判未完成，人工草稿保持不变",
        activityTone: "error",
      };
    case "mark-submitting":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: { ...caseState, submitState: "submitting" },
        },
        activity: "正在提交研判并重建投影",
        activityTone: "active",
      };
    case "mark-submitted":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            label: action.label || caseState.label,
            committedLabelId: action.labelId || caseState.committedLabelId,
            dirty: false,
            submitState: "idle",
            canReveal: Boolean(action.label || caseState.label),
            needsCompletion: false,
          },
        },
        activity: "研判已写入权威账本，投影已更新",
        activityTone: "success",
      };
    case "mark-submit-error":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: { ...caseState, submitState: "error" },
        },
        activity: action.message || "研判提交失败，草稿仍保留",
        activityTone: "error",
      };
    case "review-mapping":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            mappingReviews: { ...caseState.mappingReviews, [action.mappingId]: action.review },
          },
        },
      };
    case "set-correction":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            corrections: { ...caseState.corrections, [action.mappingId]: String(action.value || "") },
          },
        },
      };
    case "toggle-record-editor":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: { ...caseState, recordEditorOpen: !caseState.recordEditorOpen },
        },
      };
    case "set-feedback":
      return {
        ...state,
        cases: {
          ...state.cases,
          [cardIdValue]: {
            ...caseState,
            feedback: action.feedback || null,
            revealState: action.revealState || "ready",
          },
        },
      };
    case "set-activity":
      return {
        ...state,
        activity: action.message,
        activityTone: action.tone || "idle",
      };
    default:
      return state;
  }
}
