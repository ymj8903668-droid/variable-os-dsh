// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { fail } from "./errors.mjs";

function unknownBar(query, reasonCode) {
  return Object.freeze({
    status: "UNKNOWN",
    reasonCode,
    securityCode: query.securityCode,
    sessionDate: query.sessionDate,
    bar: null,
  });
}

function freezeQueries(queries) {
  if (!Array.isArray(queries)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    queries.map((query) =>
      Object.freeze({
        securityCode: query.securityCode,
        sessionDate: query.sessionDate,
      }),
    ),
  );
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

export function shanghaiSessionCutoff(sessionDate) {
  if (typeof sessionDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    fail("INVALID_SESSION", "sessionDate must be YYYY-MM-DD");
  }
  return `${sessionDate}T15:00:00+08:00`;
}

export function normalizeShanghaiSessionDate(value) {
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      return match[1];
    }
  }
  const date =
    value instanceof Date
      ? value
      : value && typeof value.getTime === "function"
        ? new Date(value.getTime())
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function normalizeBarRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const sessionDate = normalizeShanghaiSessionDate(
    row.trade_date ?? row.tradeDate ?? row.date ?? row.sessionDate,
  );
  if (!sessionDate) {
    return null;
  }
  const close = pickNumber(row.close);
  if (close == null) {
    return null;
  }
  return {
    sessionDate,
    bar: Object.freeze({
      open: pickNumber(row.open),
      high: pickNumber(row.high),
      low: pickNumber(row.low),
      close,
      preClose: pickNumber(row.pre_close, row.preClose),
      pctChange: pickNumber(row.pct_chg, row.pctChange),
      volume: pickNumber(row.volume, row.vol),
      amount: pickNumber(row.amount),
      turnover: pickNumber(row.turnover),
    }),
  };
}

const SECRET_KEYS = new Set([
  "host",
  "hostname",
  "user",
  "username",
  "password",
  "pass",
  "path",
  "pgConfigPath",
  "configPath",
  "databaseUrl",
  "connectionString",
]);

export function redactMarketSecrets(value, seen = new WeakSet()) {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactMarketSecrets(item, seen));
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      continue;
    }
    if (
      typeof raw === "string" &&
      (/\/secret\//i.test(raw) ||
        /password/i.test(raw) ||
        /\.pg\.json$/i.test(raw) ||
        /db\.internal/i.test(raw))
    ) {
      continue;
    }
    out[key] = redactMarketSecrets(raw, seen);
  }
  return out;
}

export function createUnavailableDailyBarAdapter() {
  return Object.freeze({
    availability: "UNAVAILABLE",
    cutoff: null,
    observationQueries: Object.freeze([]),
    diagnostics: Object.freeze({ available: false, source: "unavailable" }),
    async getDailyBar(query) {
      return unknownBar(query, "PROVIDER_UNAVAILABLE");
    },
  });
}

export function createInjectedDailyBarAdapter(fetchBar, options = {}) {
  if (typeof fetchBar !== "function") {
    fail("INVALID_ADAPTER", "injected daily-bar fetch function required");
  }
  const cutoff = options.cutoff || null;
  const observationQueries = freezeQueries(options.observationQueries);
  return Object.freeze({
    availability: "INJECTED",
    cutoff,
    observationQueries,
    diagnostics: Object.freeze({ available: true, source: "injected" }),
    async getDailyBar(query) {
      const row = await fetchBar(query);
      if (!row || row.status !== "COMPLETE" || !row.bar) {
        return unknownBar(query, (row && row.reasonCode) || "BAR_MISSING");
      }
      return Object.freeze({
        status: "COMPLETE",
        reasonCode: null,
        securityCode: query.securityCode,
        sessionDate: query.sessionDate,
        bar: Object.freeze({ ...row.bar }),
      });
    },
  });
}

export function createFixtureDailyBarAdapter(fixture) {
  if (!fixture || fixture.synthetic !== true) {
    fail("INVALID_MARKET", "daily-bar fixture must be synthetic");
  }
  return createInjectedDailyBarAdapter(
    async (query) => {
      const day = fixture.sessions?.[query.sessionDate];
      const point = day?.[query.securityCode];
      if (!point || point.close == null) {
        return unknownBar(query, "BAR_MISSING");
      }
      return {
        status: "COMPLETE",
        securityCode: query.securityCode,
        sessionDate: query.sessionDate,
        bar: {
          open: point.open ?? null,
          high: point.high ?? null,
          low: point.low ?? null,
          close: point.close,
          volume: point.volume ?? null,
          turnover: point.turnover ?? null,
        },
      };
    },
    {
      cutoff: fixture.cutoff || null,
      observationQueries: fixture.observationQueries || [],
    },
  );
}

