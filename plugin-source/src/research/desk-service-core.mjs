// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { applicationServiceGate } from "../runtime/application-recovery.mjs";
import { handleCommand } from "../http/command.mjs";
import { queryInbox } from "../http/query.mjs";
import { queryFeedback } from "../feedback/query.mjs";
import { queryReport } from "../report/query.mjs";
import {
  queryCasefile,
  queryEvidence,
  querySnapshots,
} from "./query.mjs";
import {
  liveLedgerWatermark,
  readProjectionHealth,
  rebuildResearchProjection,
} from "./projection.mjs";
import { refreshResearch } from "./refresh.mjs";
import { resolveDailyBarAdapter } from "./daily-bar.mjs";
import {
  formatMarketPulseSpeech,
  resolveRealtimeMarketAdapter,
} from "./realtime-market.mjs";
import { researchObservationQueries } from "./cases.mjs";
import { curateCaseHighlights } from "./llm-curate.mjs";
import { assertLoopbackUrl, resolveDeskPaths } from "./desk-paths.mjs";
import { searchWechatRawMessages as searchWechatRawMessagesFromDisk } from "./wechat-raw-search.mjs";
import { searchWechatRadarMessages as searchWechatRadarMessagesFromDb } from "./wechat-radar-search.mjs";
import {
  queryCatalystAuditOverview,
  queryCatalystSourceList,
  queryCatalystWatchDetail,
  queryCatalystWatchList,
} from "../watch/query.mjs";

const PROJECTION_COMPLETE = "COMPLETE";
const PROJECTION_STALE = "PROJECTION_STALE";
// Keep one external call bounded within the five-minute live round while
// leaving the source analyzer its full 180-second contract and no retry.
export const WECHAT_SYNC_TIMEOUT_MS = 90_000;

const DEFAULT_OPERATIONS = Object.freeze({
  handleCommand,
  queryInbox,
  queryFeedback,
  queryReport,
  queryCasefile,
  queryEvidence,
  querySnapshots,
  liveLedgerWatermark,
  queryCatalystWatchList,
  queryCatalystWatchDetail,
  queryCatalystAuditOverview,
  queryCatalystSourceList,
  readProjectionHealth,
  rebuildResearchProjection,
  refreshResearch,
  resolveDailyBarAdapter,
  curateCaseHighlights,
  resolveRealtimeMarketAdapter,
  searchWechatRawMessages: searchWechatRawMessagesFromDisk,
  searchWechatRadarMessages: searchWechatRadarMessagesFromDb,
});

function errorObject(code, message, details = undefined) {
  return {
    code,
    message,
    ...(details && typeof details === "object" ? { details } : {}),
  };
}

function normalizeError(error) {
  const code =
    error && typeof error.code === "string" ? error.code : "INTERNAL";
  const message =
    error && typeof error.message === "string"
      ? error.message
      : "Variable OS desk request failed";
  const details =
    error && error.details && typeof error.details === "object"
      ? error.details
      : undefined;
  return errorObject(code, message, details);
}

function failed(code, message, extra = {}) {
  return { ok: false, error: errorObject(code, message), ...extra };
}

function projectionState(rebuilt) {
  return rebuilt && rebuilt.ok !== false
    ? PROJECTION_COMPLETE
    : PROJECTION_STALE;
}

function publicStorageDescriptor(storage) {
  if (!storage || typeof storage !== "object") return null;
  return Object.freeze({
    configuredMode: storage.configuredMode,
    writerKind: storage.writerKind,
    authorityMode: storage.authorityMode,
    authorityGeneration: storage.authorityGeneration,
  });
}

function watermarkFrom(params) {
  if (
    params.strictWatermark === true &&
    (!Object.hasOwn(params, "asOfWatermark") ||
      params.asOfWatermark === undefined ||
      params.asOfWatermark === null ||
      params.asOfWatermark === "")
  ) {
    return undefined;
  }
  return params.asOfWatermark || "latest";
}

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function exposureCutoffDateFromInstant(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? SHANGHAI_DATE_FORMATTER.format(new Date(timestamp))
    : null;
}

