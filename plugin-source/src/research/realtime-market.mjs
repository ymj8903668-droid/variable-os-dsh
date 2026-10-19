// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const SAMPLE_RETENTION_MS = 30 * 60 * 1000;
const MAX_SAMPLES_PER_SECURITY = 120;

export function toShanghaiTimestamp(value = new Date()) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace(/Z$/u, "+08:00");
}

function marketError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function tsCodeToSecurityCode(value) {
  const match = String(value || "").toUpperCase().match(/^(\d{6})\.(SH|SZ|BJ)$/u);
  return match ? `${match[2]}${match[1]}` : null;
}

export function resolveRealtimeMarketAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return import("./tushare-client.mjs").then(({ createTushareRealtimeClient }) => {
    const client = createTushareRealtimeClient({
      token: env.TUSHARE_TOKEN || env.TUSHARE_API_TOKEN || "",
      apiUrl: env.TUSHARE_API_URL,
      fetchImpl,
    });
    return client ? createRealtimeMarketAdapter(client) : null;
  });
}

export function resolveAshareCode(value) {
  const text = String(value || "").trim().toUpperCase();
  const explicit = text.match(/^(?:((?:SH|SZ|BJ))(\d{6})|(\d{6})\.((?:SH|SZ|BJ)))$/u);
  if (explicit) {
    const exchange = explicit[1] || explicit[4];
    const code = explicit[2] || explicit[3];
    return `${code}.${exchange}`;
  }
  if (!/^\d{6}$/u.test(text)) return null;
  if (/^(?:4|8|92)/u.test(text)) return `${text}.BJ`;
  if (/^(?:5|6|9)/u.test(text)) return `${text}.SH`;
  if (/^(?:0|1|2|3)/u.test(text)) return `${text}.SZ`;
  return null;
}

function normalizeSecurity(value, query) {
  if (!value || typeof value !== "object") return null;
  const tsCode = resolveAshareCode(value.tsCode || value.ts_code || value.securityCode);
  const securityCode = tsCodeToSecurityCode(tsCode);
  const name = String(value.name || query || "").trim().slice(0, 40);
  if (!tsCode || !securityCode || !name) return null;
  return Object.freeze({ tsCode, securityCode, name });
}

function normalizeQuote(row) {
  if (!row || typeof row !== "object") return null;
  const preClose = finiteNumber(row.pre_close ?? row.preClose);
  const last = finiteNumber(row.close ?? row.last);
  const open = finiteNumber(row.open);
  const high = finiteNumber(row.high);
  const low = finiteNumber(row.low);
  if (
    preClose === null || preClose <= 0 || last === null || last <= 0
    || open === null || high === null || low === null
  ) return null;
  const change = round(last - preClose);
  const pctChange = round((change / preClose) * 100);
  return Object.freeze({
    last,
    previousClose: preClose,
    change,
    pctChange,
    open,
    high,
    low,
    volume: finiteNumber(row.vol ?? row.volume),
    amount: finiteNumber(row.amount),
  });
}

function instantMs(value) {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  return Date.parse(normalized);
}

function normalizeMinutes(value) {
  const rows = Array.isArray(value?.rows) ? value.rows : [];
  return rows
    .map((row) => ({
      at: String(row?.time || row?.trade_time || row?.at || "").trim(),
      atMs: instantMs(row?.time || row?.trade_time || row?.at),
      close: finiteNumber(row?.close),
      volume: finiteNumber(row?.vol ?? row?.volume),
      amount: finiteNumber(row?.amount),
    }))
    .filter((row) => Number.isFinite(row.atMs) && row.close !== null && row.close > 0)
    .sort((left, right) => left.atMs - right.atMs)
    .slice(-360);
}

function directionLabel(value) {
  return value >= 0 ? "上涨" : "下跌";
}

function createAnomaly(kind, severity, summary, metrics) {
  return Object.freeze({ kind, severity, summary, metrics: Object.freeze(metrics) });
}

