// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useState } from "react";
import { WATCH_SOURCES, WATCH_PRIORITIES } from "../../../src/runtime/harness-research-host-watch.mjs";

const time = (value: any) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知";
const statusLabel: Record<string, string> = { active: "关注中", paused: "已暂停", cancelled: "已取消", expired: "已到期" };

export function ResearchHostWatchPanel({ snapshot, blocked, busy, autoNarration, speechReady, speechSupported, onUnlockSpeech, onCreate, onStatus, onDismissDraft, onClearEnded, onOpenCard, onSpeak }: any) {
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("all");
  const [priority, setPriority] = useState("quiet");
  const [durationHours, setDuration] = useState(4);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!snapshot.draft) return;
    setTopic(snapshot.draft.topic); setSource(snapshot.draft.source);
    setPriority(snapshot.draft.priority); setDuration(snapshot.draft.durationHours);
    setMessage("小美已准备草案，尚未启用。请核对后确认。");
  }, [snapshot.draft]);
  const tasks = snapshot.state.tasks;
  const active = tasks.filter((t: any) => t.status === "active");
  const alerts = [...snapshot.state.alerts].reverse().slice(0, 10);
  return <section className="vos-watch-panel" aria-label="小美关注任务">
    <header><strong>小美 · 关注任务</strong><span>{active.length} 项关注中</span></header>
    <p>只订阅已入库雷达的新卡与新证据，切卡不改变关注范围。任务保存在本标签页，刷新可恢复；页面关闭不执行，关闭标签页后不保证保留。恢复时只核对雷达保留条目。提醒不等于投资建议。</p>
    <form onSubmit={async e => {
      e.preventDefault();
      if (await onCreate({ topic, source, priority, durationHours })) {
        setMessage(`已保存“${topic === "*" ? "全部主题" : topic}”关注任务；现有雷达作为起点，不重复播历史卡片。`);
        setTopic(""); onDismissDraft();
      }
    }}>
      <label>关注主题<input value={topic} maxLength={80} required placeholder="例如：机器人；全部主题输入 *；多词须同时匹配" onChange={e => setTopic(e.target.value)} /></label>
      <label>来源<select value={source} onChange={e => setSource(e.target.value)}>{Object.entries(WATCH_SOURCES).map(([key, label]) => <option value={key} key={key}>{String(label)}</option>)}</select></label>
      <label>提醒方式<select value={priority} onChange={e => setPriority(e.target.value)}>{Object.entries(WATCH_PRIORITIES).map(([key, label]) => <option value={key} key={key}>{String(label)}</option>)}</select></label>
      <label>持续小时<input type="number" min={1} max={24} step={1} value={durationHours} required onChange={e => setDuration(Number(e.target.value))} /></label>
      <button type="submit" disabled={blocked || !topic.trim()}>确认启用关注</button>
      {snapshot.draft ? <button type="button" onClick={() => { onDismissDraft(); setTopic(""); setMessage("已放弃关注草案，未启用。"); }}>放弃草案</button> : null}
    </form>
    {blocked ? <p role="status">等待完整雷达快照；新关注与提醒暂不可用。</p> : null}
    {snapshot.error ? <p role="alert">{snapshot.error}</p> : <p role="status">{message}</p>}
    {autoNarration ? <p>当前已开启全雷达自动播报，关注提醒仅显示在这里，避免双重播报。</p> : null}
    {!autoNarration && active.some((t: any) => t.priority !== "quiet") && !speechReady ? <p>刷新后请点击恢复本页短播。<button type="button" disabled={!speechSupported} onClick={onUnlockSpeech}>启用关注短播</button>{!speechSupported ? "当前没有可用语音，将仅显示页面提醒。" : ""}</p> : null}
    <ul className="vos-watch-tasks">{tasks.map((task: any) => <li key={task.id}>
      <div><strong>{task.topic === "*" ? "全部主题" : task.topic}</strong><span>{statusLabel[task.status]} · {WATCH_SOURCES[task.source]} · {WATCH_PRIORITIES[task.priority]}</span><small>截至 {time(task.expiresAt)}（上海时间）{task.issue ? ` · ${task.issue}` : ""}</small></div>
      <div className="vos-watch-actions">{["active", "paused"].includes(task.status) ? <>
        <button type="button" disabled={Boolean(task.issue)} onClick={() => onStatus(task.id, task.status === "active" ? "paused" : "active")}>{task.status === "active" ? "暂停" : "恢复"}</button>
        <button type="button" onClick={() => onStatus(task.id, "cancelled")}>取消任务</button>
      </> : null}</div>
    </li>)}</ul>
    {tasks.some((t: any) => ["cancelled", "expired"].includes(t.status)) ? <button type="button" onClick={onClearEnded}>清理已结束任务及其提醒</button> : null}
    {alerts.length ? <details className="vos-watch-alerts" open><summary>关注动态 · 最近 {alerts.length} 条</summary><ol>{alerts.map((a: any) => <li key={a.id}>
      <strong>{a.level === "priority" ? "优先复核" : "资料更新"}</strong><p>{a.summary}</p>
      <small>{time(a.createdAt)} · {a.speechStatus === "queued" ? "已交给播报队列（不代表已听到）" : a.speechStatus === "pending" ? "待空闲时短播" : "仅页面提醒"}</small>
      <div className="vos-watch-actions"><button type="button" disabled={blocked} onClick={() => onOpenCard(a.cardId)}>打开对应卡片</button><button type="button" disabled={busy || blocked || !speechSupported} onClick={() => setMessage(onSpeak(a) ? "这条提醒已交给本机播报队列。" : "当前正在对话或播报，请稍后重试。")}>播报这条</button></div>
      <details><summary>证据与时间回执</summary><dl>
        <dt>变量 / 催化</dt><dd>{a.trace.variableId || "未知"} / {a.trace.catalystIdentityKey || "未知"}</dd>
        <dt>版本 / 水位</dt><dd>{a.trace.revision} / {a.trace.watermark || "未知"}</dd>
        <dt>资料 / 扫描时间</dt><dd>{time(a.trace.materialAt)} / {time(a.trace.scannedAt)}</dd>
        <dt>证据哈希</dt><dd>{a.trace.evidenceHashes.join(" · ") || "未知"}</dd>
      </dl></details>
    </li>)}</ol></details> : <small>没有新的匹配变化时保持安静。</small>}
  </section>;
}
