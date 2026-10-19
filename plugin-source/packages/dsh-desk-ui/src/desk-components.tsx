// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cardTimeMeta,
  catalystWatchQualityLabel,
  cleanDisplayText,
  filterRadarCardsByDate,
  filterRadarCardsByJudgment,
  filterRadarCardsByRedTeam,
  filterRadarCardsBySource,
  radarCardSourceLabel,
  RADAR_SOURCE_FILTERS,
  formatCatalystSourceFingerprint,
  formatCatalystSourceNamespace,
  formatCatalystSourceTitle,
  createRadarUiState,
  radarDateOptions,
  radarCardIndicatorLabel,
  radarCardSummaryLabel,
  radarDisplayCountLabel,
  radarHeadingLabel,
  radarTodayDateId,
  radarEmptyLabel,
  shouldResetRadarDateFilter,
  resolveRadarFilterSelection,
  parseResearchHostMarkdown,
  selectTimelineEvidence,
  sortRadarCards,
  researchHostVoiceLogLabel,
  translateStatus,
} from "./view-model.mjs";
import { DeskIcon } from "./icons";
import { filterDeskHomeCards, countNewDeskCards } from './desk-layout-state.mjs';

type Dispatch = (action: Record<string, unknown>) => void;

function ResearchHostInline({ content, onCitation }: { content: any[]; onCitation?: (id:string)=>void }) {
  const words=(text:string)=>onCitation ? String(text).split(/(\[[A-Z]+[0-9]+\])/g).map((v,i)=>/^\[[A-Z]+[0-9]+\]$/.test(v)?<button type="button" className="research-citation" key={i} onClick={()=>onCitation(v.slice(1,-1))}>{v}</button>:v):text;
  return <>{content.map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "strong") return <strong key={key}>{words(token.text)}</strong>;
    if (token.type === "code") return <code key={key}>{words(token.text)}</code>;
    if (token.type === "link") return <a key={key} href={token.href} target="_blank" rel="noreferrer">{words(token.text)}</a>;
    return <React.Fragment key={key}>{words(token.text)}</React.Fragment>;
  })}</>;
}

export function ResearchHostMarkdown({ text, live = false, busy = false, onCitation }: { text: string; live?: boolean; busy?: boolean; onCitation?: (id:string)=>void }) {
  const blocks = useMemo(() => parseResearchHostMarkdown(text), [text]);
  return <div className="vos-host-markdown" aria-live={live ? "polite" : undefined}>
    {blocks.map((block: any, index: number) => {
      const key = `${block.type}-${index}`;
      if (block.type === "heading") {
        return block.level >= 3
          ? <h4 key={key}><ResearchHostInline onCitation={onCitation} content={block.content} /></h4>
          : <h3 key={key}><ResearchHostInline onCitation={onCitation} content={block.content} /></h3>;
      }
      if (block.type === "unordered-list" || block.type === "ordered-list") {
        const List = block.type === "ordered-list" ? "ol" : "ul";
        return <List key={key}>{block.items.map((item: any[], itemIndex: number) => <li key={itemIndex}><ResearchHostInline onCitation={onCitation} content={item} /></li>)}</List>;
      }
      if (block.type === "table") return <div className="vos-markdown-table-scroll" key={key} role="region" aria-label="研究证据表格" tabIndex={0}><table>
        <thead><tr>{block.header.map((cell: any[], i: number) => <th scope="col" key={i} style={{textAlign: block.align[i]}}><ResearchHostInline onCitation={onCitation} content={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row: any[][], ri: number) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{textAlign: block.align[ci]}}><ResearchHostInline onCitation={onCitation} content={cell} /></td>)}</tr>)}</tbody>
      </table></div>;
      if (block.type === "blockquote") return <blockquote key={key}><ResearchHostInline onCitation={onCitation} content={block.content} /></blockquote>;
      if (block.type === "separator") return <hr key={key} />;
      return <p key={key}><ResearchHostInline onCitation={onCitation} content={block.content} /></p>;
    })}
    {busy ? <i className="vos-host-caret" aria-label="回答生成中" /> : null}
  </div>;
}

let pointerDraggedEvidenceId: string | null = null;

function evidenceIdFromInteraction(event: any) {
  const dataTransferId = event.dataTransfer?.getData?.("text/x-variable-evidence");
  const evidenceId = dataTransferId || pointerDraggedEvidenceId;
  pointerDraggedEvidenceId = null;
  return evidenceId;
}

const LABELS = [
  { id: "TRADABLE", label: "可炒", detail: "具备交易叙事", icon: "fire" },
  { id: "WATCH", label: "继续观察", detail: "等待更多证据", icon: "eye" },
  { id: "NOT_TRADABLE", label: "不可炒", detail: "暂不形成变量", icon: "ban" },
] as const;

function polygonPoints(values: number[], radius: number, center = 74) {
  return values
    .map((value, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 6;
      const distance = radius * (value / 100);
      return `${center + Math.cos(angle) * distance},${center + Math.sin(angle) * distance}`;
    })
    .join(" ");
}

function watchScore(value: any) {
  const score = Number(value?.totalScore);
  return Number.isFinite(score) ? Math.round(score * 100) : 0;
}

function watchTime(value: any) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待核对";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function CatalystFunnelNav({ mode, funnel, blocked = false, onSelect }: any) {
  const count = (value: any) => blocked ? "—" : String(Math.max(0, Number(value) || 0));
  const tabs = [
    { id: "ALL", label: "全部新增", count: funnel?.allSources },
    { id: "FORMAL", label: "正式卡", count: funnel?.formalCards },
    { id: "WATCH", label: "观察催化", count: funnel?.watchCatalysts },
    { id: "DISCARDED", label: "已丢弃", count: funnel?.discarded },
  ];
  return <nav className="vos-catalyst-funnel" aria-label="催化筛选漏斗">
    {tabs.map((tab) => <button
      key={tab.id}
      type="button"
      aria-current={mode === tab.id ? "page" : undefined}
      onClick={() => onSelect(tab.id)}
    ><span>{tab.label}</span><strong>{count(tab.count)}</strong></button>)}
    <small>WATCH 保持正式 REJECT · 影子期只读</small>
  </nav>;
}

function sourceStatusLabel(status: string | null | undefined) {
  return ({
    UNREVIEWED: "尚未研判",
    FORMAL: "正式卡",
    WATCH: "观察催化",
    DISCARDED: "已丢弃",
    FAILED: "研判失败",
  } as Record<string, string>)[String(status || "")] || "处理中";
}

export function CatalystSourcePanel({
  list,
  funnel,
  uiState,
  busy = false,
  error = null,
  projectionBlocked = false,
  onFilter,
  onSelect,
  onScroll,
  onRefresh,
}: any) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = Array.isArray(list?.items) ? list.items : [];
  const selected = items.find((item: any) => item.sourceItemId === uiState.selectedSourceItemId) || null;
  useEffect(() => {
    if (scrollRef.current && Math.abs(scrollRef.current.scrollTop - uiState.scrollTop) > 1) {
      scrollRef.current.scrollTop = uiState.scrollTop;
    }
  }, [uiState.scrollTop, items.length]);
  if (projectionBlocked) {
    return <section className="vos-watch-blocked" role="alert">
      <strong>新增投影不可用</strong>
      <p>权威账本与只读投影水位未对齐，不能把未知数量显示为 0。</p>
    </section>;
  }
  return <section className="vos-watch-surface vos-source-surface" aria-label="全部新增原始只读页">
    <header className="vos-watch-heading">
      <div><span>SHADOW · READ ONLY</span><h2>全部新增</h2><p>原始输入不过滤；正式卡仍按现有自动研判和证据门槛生成。</p></div>
      <button type="button" disabled={busy} onClick={onRefresh}>{busy ? "读取中" : "刷新新增投影"}</button>
    </header>
    <div className="vos-watch-filters" aria-label="全部新增筛选">
      <label><span>来源</span><select aria-label="新增来源筛选" value={uiState.filters.source} onChange={(event) => onFilter("source", event.target.value)}><option value="">全部来源</option><option value="local.wechat">微信</option><option value="local.gangtise">冈底斯</option><option value="markdown">Markdown</option></select></label>
      <label><span>类别</span><select aria-label="新增类别筛选" value={uiState.filters.archetype} onChange={(event) => onFilter("archetype", event.target.value)}><option value="">全部类别</option><option value="ORDER_CONTRACT">订单合同</option><option value="SUPPLY_CHAIN">供应链</option><option value="PRICE_CHANGE">价格变化</option><option value="REGULATORY">政策监管</option><option value="TECHNOLOGY">技术进展</option><option value="OTHER">其他</option></select></label>
      <label><span>新鲜度</span><select aria-label="新增新鲜度筛选" value={uiState.filters.freshness} onChange={(event) => onFilter("freshness", event.target.value)}><option value="">全部新鲜度</option><option value="FRESH">24 小时内</option><option value="STALE">积压</option></select></label>
      <label><span>处理状态</span><select aria-label="新增处理状态筛选" value={uiState.filters.status} onChange={(event) => onFilter("status", event.target.value)}><option value="">全部状态</option><option value="UNREVIEWED">尚未研判</option><option value="FORMAL">正式卡</option><option value="WATCH">观察催化</option><option value="DISCARDED">已丢弃</option><option value="FAILED">研判失败</option></select></label>
    </div>
    {error ? <div className="vos-watch-error" role="alert">新增投影读取失败；当前列表不代表 0。</div> : null}
    <div className="vos-watch-layout">
      <div className="vos-watch-list" ref={scrollRef} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
        {items.map((item: any, index: number) => <button key={item.sourceItemId} type="button" aria-current={item.sourceItemId === uiState.selectedSourceItemId ? "true" : undefined} onClick={() => onSelect(item.sourceItemId)}>
          <span className="vos-watch-rank">{index + 1}</span>
          <span><strong>{formatCatalystSourceTitle(item)}</strong><small>{formatCatalystSourceNamespace(item.sourceNamespace)} · {item.sourceType || "来源"} · {watchTime(item.availableAt)}</small><em>{sourceStatusLabel(item.screeningStatus)} · {item.freshness === "FRESH" ? "新鲜" : "积压"}</em></span>
          <span className="vos-watch-priority"><b>{item.screeningStatus === "FORMAL" ? "卡" : item.screeningStatus === "WATCH" ? "观" : "—"}</b><small>结果</small></span>
        </button>)}
        {!items.length && !busy && !error ? <div className="vos-paper-empty"><strong>{Number(funnel?.allSources || 0) === 0 ? "暂无自然到达新增" : "当前筛选没有新增"}</strong><br />原始输入不会因未成卡而消失；此处不复制私密正文。</div> : null}
      </div>
      <article className="vos-watch-detail">
        {selected ? <>
          <header><div><span>{sourceStatusLabel(selected.screeningStatus)} · {selected.freshness}</span><h2>{formatCatalystSourceTitle(selected)}</h2></div><small>{formatCatalystSourceNamespace(selected.sourceNamespace)}</small></header>
          <dl className="vos-watch-boundary"><div><dt>来源类型</dt><dd>{selected.sourceType}</dd></div><div><dt>来源可用</dt><dd>{watchTime(selected.availableAt)}</dd></div><div><dt>声明发布时间</dt><dd>{watchTime(selected.declaredPublishedAt)}</dd></div><div><dt>首次取回</dt><dd>{watchTime(selected.firstRetrievedAt)}</dd></div></dl>
          <section><h3>筛选结果</h3><p>{sourceStatusLabel(selected.screeningStatus)}{selected.screeningDecision ? ` · ${selected.screeningDecision}` : " · 尚未产生正式筛选决定"}</p><p>安全指纹：<code title="完整指纹仅保留在审计账本">{formatCatalystSourceFingerprint(selected)}</code></p></section>
          <section><h3>时间边界</h3><p>仅显示冻结的可用时间和声明时间；不展示 raw 路径、正文或模型提示。</p></section>
          <footer>全部新增是原始安全索引；正式卡、观察催化和丢弃结果均来自既有正式流程。</footer>
        </> : <div className="vos-paper-empty">选择一条新增以读取安全索引。</div>}
      </article>
    </div>
  </section>;
}

