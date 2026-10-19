// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import {validatePublishedDocument} from './published-document.mjs';
import {STOCK_PRICE_METRICS} from './stock-price-snapshot.mjs';
export const STOCK_PRICE_INSTRUCTIONS='行情是已审核的有界历史快照。每个价格论断须写明代码、交易日期、币种和复权口径；成交量/额使用声明单位。数字字符串保持原始精度，NULL是缺失而非零。涨跌幅及换手率单位未声明，不得猜测百分比或自动换算。不得混合不同复权、币种或量额单位比较；不能把价格变化本身当因果证明。TEST_ONLY仅合成数据；不声称实时、完整历史或交易日当时已知。空快照只说明本次查询窗口没有记录。';
/** Metadata is bound into the existing source proof; original content stays exact. */
export function stockPriceContext(doc){
 validatePublishedDocument(doc,{scope:'stock-price/'});const s=JSON.parse(doc.content),rows=s.rows;
 return {schema:'stock-price-context-v1',symbol:s.query.symbol,startDate:s.query.startDate,endDate:s.query.endDate,limit:s.query.limit,
  status:s.status,rowCount:rows.length,firstDate:rows[0]?.tradeDate??null,lastDate:rows.at(-1)?.tradeDate??null,capturedAt:s.capturedAt,
  currency:s.source.currency,adjustment:s.source.adjustment,volumeUnit:s.source.volumeUnit,amountUnit:s.source.amountUnit,
  ratioUnits:'UNDECLARED',licenseStatus:s.source.licenseStatus,snapshotHash:s.contentHash,historicalKnowledgeProven:false,completeHistory:false,live:false};
}
/** Reject naked figures: exact quoted fields must identify one original trading day. */
export function validStockQuote(doc,quote){
 try{
  stockPriceContext(doc);if(typeof quote!=='string'||!doc.content.includes(quote))return false;
  const dates=[...quote.matchAll(/"tradeDate"\s*:\s*"(20\d\d-\d\d-\d\d)"/g)];if(dates.length!==1)return false;
  const row=JSON.parse(doc.content).rows.find(r=>r.tradeDate===dates[0][1]);if(!row)return false;
  const fields=[...quote.matchAll(new RegExp('"('+STOCK_PRICE_METRICS.join('|')+')"\\s*:\\s*("-?[0-9.]+"|null)(?=$|[\\s,}])','g'))];
  return fields.length>0&&fields.every(([,key,value])=>JSON.parse(value)===row[key]);
 }catch{return false;}
}