function configuredWechatExposureCutoffDate(env, sourceRuntime) {
  const configured = typeof env?.VARIABLE_OS_WECHAT_RAW_EXPOSURE_CUTOFF_DATE === "string"
    ? env.VARIABLE_OS_WECHAT_RAW_EXPOSURE_CUTOFF_DATE.trim()
    : "";
  if (configured) return DATE_ONLY_PATTERN.test(configured) ? configured : null;
  const connector = Array.isArray(sourceRuntime?.connectors)
    ? sourceRuntime.connectors.find((item) => item?.id === "wechat")
    : null;
  return exposureCutoffDateFromInstant(connector?.lastSourceAt);
}

async function safeHealth(operations, runtime, live = null) {
  return operations.readProjectionHealth({
    researchRoot: runtime.researchRoot,
    ledgerRoot: runtime.config.ledgerRoot,
    store: runtime.store,
    now: runtime.now,
    live,
  });
}

async function readJsonResponse(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > 1024 * 1024) {
    const error = new Error("WeChat sync response is too large");
    error.code = "WECHAT_SYNC_RESPONSE_TOO_LARGE";
    throw error;
  }
  const raw = await response.text();
  if (raw.length > 1024 * 1024) {
    const error = new Error("WeChat sync response is too large");
    error.code = "WECHAT_SYNC_RESPONSE_TOO_LARGE";
    throw error;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 500) };
  }
}

function mergeWechatSearchResults(raw, radar, query, limit) {
  const seen = new Set();
  const matches = [];
  for (const [source, result] of [["raw", raw], ["radar", radar]]) {
    for (const match of Array.isArray(result?.matches) ? result.matches : []) {
      const key = String(match?.contentHash || `${source}:${match?.sourceDocumentKey || match?.heading || ""}`);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ ...match, sourceChannel: source });
    }
  }
  matches.sort((left, right) => {
    const rightTime = Date.parse(String(right?.eventAt || ""));
    const leftTime = Date.parse(String(left?.eventAt || ""));
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
  const visible = matches.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 5);
  return {
    schema: "wechat-search-v1",
    readOnly: true,
    source: "wechat-both",
    channel: "both",
    query: raw?.query || radar?.query || query,
    dateFrom: raw?.dateFrom || radar?.dateFrom || null,
    dateTo: raw?.dateTo || radar?.dateTo || null,
    exposureCutoffDate: raw?.exposureCutoffDate || radar?.exposureCutoffDate || null,
    matches: visible,
    totalMatches: matches.length,
    truncated: matches.length > visible.length || raw?.truncated === true || radar?.truncated === true,
    sourceTotals: {
      raw: Number(raw?.totalMatches) || 0,
      radar: Number(radar?.totalMatches) || 0,
    },
    channels: Object.freeze({ raw, radar }),
  };
}

/**
 * One application service for the compatibility server, Harness RPC and vos_*.
 * Every public call returns the same result envelope and never leaks a stack.
 */