export function CatalystWatchPanel({
  list,
  detail,
  funnel,
  uiState,
  busy = false,
  error = null,
  projectionBlocked = false,
  onFilter,
  onSelect,
  onToggleReference,
  onDraft,
  onScroll,
  onRefresh,
}: any) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = Array.isArray(list?.items) ? list.items.slice(0, 10) : [];
  const selected = items.find((item: any) => item.watchId === uiState.selectedWatchId) || null;
  const references = detail
    ? [...(detail.sourceRefs || []), ...(detail.evidenceRefs || [])]
    : [];
  useEffect(() => {
    if (scrollRef.current && Math.abs(scrollRef.current.scrollTop - uiState.scrollTop) > 1) {
      scrollRef.current.scrollTop = uiState.scrollTop;
    }
  }, [uiState.scrollTop, items.length]);
  if (projectionBlocked) {
    return <section className="vos-watch-blocked" role="alert">
      <strong>观察投影不可用</strong>
      <p>权威账本与只读投影水位未对齐，不能把未知数量显示为 0。</p>
    </section>;
  }
  return <section className="vos-watch-surface" aria-label="观察催化只读页">
    <header className="vos-watch-heading">
      <div><span>SHADOW · READ ONLY</span><h2>观察催化</h2><p>{catalystWatchQualityLabel(funnel)}</p></div>
      <button type="button" disabled={busy} onClick={onRefresh}>{busy ? "读取中" : "刷新只读投影"}</button>
    </header>
    <div className="vos-watch-filters" aria-label="观察催化筛选">
      <label><span>来源</span><select aria-label="观察来源筛选" value={uiState.filters.source} onChange={(event) => onFilter("source", event.target.value)}><option value="">全部来源</option><option value="local.wechat">微信</option><option value="local.gangtise">冈底斯</option><option value="markdown">Markdown</option></select></label>
      <label><span>类别</span><select aria-label="观察类别筛选" value={uiState.filters.archetype} onChange={(event) => onFilter("archetype", event.target.value)}><option value="">全部类别</option><option value="ORDER_CONTRACT">订单合同</option><option value="SUPPLY_CHAIN">供应链</option><option value="PRICE_CHANGE">价格变化</option><option value="REGULATORY">政策监管</option><option value="TECHNOLOGY">技术进展</option><option value="OTHER">其他</option></select></label>
      <label><span>新鲜度</span><select aria-label="观察新鲜度筛选" value={uiState.filters.freshness} onChange={(event) => onFilter("freshness", event.target.value)}><option value="">全部新鲜度</option><option value="FRESH">新鲜</option><option value="EXPIRING">即将失效</option><option value="EXPIRED">已过期</option></select></label>
      <label><span>状态</span><select aria-label="观察状态筛选" value={uiState.filters.status} onChange={(event) => onFilter("status", event.target.value)}><option value="">全部状态</option><option value="OPEN">OPEN</option><option value="VERIFYING">VERIFYING</option><option value="PROMOTED">PROMOTED</option><option value="DISCARDED">DISCARDED</option><option value="EXPIRED">EXPIRED</option></select></label>
    </div>
    {error ? <div className="vos-watch-error" role="alert">观察投影读取失败；当前列表不代表 0。</div> : null}
    <div className="vos-watch-layout">
      <div
        className="vos-watch-list"
        ref={scrollRef}
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      >
        {items.map((item: any, index: number) => <button
          key={item.watchId}
          type="button"
          aria-current={item.watchId === uiState.selectedWatchId ? "true" : undefined}
          onClick={() => onSelect(item.watchId)}
        ><span className="vos-watch-rank">{index + 1}</span><span><strong>{item.catalystArchetype}</strong><small>{item.sourceType} · {item.sourceNamespace} · {watchTime(item.sourceAvailableAt)}</small><em>{item.missingEvidence?.[0] || "证据缺口待核对"}</em></span><span className="vos-watch-priority"><b>{watchScore(item.importance)}</b><small>重要度</small></span></button>)}
        {!items.length && !busy && !error ? <div className="vos-paper-empty"><strong>{Number(funnel?.watchCatalysts || 0) === 0 ? "线上质量尚待验证" : "当前筛选没有观察催化"}</strong><br />{Number(funnel?.watchCatalysts || 0) === 0 ? "当前没有自然到达的观察样本；fixture 不计入线上质量。" : "保留筛选条件，可切换来源、类别、新鲜度或状态。"}</div> : null}
      </div>
      <article className="vos-watch-detail">
        {selected && detail?.watchId === selected.watchId ? <>
          <header><div><span>{detail.status} · {detail.freshness}</span><h2>{detail.catalystArchetype}</h2></div><small>失效 {watchTime(detail.expiresAt)}</small></header>
          <div className="vos-watch-score-grid"><div><span>重要度</span><strong>{watchScore(detail.importance)}</strong><small>{detail.importance?.ruleVersion}</small></div><div><span>证据成熟度</span><strong>{watchScore(detail.evidenceMaturity)}</strong><small>{detail.evidenceMaturity?.ruleVersion}</small></div></div>
          <dl className="vos-watch-boundary"><div><dt>事件时间</dt><dd>{watchTime(detail.eventTime)}</dd></div><div><dt>来源可用</dt><dd>{watchTime(detail.sourceAvailableAt)}</dd></div><div><dt>分析截止</dt><dd>{watchTime(detail.sourceCutoff)}</dd></div><div><dt>预期窗口</dt><dd>{detail.expectedHorizon}</dd></div></dl>
          <section><h3>缺失证据</h3><ul>{(detail.missingEvidence || []).map((item: string) => <li key={item}>{item}</li>)}</ul></section>
          <section><h3>补证方向</h3><ul>{(detail.verificationPlan || []).map((item: string) => <li key={item}>{item}</li>)}</ul></section>
          <section><h3>失效条件</h3><ul>{(detail.invalidationConditions || []).map((item: string) => <li key={item}>{item}</li>)}</ul></section>
          <section className="vos-watch-references"><h3>完整引用入口</h3><p>仅展示冻结引用索引，不复制私密正文或本机路径。</p>{references.map((ref: string) => <div key={ref}><button type="button" aria-expanded={uiState.expandedReferences.includes(ref)} onClick={() => onToggleReference(ref)}>{ref}<span>{uiState.expandedReferences.includes(ref) ? "收起" : "展开"}</span></button>{uiState.expandedReferences.includes(ref) ? <small>来源项 {detail.sourceItemId} · 截止 {watchTime(detail.sourceCutoff)}</small> : null}</div>)}</section>
          <label className="vos-watch-draft"><span>补证草稿</span><textarea aria-label="观察补证草稿" value={uiState.drafts[detail.watchId] || ""} maxLength={500} placeholder="仅保留在当前浏览器页面会话；不会写入账本" onChange={(event) => onDraft(detail.watchId, event.target.value)} /><small>未提交草稿 · 无保存或处置入口</small></label>
          <footer>只读影子：不得自动成卡、批准映射、触发反馈任务或交易动作。</footer>
        </> : <div className="vos-paper-empty">选择一条观察催化以读取审计详情。</div>}
      </article>
    </div>
  </section>;
}

export function CatalystDiscardPanel({ funnel, projectionBlocked = false }: any) {
  return <section className="vos-discard-surface" aria-label="已丢弃审计">
    <span>SHADOW AUDIT · READ ONLY</span>
    <h2>已丢弃</h2>
    {projectionBlocked
      ? <p role="alert">投影水位不一致，丢弃数量未知，不显示为 0。</p>
      : <><strong>{Math.max(0, Number(funnel?.discarded) || 0)}</strong><p>仅统计正式筛选 REJECT + DISCARD；不含 WATCH，也不反推历史结论。</p></>}
    <small>V1 不提供人工处置或写入入口。五日影子报告按来源、行业、新鲜/积压分层复盘假阴性。</small>
  </section>;
}

export function RadarChart({ metrics, tone = "red" }: { metrics: any[]; tone?: "red" | "blue" }) {
  const values = metrics.map((metric) => metric.value);
  const labelPositions = [
    { x: 74, y: 9, anchor: "middle" },
    { x: 135, y: 41, anchor: "start" },
    { x: 135, y: 113, anchor: "start" },
    { x: 74, y: 146, anchor: "middle" },
    { x: 13, y: 113, anchor: "end" },
    { x: 13, y: 41, anchor: "end" },
  ];
  return (
    <figure className={`vos-radar vos-radar-${tone}`}>
      <svg role="img" aria-label="六项结构指标雷达图" viewBox="-20 -3 188 154">
        <title>结构指标，不是置信度</title>
        {[20, 40, 60, 80, 100].map((value) => (
          <polygon key={value} className="vos-radar-grid" points={polygonPoints(Array(6).fill(value), 54)} />
        ))}
        {Array.from({ length: 6 }, (_, index) => {
          const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 6;
          return <line key={index} className="vos-radar-axis" x1="74" y1="74" x2={74 + Math.cos(angle) * 54} y2={74 + Math.sin(angle) * 54} />;
        })}
        <polygon className="vos-radar-fill" points={polygonPoints(values, 54)} />
        <polygon className="vos-radar-stroke" points={polygonPoints(values, 54)} />
        {values.map((value, index) => {
          const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 6;
          return <circle key={metrics[index].id} className="vos-radar-point" cx={74 + Math.cos(angle) * 54 * (value / 100)} cy={74 + Math.sin(angle) * 54 * (value / 100)} r="2.2"><title>{metrics[index].label}：{value} · {metrics[index].detail}</title></circle>;
        })}
        {metrics.map((metric, index) => (
          <text key={metric.id} className="vos-radar-label" x={labelPositions[index].x} y={labelPositions[index].y} textAnchor={labelPositions[index].anchor as any}>{metric.label}</text>
        ))}
      </svg>
      <figcaption>结构指标，不是置信度</figcaption>
    </figure>
  );
}

const RadarCard = React.memo(function RadarCard({
  card,
  view,
  pinned,
  selected,
  index,
  onSelect,
  onTogglePin,
}: any) {
  const historical = view?.kindLabel === "历史样本";
  const humanOriginal = card.schema === "published-card-v3";
  const title = view?.title || (humanOriginal ? card.variableTitle : cleanDisplayText(card.eventSummary));
  const time = cardTimeMeta(card);
  const suggestion = card.systemSuggestion?.authority === "SYSTEM_SUGGESTION"
    ? card.systemSuggestion
    : null;
  const suggestionLabel = suggestion?.label === "TRADABLE"
    ? "可炒"
    : suggestion?.label === "NOT_TRADABLE"
      ? "不可炒"
      : suggestion?.label === "WATCH"
        ? "继续观察"
        : "待预判";
  const suggestionSource = suggestion?.basis === "MODEL"
    ? "模型预判"
    : suggestion
      ? "规则预判"
      : "系统预判";
  return (
    <article id={`vos-card-${card.cardRevisionId}`} className={`vos-variable-card ${selected ? "is-selected" : ""} ${historical ? "is-history" : ""}`} data-card-id={card.cardRevisionId}>
      <button className="vos-variable-main" type="button" aria-current={selected ? "true" : undefined} onClick={() => onSelect(card.cardRevisionId)}>
        <span className={`vos-variable-time ${time.missing ? "is-missing" : ""}`} title={time.accessibleLabel}>
          <span>{Number(card.revision || 1) > 1 ? "最近更新" : "进入雷达"}</span>
          <time dateTime={time.iso || undefined}>{time.label}</time>
        </span>
        <span className="vos-variable-source"><span>资料来源</span><strong>{humanOriginal ? "作者填写" : radarCardSourceLabel(card)}</strong></span>
        <span className="vos-variable-heading"><strong>{title}</strong><span aria-hidden="true">⋮</span></span>
        <span className="vos-variable-badges">
          <span className={`vos-badge ${historical ? "vos-badge-blue" : "vos-badge-red"}`}>{view?.urgency || "等待复核"}</span>
          {humanOriginal ? <span className="vos-badge">人工原卡 · 无模型预判</span> : <>
          <span className={`vos-badge vos-system-suggestion is-${String(suggestion?.label || "unknown").toLowerCase()}`} title={suggestion?.rationale || "旧版卷宗尚无系统预判"}>{suggestionSource} · {suggestionLabel}<small>仅供复核</small></span>
          <span className="vos-badge">证据 {view?.evidence?.length ?? "—"}</span>
          <span className="vos-badge">未知 {view?.uncertainties?.length ?? card.uncertainties?.length ?? 0}</span>
          </>}
        </span>
        {Number(card.revision || 1) > 1 ? <span className="vos-variable-version">同一变量 · 第 {card.revision} 版</span> : null}
        <span className="vos-variable-summary">{humanOriginal ? "阅读作者原文与出处" : radarCardSummaryLabel({ selected, view })}<DeskIcon name="chevron" size={15} /></span>
        {humanOriginal ? <span className="vos-card-not-loaded">作者提供的证据与出处尚未独立核验</span> : view ? <RadarChart metrics={view.radar} tone={historical ? "blue" : "red"} /> : selected ? <span className="vos-card-loading" aria-label={radarCardIndicatorLabel({ selected, viewReady: false }) || undefined} /> : <span className="vos-card-not-loaded" aria-label={radarCardIndicatorLabel({ selected, viewReady: false }) || undefined}>点击查看雷达指标</span>}
      </button>
      <button className="vos-pin-button" type="button" aria-pressed={pinned} aria-label={`${pinned ? "取消置顶" : "置顶"}${view?.title || (humanOriginal ? title : `变量 ${index + 1}`)}`} onClick={() => onTogglePin(card.cardRevisionId)}><DeskIcon name="pin" size={17} /></button>
    </article>
  );
});

