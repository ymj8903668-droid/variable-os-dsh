// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../../../src/schema/canonical-json.mjs";

export const STOCK_PRICE_METRICS = Object.freeze(['open', 'high', 'low', 'close', 'preClose', 'change', 'pctChange', 'volume', 'amount', 'turnover']);
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const invalid = () => Object.assign(Error('STOCK_PRICE_INPUT_INVALID'), { code: 'STOCK_PRICE_INPUT_INVALID' });
function object(x, keys) {
  if (!x || Object.getPrototypeOf(x) !== Object.prototype || Object.keys(x).length !== keys.length
    || keys.some(k => !Object.hasOwn(x, k))) throw invalid();
}
function date(x) {
  if (typeof x !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(x)
    || !Number.isFinite(Date.parse(x + 'T00:00:00Z')) || new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) !== x) throw invalid();
  return x;
}
export function validateStockPriceSource(source) {
 object(source, ['id', 'version', 'tenantId', 'datasetId', 'currency', 'adjustment', 'volumeUnit', 'amountUnit', 'licenseStatus', 'modelUseAllowed']);
 if (!['id', 'version', 'tenantId', 'datasetId'].every(k => id(source[k])) || source.currency !== 'CNY'
   || !['RAW', 'QFQ', 'HFQ'].includes(source.adjustment) || !['share', 'lot'].includes(source.volumeUnit)
   || !['CNY', 'thousand-CNY'].includes(source.amountUnit) || !['TEST_ONLY', 'AUTHORIZED'].includes(source.licenseStatus)
   || typeof source.modelUseAllowed !== 'boolean') throw invalid();
}
export function validateStockPriceRequest(request, now) {
 object(request, ['symbol', 'startDate', 'endDate', 'limit']);
 if (typeof request.symbol !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/.test(request.symbol)
   || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200 || !Number.isSafeInteger(now)) throw invalid();
 date(request.startDate); date(request.endDate);
 if (request.startDate > request.endDate || request.endDate > new Date(now + 8 * 3600000).toISOString().slice(0, 10)
   || Date.parse(request.endDate) - Date.parse(request.startDate) > 3660 * 86400000) throw invalid();
}
function decimal(value, signed) {
  if (value === null) return;
  if (typeof value !== 'string' || value.length > 64 || !/^-?(?:0|[1-9]\d{0,37})(?:\.\d{1,18})?$/.test(value)
    || !signed && value.startsWith('-')) throw invalid();
}
const scaled = x => {
  const negative = x.startsWith('-'), [whole, fractional = ''] = (negative ? x.slice(1) : x).split('.');
  return BigInt(whole + fractional.padEnd(18, '0')) * (negative ? -1n : 1n);
};
export function checkedStockPriceRows(rows, source, request) {
  if (!Array.isArray(rows) || rows.length > request.limit) throw invalid();
  const [code, exchange] = request.symbol.split('.'), symbols = [request.symbol, exchange + code, code];
  const seen = new Set(); let previous = '';
  return rows.map(row => {
    object(row, ['sourceSymbol', 'tradeDate', '__dateCount', ...STOCK_PRICE_METRICS]);
    date(row.tradeDate);
    if (!symbols.includes(row.sourceSymbol) || row.__dateCount !== '1' || seen.has(row.tradeDate)
      || row.tradeDate < previous || row.tradeDate < request.startDate || row.tradeDate > request.endDate) throw invalid();
    seen.add(row.tradeDate); previous = row.tradeDate;
    for (const k of STOCK_PRICE_METRICS) decimal(row[k], ['change', 'pctChange'].includes(k));
    if (row.high !== null && row.low !== null && scaled(row.high) < scaled(row.low)) throw invalid();
    for (const k of ['open', 'close']) if (row[k] !== null
      && (row.high !== null && scaled(row[k]) > scaled(row.high) || row.low !== null && scaled(row[k]) < scaled(row.low))) throw invalid();
    const { __dateCount: _count, ...values } = row;
    const id = 'price-' + canonicalHash([source.tenantId, source.datasetId, source.id, request.symbol, row.tradeDate]);
    const record = { id, symbol: request.symbol, ...values };
    return { ...record, contentHash: canonicalHash(record) };
  });
}

/** Validate original bounded capture, not a claim of complete market coverage or publication approval. */
export function validateStockPriceSnapshot(value, { tenantId, datasetId, capturedBefore } = {}) {
 try {
  object(value, ['schema','source','query','capturedAt','historicalKnowledgeProven','publicationApproved','status','reason','readOnlyVerified','rows','contentHash']);
  if (value.schema !== 'stock-price-snapshot-v1' || value.historicalKnowledgeProven !== false || value.publicationApproved !== false
    || value.readOnlyVerified !== true || value.reason !== null || !['ok','empty'].includes(value.status)
    || typeof value.capturedAt !== 'string' || new Date(value.capturedAt).toISOString() !== value.capturedAt) throw invalid();
  const captured = Date.parse(value.capturedAt);
  validateStockPriceSource(value.source);validateStockPriceRequest(value.query,captured);
  if (tenantId !== undefined && value.source.tenantId !== tenantId || datasetId !== undefined && value.source.datasetId !== datasetId
    || capturedBefore !== undefined && (!Number.isFinite(Date.parse(capturedBefore)) || captured > Date.parse(capturedBefore))) throw invalid();
  if (!Array.isArray(value.rows) || (value.status === 'empty') !== (value.rows.length === 0)) throw invalid();
  const raw = value.rows.map(row => {
   object(row, ['id','symbol','sourceSymbol','tradeDate',...STOCK_PRICE_METRICS,'contentHash']);
   const {id: _id,symbol: _symbol,contentHash: _hash,...fields}=row;
   return {...fields,__dateCount:'1'};
  });
  const rows=checkedStockPriceRows(raw,value.source,value.query);
  if (canonicalHash(rows)!==canonicalHash(value.rows)
    || value.contentHash!==canonicalHash({schema:value.schema,source:value.source,query:value.query,status:value.status,rows})) throw invalid();
  return structuredClone(value);
 } catch { throw Object.assign(Error('STOCK_PRICE_SNAPSHOT_INVALID'),{code:'STOCK_PRICE_SNAPSHOT_INVALID'}); }
}
