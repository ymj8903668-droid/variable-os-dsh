// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createDeskLayoutState, deskLayoutGeometry, deskLayoutPreference, deskLayoutReducer } from './desk-layout-state.mjs';

const PREFERENCE_KEY = 'variable-desk-layout-v1';
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]';
function readPreference(width: number) {
  try { return createDeskLayoutState(JSON.parse(window.sessionStorage.getItem(PREFERENCE_KEY) || 'null'), width); }
  catch { return createDeskLayoutState(null, width); }
}

export function DeskLayout({ radar, workspace, details, decision, reference, onClearReference, referenceRequired = false,
  readingFirst = false, readingScope, readingContent, request, versionNotice, pending = { count: 0 }, onShowAgentApproval, onShowWatchDraft, initialWidth = 1440 }: any) {
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const focusReading = useRef(false);
  const drawerRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const hadPreference = useRef<boolean | null>(null);
  if (hadPreference.current === null) {
    try { hadPreference.current = Boolean(window.sessionStorage.getItem(PREFERENCE_KEY)); }
    catch { hadPreference.current = false; }
  }
  const [measured, setMeasured] = useState(false);
  const [width, setWidth] = useState(initialWidth);
  const [layout, dispatch] = useReducer(deskLayoutReducer, initialWidth, readPreference);
  const [preferenceError, setPreferenceError] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  // Published cards start in reading mode even if a prior local workspace
  // saved research as its layout preference. Research remains an explicit opt-in.
  const [researchOptIn, setResearchOptIn] = useState(false);
  const mode = readingFirst ? researchOptIn ? 'research' : 'intraday' : layout.mode;
  const reading = readingFirst && mode === 'intraday';
  const geometry = deskLayoutGeometry(layout, width);
  const research = mode === 'research' && geometry.docked;
  const drawerOpen = !reading && (layout.drawer.open || research);
  const overlay = drawerOpen && !geometry.docked && !research;
  const listOverlay = geometry.listOverlay && layout.leftOpen;
  const act = (action: any) => dispatch({ ...action, width: action.width ?? width });
  const open = (purpose: string) => {
    if (reading && purpose === 'details') {
      focusReading.current = true;
      act({ type: 'read-card' });
      return;
    }
    returnFocus.current = document.activeElement as HTMLElement;
    act({ type: 'open-drawer', purpose });
  };
  const close = () => {
    act({ type: 'close-drawer' });
    window.requestAnimationFrame(() => {
      const target = returnFocus.current?.isConnected && returnFocus.current.getClientRects().length && !returnFocus.current.closest('[inert]') ? returnFocus.current : rootRef.current?.querySelector<HTMLElement>('.vos-home-rail-toggle');
      target?.focus();
    });
  };
  const closeRail = () => {
    act({ type: 'toggle-left' });
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.vos-home-rail-toggle')?.focus());
  };
  useEffect(() => {
    if (!rootRef.current) return;
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      const actual = entry.contentRect.width;
      setWidth(actual);
      dispatch({ type: 'measure', width: actual, hasPreference: first ? hadPreference.current : true });
      setMeasured(true);
      first = false;
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!measured) return;
    try { window.sessionStorage.setItem(PREFERENCE_KEY, JSON.stringify(deskLayoutPreference(layout))); setPreferenceError(false); }
    catch { setPreferenceError(true); }
  }, [measured, layout.mode, layout.leftOpen, layout.leftWidth]);
  useEffect(() => { setResearchOptIn(false); }, [readingFirst, readingScope]);
  useEffect(() => { if (request) open(request.purpose); }, [request]);
  useEffect(() => {
    if (!focusReading.current || !reading || listOverlay) return;
    focusReading.current = false;
    workspaceRef.current?.focus();
  }, [layout, reading, listOverlay]);
  useEffect(() => {
    if (!layout.drawer.open) return;
    drawerRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [layout.drawer.open, overlay]);
  useEffect(() => {
    if (listOverlay) railRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [listOverlay]);
  const drawerKeys = (event: React.KeyboardEvent, region: HTMLElement | null, modal: boolean) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const target = event.target as HTMLElement;
    if (target.closest('[role="dialog"],[role="alertdialog"]') !== region && target.closest('[role="dialog"],[role="alertdialog"]')) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (region === railRef.current) closeRail();
      else close();
    }
    if (event.key !== 'Tab' || !modal || !region) return;
    const controls = [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(node => node.getClientRects().length);
    const targetNode = event.shiftKey ? controls.at(-1) : controls[0];
    if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
      event.preventDefault(); targetNode?.focus();
    }
  };
  return <div ref={rootRef} className={`vos-home-layout${research ? ' is-research' : ''}${overlay ? ' has-overlay' : ''}${listOverlay ? ' has-list-overlay' : ''}`}
    data-mode={reading ? 'reading' : mode} style={{ '--desk-rail': `${geometry.railWidth}px`, '--desk-drawer': `${geometry.drawerWidth}px` } as React.CSSProperties}>
    <nav className="vos-home-toolbar" aria-label="工作台布局" {...(overlay || listOverlay ? { inert: '' } : {})}>
      <button className="vos-home-rail-toggle" type="button" aria-label={layout.leftOpen ? '收起卡片栏' : '展开卡片栏'} aria-expanded={layout.leftOpen}
        onClick={() => act({ type: 'toggle-left' })}>☰ 卡片</button>
      <div role="group" aria-label="工作模式">{[['intraday', readingFirst ? '卡片阅读' : '盘中模式'], ['research', readingFirst ? '个人研究（可选）' : '研究模式']].map(([next, title]) =>
        <button key={next} type="button" aria-pressed={mode === next} onClick={() => {
          if (readingFirst) { setResearchOptIn(next === 'research'); act({ type: 'close-drawer' }); }
          else act({ type: 'set-mode', mode: next });
        }}>{title}</button>)}</div>
      <button hidden={reading} type="button" onClick={() => open(details ? 'details' : 'decision')}>{details ? '查看详情' : '查看研判'}</button>
      <button hidden={reading} type="button" onClick={() => open('decision')}>研判与映射</button>
      <button hidden={reading} type="button" aria-expanded={pendingOpen} title="仅当前卡片与当前会话，不是全局待复核卡片数" onClick={() => setPendingOpen(!pendingOpen)}>待你确认 {pending.count}</button>
      <div className="vos-home-pending" hidden={reading || !pendingOpen} role="region" aria-label="当前待确认事项">
        <small>仅当前卡片与当前会话</small>
        {pending.draft ? <button type="button" onClick={() => { open('decision'); setPendingOpen(false); }}>查看当前卡片草稿</button> : null}
        {pending.agent ? <button type="button" onClick={() => { onShowAgentApproval?.(); setPendingOpen(false); }}>查看 Agent 确认</button> : null}
        {pending.watch ? <button type="button" onClick={() => { onShowWatchDraft?.(); setPendingOpen(false); }}>查看关注草案</button> : null}
        {!pending.count ? <span>当前范围没有待确认事项</span> : null}
      </div>
      {preferenceError ? <small role="status">布局偏好未保存；当前操作仍可用</small> : null}
    </nav>
    {mode === 'research' && !research ? <small className="vos-home-narrow-note">当前容器较窄：保留研究功能，详情按需展开。</small> : null}
    <div className={`vos-home-grid${geometry.docked && drawerOpen ? ' is-docked' : ''}`}>
      <aside ref={railRef} className="vos-home-rail" hidden={!layout.leftOpen} {...(overlay ? { inert: '' } : {})} role={listOverlay ? 'dialog' : 'region'} aria-modal={listOverlay || undefined} aria-label="卡片栏"
        onKeyDown={event => drawerKeys(event, railRef.current, listOverlay)}>
        <div className="vos-home-rail-tools"><label>宽度<input aria-label="卡片栏宽度" type="range" min="280" max="440" step="10" value={layout.leftWidth} onChange={event => act({ type: 'resize-left', width: Number(event.target.value) })} /></label>
          <button type="button" aria-label="收起卡片列表" onClick={closeRail}>收起</button></div>
        {radar}
      </aside>
      <div className="vos-home-rail-stub" {...(overlay || listOverlay ? { inert: '' } : {})} hidden={layout.leftOpen && !geometry.listOverlay}><button type="button" onClick={() => act({ type: 'toggle-left' })}>卡片列表</button></div>
      <main ref={workspaceRef} tabIndex={reading ? -1 : undefined} className="vos-home-workspace" {...(overlay || listOverlay ? { inert: '' } : {})} aria-label={reading ? "业主原卡阅读区" : "小美全局工作区"}>
        <div className="vos-home-reference">{reference ? <><span>{reading ? '正在阅读' : '当前参考'}：{reference.title} · 第 {reference.revision || 1} 版</span><button hidden={reading} type="button" aria-label={referenceRequired ? "清除参考并结束当前卡片对话" : "清除参考，不清空对话"} onClick={onClearReference}>× 清除</button></> : <span>{reading ? "选择卡片阅读业主原文，无需配置模型。" : referenceRequired ? "当前卡片工作区 · 尚未选择参考卡片" : "全局工作区 · 无需先选卡，直接交代任务"}</span>}</div>
        {versionNotice}
        {reading ? <div className="vos-home-details vos-home-reading">{readingContent ?? details}</div> : null}
        <div className="vos-home-assistant" hidden={reading}>{workspace}</div>
      </main>
      <section ref={drawerRef} className="vos-home-drawer" hidden={!drawerOpen} role={geometry.docked || research ? 'region' : 'dialog'} aria-modal={!geometry.docked && !research || undefined}
        aria-label="详情与研判抽屉" onKeyDown={event => drawerKeys(event, drawerRef.current, overlay)}>
        <header className="vos-home-drawer-header"><div><strong>{reference?.title || '全局工作区'}</strong><small>{reference ? `第 ${reference.revision || 1} 版 · ${reference.time || '资料时间见卷宗'}` : '选择卡片后查看证据与研判'}</small></div>
          <button type="button" aria-label="关闭详情抽屉" onClick={close}>关闭</button>
          <div role="group" aria-label="抽屉用途">{details ? <button type="button" aria-pressed={layout.drawer.purpose === 'details'} onClick={() => act({ type: 'open-drawer', purpose: 'details' })}>详情与证据</button> : null}
            <button type="button" aria-pressed={layout.drawer.purpose === 'decision'} onClick={() => act({ type: 'open-drawer', purpose: 'decision' })}>研判与映射</button></div>
        </header>
        <div className="vos-home-details" hidden={!research && layout.drawer.purpose !== 'details'}>{reading ? null : details}</div>
        <div className="vos-home-decision" hidden={!research && details && layout.drawer.purpose !== 'decision'}>{decision}</div>
      </section>
    </div>
  </div>;
}