export function RadarColumn({
  cards,
  views,
  selectedId,
  pinnedIds,
  busy,
  emptyLabel = "今天暂时没有进入人工复核的变量。",
  onSelect,
  onClearSelection,
  onTogglePin,
  onReread,
  narration,
  onToggleAutoNarration,
  onAutoNarrationScopeChange,
  uiState,
  onUiChange = () => {},
  dataReady = true,
  expanded = false,
  onCollapse,
  preserveSelection = false,
  homeFilter,
  onHomeFilterChange,
}: any) {
  const [localFilter, setLocalFilter] = useState({ tab: 'all', query: '' });
  const { tab: homeTab, query: homeQuery } = homeFilter || localFilter;
  const changeFilter = (value: any) => onHomeFilterChange ? onHomeFilterChange(value) : setLocalFilter(value);
  const setHomeTab = (tab: string) => changeFilter({ tab, query: homeQuery });
  const setHomeQuery = (query: string) => changeFilter({ tab: homeTab, query });
  const [seenCards, setSeenCards] = useState(cards);
  const railRef = useRef<HTMLElement>(null);
  const scrollAnchor = useRef<any>(null);
  const newCount = countNewDeskCards(seenCards, cards);
  useEffect(() => { if (!seenCards.length && cards.length) setSeenCards(cards); }, [cards, seenCards]);
  useEffect(() => {
    const anchor = scrollAnchor.current;
    const rail = railRef.current;
    if (!preserveSelection || !anchor || !rail) return;
    const node = document.getElementById(`vos-card-${anchor.id}`);
    if (node && rail.contains(node)) rail.scrollTop += node.getBoundingClientRect().top - rail.getBoundingClientRect().top - anchor.offset;
  }, [cards, preserveSelection]);
  const radarUi = uiState || createRadarUiState();
  const sortDirection = radarUi.sortDirection;
  const dateFilter = radarUi.dateFilter;
  const judgmentFilter = radarUi.judgmentFilter;
  const sourceFilter = radarUi.sourceFilter || "all";
  const redTeamOnly = radarUi.redTeamOnly;
  const cardHandlers = useRef({ onSelect, onTogglePin });
  cardHandlers.current = { onSelect, onTogglePin };
  const selectCard = useCallback(
    (id: string) => cardHandlers.current.onSelect(id),
    [],
  );
  const togglePin = useCallback(
    (id: string) => cardHandlers.current.onTogglePin(id),
    [],
  );
  const ordered = useMemo(
    () => sortRadarCards(cards, pinnedIds, sortDirection),
    [cards, pinnedIds, sortDirection],
  );
  const dateOptions = useMemo(
    () => radarDateOptions(cards, sortDirection),
    [cards, sortDirection],
  );
  const headingLabel = radarHeadingLabel({
    dateFilter,
    dateOptions,
    todayDate: radarTodayDateId(),
  });
  const datedCards = useMemo(
    () => filterRadarCardsByDate(ordered, dateFilter),
    [ordered, dateFilter],
  );
  const judgedCards = useMemo(
    () => filterRadarCardsByJudgment(datedCards, judgmentFilter),
    [datedCards, judgmentFilter],
  );
  const reviewedCards = useMemo(
    () => filterRadarCardsByRedTeam(judgedCards, redTeamOnly),
    [judgedCards, redTeamOnly],
  );
  const sourceOptions = useMemo(
    () => RADAR_SOURCE_FILTERS.map((option) => ({ ...option, count: filterRadarCardsBySource(reviewedCards, option.id).length })),
    [reviewedCards],
  );
  const visibleCards = useMemo(
    () => filterDeskHomeCards(filterRadarCardsBySource(reviewedCards, sourceFilter), { tab: homeTab, query: homeQuery, pinnedIds }),
    [reviewedCards, sourceFilter, homeTab, homeQuery, pinnedIds],
  );
  const visibleSelection = useMemo(
    () => resolveRadarFilterSelection(visibleCards, selectedId),
    [selectedId, visibleCards],
  );
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const cardNodes = useMemo(
    () => visibleCards.map((card: any, index: number) => (
      <RadarCard
        key={card.cardRevisionId}
        card={card}
        view={views[card.cardRevisionId]}
        pinned={pinnedSet.has(card.cardRevisionId)}
        selected={selectedId === card.cardRevisionId}
        index={index}
        onSelect={selectCard}
        onTogglePin={togglePin}
      />
    )),
    [pinnedSet, selectCard, selectedId, togglePin, views, visibleCards],
  );
  useEffect(() => {
    if (shouldResetRadarDateFilter({ dateFilter, dateOptions, dataReady })) {
      onUiChange({ type: "set-date", value: "all" });
    }
  }, [dataReady, dateFilter, dateOptions, onUiChange]);
  useEffect(() => {
    if (preserveSelection) return;
    if (visibleSelection === selectedId) return;
    if (visibleSelection) onSelect(visibleSelection, "refresh");
    else onClearSelection?.();
  }, [onClearSelection, onSelect, selectedId, visibleSelection, preserveSelection]);
  return (
    <aside ref={railRef} className="vos-radar-column" aria-label={headingLabel} data-expanded={expanded || undefined} onScroll={() => {
      const rail = railRef.current;
      if (!rail) return;
      const top = rail.getBoundingClientRect().top;
      // Sorted DOM positions permit logarithmic lookup, without laying out the entire radar on scroll.
      const nodes = rail.querySelector('.vos-variable-list')?.children;
      let low = 0, high = nodes?.length || 0;
      while (low < high) { const mid = (low + high) >>> 1; if (nodes![mid].getBoundingClientRect().bottom <= top) low = mid + 1; else high = mid; }
      const node = nodes?.[low] as HTMLElement | undefined;
      scrollAnchor.current = node ? { id: node.dataset.cardId, offset: node.getBoundingClientRect().top - top } : null;
    }}>
      {preserveSelection ? <div className="vos-home-card-filters">
        <div role="group" aria-label="卡片集合">{[['all','全部'],['pinned','我关注'],['review','待复核']].map(([id,label]) => <button key={id} type="button" aria-pressed={homeTab === id} onClick={() => setHomeTab(id)}>{label}</button>)}</div>
        <input aria-label="筛选已加载卡片" placeholder="在已加载卡片中筛选…" value={homeQuery} onChange={event => setHomeQuery(event.target.value)} />
        <small>仅筛选已加载标题/摘要；我关注＝已固定，待复核＝必须复核/紧急状态。</small>
        {newCount ? <button type="button" className="vos-home-new-cards" onClick={() => { changeFilter({tab:'all',query:''}); onUiChange({ type:'set-date',value:'all' }); onUiChange({type:'set-judgment',value:'all'}); onUiChange({type:'set-source',value:'all'}); if (redTeamOnly) onUiChange({type:'toggle-red-team'}); onUiChange({type:'set-sort',value:'newest'}); setSeenCards(cards); scrollAnchor.current = null; railRef.current?.scrollTo({top:0}); }}>新增 {newCount} 条 · 查看最新</button> : null}
        {selectedId && !visibleCards.some((card: any) => card.cardRevisionId === selectedId) ? <small role="status">当前卡不在筛选结果中；详情与参考保留。</small> : null}
      </div> : null}
      <div className="vos-column-title">
        <h2><DeskIcon name="crosshair" />{headingLabel}</h2>
        <div className="vos-column-actions">
          <label className="vos-time-sort">
            <span>时间</span>
            <select aria-label="雷达时间排序" value={sortDirection} onChange={(event) => onUiChange({ type: "set-sort", value: event.target.value })}>
              <option value="newest">最新在前</option>
              <option value="oldest">最早在前</option>
            </select>
          </label>
          <button className="vos-icon-button" type="button" aria-label="重新读取当前投影" disabled={Boolean(busy)} onClick={onReread}><DeskIcon name="refresh" /></button>
        </div>
      </div>
      <details className="vos-home-radar-options" open={!preserveSelection}><summary>日期、信源与播报设置</summary><div className="vos-radar-navigator">
        <label>
          <span>日期</span>
          <select aria-label="雷达日期跳转" value={dateFilter} onChange={(event) => onUiChange({ type: "set-date", value: event.target.value })}>
            <option value="all">全部 {cards.length}</option>
            {dateOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.count}</option>)}
          </select>
        </label>
        <label>
          <span>预判</span>
          <select aria-label="系统预判筛选" value={judgmentFilter} onChange={(event) => onUiChange({ type: "set-judgment", value: event.target.value })}>
            <option value="all">全部</option>
            <option value="TRADABLE">可炒</option>
            <option value="WATCH">继续观察</option>
            <option value="NOT_TRADABLE">不可炒</option>
          </select>
        </label>
        <label className="vos-radar-source-filter">
          <span>资料来源</span>
          <select aria-label="资料来源筛选" value={sourceFilter} onChange={(event) => onUiChange({ type: "set-source", value: event.target.value })}>
            {sourceOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.count}</option>)}
          </select>
        </label>
        <button
          className={`vos-red-team-filter ${redTeamOnly ? "is-active" : ""}`}
          type="button"
          role="switch"
          aria-checked={redTeamOnly}
          title="只显示已经识别出反证的变量；失效条件仍在卷宗中持续监控"
          onClick={() => onUiChange({ type: "toggle-red-team" })}
        ><DeskIcon name="eye" size={13} />反证优先</button>
        <span aria-live="polite">{radarDisplayCountLabel(visibleCards.length, datedCards.length)}</span>
        {expanded
          ? <button type="button" onClick={onCollapse}>返回卷宗</button>
          : <small>{preserveSelection ? '点击卡片查看详情；顶部可收起、调整宽度' : '拖动右侧把手展开'}</small>}
        <div className={`vos-radar-narration ${narration?.autoEnabled ? "is-enabled" : ""}`} role="group" aria-label="雷达语音播报">
          <span className="vos-radar-narration-title"><DeskIcon name="volume" size={14} /><span><strong>本机语音</strong><small>{narration?.supported ? "只在本机播放，不调用模型" : narration?.unavailableMessage || "当前设备不支持语音播报"}</small></span></span>
          <label className="vos-narration-scope">
            <span>范围</span>
            <select
              aria-label="自动播报范围"
              value={narration?.autoScope || "all"}
              disabled={!narration?.supported}
              onChange={(event) => onAutoNarrationScopeChange(event.target.value)}
            >
              <option value="all">全部新雷达</option>
              <option value="must-review">仅必须复核</option>
            </select>
          </label>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(narration?.autoEnabled)}
            disabled={!narration?.supported}
            onClick={onToggleAutoNarration}
          >{narration?.autoEnabled ? "自动播报已开" : "开启自动播报"}</button>
          <small>开启即播最新一条；新卡出现就读重点，无需点开</small>
          {narration?.autoEnabled ? <small role="status" aria-label="新卡播报状态">
            {narration.status === "error" ? narration.message
              : narration.active ? `正在${narration.status === "paused" ? "暂停" : "播报"}：${narration.active.title} · 排队 ${narration.queue.length} 条`
                : "等待新卡 · 已有卡片不重复播报"}
          </small> : null}
        </div>
      </div>
      </details><div className="vos-variable-list">
        {cardNodes}
        {!visibleCards.length ? <div className="vos-paper-empty">{radarEmptyLabel({ cards, datedCards, visibleCards, emptyLabel })}</div> : null}
      </div>
    </aside>
  );
}

function EvidenceCard({ evidence, evidenceDetail, evidenceDetailError, cardId, included, onAdd, onExpandEvidence, blocked = false }: any) {
  const [expanded, setExpanded] = useState(evidence.ordinal === 1);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const truncated = /(?:\.{3}|…+)\s*$/u.test(String(evidence.summary || ""));
  const fullQuote = evidenceDetail?.fullQuote || evidence.summary;
  const toggleExpanded = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!truncated || evidenceDetail || typeof onExpandEvidence !== "function") return;
    setLoadingDetail(true);
    try {
      await onExpandEvidence(evidence);
    } finally {
      setLoadingDetail(false);
    }
  };
  return (
    <article
      className={`vos-evidence-card ${evidence.ordinal === 1 ? "is-core" : ""}`}
      draggable={!blocked}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button,input,textarea")) return;
        pointerDraggedEvidenceId = evidence.id;
      }}
      onMouseUp={() => { pointerDraggedEvidenceId = null; }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("text/x-variable-evidence", evidence.id);
      }}
      onDragEnd={() => { pointerDraggedEvidenceId = null; }}
    >
      <div className="vos-evidence-topline">
        <span className="vos-evidence-ribbon">{evidence.label}</span>
        <button className="vos-text-button" type="button" aria-expanded={expanded} aria-busy={loadingDetail || undefined} onClick={() => void toggleExpanded()}>{loadingDetail ? "读取中" : expanded ? "收起" : "展开"}</button>
      </div>
      <blockquote className={expanded ? "" : "is-clamped"}>“{expanded ? fullQuote : evidence.summary}”</blockquote>
      {expanded && evidenceDetailError ? <small className="vos-evidence-detail-error" role="alert">完整引用暂不可读，当前仅显示冻结摘录</small> : null}
      <footer>
        <span title={evidence.sourcePath || undefined}><DeskIcon name="link" size={16} />{evidence.sourceLabel}{evidence.sourceRef && evidence.sourceRef !== "SEED" ? ` · ${evidence.sourceRef}` : ""}</span>
        <span>{evidence.timeLabel}</span>
        <span className="vos-trust-label">{evidence.accessLabel}</span>
      </footer>
      <button className="vos-include-button" type="button" disabled={blocked || included} onClick={() => onAdd({ type: "add-evidence", cardId, evidenceId: evidence.id })}>{included ? "已纳入判断" : "纳入判断依据"}</button>
    </article>
  );
}