export function createLocalDailyBarAdapter({
  observationQueries = [],
  fetchSecurityRows,
} = {}) {
  if (typeof fetchSecurityRows !== "function") {
    fail("INVALID_ADAPTER", "fetchSecurityRows function required");
  }
  const queries = freezeQueries(observationQueries);
  const cache = new Map();
  let latestCompleteSession = null;

  async function loadSecurity(securityCode) {
    if (cache.has(securityCode)) {
      return cache.get(securityCode);
    }
    const byDate = new Map();
    try {
      const rows = await fetchSecurityRows(securityCode);
      for (const row of rows || []) {
        const normalized = normalizeBarRow(row);
        if (!normalized) {
          continue;
        }
        byDate.set(normalized.sessionDate, normalized.bar);
      }
    } catch {
      // fail closed: missing/errored security stays empty → UNKNOWN bars
    }
    cache.set(securityCode, byDate);
    return byDate;
  }

  const adapter = {
    availability: "LOCAL",
    observationQueries: queries,
    diagnostics: Object.freeze({ available: true, source: "local-sql" }),
    get cutoff() {
      return latestCompleteSession
        ? shanghaiSessionCutoff(latestCompleteSession)
        : null;
    },
    async getDailyBar(query) {
      const byDate = await loadSecurity(query.securityCode);
      const bar = byDate.get(query.sessionDate);
      if (!bar || bar.close == null) {
        return unknownBar(query, "BAR_MISSING");
      }
      if (
        !latestCompleteSession ||
        query.sessionDate > latestCompleteSession
      ) {
        latestCompleteSession = query.sessionDate;
      }
      return Object.freeze({
        status: "COMPLETE",
        reasonCode: null,
        securityCode: query.securityCode,
        sessionDate: query.sessionDate,
        bar,
      });
    },
  };
  return adapter;
}

export async function createTradingWikiDailyBarAdapter({
  wikiRoot,
  env = process.env,
  loadAskMarket,
  observationQueries = [],
} = {}) {
  const configPath =
    env.VARIABLE_OS_STOCK_DB_CONFIG || env.PG_SHIHAO_CONFIG_PATH || null;
  void configPath;
  void wikiRoot;

  if (typeof loadAskMarket !== "function") {
    return Object.freeze({
      ...createUnavailableDailyBarAdapter(),
      diagnostics: Object.freeze(
        redactMarketSecrets({ available: false, source: "local-sql" }),
      ),
    });
  }

  let ask;
  try {
    ask = await loadAskMarket();
  } catch {
    return Object.freeze({
      ...createUnavailableDailyBarAdapter(),
      diagnostics: Object.freeze(
        redactMarketSecrets({ available: false, source: "local-sql" }),
      ),
    });
  }

  const usable =
    ask &&
    typeof ask.hasUsableStockDailyPgConfig === "function" &&
    ask.hasUsableStockDailyPgConfig() === true;
  if (!usable) {
    return Object.freeze({
      ...createUnavailableDailyBarAdapter(),
      diagnostics: Object.freeze(
        redactMarketSecrets({ available: false, source: "local-sql" }),
      ),
    });
  }

  const local = createLocalDailyBarAdapter({
    observationQueries,
    fetchSecurityRows: async (securityCode) => {
      const result = await ask.searchAskStockDaily(
        wikiRoot,
        { securityCode },
        {
          askStockDailyCrossCheck: false,
          stockDailyCrossCheck: false,
          pgConfigPath: "[redacted]",
        },
      );
      if (!result || result.status !== "ok" || !Array.isArray(result.results)) {
        return [];
      }
      return result.results.map((item) => item.row || item).filter(Boolean);
    },
  });

  return Object.freeze({
    availability: local.availability,
    observationQueries: local.observationQueries,
    get cutoff() {
      return local.cutoff;
    },
    getDailyBar: (...args) => local.getDailyBar(...args),
    diagnostics: Object.freeze(
      redactMarketSecrets({
        available: true,
        source: "local-sql",
      }),
    ),
  });
}

/**
 * Tushare daily bars via injectable fetchDailyRows(securityCode) → row[].
 * Missing sessions stay UNKNOWN; never invents closes.
 */
export function createTushareDailyBarAdapter({
  fetchDailyRows,
  observationQueries = [],
} = {}) {
  if (typeof fetchDailyRows !== "function") {
    fail("INVALID_ADAPTER", "fetchDailyRows function required");
  }
  const queries = freezeQueries(observationQueries);
  const dates = queries.map((row) => row.sessionDate).filter(Boolean).sort();
  const startDate = dates[0] || null;
  const endDate = dates[dates.length - 1] || null;
  const local = createLocalDailyBarAdapter({
    observationQueries: queries,
    fetchSecurityRows: async (securityCode) =>
      fetchDailyRows(securityCode, { startDate, endDate }),
  });
  return Object.freeze({
    availability: "TUSHARE",
    observationQueries: local.observationQueries,
    get cutoff() {
      return local.cutoff;
    },
    getDailyBar: (...args) => local.getDailyBar(...args),
    diagnostics: Object.freeze({ available: true, source: "tushare-daily" }),
  });
}

/**
 * Resolve production daily-bar adapter for CLI/server refresh.
 * Priority: forceOffline → UNAVAILABLE; Tushare token → tushare-daily; else UNAVAILABLE.
 */
export async function resolveDailyBarAdapter({
  env = process.env,
  forceOffline = false,
  observationQueries = [],
  createTushareFetcher,
} = {}) {
  if (
    forceOffline ||
    env.VARIABLE_OS_MARKET_OFFLINE === "1" ||
    env.VARIABLE_OS_MARKET_OFFLINE === "true"
  ) {
    return createUnavailableDailyBarAdapter();
  }
  const { createTushareHttpFetcher } = await import("./tushare-client.mjs");
  const fetcher =
    typeof createTushareFetcher === "function"
      ? createTushareFetcher()
      : createTushareHttpFetcher({
          token: env.TUSHARE_TOKEN || env.TUSHARE_API_TOKEN || "",
          apiUrl: env.TUSHARE_API_URL,
        });
  if (!fetcher) {
    return createUnavailableDailyBarAdapter();
  }
  return createTushareDailyBarAdapter({
    fetchDailyRows: fetcher,
    observationQueries,
  });
}