export function createDeskService({
  runtimeFactory,
  operations: operationOverrides = {},
  pathResolver = resolveDeskPaths,
  fetchImpl = globalThis.fetch,
  env = process.env,
  modelStatusProvider = null,
  sourceWorkerStorageProvider,
} = {}) {
  const operations = { ...DEFAULT_OPERATIONS, ...operationOverrides };
  if (typeof runtimeFactory !== "function" || typeof operations.readSourceRuntimeHealth !== "function") {
    throw Object.assign(Error("DESK_RUNTIME_REQUIRED"), { code: "DESK_RUNTIME_REQUIRED" });
  }
  let wechatSyncInFlight = false;
  let realtimeMarketAdapterPromise = null;
  let liveProjectionCache = null;
  let liveProjectionBuild = null;

  async function withRuntime(run) {
    const runtime = await runtimeFactory({ env });
    try {
      return await run(runtime);
    } finally {
      await runtime.close?.();
    }
  }

  async function resolveStableLive(runtime) {
    if (typeof runtime.store?.readRevision !== "function") return null;
    while (true) {
      let revision;
      try {
        revision = await runtime.store.readRevision();
      } catch {
        return null;
      }
      if (liveProjectionCache?.revision === revision) {
        return liveProjectionCache.live;
      }
      if (liveProjectionBuild?.revision === revision) {
        return liveProjectionBuild.promise;
      }
      if (liveProjectionBuild) {
        // One full ledger build across revisions, not one per revision. Re-read
        // metadata after waiting so a newer request cannot inherit an old result.
        await liveProjectionBuild.promise.catch(() => undefined);
        continue;
      }
      // Existing consumers keep their snapshot; the cache need not retain another
      // full generation while its replacement is being assembled.
      liveProjectionCache = null;
      const promise = (async () => {
        const live = await operations.liveLedgerWatermark(runtime.store, runtime.now);
        try {
          const confirmedRevision = await runtime.store.readRevision();
          if (confirmedRevision === revision) {
            liveProjectionCache = { revision, live };
          }
        } catch {
          // A transient stat failure only disables reuse; the live projection remains valid.
        }
        return live;
      })();
      liveProjectionBuild = { revision, promise };
      try {
        return await promise;
      } finally {
        if (liveProjectionBuild?.promise === promise) liveProjectionBuild = null;
      }
    }
  }

  async function bootstrap(params) {
    return withRuntime(async (runtime) => {
      const initialReads = [
        resolveStableLive(runtime),
        Promise.resolve().then(() => operations.readSourceRuntimeHealth({env,workerStorageProvider:sourceWorkerStorageProvider})),
        typeof modelStatusProvider === "function"
          ? Promise.resolve().then(() => modelStatusProvider()).catch(() => null)
          : Promise.resolve(null),
      ];
      let initialResults;
      try {
        initialResults = await Promise.all(initialReads);
      } catch (error) {
        // A sibling failure must not close the runtime under a shared build.
        await Promise.allSettled(initialReads);
        throw error;
      }
      const [live, sourceRuntime, rawHarnessModel] = initialResults;
      const health = await safeHealth(operations, runtime, live);
      const harnessModel =
        rawHarnessModel &&
        ["deepseek-official", "grok-cli"].includes(rawHarnessModel.provider) &&
        typeof rawHarnessModel.model === "string" &&
        rawHarnessModel.model.trim()
          ? {
              provider: rawHarnessModel.provider,
              model: rawHarnessModel.model.trim().slice(0, 120),
              reasoningEffort:
                typeof rawHarnessModel.reasoningEffort === "string"
                  ? rawHarnessModel.reasoningEffort.trim().slice(0, 40)
                  : undefined,
              sourceWorkerEnabled: rawHarnessModel.sourceWorkerEnabled === true,
              analysisEngine:
                rawHarnessModel.analysisEngine === "grok-cli"
                  ? "grok-cli"
                  : "deepseek",
              ...(Number.isInteger(rawHarnessModel.analysisConcurrencyLimit) &&
              rawHarnessModel.analysisConcurrencyLimit >= 1
                ? {
                    analysisConcurrencyLimit: Math.min(
                      4,
                      rawHarnessModel.analysisConcurrencyLimit,
                    ),
                  }
                : {}),
              ...(rawHarnessModel.analysisLaneStrategy === "FRESH_AND_BACKLOG"
                ? { analysisLaneStrategy: "FRESH_AND_BACKLOG" }
                : {}),
              ...(Number.isInteger(rawHarnessModel.analysisTimeoutSeconds) &&
              rawHarnessModel.analysisTimeoutSeconds >= 30
                ? {
                    analysisTimeoutSeconds: Math.min(
                      300,
                      rawHarnessModel.analysisTimeoutSeconds,
                    ),
                  }
                : {}),
            }
          : null;
      let inbox = null;
      let snapshots = null;
      let catalystOverview = null;
      let bootstrapError = null;
      let bootstrapProjectionStatus = health.projectionStatus;
      if (health.projectionStatus === PROJECTION_COMPLETE) {
        try {
          [inbox, snapshots] = await Promise.all([
            operations.queryInbox({
              store: runtime.store,
              asOfWatermark: watermarkFrom(params),
              cardId: params.card || null,
              mode: params.mode || null,
              taskId: params.task || null,
              now: runtime.now,
              live,
            }),
            operations.querySnapshots({
              derivedRoot: runtime.researchRoot,
              store: runtime.store,
              now: runtime.now,
              snapshot: params.snapshot || undefined,
              live,
            }),
          ]);
        } catch (error) {
          bootstrapError = normalizeError(error);
          if (bootstrapError.code === PROJECTION_STALE) {
            bootstrapProjectionStatus = PROJECTION_STALE;
          }
        }
        try {
          catalystOverview = await operations.queryCatalystAuditOverview({
            derivedRoot: runtime.researchRoot,
            store: runtime.store,
            now: runtime.now,
            asOfWatermark: watermarkFrom(params),
            live,
          });
        } catch (error) {
          const normalized = normalizeError(error);
          bootstrapError ||= normalized;
          if (normalized.code === PROJECTION_STALE) {
            bootstrapProjectionStatus = PROJECTION_STALE;
          }
        }
      }
      const paths = pathResolver(env);
      const bootstrapHealth =
        bootstrapProjectionStatus === health.projectionStatus
          ? health
          : { ...health, projectionStatus: bootstrapProjectionStatus };
      return {
        ok: true,
        projectionStatus: bootstrapProjectionStatus,
        result: {
          health: bootstrapHealth,
          sourceRuntime,
          inbox,
          snapshots,
          catalystFunnel: catalystOverview?.funnel || null,
          featureFlags: {
            watchCatalystEnabled:
              rawHarnessModel?.watchCatalystEnabled === true ||
              env.VARIABLE_OS_WATCH_CATALYST_ENABLED === "1",
            watchCatalystUiEnabled:
              rawHarnessModel?.watchCatalystUiEnabled === true ||
              env.VARIABLE_OS_WATCH_CATALYST_UI_ENABLED === "1",
          },
          bootstrapError,
          diagnostics: {
            mode: runtime.config.mode,
            version: "variable-desk-v1",
            dataSources: {
              sourceRoot: paths.sourceRoot,
              wechat: paths.wechatMdDir,
              gangtise: paths.gangtiseCluesDir,
              liudu: paths.liuduRoot,
              radarSync: paths.radarSyncUrl,
            },
            model: harnessModel
              ? `${harnessModel.model}${
                  harnessModel.reasoningEffort
                    ? ` · ${harnessModel.reasoningEffort}`
                    : ""
                }`
              : sourceRuntime?.latestAnalysis?.model ||
                paths.llmModel ||
                "本地结构解析",
            remoteModelConfigured: Boolean(
              (harnessModel && harnessModel.sourceWorkerEnabled) ||
                sourceRuntime?.latestAnalysis?.provider === "grok-cli" ||
                sourceRuntime?.latestAnalysis?.provider === "deepseek-official" ||
                sourceRuntime?.latestAnalysis?.provider === "remote-llm" ||
                (env.VARIABLE_OS_ALLOW_REMOTE_SOURCE_LLM === "1" &&
                  (env.VARIABLE_OS_LLM_API_KEY ||
                    env.DEEPSEEK_API_KEY ||
                    env.OPENAI_API_KEY)),
            ),
            harnessModel,
          },
        },
      };
    });
  }

  async function health() {
    return withRuntime(async (runtime) => {
      const live = await resolveStableLive(runtime);
      const result = await safeHealth(operations, runtime, live);
      const storage = publicStorageDescriptor(runtime.storage);
      return {
        ok: true,
        result: storage ? { ...result, storage } : result,
        projectionStatus: result.projectionStatus,
      };
    });
  }

  async function sourceHealth() {
    return {
      ok: true,
      result: await Promise.resolve(operations.readSourceRuntimeHealth({env,workerStorageProvider:sourceWorkerStorageProvider})),
      projectionStatus: null,
    };
  }

  async function wechatRawSearch(params) {
    const paths = pathResolver(env);
    let sourceRuntime;
    try {
      sourceRuntime = await Promise.resolve(operations.readSourceRuntimeHealth({env,workerStorageProvider:sourceWorkerStorageProvider}));
    } catch {
      sourceRuntime = null;
    }
    const exposureCutoffDate = configuredWechatExposureCutoffDate(env, sourceRuntime);
    if (!exposureCutoffDate) {
      return failed(
        "WECHAT_RAW_EXPOSURE_CUTOFF_UNAVAILABLE",
        "微信原始舆情曝光水位不可用，已拒绝检索",
      );
    }
    const channel = params.channel === "radar" || params.channel === "both" ? params.channel : "raw";
    const common = {
      query: params.query,
      limit: params.limit,
      exposureCutoffDate,
    };
    if (params.dateFrom !== undefined) common.dateFrom = params.dateFrom;
    if (params.dateTo !== undefined) common.dateTo = params.dateTo;
    const rawInput = { directory: paths.wechatMdDir, ...common };
    const radarInput = {
      dbPath: paths.radarDb,
      groupsConfigPath: paths.radarGroupsConfig,
      ...common,
    };
    const [rawResult, radarResult] = channel === "both"
      ? await Promise.all([
          operations.searchWechatRawMessages(rawInput),
          operations.searchWechatRadarMessages(radarInput),
        ])
      : [
          channel === "radar" ? null : await operations.searchWechatRawMessages(rawInput),
          channel === "radar" ? await operations.searchWechatRadarMessages(radarInput) : null,
        ];
    const result = channel === "both"
      ? mergeWechatSearchResults(rawResult, radarResult, common.query, common.limit)
      : channel === "radar" ? radarResult : rawResult;
    const count = Number(result?.totalMatches) || 0;
    const visible = Array.isArray(result?.matches) ? result.matches.slice(0, 3) : [];
    const label = channel === "radar" ? "微信 Radar 舆情" : channel === "both" ? "微信原始与 Radar 舆情" : "微信原始舆情";
    const speech = count
      ? `${label}找到 ${count} 条，最近包括：${visible.map((item) => item.heading).filter(Boolean).join("、")}。`
      : `${label}没有找到与“${String(result?.query || params.query || "该查询")}”匹配的片段。`;
    return {
      ok: true,
      result: { ...result, channel, speech },
      projectionStatus: null,
    };
  }

  async function marketPulse(params) {
    const query = typeof params.query === "string"
      ? params.query.replace(/\s+/gu, " ").trim().slice(0, 80)
      : "";
    if (!query) return failed("MARKET_QUERY_REQUIRED", "股票名称或代码不能为空");
    if (!realtimeMarketAdapterPromise) {
      realtimeMarketAdapterPromise = Promise.resolve(
        operations.resolveRealtimeMarketAdapter({ env, fetchImpl }),
      );
    }
    const adapter = await realtimeMarketAdapterPromise;
    if (!adapter || typeof adapter.getMarketPulse !== "function") {
      return failed("MARKET_REALTIME_UNAVAILABLE", "未配置可用的实时行情凭据");
    }
    const result = await adapter.getMarketPulse({ query });
    return {
      ok: true,
      result: { ...result, speech: formatMarketPulseSpeech(result) },
      projectionStatus: null,
    };
  }

  async function inbox(params) {
    return withRuntime(async (runtime) => {
      const live = await resolveStableLive(runtime);
      return {
        ok: true,
        result: await operations.queryInbox({
          store: runtime.store,
          asOfWatermark: watermarkFrom(params),
          cardId: params.card || null,
          mode: params.mode || null,
          taskId: params.task || null,
          now: runtime.now,
          live,
        }),
        projectionStatus: PROJECTION_COMPLETE,
      };
    });
  }

  async function casefile(params) {
    return withRuntime(async (runtime) => {
      const live = await resolveStableLive(runtime);
      return {
        ok: true,
        result: await operations.queryCasefile({
          derivedRoot: runtime.researchRoot,
          store: runtime.store,
          card: params.card,
          snapshot: params.snapshot || undefined,
          asOfWatermark: watermarkFrom(params),
          now: runtime.now,
          live,
        }),
        projectionStatus: PROJECTION_COMPLETE,
      };
    });
  }

  async function evidence(params) {
    return withRuntime(async (runtime) => {
      const paths = pathResolver(env);
      const live = await resolveStableLive(runtime);
      return {
        ok: true,
        result: await operations.queryEvidence({
          derivedRoot: runtime.researchRoot,
          store: runtime.store,
          id: params.id,
          snapshot: params.snapshot || undefined,
          now: runtime.now,
          sourceRoots: [paths.sourceRoot, paths.liuduRoot].filter(Boolean),
          live,
        }),
        projectionStatus: PROJECTION_COMPLETE,
      };
    });
  }

  async function feedback(params) {
    return withRuntime(async (runtime) => ({
      ok: true,
      result: await operations.queryFeedback({
        store: runtime.store,
        asOfWatermark: watermarkFrom(params),
        cardId: params.card || null,
        presentationDecisionId:
          params.decision || params.presentationDecisionId || null,
        now: runtime.now,
        researchRoot: runtime.researchRoot,
      }),
      projectionStatus: PROJECTION_COMPLETE,
    }));
  }

  async function report(params) {
    return withRuntime(async (runtime) => ({
      ok: true,
      result: await operations.queryReport({
        store: runtime.store,
        asOfWatermark: watermarkFrom(params),
        date: params.date || null,
        snapshotId: params.snapshot || params.snapshotId || null,
        now: runtime.now,
      }),
      projectionStatus: PROJECTION_COMPLETE,
    }));
  }

  async function catalystWatchList(params) {
    return withRuntime(async (runtime) => ({
      ok: true,
      result: await operations.queryCatalystWatchList({
        derivedRoot: runtime.researchRoot,
        store: runtime.store,
        now: runtime.now,
        status: params.status,
        source: params.source,
        archetype: params.archetype,
        freshness: params.freshness,
        limit: params.limit,
        cursor: params.cursor,
        asOfWatermark: watermarkFrom(params),
      }),
      projectionStatus: PROJECTION_COMPLETE,
    }));
  }

  async function catalystWatchDetail(params) {
    return withRuntime(async (runtime) => ({
      ok: true,
      result: await operations.queryCatalystWatchDetail({
        derivedRoot: runtime.researchRoot,
        store: runtime.store,
        now: runtime.now,
        watchId: params.watchId,
        asOfWatermark: watermarkFrom(params),
      }),
      projectionStatus: PROJECTION_COMPLETE,
    }));
  }

  async function catalystAuditOverview(params) {
    return withRuntime(async (runtime) => ({
      ok: true,
      result: await operations.queryCatalystAuditOverview({
        derivedRoot: runtime.researchRoot,
        store: runtime.store,
        now: runtime.now,
        asOfWatermark: watermarkFrom(params),
      }),
      projectionStatus: PROJECTION_COMPLETE,
    }));
  }

  async function catalystSourceList(params) {
    return withRuntime(async (runtime) => ({
      ok: true,
      result: await operations.queryCatalystSourceList({
        derivedRoot: runtime.researchRoot,
        store: runtime.store,
        now: runtime.now,
        source: params.source,
        archetype: params.archetype,
        status: params.status,
        freshness: params.freshness,
        limit: params.limit,
        cursor: params.cursor,
        asOfWatermark: watermarkFrom(params),
      }),
      projectionStatus: PROJECTION_COMPLETE,
    }));
  }

  async function refresh(params) {
    return withRuntime(async (runtime) => {
      const paths = pathResolver(env);
      const forceOffline = Boolean(params.forceOffline);
      const dailyBarAdapter = await operations.resolveDailyBarAdapter({
        env,
        forceOffline,
        observationQueries: researchObservationQueries(),
      });
      const refreshed = await operations.refreshResearch({
        sourceRoot: paths.sourceRoot,
        derivedRoot: runtime.researchRoot,
        now: runtime.now,
        store: runtime.store,
        forceOffline,
        dailyBarAdapter,
      });
      if (!refreshed || refreshed.ok === false) {
        return failed(
          refreshed?.error?.code || "REFRESH_FAILED",
          refreshed?.error?.message || "Research refresh failed",
          { projectionStatus: PROJECTION_STALE, result: refreshed || null },
        );
      }
      const rebuilt = await operations.rebuildResearchProjection({
        derivedRoot: runtime.researchRoot,
        ledgerRoot: runtime.config.ledgerRoot,
        store: runtime.store,
        now: runtime.now,
      });
      if (projectionState(rebuilt) !== PROJECTION_COMPLETE) {
        return failed(
          "PROJECTION_STALE_AFTER_REFRESH",
          "Snapshot refreshed but the SQLite projection is stale",
          {
            projectionStatus: PROJECTION_STALE,
            result: refreshed,
          },
        );
      }
      return {
        ok: true,
        result: refreshed,
        projectionStatus: PROJECTION_COMPLETE,
      };
    });
  }

  async function repairProjection() {
    return withRuntime(async (runtime) => {
      let rebuilt;
      try {
        rebuilt = await operations.rebuildResearchProjection({
          derivedRoot: runtime.researchRoot,
          ledgerRoot: runtime.config.ledgerRoot,
          store: runtime.store,
          now: runtime.now,
        });
      } catch {
        rebuilt = null;
      }
      if (projectionState(rebuilt) !== PROJECTION_COMPLETE) {
        return failed(
          "PROJECTION_REPAIR_FAILED",
          "The SQLite projection could not be rebuilt from the canonical ledger",
          {
            projectionStatus: PROJECTION_STALE,
            result: rebuilt || null,
          },
        );
      }
      return {
        ok: true,
        result: rebuilt,
        projectionStatus: PROJECTION_COMPLETE,
      };
    });
  }

  async function command(params) {
    return withRuntime(async (runtime) => {
      const result = await operations.handleCommand({
        store: runtime.store,
        now: runtime.now,
        body: params,
      });
      let rebuilt;
      try {
        rebuilt = await operations.rebuildResearchProjection({
          derivedRoot: runtime.researchRoot,
          ledgerRoot: runtime.config.ledgerRoot,
          store: runtime.store,
          now: runtime.now,
        });
      } catch (error) {
        rebuilt = { ok: false, error };
      }
      if (projectionState(rebuilt) !== PROJECTION_COMPLETE) {
        return failed(
          "PROJECTION_STALE_AFTER_COMMIT",
          "Command committed to the canonical ledger but projection rebuild failed",
          {
            projectionStatus: PROJECTION_STALE,
            receipt: result.commitGroupReceipt || null,
            result,
          },
        );
      }
      return {
        ok: true,
        result,
        receipt: result.commitGroupReceipt || null,
        projectionStatus: PROJECTION_COMPLETE,
      };
    });
  }

  async function curate(params) {
    return {
      ok: true,
      result: await operations.curateCaseHighlights({
        caseTitle: params.caseTitle,
        processSummaries: params.processSummaries,
        knownThenNote: params.knownThenNote,
      }),
      projectionStatus: null,
    };
  }

  async function wechatSync(params) {
    if (wechatSyncInFlight) {
      return failed("SYNC_IN_PROGRESS", "A WeChat sync request is already running");
    }
    const paths = pathResolver(env);
    let url;
    try {
      url = assertLoopbackUrl(paths.radarSyncUrl);
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
    if (typeof fetchImpl !== "function") {
      return failed("WECHAT_SYNC_UNAVAILABLE", "fetch is unavailable");
    }
    wechatSyncInFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WECHAT_SYNC_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: params.force === true }),
        signal: controller.signal,
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        return failed("WECHAT_SYNC_FAILED", `WeChat sync returned HTTP ${response.status}`, {
          result: { status: response.status, payload },
        });
      }
      return {
        ok: true,
        result: { status: response.status, payload },
        projectionStatus: null,
      };
    } catch (error) {
      const code =
        error && error.name === "AbortError"
          ? "WECHAT_SYNC_TIMEOUT"
          : error && error.code
            ? error.code
            : "WECHAT_SYNC_FAILED";
      return failed(code, error?.message || "WeChat sync failed");
    } finally {
      clearTimeout(timer);
      wechatSyncInFlight = false;
    }
  }

  const methods = Object.freeze({
    bootstrap,
    health,
    sourceHealth,
    wechatRawSearch,
    marketPulse,
    inbox,
    casefile,
    evidence,
    feedback,
    report,
    catalystWatchList,
    catalystWatchDetail,
    catalystAuditOverview,
    catalystSourceList,
    repairProjection,
    refresh,
    command,
    curate,
    wechatSync,
  });

  return Object.freeze({
    async call(method, params = {}) {
      if (!Object.hasOwn(methods, method)) {
        return failed("METHOD_NOT_FOUND", "Unknown Variable OS desk method");
      }
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return failed("INVALID_PARAMS", "params must be a JSON object");
      }
      try {
        return await applicationServiceGate.run(() => methods[method](params));
      } catch (error) {
        const normalized = normalizeError(error);
        return {
          ok: false,
          error: normalized,
          ...(normalized.code === "PROJECTION_STALE"
            ? { projectionStatus: PROJECTION_STALE }
            : {}),
        };
      }
    },
  });
}