export function DeepResearchPanel({ platform = false, children, research, onRun, onCancel, onScopeChange, available = true, personal = false, webAvailable = !personal, webRequiresApiSupplement = true, apiSupplementAvailable = !personal, source = "api" }: any) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [modelConsent, setModelConsent] = useState(false);
  const [webConsent, setWebConsent] = useState(false);
  const [apiConsent, setApiConsent] = useState(false);
  const [scope, setScope] = useState(research?.scope || "selected");
  const phase = research?.phase || "idle";
  const proposal = research?.result || null;
  const loading = phase === "loading";
  const ima = personal && source === "ima";
  const original = personal && source === "published";
  const library = ima && scope === "library";
  const selectedIma = ima && !library;
  const allowWeb = webAvailable && (!ima || library && (!webRequiresApiSupplement || apiSupplementAvailable && apiConsent));
  const counts = proposal?.counts;
  const separateMemory = platform && Number.isSafeInteger(counts?.stock);
  const relatedCounts = counts ? [counts.graph, counts.facts, ...(separateMemory ? [] : [counts.brain])] : [];
  const related = relatedCounts.length && relatedCounts.every(Number.isSafeInteger)
    ? relatedCounts.reduce((sum, value) => sum + value, 0) : "UNKNOWN";
  const originalRefs = proposal?.evidence?.filter((row: any) => row.sourceType === "published-card").length ?? 0;
  const countLabel = original && proposal ? `原卡证据 ${originalRefs} · 其他引用 ${(proposal.evidence?.length ?? 0) - originalRefs}` : counts
    ? `联网 ${counts.web ?? "UNKNOWN"} · 研究库 ${counts.wiki ?? "UNKNOWN"} · 原始信源 ${counts.raw ?? "UNKNOWN"} · 关系/事实 ${related}${platform && Number.isSafeInteger(counts.stock) ? ` · 记忆 ${counts.brain ?? 0} · 行情 ${counts.stock}` : ""}`
    : selectedIma ? "所选 IMA 资料" : personal ? "授权发布资料" : "联网与本地六源交叉检索";
  const resetConsent = () => { setConfirming(false); setModelConsent(false); setWebConsent(false); setApiConsent(false); };
  return (
    <section data-research-task={platform ? research?.id : undefined} className={`vos-deep-research ${loading ? "is-loading" : ""}`} aria-label={original ? "原卡个人研究" : selectedIma ? "所选 IMA 资料研究" : "Trading Wiki Deep Research 联网补证"}>
      <header>
        <span className="vos-research-mark"><DeskIcon name="sparkle" size={17} /></span>
        <div>
          <strong>{original ? "个人研究（可选）" : personal ? "当前变量补证" : "Trading Wiki Deep Research"}</strong>
          <small>{platform ? "授权原文 · 平台 DeepSeek 与计划内联网" : original ? "原卡证据 · 我的模型" : library ? "IMA 库内查询 · 所选 Host 模型" : selectedIma ? "所选 IMA 正文 · 所选 Host 模型" : personal ? "授权信源 · 所选 Host 模型" : "Tavily 联网 · 本地六源 · DeepSeek 综合"}</small>
        </div>
        <button type="button" disabled={!available || loading} aria-busy={loading || undefined} onClick={() => {
          if (platform) onRun(false);
          else if (personal) { resetConsent(); setConfirming(true); }
          else onRun(Boolean(proposal));
        }}>
          <DeskIcon name={proposal ? "refresh" : "link"} size={15} />
          {loading ? "正在补证" : platform ? "预览深研计划" : original ? proposal ? "重新研究" : "研究原卡" : library ? proposal ? "重新检索" : "查询研究库" : selectedIma ? proposal ? "重新研究" : "研究所选资料" : proposal ? "重新检索" : "联网补证"}
        </button>
      </header>
      {ima ? <fieldset className="vos-research-scope" aria-label="研究范围">
        {([["selected", "所选资料"], ["library", "库内查询"]] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name="ima-research-scope" checked={scope === value} onChange={() => {
            resetConsent(); setExpanded(false); setScope(value); onScopeChange?.(value);
          }} />{label}</label>)}
      </fieldset> : null}
      <div className="vos-research-boundary">
        <span>{proposal?.boundaryLabel || (platform ? "平台承担模型与联网费用；预览计划后显式确认，不改写业主原卡" : original ? "同步与查看无需模型；个人研究不会改写业主原卡" : library ? "IMA 库内查询 · 限额读取 · 历史覆盖 UNKNOWN" : selectedIma ? "所选 IMA 资料 · 未检索全库或网页 · 不属于事前冻结证据" : "当前联网补证 · 不属于事前冻结证据")}</span>
        <small>{platform ? "用户无需模型 Key；结果保存为本人私人研究" : original ? "配置自己的模型后，逐次授权使用" : "只读检索，不写 Wiki、原始资料或账本"}</small>
      </div>
      {children}
      {personal && confirming ? <fieldset className="vos-research-consent">
        <legend>本次补证授权</legend>
        <label><input type="checkbox" checked={modelConsent} onChange={event => setModelConsent(event.target.checked)} />{original ? "允许本次将业主原卡及证据发送给我的 Host 模型" : library ? "允许本次将库内命中资料的正文发送给我的 Host 模型" : selectedIma ? "允许本次将所选 IMA 正文发送给我的 Host 模型" : "允许本次使用我的 Host 模型"}</label>
        {library ? <label><input type="checkbox" disabled={!apiSupplementAvailable} checked={apiSupplementAvailable && apiConsent} onChange={event => {
          setApiConsent(event.target.checked); setWebConsent(false);
        }} />同时检索已配置 API 的授权摘录并交给我的 Host 模型</label> : null}
        <label><input type="checkbox" disabled={!allowWeb} checked={allowWeb && webConsent} onChange={event => setWebConsent(event.target.checked)} />允许本次联网检索</label>
        <div><button type="button" disabled={!available || !modelConsent} onClick={() => {
          onRun(Boolean(proposal), { modelUseAllowed: true, webSearchAllowed: allowWeb && webConsent,
            ...(ima ? { researchScope: scope } : {}), ...(library ? { apiSupplementAllowed: apiSupplementAvailable && apiConsent } : {}) });
          resetConsent();
        }}>开始补证</button><button type="button" onClick={resetConsent}>取消</button></div>
      </fieldset> : null}
      {loading ? <div className="vos-research-progress" role="status"><i /><span>{platform ? "正在执行已确认计划，进度来自已保存的任务记录。" : personal
        ? "正在读取授权资料并由所选 Host 模型综合…" : "正在检索网页与研究库，再交给 DeepSeek 归纳支持、反证和未知项…"}</span>
        {personal && !platform ? <button type="button" className="vos-text-button" aria-label="取消本次补证" onClick={onCancel}><DeskIcon name="close" size={15} />取消</button> : null}
      </div> : null}
      {research?.error ? <p className="vos-research-error" role="alert">{research.error}</p> : null}
      {proposal ? <div className="vos-research-result">
        <div className="vos-research-meta"><span>{proposal.modelLabel}</span><span>{countLabel}</span><span>{proposal.generatedLabel}</span></div>
        {personal ? <p role="status">{original ? `覆盖不完整 · ${proposal.webStatus === "off" ? "未联网检索" : proposal.webStatus === "done" ? "已联网补证（当前观察）" : "联网结果不完整"}` : `${proposal.status} · 联网 ${proposal.webStatus}`}</p> : null}
        {!original && proposal.wiki ? <p role="status">Wiki {proposal.wiki.mode}: {proposal.wiki.status} / {proposal.wiki.included ?? "UNKNOWN"}</p> : null}
        {proposal.readScope?.coverage === "IMA_LIBRARY_SEARCH" ? <p role="status">命中 {proposal.readScope.matched} · 已读 {proposal.readScope.included} · 未读 {proposal.readScope.omitted}</p> : null}
        <div className={`vos-research-summary ${expanded ? "is-expanded" : ""}`}>{platform ? <ResearchHostMarkdown text={proposal.answer} /> : proposal.answer}</div>
        <button className="vos-research-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起综合" : "展开综合"}</button>
      </div> : !loading ? <p className="vos-research-empty">{original ? "基于当前版本的原卡与证据核对逻辑、反证和未知项。联网检索需另行勾选。" : selectedIma ? "本次范围仅所选资料；全库、网页及历史覆盖未知。" : "围绕当前变量补查最新公告、产业进展、反证与市场共识，再把有出处的引用续接到下方证据链。"}</p> : null}
    </section>
  );
}

export function DeepResearchEvidenceChain({ proposal, onReadOriginal }: any) {
  if (!proposal?.evidence?.length) return null;
  return (
    <section className="vos-research-chain" aria-label="当前联网补证引用">
      <div className="vos-research-chain-title">
        <span>{proposal.readScope?.coverage === "REVIEWED_PUBLISHED_CARD" ? "原卡个人研究引用" : proposal.readScope?.coverage === "IMA_LIBRARY_SEARCH" ? "库内查询补证" : proposal.readScope ? "所选资料补证" : "当前联网补证"}</span>
        <small>{proposal.evidence.length} 条候选引用 · 需人工复核</small>
      </div>
      <p className="vos-research-chain-notice">{proposal.readScope
        ? "资料补证不会自动纳入正式研判，也不会改写上方的事前冻结证据。"
        : "联网补证不会自动纳入正式研判，也不会改写上方的事前冻结证据。"}</p>
      <div className="vos-research-cards">
        {proposal.evidence.map((evidence: any) => <DeepResearchEvidenceCard key={`${evidence.ref}:${evidence.sourcePath}`} evidence={evidence} onReadOriginal={onReadOriginal} />)}
      </div>
    </section>
  );
}

function DeepResearchEvidenceCard({ evidence, onReadOriginal }: any) {
  const [expanded, setExpanded] = useState(false);
  const expandable = evidence.excerpt.length > 180;
  return (
    <article className={`vos-research-evidence ${evidence.invalidated ? "is-invalidated" : ""}`}>
      <header><span>{evidence.ref}</span><strong>{evidence.title}</strong><small>{evidence.stateLabel}</small></header>
      <p className={!expanded && expandable ? "is-clamped" : ""}>{evidence.sourceType === "published-card" ? evidence.excerpt : evidence.contentHash ? `SHA-256 ${evidence.contentHash}` : evidence.excerpt}</p>
      {evidence.sourceType === "published-card" ? <small>SHA-256 {evidence.contentHash}{evidence.originalRetrievalRef ? ` · 原引用 ${evidence.originalRetrievalRef}` : ""}</small> : null}
      {evidence.observedAt ? <small>{evidence.observedAt} / version UNKNOWN</small> : null}
      {expandable ? <button type="button" className="vos-research-quote-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起摘录" : "展开摘录"}</button> : null}
      <footer>
        <span>{evidence.sourceLabel}</span>
        {onReadOriginal && (evidence.sourceType.startsWith('published-') || evidence.readableOriginal === true) ? <button type="button" onClick={() => onReadOriginal(evidence.ref)} aria-label={`查看 ${evidence.ref} 完整原文`}>查看完整原文</button> : null}
        {evidence.href ? <a href={evidence.href} target="_blank" rel="noreferrer noopener" aria-label={`打开 ${evidence.title} 的来源网页`}>查看网页<DeskIcon name="link" size={13} /></a> : <span title={evidence.sourcePath}>{evidence.sourceType === "published-card" ? "原卡只读引用" : evidence.sourceLabel === "IMA" ? "IMA 只读引用" : "本地只读引用"}</span>}
      </footer>
    </article>
  );
}

function TimelineOutcomeCards({ outcomes, stageLabel }: any) {
  if (!outcomes.length) return null;
  return <section className="vos-outcome-cards" aria-label={`${stageLabel}真实反馈`}>
    <header><strong>后续核对</strong><span>已按正式揭晓门控披露</span></header>
    {outcomes.map((outcome: any) => <article key={outcome.id}>
      <div><small>{outcome.horizon}</small><strong>{outcome.targetLabel}</strong></div>
      <h3>{outcome.resultLabel}</h3>
      <p>{outcome.reasonLabel}</p>
      <footer>{outcome.reviewLabel}</footer>
    </article>)}
  </section>;
}

const HOST_RECEIPT_LABELS: Record<string, string> = {
  AWAITING_CONFIRMATION: "等待确认",
  RUNNING: "进行中",
  SUCCEEDED: "已完成",
  FAILED: "未完成",
  CANCELED: "已取消",
};

function ResearchHostTranscript({ children, answer }: any) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newAnswer, setNewAnswer] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (atBottom.current) node.scrollTop = node.scrollHeight;
    else setNewAnswer(true);
  }, [answer]);
  return <div className="vos-home-transcript-wrap"><div ref={ref} className="vos-home-transcript" aria-label="对话阅读区" onScroll={() => {
    const node = ref.current;
    if (!node) return;
    atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    if (atBottom.current) setNewAnswer(false);
  }}>{children}</div><button type="button" className="vos-home-answer-bottom" onClick={() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; atBottom.current = true; setNewAnswer(false); }}>{newAnswer ? '有新回答 · 回到底部' : '回到底部'}</button></div>;
}