function quoteLevelAnomalies(quote) {
  const anomalies = [];
  const gapPct = ((quote.open - quote.previousClose) / quote.previousClose) * 100;
  if (Math.abs(gapPct) >= 2) {
    anomalies.push(createAnomaly(
      "OPEN_GAP",
      Math.abs(gapPct) >= 5 ? "HIGH" : "MEDIUM",
      `开盘较昨收${directionLabel(gapPct)}${Math.abs(gapPct).toFixed(2)}%`,
      { gapPct: round(gapPct) },
    ));
  }
  const rangePct = ((quote.high - quote.low) / quote.previousClose) * 100;
  if (rangePct >= 4) {
    anomalies.push(createAnomaly(
      "INTRADAY_RANGE",
      rangePct >= 8 ? "HIGH" : "MEDIUM",
      `日内振幅达到${rangePct.toFixed(2)}%`,
      { rangePct: round(rangePct) },
    ));
  }
  return anomalies;
}

function minuteAnomalies(rows) {
  if (rows.length < 2) return [];
  const anomalies = [];
  const latest = rows.at(-1);
  const baseline = [...rows].reverse().find((row) => latest.atMs - row.atMs >= 5 * 60 * 1000)
    || rows[0];
  const movePct = ((latest.close - baseline.close) / baseline.close) * 100;
  if (Math.abs(movePct) >= 1.5) {
    anomalies.push(createAnomaly(
      "PRICE_MOVE_5M",
      Math.abs(movePct) >= 3 ? "HIGH" : "MEDIUM",
      `近5分钟${directionLabel(movePct)}${Math.abs(movePct).toFixed(2)}%`,
      { movePct: round(movePct), windowMinutes: 5 },
    ));
  }
  const priorVolumes = rows.slice(Math.max(0, rows.length - 6), -1)
    .map((row) => row.volume)
    .filter((volume) => volume !== null && volume >= 0);
  if (latest.volume !== null && priorVolumes.length >= 3) {
    const average = priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length;
    const ratio = average > 0 ? latest.volume / average : 0;
    if (ratio >= 2.5) {
      anomalies.push(createAnomaly(
        "VOLUME_SPIKE_1M",
        ratio >= 5 ? "HIGH" : "MEDIUM",
        `最新1分钟成交量为前序均值的${ratio.toFixed(1)}倍`,
        { volumeRatio: round(ratio), windowMinutes: 1 },
      ));
    }
  }
  return anomalies;
}

function sampledAnomalies(samples) {
  if (samples.length < 2) return [];
  const latest = samples.at(-1);
  const previous = [...samples].reverse().find((sample) => latest.atMs - sample.atMs >= 60 * 1000)
    || samples.at(-2);
  const elapsedMinutes = Math.max(1, round((latest.atMs - previous.atMs) / 60_000, 1));
  const movePct = ((latest.last - previous.last) / previous.last) * 100;
  if (elapsedMinutes <= 10 && Math.abs(movePct) >= 1) {
    return [createAnomaly(
      "PRICE_MOVE_SAMPLED",
      Math.abs(movePct) >= 2.5 ? "HIGH" : "MEDIUM",
      `实时报价采样近${elapsedMinutes}分钟${directionLabel(movePct)}${Math.abs(movePct).toFixed(2)}%`,
      { movePct: round(movePct), windowMinutes: elapsedMinutes },
    )];
  }
  return [];
}

function dedupeAnomalies(values) {
  const seen = new Set();
  return Object.freeze(values.filter((item) => {
    if (seen.has(item.kind)) return false;
    seen.add(item.kind);
    return true;
  }).slice(0, 5));
}

