// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { fail } from "./errors.mjs";

const DEFAULT_API = "https://api.tushare.pro";

/**
 * Convert exchange-prefixed Variable OS security codes to Tushare ts_code.
 */
export function toTushareTsCode(securityCode) {
  const raw = String(securityCode || "").trim().toUpperCase();
  if (!raw) {
    return null;
  }
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) {
    return raw;
  }
  const prefixed = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixed) {
    return `${prefixed[2]}.${prefixed[1]}`;
  }
  const bare = raw.match(/^(\d{6})$/);
  if (bare) {
    return null;
  }
  return null;
}

export function sessionDateToTradeDate(sessionDate) {
  if (typeof sessionDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    return null;
  }
  return sessionDate.replaceAll("-", "");
}

export function tradeDateToSessionDate(tradeDate) {
  const raw = String(tradeDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return null;
}

/**
 * HTTP fetcher for Tushare pro `daily`. Token from env only; never log it.
 */
export function createTushareHttpFetcher({
  token = process.env.TUSHARE_TOKEN || process.env.TUSHARE_API_TOKEN || "",
  apiUrl = process.env.TUSHARE_API_URL || DEFAULT_API,
  fetchImpl = globalThis.fetch,
} = {}) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return null;
  }
  if (typeof fetchImpl !== "function") {
    fail("INVALID_FETCH", "fetchImpl required for Tushare HTTP client");
  }

  return async function fetchDailyRows(securityCode, { startDate, endDate } = {}) {
    const tsCode = toTushareTsCode(securityCode);
    if (!tsCode) {
      return [];
    }
    const params = { ts_code: tsCode };
    if (startDate) {
      const start = sessionDateToTradeDate(startDate) || startDate;
      params.start_date = start;
    }
    if (endDate) {
      const end = sessionDateToTradeDate(endDate) || endDate;
      params.end_date = end;
    }
    const response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_name: "daily",
        token: trimmed,
        params,
        fields:
          "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
      }),
    });
    if (!response.ok) {
      const err = new Error(`TUSHARE_HTTP_${response.status}`);
      err.code = "TUSHARE_HTTP";
      throw err;
    }
    const payload = await response.json();
    if (payload && typeof payload.code === "number" && payload.code !== 0) {
      const err = new Error(payload.msg || "TUSHARE_API_ERROR");
      err.code = "TUSHARE_API";
      throw err;
    }
    const fields = payload?.data?.fields;
    const items = payload?.data?.items;
    if (!Array.isArray(fields) || !Array.isArray(items)) {
      return [];
    }
    return items.map((row) => {
      const out = {};
      for (let i = 0; i < fields.length; i += 1) {
        out[fields[i]] = row[i];
      }
      if (out.trade_date) {
        out.trade_date = tradeDateToSessionDate(out.trade_date) || out.trade_date;
      }
      return out;
    });
  };
}

function mapTushareRows(payload) {
  const fields = payload?.data?.fields;
  const items = payload?.data?.items;
  if (!Array.isArray(fields) || !Array.isArray(items)) return [];
  return items.slice(0, 5000).map((row) => {
    const out = {};
    for (let index = 0; index < fields.length; index += 1) out[fields[index]] = row[index];
    return out;
  });
}

function securityCodeFromTsCode(value) {
  const match = String(value || "").toUpperCase().match(/^(\d{6})\.(SH|SZ|BJ)$/u);
  return match ? `${match[2]}${match[1]}` : null;
}

function inferBareTushareTsCode(value) {
  const code = String(value || "").trim();
  if (!/^\d{6}$/u.test(code)) return null;
  if (/^(?:4|8|92)/u.test(code)) return `${code}.BJ`;
  if (/^(?:5|6|9)/u.test(code)) return `${code}.SH`;
  if (/^(?:0|1|2|3)/u.test(code)) return `${code}.SZ`;
  return null;
}

/**
 * Read-only Tushare realtime client. `rt_k` supplies the live quote while
 * `rt_min_daily` is optional because it has a separately controlled permission.
 */
export function createTushareRealtimeClient({
  token = process.env.TUSHARE_TOKEN || process.env.TUSHARE_API_TOKEN || "",
  apiUrl = process.env.TUSHARE_API_URL || DEFAULT_API,
  fetchImpl = globalThis.fetch,
} = {}) {
  const trimmed = String(token || "").trim();
  if (!trimmed) return null;
  if (typeof fetchImpl !== "function") fail("INVALID_FETCH", "fetchImpl required for Tushare HTTP client");
  const resolvedNames = new Map();
  const resolvedQuotes = new Map();

  async function request(apiName, params, fields = "") {
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_name: apiName, token: trimmed, params, fields }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      const error = new Error("Tushare realtime request failed");
      error.code = ["AbortError", "TimeoutError"].includes(String(cause?.name || ""))
        ? "TUSHARE_TIMEOUT"
        : "TUSHARE_NETWORK";
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`TUSHARE_HTTP_${response.status}`);
      error.code = "TUSHARE_HTTP";
      throw error;
    }
    const payload = await response.json();
    if (payload && typeof payload.code === "number" && payload.code !== 0) {
      const error = new Error("Tushare realtime request was rejected");
      error.code = payload.code === 40203 || payload.code === -2001
        ? "TUSHARE_PERMISSION"
        : "TUSHARE_API";
      throw error;
    }
    return mapTushareRows(payload);
  }

  async function resolveSecurity(query) {
    const text = String(query || "").replace(/\s+/gu, " ").trim().slice(0, 40);
    if (!text) return null;
    const explicit = toTushareTsCode(text) || inferBareTushareTsCode(text);
    if (explicit) {
      const quoteRows = await request("rt_k", { ts_code: explicit });
      const quote = quoteRows.find((row) => row.ts_code === explicit) || quoteRows[0];
      if (quote) resolvedQuotes.set(explicit, quote);
      return quote ? {
        tsCode: explicit,
        securityCode: securityCodeFromTsCode(explicit),
        name: String(quote.name || explicit),
      } : null;
    }
    if (resolvedNames.has(text)) return resolvedNames.get(text);
    const rows = await request(
      "stock_basic",
      { name: text, list_status: "L" },
      "ts_code,symbol,name,exchange,list_status",
    );
    const exactRows = rows.filter((row) => String(row.name || "").trim() === text);
    const row = exactRows.length === 1 ? exactRows[0] : null;
    const result = row?.ts_code ? {
      tsCode: String(row.ts_code),
      securityCode: securityCodeFromTsCode(row.ts_code),
      name: String(row.name),
    } : null;
    if (result) resolvedNames.set(text, result);
    return result;
  }

  return Object.freeze({
    async resolveSecurity(query) {
      return resolveSecurity(query);
    },
    async fetchQuote(tsCode) {
      if (resolvedQuotes.has(tsCode)) {
        const quote = resolvedQuotes.get(tsCode);
        resolvedQuotes.delete(tsCode);
        return quote;
      }
      const rows = await request("rt_k", { ts_code: tsCode });
      return rows.find((row) => row.ts_code === tsCode) || rows[0] || null;
    },
    async fetchMinutes(tsCode) {
      try {
        const rows = await request("rt_min_daily", { ts_code: tsCode, freq: "1MIN" });
        return { available: true, rows };
      } catch (error) {
        if (error?.code === "TUSHARE_PERMISSION") {
          return {
            available: false,
            reasonCode: "REALTIME_MINUTE_PERMISSION_REQUIRED",
            rows: [],
          };
        }
        throw error;
      }
    },
    diagnostics: Object.freeze({ source: "tushare-realtime", minuteSourceOptional: true }),
  });
}