function PersonalResearchHistory({ scopeKey, plan, disabled, authorized, platform = false, onClearConsent,
  onLoad, onRestore }: any) {
  const [entries, setEntries] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  const key = `${scopeKey}:${plan.scope}:${plan.webSearchAllowed}`;
  useEffect(() => {
    setEntries([]); setCursor(null); setSelected(""); setStatus(""); setBusy(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [key]);
  const load = async (next = false) => {
    if (disabled || busy) return;
    onClearConsent();
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    setBusy(true); setStatus(""); setSelected("");
    if (!next) { setEntries([]); setCursor(null); }
    try {
      const page = await onLoad(plan, next ? cursor : null, { signal: controller.signal });
      if (request.current !== controller || controller.signal.aborted) return;
      const prior = next ? entries : [];
      if (prior.length + page.entries.length > 1024 || next && page.nextCursor === cursor
        || page.entries.some((row: any) => prior.some(item => item.sessionId === row.sessionId))) {
        throw Error("HISTORY_INVALID");
      }
      setEntries([...prior, ...page.entries]); setCursor(page.nextCursor);
      setStatus(prior.length + page.entries.length ? "" : "当前范围暂无历史");
    } catch {
      if (request.current !== controller || controller.signal.aborted) return;
      setEntries([]); setCursor(null); setStatus("历史读取失败");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  const restore = async () => {
    if (disabled || busy || !authorized || !entries.some(row => row.sessionId === selected)) return;
    const controller = new AbortController();
    request.current = controller; setBusy(true); setStatus("");
    try {
      const restored = await onRestore(selected, { signal: controller.signal });
      if (request.current !== controller || controller.signal.aborted) return;
      setStatus(restored ? "历史已恢复" : "历史恢复失败");
      if (!restored) { setSelected(""); setEntries([]); setCursor(null); }
    } catch {
      if (request.current !== controller || controller.signal.aborted) return;
      setSelected(""); setEntries([]); setCursor(null); setStatus("历史恢复失败");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  return <div className="vos-host-recovery vos-host-history" aria-label="个人研究历史" aria-busy={busy}>
    <button type="button" aria-label="读取研究历史" title="读取研究历史" disabled={disabled || busy}
      onClick={() => void load()}><DeskIcon name="book" size={16} />{platform ? '读取研究历史' : null}</button>
    <select aria-label="研究历史" value={selected} disabled={disabled || busy || !entries.length}
      onChange={event => { onClearConsent(); setSelected(event.target.value); setStatus(""); }}>
      <option value="">选择研究历史</option>
      {entries.map(row => <option key={row.sessionId} value={row.sessionId}>
        {row.updatedAt === null ? "时间未知" : new Date(row.updatedAt).toLocaleString("zh-CN")} · {row.sessionId.slice(-8)}
      </option>)}
    </select>
    {cursor ? <button type="button" aria-label="更多研究历史" title="更多研究历史" disabled={disabled || busy}
      onClick={() => void load(true)}><DeskIcon name="chevron" size={16} />{platform ? '更多研究历史' : null}</button> : null}
    <button type="button" aria-label="恢复研究历史" title="恢复研究历史"
      disabled={disabled || busy || !authorized || !selected} onClick={() => void restore()}>
      <DeskIcon name="play" size={16} />{platform ? '恢复研究历史' : null}</button>
    {busy || status ? <span role="status">{busy ? "正在读取" : status}</span> : null}
  </div>;
}

export function ResearchHostPanel({ context, hostState, voiceState, recovery = {}, speechStatus = {}, duplex = null, onPreviewSpeech, onSelectVoice, onToggleNarration, narrationControls = null, compact = false, busy = false, personal = false, platform = false, platformSupplementAvailable = false, platformNavigationAvailable = false, platformSearchAvailable = false, platformAgentAvailable = false, platformJudgmentAvailable = false, submissionDisabled = false, source = "api", scopeKey = "", publishedAvailable = false, webAvailable = !personal, draftApprovalAvailable = false, onChangeConversationPlan, onLoadHistory, onRestoreHistory, retirementState = {}, onRetryRetirements, canSwitchCard = false, onToggleExpanded, onRequestTool, onConfirmTool, onCancelTool, onSubmitQuestion, onStartListening, onStopListening, onInterruptVoice, onToggleWake, onContinue, onReplay }: any) {
  const [questionDraft, setQuestionDraft] = useState("");
  const [modelConsent, setModelConsent] = useState<any>(null);
  const [researchScope, setResearchScope] = useState("current");
  const [webConsent, setWebConsent] = useState(false);
  const [callConsent, setCallConsent] = useState<any>(null);
  const published = researchScope === "published";
  const useWeb = webAvailable && webConsent;
  const consentKey = `${scopeKey}:${context?.cardId || ""}:${researchScope}:${useWeb}:${webAvailable}:${platformAgentAvailable}`;
  const authorized = !personal || modelConsent?.key === consentKey && modelConsent?.allowed === true;
  const callConsentKey = `${consentKey}:${duplex?.revision || ""}`;
  const callAuthorized = !personal || callConsent?.key === callConsentKey && callConsent?.allowed === true;
  const consumeConsent = () => {
    setModelConsent(null);
    return personal ? { modelUseAllowed: true,
      researchPlan: { scope: researchScope, webSearchAllowed: published && useWeb } } : {};
  };
  const changePlan = (scope: string, web: boolean) => {
    setModelConsent(null); setCallConsent(null); setQuestionDraft("");
    setResearchScope(scope); setWebConsent(web);
    onChangeConversationPlan?.();
  };
  const Transcript = compact ? ResearchHostTranscript : 'div';
  const pastTurns = (hostState?.sessionLog || []).filter((entry: any) => ['user', 'assistant'].includes(entry.kind) && entry.text);
  // Website history contains preceding turns only. Their IDs, not equal text, identify distinct turns.
  const visiblePastTurns = platform ? pastTurns : pastTurns.filter((entry: any) => entry.text !== voiceState?.question && entry.text !== voiceState?.answer).slice(-12);
  if (!context) return null;
  const expanded = Boolean(hostState?.expanded);
  const callActive = Boolean(duplex?.active);
  const blocked = hostState?.phase === "blocked";
  const pendingTool = hostState?.pendingTool || null;
  const toolsDisabled = blocked || busy || Boolean(pendingTool) || callActive;
  const nodeLabel = context.timelineNode?.label || `${context.stage.label}全部节点`;
  const voicePhase = voiceState?.phase || "idle";
  const voiceBusy = voicePhase === "thinking" || voicePhase === "answering";
  const listening = voicePhase === "listening";
  const stopping = listening && Boolean(voiceState?.recognitionStopping);
  const recognitionDiagnostics = voiceState?.recognitionDiagnostics || [];
  const recognition = recognitionDiagnostics.at(-1);
  const audioReady = recognition?.mode === "ptt" && recognition.audioStartMs != null && !recognition.audioEnded && !["ended", "error", "cancelled", "start-failed", "stop-failed", "stop-timeout"].includes(recognition.stage);
  const recognitionLabels: any = { starting: "请求启动", started: "识别服务已启动", "audio-start": "已开始收音", "audio-end": "已结束收音", "speech-start": "检测到讲话", "speech-end": "检测到停顿", "first-result": "收到首段转写", "final-result": "收到最终转写", stopping: "正在收尾", ended: "已结束", error: "识别错误", cancelled: "已取消", "start-failed": "启动失败", "stop-failed": "结束失败", "stop-timeout": "结束超时" };
  const recognitionErrors: any = { "no-speech": "未检测到讲话", network: "浏览器识别服务网络异常", "audio-capture": "无法采集麦克风", "not-allowed": "权限拒绝", "service-not-allowed": "识别服务未授权", "language-not-supported": "语言不支持", aborted: "被取消", unknown: "浏览器未提供可识别错误码" };
  const recognitionTime = (value: any) => value == null ? "未报告" : `${value}ms`;
  const firstVoiceLatency = voiceState?.latency?.firstVoice;
  const localInterruptionLatency = voiceState?.latency?.localInterruption;
  const cancellationConvergenceLatency = voiceState?.latency?.cancellationConvergence;
  const latencyValue = (metric: any) => metric?.count
    ? `${metric.p50Ms}ms / ${metric.p95Ms}ms · ${metric.target}${metric.targetMet === true ? " 达标" : metric.targetMet === false ? " 未达标" : ""}`
    : `待实测 · 目标 ${metric?.target || "待确认"}`;
  const submitDraft = () => {
    const value = questionDraft.trim();
    if (!value || busy || !authorized || submissionDisabled) return;
    setQuestionDraft("");
    onSubmitQuestion(value, consumeConsent());
  };
  return (
    <section className={`vos-research-host ${blocked ? "is-blocked" : "is-ready"}${compact ? " is-workspace" : ""}`} data-personal={personal || undefined} aria-label="研究主持人">
      <header>
        <span className="vos-host-avatar" aria-hidden="true"><DeskIcon name="sparkle" size={17} /></span>
        <div>
          <small>{personal ? "小美 · 当前卡片研究" : context.readScope ? "小美 · 资料研究" : "小美 · 全局研究助手"}</small>
          <strong>{personal ? published ? "当前卡片与授权补证" : "当前卡片证据与反证" : context.readScope ? "所选 IMA 资料" : blocked ? "卷宗操作暂停，资料查询仍可用" : "可查微信舆情、联网资料与全局卷宗"}</strong>
        </div>
        <button type="button" aria-expanded={expanded} onClick={onToggleExpanded}>{expanded ? "收起上下文" : "查看上下文"}</button>
      </header>
      <p role="status" aria-live="polite">{hostState?.message || context.summary}</p>
      {duplex ? <div className="vos-host-duplex" aria-label="小美端到端通话">
        <div className="vos-host-recovery">
          <select aria-label="小美语音方案" value={duplex.mode} disabled={callActive} onChange={event=>duplex.selectMode?.(event.target.value)}>
            <option value="duplex">豆包 3.0 · 连续通话</option><option value="local" disabled={personal}>本机语音回退</option>
          </select>
          {duplex.mode === 'duplex' && !callActive ? <button type="button" aria-label="开始与小美通话"
            disabled={!callAuthorized || duplex.available === false || busy || voiceBusy || Boolean(pendingTool)}
            onClick={() => {
              if (!callAuthorized) return;
              setCallConsent(null); setModelConsent(null);
              duplex.start(personal ? { modelUseAllowed: true, audioUseAllowed: true, summaryUseAllowed: true,
                researchPlan: { scope: researchScope, webSearchAllowed: published && useWeb } } : undefined);
            }}>开始通话</button> : null}
          {personal && !callActive && duplex.available === false ? <button type="button" aria-label="重新检查通话配置"
            title="重新检查通话配置" onClick={duplex.refresh}><DeskIcon name="refresh" size={16} /></button> : null}
          {callActive ? <>
            <button type="button" aria-label="挂断通话" onClick={duplex.hangup}>挂断</button>
            <button type="button" aria-label="通话麦克风静音" aria-pressed={duplex.muted} onClick={duplex.toggleMute}>{duplex.muted?'恢复麦克风':'静音'}</button>
            <button type="button" aria-label="只停止小美说话" onClick={duplex.stopSpeaking}>先停一下</button>
            <button type="button" aria-label="取消当前研究" onClick={duplex.cancelResearch}>取消研究</button>
          </> : null}
          <span role="status">{duplex.status === 'starting'?'正在申请麦克风并连接':duplex.status === 'listening'?'通话中 · 我在听':duplex.status === 'speaking'?'小美正在说话，可随时插话':duplex.status === 'error'?`通话未能继续 · ${duplex.code || '请重试或选本机回退'}`:'未通话，麦克风不会为通话自动开启'}</span>
        </div>
        {duplex.mode === 'duplex' ? <small>点击后将麦克风音频及必要研究摘要发送到火山引擎，按用量计费；本机不保存音频。研究仍由原生 DSH 执行，正式操作需人工确认。挂断结束本次通话，不自动重连。</small> : <small>沿用浏览器识别＋原生 DSH＋已安装的本机声音。</small>}
        {personal && duplex.mode === 'duplex' && !callActive ? <label className="vos-host-model-consent vos-host-call-consent">
          <input type="checkbox" checked={callAuthorized} disabled={duplex.available === false || busy || voiceBusy}
            onChange={event => setCallConsent({ key: callConsentKey, allowed: event.target.checked })} />
          允许本次通话使用当前研究范围及我的 Host 模型，并向火山引擎发送麦克风音频和经核验的研究口播摘要
        </label> : null}
        {duplex.question ? <p>你：{duplex.question}</p> : null}
        {duplex.answer ? <p aria-live="polite">小美：{duplex.answer}</p> : null}
        {duplex.researchState ? <small role="status">研究状态：{duplex.researchState} · 过程与文字详情见下方 Session Log</small> : null}
      </div> : null}
      <div className={`vos-host-conversation is-${voicePhase}`} aria-label="与小美对话">
        <Transcript {...(compact ? { answer: voiceState?.answer } : {})}>
        {compact && platform && !voiceState?.question && !voiceState?.answer && !(hostState?.sessionLog || []).some((entry:any)=>['user','assistant'].includes(entry.kind)&&entry.text)
          ? <div className="vos-host-selected-context"><p>已选原卡：{context.variableTitle}</p><small>可围绕当前原卡提问、查看引用或读取本人历史。</small></div> : null}
        {compact ? visiblePastTurns.map((entry: any) => <div key={entry.id} className={`vos-host-turn is-${entry.kind}`}><small>{entry.kind === 'user' ? '你' : '小美'}</small><ResearchHostMarkdown text={entry.text} /></div>) : null}
        {voiceState?.question ? <div className="vos-host-turn is-user"><small>你</small><p>{voiceState.question}</p></div> : null}
        {voiceState?.answer ? <div className="vos-host-turn is-assistant"><small>小美{voiceState.model?.model ? ` · ${voiceState.model.model}` : ""}</small><ResearchHostMarkdown text={voiceState.answer} live busy={voiceBusy} /></div> : null}
        {listening ? <div className="vos-host-listening" role="status"><span /><strong>{stopping ? "正在结束识别" : audioReady ? "正在听" : "等待浏览器开始收音"}</strong><small>{voiceState.interimTranscript || voiceState.transcript || (stopping ? "正在等待最终转写，异常时会恢复输入" : audioReady ? "松开后发送" : "麦克风就绪后再说，松开可结束本轮")}</small></div> : null}
        {voicePhase === "thinking" && !voiceState?.answer ? <div className="vos-host-thinking" role="status"><span /><span /><span />正在理解问题并选择资料来源</div> : null}
        {voiceState?.error ? <p className="vos-host-voice-error" role="alert">{voiceState.error}</p> : null}
        {voiceState?.recoverableTranscript ? <div className="vos-host-interrupted"><p>未发送的转写（请复核）：{voiceState.recoverableTranscript}</p><button type="button" disabled={busy || listening} onClick={() => setQuestionDraft(voiceState.recoverableTranscript)}>放入输入框</button></div> : null}
        {voiceState?.interrupted && voiceState?.answer ? <small className="vos-host-interrupted">已打断，保留已说出的部分</small> : null}
        </Transcript>
        {recovery.speechMode === "contextual-v1" && recovery.spokenAnswer ? <details className="vos-host-spoken" aria-label="这次口头回应">
          <summary>这次口头回应 <span>由当前 Agent 结合上下文生成</span></summary>
          <p>{recovery.spokenAnswer}</p>
        </details> : null}
        {recovery.answer && recovery.speechMode === "contextual-v1" && recovery.speechStatus === "unavailable" ? <p className="vos-host-spoken-status" role="status" aria-label="口语回应生成状态">未生成完整口语回应；文字仍可查看，不自动朗读全文。</p> : null}
        {!callActive ? <div className={`vos-host-wake ${voiceState?.wakeArmed ? "is-armed" : ""}`}>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(voiceState?.wakeArmed)}
            disabled={!voiceState?.recognitionSupported || busy || callActive}
            onClick={() => { void onToggleWake(!voiceState?.wakeArmed); }}
          ><DeskIcon name="sparkle" size={12} />{voiceState?.wakeArmed
            ? "关闭“小美”持续唤醒"
            : voiceState?.wakePreferred
              ? "启用“小美”持续唤醒"
              : "重新启用“小美”持续唤醒"}</button>
          <span role="status">{voiceState?.wakeAwaiting && voiceState?.wakeListening
            ? "我在，请继续说"
            : voiceState?.wakeListening
              ? "说“小美＋指令”打断；或按住说话"
              : voiceState?.wakeArmed
                ? "仅当前页面前台生效"
                : voiceState?.wakePreferred
                  ? "首次需点击授权麦克风"
                  : "本次会话已关闭"}</span>
        </div> : null}
        {personal ? <div className="vos-host-recovery">
          <label>研究范围 <select aria-label="对话研究范围" value={researchScope} disabled={callActive}
            onChange={event => changePlan(event.target.value, false)}>
            <option value="current">当前卡片</option>
            <option value="published" disabled={!publishedAvailable}>当前卡片 + API 补证</option>
          </select></label>
          {published ? <label className="vos-host-model-consent"><input type="checkbox"
            checked={useWeb} disabled={callActive || !webAvailable} onChange={event => changePlan(researchScope, event.target.checked)} />
            允许本次联网补证</label> : null}
        </div> : null}
        {personal && (retirementState.pending || retirementState.unconfirmed) ? <div className="vos-host-recovery" role="status">
          <span>{retirementState.unconfirmed ? "旧会话销毁未确认" : "正在确认旧会话销毁"}</span>
          {retirementState.unconfirmed ? <button type="button" disabled={retirementState.pending > 0}
            onClick={onRetryRetirements}><DeskIcon name="refresh" size={14} />重试会话销毁确认</button> : null}
        </div> : null}
        {personal ? <label className="vos-host-model-consent">
          <input type="checkbox" checked={authorized} disabled={busy || voiceBusy || submissionDisabled}
            onChange={event => setModelConsent({ key: consentKey, allowed: event.target.checked })} />
          {platform ? platformAgentAvailable ? "允许本次使用平台模型研究当前卡片、其他已授权原卡和本人会话上下文" : "允许本次使用平台模型研究当前卡片和已核实的本人上下文" : published ? source === "ima" ? useWeb
            ? "允许本次联网检索，并将所选 IMA 正文及 API 补证发送给我的 Host 模型"
            : "允许本次将所选 IMA 正文及 API 补证发送给我的 Host 模型"
            : useWeb ? "允许本次联网检索，并将当前卡片及 API 补证发送给我的 Host 模型"
            : "允许本次将当前卡片及 API 补证发送给我的 Host 模型"
            : source === "ima" ? "允许本次将所选 IMA 正文发送给我的 Host 模型" : "允许本次将当前卡片授权证据发送给我的 Host 模型"}
        </label> : null}
        {personal && onLoadHistory && onRestoreHistory ? <PersonalResearchHistory
          platform={platform}
          scopeKey={consentKey} plan={{ scope: researchScope, webSearchAllowed: published && useWeb }}
          disabled={busy || voiceBusy || listening || callActive || Boolean(pendingTool)}
          authorized={platform || authorized} onClearConsent={() => { setModelConsent(null); setCallConsent(null); }}
          onLoad={onLoadHistory}
          onRestore={(id: string, options: any) => {
            setQuestionDraft(""); setCallConsent(null);
            return onRestoreHistory(id, consumeConsent(), options);
          }} /> : null}
        <form className="vos-host-composer" onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
          <input
            aria-label="向研究主持人提问"
            disabled={busy || listening || callActive || submissionDisabled}
            maxLength={500}
            placeholder={personal ? "问当前卡片的证据、反证与待定项…" : "问微信舆情、联网资料、股票或全局雷达…"}
            value={questionDraft}
            onChange={(event) => setQuestionDraft(event.target.value)}
          />
          <button type="submit" disabled={!questionDraft.trim() || busy || listening || callActive || !authorized || submissionDisabled}>发送</button>
          <button
            className={`vos-host-mic ${listening && audioReady && !stopping ? "is-listening" : ""}`}
            type="button"
            aria-label={listening ? "松开结束语音" : voiceState?.recognitionSupported ? "按住说话" : "当前浏览器不支持语音输入"}
            disabled={!voiceState?.recognitionSupported || busy || stopping || callActive}
            onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); void onStartListening(); }}
            onPointerUp={(event) => { event.preventDefault(); onStopListening(); }}
            onPointerCancel={onStopListening}
            onLostPointerCapture={onStopListening}
            onBlur={onStopListening}
            onKeyDown={(event) => {
              if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                event.preventDefault();
                void onStartListening();
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                onStopListening();
              }
            }}
          ><DeskIcon name="mic" size={14} />{stopping ? "正在收尾" : listening ? audioReady ? "松开发送" : "松开结束" : "按住说话"}</button>
          {!callActive && (voiceBusy || recovery.audioActive) ? <button className="vos-host-stop" type="button" onClick={onInterruptVoice}><DeskIcon name="stop" size={12} />打断</button> : null}
        </form>
        {recovery.question || recovery.answer ? <div className="vos-host-recovery" aria-label="回答恢复">
          <button type="button" aria-label="继续上个问题（原生 Agent）" disabled={busy || callActive || !recovery.canContinue || !authorized} onClick={() => onContinue(consumeConsent())}>继续上个问题</button>
          <button type="button" aria-label="重听已生成回答（仅本机）" disabled={busy || callActive || !recovery.canReplay} onClick={onReplay}>{recovery.speechMode === "contextual-v1" ? "重听口语回应" : "重听回答"}</button>
          <small>继续会请求原生 Agent 核对已有结果；重听只播已生成回应，不重新检索或补齐未完成内容。</small>
        </div> : null}
        <div className="vos-host-recovery" aria-label="本机语音回复">
          {personal ? <label><input type="checkbox" aria-label="播报研究回应"
            checked={Boolean(speechStatus.replyEnabled)}
            disabled={!speechStatus.supported || busy || callActive}
            onChange={event => onToggleNarration?.(event.target.checked)} />播报研究回应</label> : null}
          {speechStatus.voices?.length > 1 ? <select aria-label="小美本机音色" value={speechStatus.selectedVoice || "system"}
            disabled={busy || voiceBusy || listening || Boolean(pendingTool) || Boolean(recovery.audioActive) || callActive}
            onChange={event => onSelectVoice?.(event.target.value)}>
            {speechStatus.voices.map((voice: any) => <option key={voice.id} value={voice.id} disabled={voice.available === false}>{voice.label}</option>)}
          </select> : null}
          <button type="button" aria-label="试听本机语音（不调用模型）"
            disabled={busy || voiceBusy || listening || Boolean(pendingTool) || Boolean(recovery.audioActive) || !speechStatus.supported || callActive}
            onClick={onPreviewSpeech}>试听声音</button>
          <span role="status" aria-label="小美播报状态">
            {callActive ? "连续通话中，本机播报已暂停" : speechStatus.supported ? speechStatus.backend === "kokoro-local" ? "Kokoro 本地中文模型" : speechStatus.backend === "macos-say" ? "macOS 本机语音" : "浏览器语音" : "语音暂不可用，仍可输入文字"}
            {!callActive && speechStatus.message ? ` · ${speechStatus.message}` : ""}
          </span>
        </div>
        {narrationControls}
        {!callActive && !voiceState?.recognitionSupported ? <small className="vos-host-voice-fallback">{platform ? "网站语音输入尚未接入，豆包继续暂缓；文字研究无需填写 Key。" : personal ? "本机语音输入未启用；文字研究使用本次授权的 Host 模型。" : "当前 WebView 无语音转写时仍可键入，回答继续使用 Harness 内置模型并播报。"}</small> : null}
        <details className="vos-home-voice-details" open={!compact}><summary>语音状态与诊断</summary>
        {speechStatus.backend === "kokoro-local" ? <p>本地合成，不上传文字或保存音频。首声统计依据播放设备回执及页面轮询，不是麦克风实测；首次加载较慢。</p> : null}
        <dl className="vos-host-voice-latency" aria-label="小美语音真实延迟">
          <div><dt>停顿→首次出声 P50/P95</dt><dd>{latencyValue(firstVoiceLatency)}</dd></div>
          <div><dt>开口→本地停声 P50/P95</dt><dd>{latencyValue(localInterruptionLatency)}</dd></div>
          <div><dt>取消全链收敛 P50/P95</dt><dd>{latencyValue(cancellationConvergenceLatency)}</dd></div>
        </dl>
        {recognitionDiagnostics.length ? <details className="vos-host-asr-diagnostics">
          <summary>语音识别诊断（最近 {recognitionDiagnostics.length} 轮）</summary>
          <small>仅当前页面内存；不存音频或转写。以下毫秒均自请求启动起算，不含权限等待；“未报告”不等于零延迟。</small>
          <ol>{recognitionDiagnostics.slice().reverse().map((item: any) => <li key={item.id}>
            <strong>{item.mode === "wake" ? "页内唤醒" : "按住说话"} #{item.id} · {item.error === "no-speech" ? "本轮未检测到讲话" : recognitionLabels[item.stage] || "状态待确认"} · {item.elapsedMs}ms</strong>
            <p>开始收音 {recognitionTime(item.audioStartMs)} · 检测讲话 {recognitionTime(item.speechStartMs)} · 首段转写 {recognitionTime(item.firstResultMs)} · 最终转写 {recognitionTime(item.finalResultMs)}{item.error ? ` · ${recognitionErrors[item.error] || recognitionErrors.unknown}` : ""}</p>
          </li>)}</ol>
        </details> : null}
        </details>
      </div>
      <div className="vos-host-tools" aria-label="研究主持人工具">
        {platformSearchAvailable ? <button type="button" disabled={toolsDisabled} onClick={() => onRequestTool("searchRadar")}><DeskIcon name="search" size={13} />检索原卡</button> : null}
        <button type="button" disabled={toolsDisabled || personal && !platformNavigationAvailable} onClick={() => onRequestTool("radarOverview", { limit: 3 })}><DeskIcon name="crosshair" size={13} />全局雷达</button>
        <button type="button" disabled={toolsDisabled || context.visibleEvidenceCount === 0} onClick={() => onRequestTool("expandEvidence")}><DeskIcon name="book" size={13} />展开当前引用</button>
        <button type="button" disabled={toolsDisabled || !canSwitchCard || personal && !platformNavigationAvailable} onClick={() => onRequestTool("switchCard", { direction: "next" })}><DeskIcon name="chevron" size={13} />切换下一卷</button>
        <button type="button" disabled={platform ? toolsDisabled || !platformSupplementAvailable : toolsDisabled || context.cardId === "global" || !authorized || submissionDisabled} onClick={() => platform ? onRequestTool("deepResearch") : personal ? onSubmitQuestion("请深研当前卡片证据与反证。", consumeConsent()) : onRequestTool("deepResearch")}><DeskIcon name="link" size={13} />当前卷宗补证</button>
        <button type="button" title={platform ? "打开研判面板，明确确认后生成草稿" : undefined} disabled={platform ? toolsDisabled || !platformJudgmentAvailable : toolsDisabled || context.cardId === "global" || !authorized || submissionDisabled || personal && !draftApprovalAvailable} onClick={() => platform ? onRequestTool("draftJudgment") : personal ? onSubmitQuestion("请生成当前卡片的一次可编辑研判草稿。", consumeConsent()) : onRequestTool("draftJudgment")}><DeskIcon name="edit" size={13} />生成研判草稿</button>
      </div>
      {hostState?.phase === "awaiting-confirmation" && pendingTool ? <div className="vos-host-confirm" role="alertdialog" aria-label={`确认${pendingTool.label}`}>
        <p>“{pendingTool.label}”会调用研究模型或检索服务，结果只填入当前卷宗，不会正式提交。</p>
        <span><button type="button" onClick={() => onCancelTool(pendingTool.id)}>取消</button><button type="button" className="is-primary" onClick={() => onConfirmTool(pendingTool.id)}>确认调用</button></span>
      </div> : null}
      {expanded ? <div className="vos-host-context">
        <dl>
          <div><dt>当前变量</dt><dd>{context.variableTitle}</dd></div>
          <div><dt>当前节点</dt><dd>{nodeLabel}</dd></div>
          <div><dt>全局雷达</dt><dd>{context.radar?.total || 0} 个变量</dd></div>
          <div><dt>可见证据</dt><dd>{context.visibleEvidenceCount} 条</dd></div>
          <div><dt>已纳入判断</dt><dd>{context.includedEvidenceCount} 条</dd></div>
        </dl>
        <small>{platformAgentAvailable ? "范围：当前卡片、其他已授权发布原卡与本人会话；可核查工具记录和来源版本，不写入业主原卡。" : personal ? published ? "范围：当前卡片与本次授权的 API 补证；联网状态以工具回执为准，未检索整个 IMA 库，未执行正式写入。"
          : "范围：当前卡片的已授权资料与冻结引用；未检索整个知识库或公开网页，未执行正式写入。" : "无需先选卡：可检索未成卡的微信整理文件、本机 Radar、本地资料与公开网页；引用保留来源和时间，正式写入仍只接受页面确认。"}</small>
      </div> : null}
      {hostState?.receipts?.length ? <ol className="vos-host-receipts" aria-label="研究主持人工具回执" aria-live="polite">
        {hostState.receipts.slice(-3).reverse().map((receipt: any) => <li key={receipt.id} className={`is-${String(receipt.status).toLowerCase()}`}><span>{HOST_RECEIPT_LABELS[receipt.status] || "状态待确认"}</span><strong>{receipt.label}</strong><small>{receipt.message}</small></li>)}
      </ol> : null}
      {hostState?.sessionLog?.length ? <details className="vos-home-session-details" open={!compact}><summary>过程与 Session Log · {hostState.sessionId ? String(hostState.sessionId).slice(-8) : '可恢复会话'}</summary><section className="vos-host-session-log" aria-label="小美 Session Log">
        <header><strong>小美 Session Log</strong><small>{hostState.sessionId ? `会话 ${String(hostState.sessionId).slice(-8)}` : "可恢复会话"}</small></header>
        <ol aria-live="polite">
          {hostState.sessionLog.slice(-12).map((entry: any) => <li key={entry.id} className={`is-${entry.kind}`}>
            <span>{entry.kind === "user"
              ? `${researchHostVoiceLogLabel(entry.kind)}/消息`
              : entry.kind === "assistant"
                ? `${researchHostVoiceLogLabel(entry.kind)}/消息`
                : researchHostVoiceLogLabel(entry.kind)}</span>
            {entry.kind === "tool-call" ? <><strong>{entry.label || entry.toolId}</strong><small>调用参数 <code>{JSON.stringify(entry.args || {})}</code> · 运行中</small></> : null}
            {entry.kind === "tool-result" ? <><strong>{entry.label || entry.toolId}</strong><small>{entry.status === "SUCCEEDED" ? "成功" : "失败"} · {entry.text}</small></> : null}
            {entry.kind === "cancellation" ? <><strong>完整取消回执</strong><small>识别尾段 {researchHostVoiceLogLabel(entry.components?.recognition || "not-active")} · 模型 {researchHostVoiceLogLabel(entry.components?.model || "not-active")} · 在途工具 {researchHostVoiceLogLabel(entry.components?.tool || "not-active")} · TTS {researchHostVoiceLogLabel(entry.components?.tts || "not-active")}{Number.isFinite(entry.localStopLatencyMs) ? ` · 本地停声 ${entry.localStopLatencyMs}ms` : ""}{Number.isFinite(entry.cancellationConvergenceMs) ? ` · 全链收敛 ${entry.cancellationConvergenceMs}ms` : Number.isFinite(entry.latencyMs) ? ` · 全链收敛 ${entry.latencyMs}ms` : ""}</small></> : null}
            {entry.kind === "user" ? <p>{entry.text}</p> : null}
            {entry.kind === "assistant" ? <ResearchHostMarkdown text={entry.text} /> : null}
          </li>)}
        </ol>
      </section></details> : null}
    </section>
  );
}

export function TimelineColumn({ assistantOnly = false, showResearchHost = true, view, local, activeStageId, activeTimelineNodeId = null, evidenceDetails = {}, evidenceDetailErrors = {}, deepResearch = null, deepResearchAvailable = true, webResearchAvailable, webRequiresApiSupplement = true, apiSupplementAvailable, publishedResearchAvailable = false, draftApprovalAvailable = false, onChangeConversationPlan, onLoadHistory, onRestoreHistory, personalRetirementState, onRetryPersonalRetirements, researchSource = "api", personalResearch = false, researchScopeKey = "", onCancelDeepResearch, onChangeResearchScope, researchHostContext = null, researchHost = null, watchPanel = null, researchHostVoice = null, researchHostRecovery = {}, researchHostSpeech = {}, duplex = null, onPreviewResearchHostSpeech, onSelectResearchHostVoice, onToggleResearchHostNarration, researchHostBusy = false, canSwitchResearchHostCard = false, onToggleResearchHost, onRequestResearchHostTool, onConfirmResearchHostTool, onCancelResearchHostTool, onSubmitResearchHostQuestion, onStartResearchHostListening, onStopResearchHostListening, onInterruptResearchHostVoice, onToggleResearchHostWake, onContinueResearchHost, onReplayResearchHost, onExpandEvidence, onDeepResearch, onDispatch, blocked = false, emptyLabel = "正在铺开冻结卷宗" }: any) {
  const researchHostPanel = showResearchHost ? <ResearchHostPanel compact={assistantOnly}
    key={personalResearch ? `${researchScopeKey}:${researchHostContext?.cardId || ""}` : "local"}
    personal={personalResearch} source={researchSource} scopeKey={researchScopeKey}
    publishedAvailable={publishedResearchAvailable} onChangeConversationPlan={onChangeConversationPlan}
    onLoadHistory={onLoadHistory} onRestoreHistory={onRestoreHistory}
    webAvailable={webResearchAvailable}
    draftApprovalAvailable={draftApprovalAvailable}
    retirementState={personalRetirementState} onRetryRetirements={onRetryPersonalRetirements}
    context={researchHostContext} hostState={researchHost} voiceState={researchHostVoice}
    busy={researchHostBusy} canSwitchCard={canSwitchResearchHostCard}
    onToggleExpanded={onToggleResearchHost} onRequestTool={onRequestResearchHostTool}
    onConfirmTool={onConfirmResearchHostTool} onCancelTool={onCancelResearchHostTool}
    onSubmitQuestion={onSubmitResearchHostQuestion} onStartListening={onStartResearchHostListening}
    onStopListening={onStopResearchHostListening} onInterruptVoice={onInterruptResearchHostVoice}
    onToggleWake={onToggleResearchHostWake}
    recovery={researchHostRecovery} onContinue={onContinueResearchHost} onReplay={onReplayResearchHost}
    speechStatus={researchHostSpeech} onPreviewSpeech={onPreviewResearchHostSpeech} onSelectVoice={onSelectResearchHostVoice}
    onToggleNarration={onToggleResearchHostNarration}
    duplex={duplex}
  /> : null;
  if (assistantOnly) return <main className="vos-home-assistant-column">{researchHostPanel}{watchPanel}</main>;
  if (!view) return <main className="vos-timeline-column" aria-label="全局研究助手">{researchHostPanel}{watchPanel}<DeskLoading label={emptyLabel} /></main>;
  const timelineSelection = selectTimelineEvidence(view, activeStageId, activeTimelineNodeId);
  const { stage, activeNode: activeTimelineNode, evidence: visibleEvidence } = timelineSelection;
  const selectedNodeIds = new Set(
    (activeTimelineNode ? [activeTimelineNode] : stage.nodes).map((node: any) => node.id),
  );
  const visibleOutcomes = view.outcomeTimeline.filter((item: any) => selectedNodeIds.has(item.nodeId));
  return (
    <main className="vos-timeline-column" aria-label="当时已知的冻结证据">
      <div className="vos-column-title vos-timeline-title">
        <h2><DeskIcon name="book" />当时已知</h2>
        <button className="vos-paper-button" type="button" disabled={blocked} onClick={() => onDispatch({ type: "toggle-record-editor", cardId: view.id })}><DeskIcon name="edit" size={17} />编辑记录（{local.evidenceIds.length}）</button>
      </div>
      <aside className="vos-gap-note" aria-label="信息差窗口"><span>信息差窗口</span><strong>{view.publishedCard ? view.publishedCard.expectedHorizon || "业主未提供" : "3—5 日"}</strong></aside>
      <PublishedCardDetails card={view.publishedCard} publication={view.publication} />
      <section className="vos-stage-panel" aria-label="关键时间线">
        <div className="vos-stage-line" aria-hidden="true" />
        {view.stages.map((item: any) => (
          <button key={item.id} className={`vos-stage ${item.state} ${item.id === stage.id ? "is-active" : ""}`} type="button" aria-pressed={item.id === stage.id} onClick={() => onDispatch({ type: "select-stage", cardId: view.id, stageId: item.id })}>
            <span>{item.label}</span>
            <i>{item.state === "complete" ? "✓" : item.state === "locked" || item.state === "pending" ? <DeskIcon name="lock" size={12} /> : "○"}</i>
            <small>{item.state === "locked" ? "待补" : item.statusLabel}</small>
          </button>
        ))}
        <div className="vos-stage-caption"><strong>{stage.label}</strong><span>{stage.nodes.length ? `${stage.nodes.length} 个冻结节点` : stage.hint}</span></div>
      </section>
      {view.revisionTrail.length > 1 ? <nav className="vos-revision-rail" aria-label="同一变量证据版本">
        <span>证据更新</span>
        <div>
          {view.revisionTrail.map((revision: any) => {
            const active = revision.id === activeTimelineNode?.id;
            return <button
              key={revision.id}
              type="button"
              className={active ? "is-active" : ""}
              aria-pressed={active}
              aria-label={`${revision.label}，${revision.changeLabel}，${revision.dateLabel}`}
              onClick={() => onDispatch({
                type: "select-stage",
                cardId: view.id,
                stageId: revision.stageId,
                nodeId: revision.id,
              })}
            >
              <strong>{revision.label}</strong>
              <small>{revision.changeLabel}</small>
              <time>{revision.dateLabel}</time>
            </button>;
          })}
        </div>
      </nav> : null}
      {researchHostPanel}
      {watchPanel}
      <section className="vos-context-strip">
        <span>事前预期差</span>
        <p>{view.expectationGap}</p>
        <small>{view.whyTradable}</small>
      </section>
      <DeepResearchPanel key={`${view.id}:${researchScopeKey}`} research={deepResearch} onRun={onDeepResearch} onCancel={onCancelDeepResearch} onScopeChange={onChangeResearchScope} available={deepResearchAvailable} personal={personalResearch} webAvailable={webResearchAvailable} webRequiresApiSupplement={webRequiresApiSupplement} apiSupplementAvailable={apiSupplementAvailable} source={researchSource} />
      <TimelineOutcomeCards outcomes={visibleOutcomes} stageLabel={stage.label} />
      <section className="vos-evidence-stack" aria-label={`${stage.label}证据`}>
        {visibleEvidence.map((evidence: any, index: number) => <EvidenceCard key={evidence.id} evidence={{ ...evidence, ordinal: index + 1, label: index === 0 ? "核心引述" : `佐证 ${index}` }} evidenceDetail={evidenceDetails[evidence.id]} evidenceDetailError={evidenceDetailErrors[evidence.id]} cardId={view.id} included={local.evidenceIds.includes(evidence.id)} onAdd={onDispatch} onExpandEvidence={onExpandEvidence} blocked={blocked} />)}
        {!visibleEvidence.length && !visibleOutcomes.length ? <div className="vos-paper-empty">{timelineSelection.emptyLabel}</div> : null}
      </section>
      <DeepResearchEvidenceChain proposal={deepResearch?.result} />
      <div
        className="vos-evidence-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const evidenceId = evidenceIdFromInteraction(event);
          if (evidenceId && !blocked) onDispatch({ type: "add-evidence", cardId: view.id, evidenceId });
        }}
        onMouseUp={(event) => {
          const evidenceId = evidenceIdFromInteraction(event);
          if (evidenceId && !blocked) onDispatch({ type: "add-evidence", cardId: view.id, evidenceId });
        }}
      >
        <DeskIcon name="drag" size={18} />拖拽线索到这里，或在卡片中选择“纳入判断”
      </div>
    </main>
  );
}