export function createRealtimeMarketAdapter({
  resolveSecurity,
  fetchQuote,
  fetchMinutes = async () => ({ available: false, reasonCode: "REALTIME_MINUTE_UNAVAILABLE", rows: [] }),
  now = () => toShanghaiTimestamp(),
} = {}) {
  if (typeof resolveSecurity !== "function" || typeof fetchQuote !== "function") {
    throw new TypeError("resolveSecurity and fetchQuote are required");
  }
  const samplesBySecurity = new Map();

  return Object.freeze({
    availability: "TUSHARE_REALTIME",
    async getMarketPulse({ query } = {}) {
      const normalizedQuery = String(query || "").replace(/\s+/gu, " ").trim().slice(0, 80);
      if (!normalizedQuery) throw marketError("MARKET_QUERY_REQUIRED", "股票名称或代码不能为空");
      const security = normalizeSecurity(await resolveSecurity(normalizedQuery), normalizedQuery);
      if (!security) throw marketError("MARKET_SECURITY_NOT_FOUND", "没有找到唯一的A股证券代码");
      const receivedAt = String(now());
      const receivedAtMs = instantMs(receivedAt);
      if (!Number.isFinite(receivedAtMs)) throw marketError("MARKET_CLOCK_INVALID", "实时时钟不可用");
      const quote = normalizeQuote(await fetchQuote(security.tsCode));
      if (!quote) throw marketError("MARKET_REALTIME_INVALID", "实时行情返回缺少价格或昨收字段");

      const retained = (samplesBySecurity.get(security.tsCode) || [])
        .filter((sample) => receivedAtMs - sample.atMs <= SAMPLE_RETENTION_MS);
      retained.push({ atMs: receivedAtMs, last: quote.last, volume: quote.volume, amount: quote.amount });
      const samples = retained.slice(-MAX_SAMPLES_PER_SECURITY);
      samplesBySecurity.set(security.tsCode, samples);

      let minuteResult;
      try {
        minuteResult = await fetchMinutes(security.tsCode);
      } catch {
        minuteResult = { available: false, reasonCode: "REALTIME_MINUTE_UNAVAILABLE", rows: [] };
      }
      const minuteRows = minuteResult?.available === true ? normalizeMinutes(minuteResult) : [];
      const minuteAvailable = minuteRows.length >= 2;
      const mode = minuteAvailable ? "REALTIME_MINUTE" : "LIVE_QUOTE_SAMPLED";
      const modeLabel = minuteAvailable ? "实时分钟" : "报价采样";
      const anomalies = dedupeAnomalies([
        ...quoteLevelAnomalies(quote),
        ...(minuteAvailable ? minuteAnomalies(minuteRows) : sampledAnomalies(samples)),
      ]);
      const note = minuteAvailable
        ? "分时异动来自Tushare实时1分钟序列。"
        : `当前账户的实时分钟源不可用；分时异动改用实时报价采样，已积累${samples.length}个短窗样本。`;

      return Object.freeze({
        availability: "LIVE",
        query: normalizedQuery,
        security,
        asOf: receivedAt,
        asOfShanghai: receivedAt,
        quoteMode: "REALTIME_QUOTE",
        freshnessSeconds: 0,
        source: minuteAvailable ? "tushare-rt-min-daily+rt-k" : "tushare-rt-k-sampled",
        quote,
        intraday: Object.freeze({
          mode,
          label: modeLabel,
          sampleCount: minuteAvailable ? minuteRows.length : samples.length,
          minutePermission: minuteResult?.available === true,
          reasonCode: minuteAvailable
            ? null
            : String(minuteResult?.reasonCode || "REALTIME_MINUTE_UNAVAILABLE"),
          anomalies,
          note,
        }),
      });
    },
  });
}

export function formatMarketPulseSpeech(value) {
  const name = String(value?.security?.name || value?.security?.tsCode || "该股票");
  const quote = value?.quote || {};
  const last = finiteNumber(quote.last);
  const pct = finiteNumber(quote.pctChange);
  if (last === null || pct === null) return `${name}的实时行情暂不可用。`;
  const direction = pct > 0 ? "上涨" : pct < 0 ? "下跌" : "持平";
  const movement = pct === 0 ? direction : `${direction}${Math.abs(pct).toFixed(2)}%`;
  const anomalies = Array.isArray(value?.intraday?.anomalies) ? value.intraday.anomalies : [];
  const anomalySpeech = anomalies.length
    ? `分时异动：${anomalies.slice(0, 3).map((item) => item.summary).join("；")}。`
    : "暂未检测到可核实的分时异动。";
  const mode = value?.intraday?.mode === "REALTIME_MINUTE" ? "实时分钟" : "实时报价采样";
  return `${name}，最新价${last.toFixed(2)}元，${movement}。${anomalySpeech}当前按${mode}监测，数据接收于${String(value?.asOf || "时间待确认")}。`;
}