function MappingRow({ mapping, cardId, local, onDispatch, onReview, busy }: any) {
  const [expanded, setExpanded] = useState(false);
  const review = local.mappingReviews[mapping.id] || mapping.review || "UNREVIEWED";
  const correction = local.corrections[mapping.id] || "";
  return (
    <div className="vos-mapping-row">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span><small>{mapping.kind}</small><strong>{mapping.name}</strong>{mapping.code ? <em>{mapping.code.replace(/^SH|^SZ/, "")}</em> : null}</span>
        <span className={`vos-review-state review-${String(review).toLowerCase()}`}>{translateStatus(review)}</span>
        <DeskIcon name="chevron" size={16} />
      </button>
      {expanded ? <div className="vos-mapping-actions">
        <button type="button" disabled={Boolean(busy)} aria-pressed={review === "APPROVED"} onClick={() => onReview(mapping, "APPROVED")}>批准</button>
        <button type="button" disabled={Boolean(busy)} aria-pressed={review === "REJECTED"} onClick={() => onReview(mapping, "REJECTED")}>驳回</button>
        <label><span>纠正为</span><input value={correction} maxLength={60} disabled={Boolean(busy)} onChange={(event) => onDispatch({ type: "set-correction", cardId, mappingId: mapping.id, value: event.target.value })} /></label>
        <button type="button" disabled={Boolean(busy) || !correction.trim()} onClick={() => onReview(mapping, "CORRECTED", correction)}>确认纠正</button>
      </div> : null}
    </div>
  );
}

function FeedbackSheet({ local }: any) {
  if (local.revealState === "idle") return null;
  if (local.revealState === "loading") return <div className="vos-feedback-sheet" role="status">正在记录揭晓并核对后续结果…</div>;
  const payload = local.feedback;
  const message = cleanDisplayText(
    payload?.message || payload?.summary || payload?.outcome?.summary || payload?.evaluation?.summary,
    local.revealState === "locked" ? "后续结果仍受揭晓状态约束，当前没有可披露内容。" : "已完成核对；当前资料没有形成可展示的后续摘要。",
  );
  return <div className="vos-feedback-sheet" role="status"><strong>{local.revealState === "locked" ? "仍待揭晓" : "后续核对"}</strong><p>{message}</p></div>;
}

function SystemSuggestionPanel({ view, local, onDispatch, blocked = false }: any) {
  const suggestion = view.systemSuggestion;
  const evidence = view.suggestionEvidence || [];
  const counterEvidence = view.counterEvidence || [];
  const invalidationConditions = view.invalidationConditions || [];
  if (!suggestion) {
    return <section className="vos-suggestion-panel is-empty" aria-label="系统预判"><p>系统预判尚未完成，人工研判仍可独立进行。</p></section>;
  }
  return <section className={`vos-suggestion-panel is-${String(suggestion.label || "unknown").toLowerCase()}`} aria-label="系统预判">
    <header>
      <span><DeskIcon name="sparkle" size={15} />{suggestion.sourceText}</span>
      <strong>{suggestion.labelText}</strong>
      <small>仅供复核</small>
    </header>
    <p className="vos-suggestion-rationale">{suggestion.rationale}</p>
    <div className="vos-suggestion-trace">
      <h3>系统预判依据 <span>{evidence.length} 条冻结引用</span></h3>
      {evidence.length ? <ol>{evidence.map((item: any) => {
        const included = local.evidenceIds.includes(item.id);
        return <li key={item.id}>
          <span><small>{item.sourceLabel} · {item.timeLabel}</small>{item.summary}</span>
          <button type="button" disabled={blocked || included} onClick={() => onDispatch({ type: "add-evidence", cardId: view.id, evidenceId: item.id })}>{included ? "已纳入" : "纳入人工判断"}</button>
        </li>;
      })}</ol> : <p className="vos-suggestion-empty">当前预判没有可展示的冻结引用。</p>}
      {!view.suggestionTraceComplete ? <p className="vos-suggestion-warning" role="note">预判引用尚未完整对齐；请先核对中栏冻结证据。</p> : null}
    </div>
    <div className="vos-red-team-monitor">
      <div>
        <h3>反证 <span>{counterEvidence.length}</span></h3>
        {counterEvidence.length ? <ul>{counterEvidence.map((item: string, index: number) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p>暂未识别明确反证</p>}
      </div>
      <div>
        <h3>失效条件 <span>{invalidationConditions.length}</span></h3>
        {invalidationConditions.length ? <ul>{invalidationConditions.map((item: string, index: number) => <li key={`${index}:${item}`}><i>待监控</i>{item}</li>)}</ul> : <p>暂无明确失效条件</p>}
      </div>
    </div>
    {view.versionChange ? <div className="vos-version-change"><strong>版本变化</strong><p>{view.versionChange.summary}</p></div> : null}
    <footer>系统预判不是正式研判，不会自动提交，也不会自动复核映射。</footer>
  </section>;
}

export function DecisionColumn({ view, local, busy, blocked = false, personal = false, publishedReview = false, platform = false, source = "api", autoJudgmentAvailable = true, narration, onDispatch, onAutoJudgment, onCancelAutoJudgment, onNarrate, onSubmit, onMappingReview, onReveal, emptyLabel = "正在准备研判区" }: any) {
  const [modelConsent, setModelConsent] = useState(false);
  if (!view) return <aside className="vos-decision-column"><DeskLoading label={emptyLabel} /></aside>;
  const selectedEvidence = local.evidenceIds.map((id: string) => view.evidence.find((item: any) => item.id === id)).filter(Boolean);
  const theme = view.mappings.find((mapping: any) => mapping.kind === "题材");
  const companies = view.mappings.filter((mapping: any) => mapping.kind === "公司");
  const needsSubmit = local.dirty || !local.committedLabelId;
  const judgmentComplete = Boolean(
    local.label && selectedEvidence.length > 0 && local.note.trim().length >= 6,
  );
  const mutationDisabled = Boolean(busy) || blocked;
  return (
    <aside className="vos-decision-column" aria-label="我的研判">
      <div className="vos-column-title">
        <h2><DeskIcon name="user" />我的研判</h2>
        <div className="vos-judgment-title-actions">
          <button
            className="vos-narration-button"
            type="button"
            disabled={!narration?.supported || mutationDisabled || !view.evidence.length}
            aria-pressed={narration?.active?.key === view.id && narration?.status !== "idle"}
            title="使用本机中文语音朗读当前卷宗；不会发送到外部 TTS"
            onClick={onNarrate}
          >
            <DeskIcon name="volume" size={15} />播报卷宗
          </button>
          <button
            className="vos-auto-judgment-button"
            type="button"
            disabled={!autoJudgmentAvailable || mutationDisabled || !view.evidence.length || local.autoJudgmentState === "loading" || personal && !modelConsent}
            aria-busy={local.autoJudgmentState === "loading" || undefined}
            title={platform ? "使用平台模型起草，消耗1次普通问答额度；不会自动提交或复核映射" : personal ? "使用我的 Host 模型起草；不会自动提交或复核映射" : "使用 DeepSeek 核对当前冻结证据并填充可编辑草稿；不会自动提交或复核映射"}
            onClick={() => {
              if (personal) {
                if (!modelConsent) return;
                setModelConsent(false);
                onAutoJudgment({ modelUseAllowed: true });
              } else onAutoJudgment();
            }}
          >
            <DeskIcon name="sparkle" size={15} />
            {local.autoJudgmentState === "loading" ? "生成中" : "自动研判"}
          </button>
          <button className="vos-icon-button" type="button" title={publishedReview ? "判断与映射复核仅保存到本人账户，并绑定当前原卡版本" : "研判、映射复核和揭晓记录会写入权威账本"} aria-label="查看记录说明"><DeskIcon name="help" /></button>
        </div>
      </div>
      <div className="vos-prototype-notice" role="note">{publishedReview ? "个人研判 · 保存到本人账户，绑定原卡版本；映射独立复核，不修改业主原卡。" : personal
        ? "个人工作台 · 提交只写个人账本，映射仍需逐项独立复核"
        : "正式工作台 · 提交会写入权威账本，映射仍需逐项独立复核"}</div>
      {personal && autoJudgmentAvailable ? <label className="vos-judgment-consent"><input type="checkbox" checked={modelConsent}
        disabled={mutationDisabled} onChange={event => setModelConsent(event.target.checked)} />{platform ? "允许本次使用平台模型起草研判，消耗1次普通问答额度" : source === "ima"
          ? "允许本次将所选 IMA 正文发送给我的 Host 模型起草研判"
          : "允许本次将当前卡片授权证据发送给我的 Host 模型起草研判"}</label> : null}
      {local.autoJudgmentState === "loading" ? <div className="vos-auto-judgment-status is-loading" role="status"><i /><span>{personal ? "我的 Host 模型" : "DeepSeek"} 正在逐条核对冻结引用并起草判断…</span>{personal
        ? <button type="button" onClick={onCancelAutoJudgment} aria-label="取消研判草稿"><DeskIcon name="close" size={15} />取消</button> : null}</div> : null}
      {local.autoJudgmentState === "ready" || local.autoJudgmentState === "edited" ? <div className="vos-auto-judgment-status is-ready" role="note"><DeskIcon name="sparkle" size={14} /><span><strong>{local.autoJudgmentModel || "DeepSeek"}</strong> 已填充{local.autoJudgmentState === "edited" ? "，你已手动调整" : ""} · 仅填充草稿，未提交</span></div> : null}
      {local.autoJudgmentState === "error" ? <div className="vos-auto-judgment-status is-error" role="alert"><span>{local.autoJudgmentError}</span></div> : null}
      <SystemSuggestionPanel view={view} local={local} onDispatch={onDispatch} blocked={mutationDisabled} />
      <div className="vos-label-grid" role="group" aria-label="变量判断">
        {LABELS.map((item) => <button key={item.id} className={`vos-label-choice label-${item.id.toLowerCase()} ${local.label === item.id ? "is-selected" : ""}`} type="button" disabled={mutationDisabled} aria-pressed={local.label === item.id} onClick={() => onDispatch({ type: "set-label", cardId: view.id, label: item.id })}><DeskIcon name={item.icon as any} size={25} /><strong>{item.label}</strong><small>{item.detail}</small></button>)}
      </div>
      <section
        className="vos-notebook"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const evidenceId = evidenceIdFromInteraction(event);
          if (evidenceId && !mutationDisabled) onDispatch({ type: "add-evidence", cardId: view.id, evidenceId });
        }}
        onMouseUp={(event) => {
          const evidenceId = evidenceIdFromInteraction(event);
          if (evidenceId && !mutationDisabled) onDispatch({ type: "add-evidence", cardId: view.id, evidenceId });
        }}
      >
        <h3>判断依据</h3>
        {selectedEvidence.length ? <ol>{selectedEvidence.map((item: any) => <li key={item.id}><span>{item.summary}</span><button type="button" aria-label={`移除${item.label}`} disabled={mutationDisabled} onClick={() => onDispatch({ type: "remove-evidence", cardId: view.id, evidenceId: item.id })}>×</button></li>)}</ol> : <p className="vos-notebook-empty">把中栏证据纳入这里，形成可回看的判断链。</p>}
        <label htmlFor={`vos-note-${view.id}`}>研判说明</label>
        <textarea id={`vos-note-${view.id}`} value={local.note} maxLength={300} disabled={mutationDisabled} placeholder="记录为什么继续观察，以及还缺哪条验证…" onChange={(event) => onDispatch({ type: "set-note", cardId: view.id, note: event.target.value })} />
        <span className="vos-char-count">{local.note.length}/300</span>
        {needsSubmit && !judgmentComplete ? <p className="vos-judgment-gate" role="note">{local.needsCompletion ? "历史研判缺少完整依据；请补入至少 1 条证据和不少于 6 字的说明后重新提交。" : "提交前需选择判断、纳入至少 1 条证据，并填写不少于 6 字的说明。"}</p> : null}
      </section>
      <section className="vos-mapping-panel">
        <div className="vos-subsection-title"><h3>映射复核</h3><span>逐项独立</span></div>
        <div className="vos-mapping-list">{(publishedReview ? view.mappings.filter((m:any)=>m.kind === "题材") : theme ? [theme] : []).map((mapping:any)=><MappingRow key={mapping.id} mapping={mapping} cardId={view.id} local={local} onDispatch={onDispatch} onReview={onMappingReview} busy={mutationDisabled} />)}{companies.map((mapping: any) => <MappingRow key={mapping.id} mapping={mapping} cardId={view.id} local={local} onDispatch={onDispatch} onReview={onMappingReview} busy={mutationDisabled} />)}</div>
        {!companies.length ? <div className="vos-paper-empty compact">当前卷宗没有公司映射。</div> : null}
      </section>
      <button className="vos-reveal-button" type="button" disabled={mutationDisabled || (publishedReview ? !needsSubmit || !judgmentComplete : needsSubmit ? !judgmentComplete : !local.canReveal) || local.revealState === "loading"} onClick={publishedReview || needsSubmit ? onSubmit : onReveal}>{publishedReview ? "保存个人研判" : needsSubmit ? local.submitState === "submitting" ? "正在提交正式研判" : "提交正式研判" : "揭示后续结果"}<span className="vos-button-seal"><DeskIcon name="seal" size={23} /></span></button>
      <FeedbackSheet local={local} />
    </aside>
  );
}

export function RecordEditor({ view, local, onDispatch, onClose, dialogRef, blocked = false }: any) {
  const selected = local.evidenceIds.map((id: string) => view.evidence.find((item: any) => item.id === id)).filter(Boolean);
  return <div className="vos-record-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="vos-record-editor" role="dialog" aria-modal="true" aria-labelledby="vos-record-title">
      <header><div><span>正式研判记录</span><h2 id="vos-record-title">判断依据编排</h2></div><button className="vos-icon-button" type="button" aria-label="关闭编辑记录" onClick={onClose}><DeskIcon name="close" /></button></header>
      <p>这里整理的是提交草稿；点击“提交正式研判”后，依据和说明会一同写入权威账本。</p>
      <ol className="vos-editor-list">{selected.map((item: any, index: number) => <li key={item.id}><DeskIcon name="drag" size={17} /><span><small>{item.sourceLabel}</small>{item.summary}</span><div><button type="button" disabled={blocked || index === 0} aria-label="上移" onClick={() => onDispatch({ type: "move-evidence", cardId: view.id, evidenceId: item.id, toIndex: index - 1 })}>↑</button><button type="button" disabled={blocked || index === selected.length - 1} aria-label="下移" onClick={() => onDispatch({ type: "move-evidence", cardId: view.id, evidenceId: item.id, toIndex: index + 1 })}>↓</button><button type="button" disabled={blocked} aria-label="移除" onClick={() => onDispatch({ type: "remove-evidence", cardId: view.id, evidenceId: item.id })}>×</button></div></li>)}</ol>
      {!selected.length ? <div className="vos-paper-empty">先从证据卡中选择判断依据。</div> : null}
      <label htmlFor={`vos-editor-note-${view.id}`}>研判说明</label>
      <textarea id={`vos-editor-note-${view.id}`} value={local.note} maxLength={300} disabled={blocked} onChange={(event) => onDispatch({ type: "set-note", cardId: view.id, note: event.target.value })} />
      <footer><span>{local.note.length}/300</span><button className="vos-paper-button primary" type="button" onClick={onClose}>完成编排</button></footer>
    </section>
  </div>;
}

export function DeskLoading({ label }: { label: string }) {
  return <div className="vos-desk-loading" role="status" aria-busy="true"><span /><span /><span /><p>{label}</p></div>;
}

const scoreLabels: Record<string, string> = {
  evidenceStrength: "证据强度", novelty: "新颖性", timeSensitivity: "时效性",
  tradabilityConfidence: "可交易性", mappingConfidence: "映射强度",
};
function Lines({ title, items }: { title: string; items: string[] }) {
  return <div><h4>{title}</h4>{items.length
    ? <ul>{items.map((value, index) => <li key={index}>{value}</li>)}</ul>
    : <p>业主未提供</p>}</div>;
}

// The Host validates the approved payload; this view neither infers missing
// fields nor fetches source bodies, links or model output during rendering.
export function PublishedCardDetails({ card, publication }: any) {
  if (!card) return null;
  if (card.schema === 'published-card-v3') return <section className="vos-published-card" aria-label="业主发布原卡">
    <header><h3>业主发布原卡 · 人工原卡</h3><small>第 {card.revision} 版 · 只读同步</small></header>
    <p>以下为作者填写的原文。证据与出处未在此独立核验；未生成模型建议或评分。</p>
    {Object.entries({title:'卡片标题',summary:'事件摘要',thesis:'变量逻辑',evidence:'证据与出处（作者填写）',counterEvidence:'反证与未知',invalidation:'失效条件',horizon:'观察期限',themes:'题材与标的（作者填写）'}).map(([key,label])=><div key={key}><h4>{label}</h4><p style={{whiteSpace:'pre-wrap'}}>{card.authorship.content[key]||'未填写'}</p></div>)}
    <details><summary>版本与证据来源</summary><dl>
      <dt>变量 ID</dt><dd>{card.variableId}</dd><dt>原卡版本 ID</dt><dd>{card.cardRevisionId}</dd>
      <dt>上一版 ID</dt><dd>{card.previousCardRevisionId||'无'}</dd><dt>发布哈希</dt><dd>{publication.contentHash}</dd>
      <dt>信源集 / 版本</dt><dd>{publication.datasetId} / {publication.datasetVersion}</dd>
      <dt>手动原稿 ID / 版本</dt><dd>{card.authorship.id} / {card.authorship.version} / {card.authorship.revision}</dd>
      <dt>原稿哈希</dt><dd>{card.authorship.contentHash}</dd><dt>创建时间</dt><dd>{card.authorship.createdAt}</dd>
      <dt>原稿修改时间</dt><dd>{card.authorship.updatedAt}</dd><dt>发布时间</dt><dd>{card.systemDecisionAt}</dd>
    </dl></details>
  </section>;
  return <section className="vos-published-card" aria-label="业主发布原卡">
    <header><h3>业主发布原卡</h3><small>第 {card.revision} 版 · 只读同步</small></header>
    {["published-card-v2", "published-card-v4"].includes(card.schema) ? <p>业主展示分级：{card.presentation.tier === "MUST_REVIEW" ? "必须复核" : "候选池"}</p> : null}
    <h4>事件摘要</h4><p>{card.eventSummary}</p>
    <h4>变量逻辑</h4><p>{card.variableThesis || "业主未提供"}</p>
    <h4>事前预期差</h4><p>{card.expectationGap || "业主未提供"}</p>
    <h4>可交易性</h4><p>{card.whyTradable || "业主未提供"}</p>
    <p>预期周期：{card.expectedHorizon || "业主未提供"} · 与前版关系：{card.relationToPrior || "业主未提供"}</p>
    <Lines title="反证" items={card.counterEvidence} />
    <Lines title="未知项" items={card.uncertainties} />
    <Lines title="失效条件" items={card.invalidationConditions} />
    {card.systemSuggestion ? <><h4>业主系统建议 · {translateStatus(card.systemSuggestion.label)}</h4>
    <p>{card.systemSuggestion.rationale}</p>
    <small>来自业主{card.systemSuggestion.basis === "MODEL" ? "模型" : "规则"}，仅供复核。</small></> : <p>原卡未记录系统建议。</p>}
    <h4>题材与映射</h4>
    {card.themes.map((row: any) => <p key={row.id}>{row.narrative}</p>)}
    {card.mappings.map((row: any) => <p key={row.id}><strong>{row.securityName || row.securityCode}（{row.securityCode}）</strong>：{row.thesis}</p>)}
    {!card.themes.length && !card.mappings.length ? <p>业主未提供</p> : null}
    <details>
      <summary>版本与证据来源</summary>
      <dl>
        {["published-card-v2", "published-card-v4"].includes(card.schema) ? <>
          <dt>展示决策 ID / 哈希</dt><dd>{card.presentation.id} / {card.presentation.recordHash}</dd>
          <dt>展示决策时间 / 策略</dt><dd>{card.presentation.decisionAt} / {card.presentation.policyVersion}</dd>
        </> : null}
        <dt>变量 ID</dt><dd>{card.variableId}</dd>
        <dt>原卡版本 ID</dt><dd>{card.cardRevisionId}</dd>
        {card.nativeCardRecordHash ? <><dt>原卡记录哈希</dt><dd>{card.nativeCardRecordHash}</dd></> : null}
        <dt>上一版 ID</dt><dd>{card.previousCardRevisionId || "无"}</dd>
        <dt>发布哈希</dt><dd>{publication.contentHash}</dd>
        <dt>信源集 / 版本</dt><dd>{publication.datasetId} / {publication.datasetVersion}</dd>
        <dt>首次发现</dt><dd>{card.firstDetectedAt}</dd>
        <dt>业主决策时间</dt><dd>{card.systemDecisionAt}</dd>
        <dt>模型 / 提示版本</dt><dd>{card.modelVersion} / {card.promptVersion}</dd>
        {card.systemSuggestion ? <><dt>建议生成时间</dt><dd>{card.systemSuggestion.suggestedAt}</dd>
        <dt>建议模型 / 提示版本</dt><dd>{card.systemSuggestion.modelVersion} / {card.systemSuggestion.promptVersion}</dd>
        <dt>建议引用</dt><dd>{card.systemSuggestion.evidenceIds.join("、")}</dd></> : null}
      </dl>
      <h4>业主结构评分（0—1）</h4>
      <dl>{Object.entries(scoreLabels).map(([key, label]) => <React.Fragment key={key}>
        <dt>{label}</dt><dd>{card.scoreComponents[key]}</dd>
      </React.Fragment>)}</dl>
      {card.evidence.map((row: any) => <section key={row.id} aria-label={`证据 ${row.id}`}>
        <h4>{row.id}</h4><blockquote>{row.quote}</blockquote>
        <dl>
          <dt>来源记录 ID</dt><dd>{row.sourceItemId}</dd>
          {row.retrievalRef ? <><dt>原引用编号</dt><dd>{row.retrievalRef}</dd></> : null}
          <dt>来源记录哈希</dt><dd>{row.sourceRecordHash}</dd>
          <dt>证据内容哈希</dt><dd>{row.contentHash}</dd>
          <dt>角色 / 级别</dt><dd>{row.role} / {row.evidenceLevel}</dd>
          <dt>可得时间</dt><dd>{row.availableAt}</dd>
          <dt>记录时间</dt><dd>{row.recordedAt}</dd>
        </dl>
      </section>)}
      {card.themes.map((row: any) => <p key={row.id}>题材 {row.id} / {row.themeRef} · 引用：{row.evidenceIds.join("、")}</p>)}
      {card.mappings.map((row: any) => <p key={row.id}>映射 {row.id} · 引用：{row.evidenceIds.join("、")}</p>)}
    </details>
  </section>;
}
