// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
// Browser-local advisory state, never an authority ledger or a background worker.
export const WATCH_SOURCES = Object.freeze({
  all: "全部信源", wechat: "微信", expert: "专家会议", research: "晨晚报",
});
export const WATCH_PRIORITIES = Object.freeze({
  quiet: "仅页面提醒", material: "新卡和新证据短播", priority: "仅优先复核短播",
});
const SCHEMA = "xiaomei-watch-v1";
const MAX_TASKS = 20;
const MAX_SEEN = 2000;
const MAX_HASHES = 256;
const text = (v, n = 240) => typeof v === "string" ? v.replace(/[\p{Cf}\u0000-\u001f]/gu, " ").trim().slice(0, n) : "";
const instant = v => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
const hashes = v => [...new Set((Array.isArray(v) ? v : []).filter(h => typeof h === "string" && /^[a-f0-9]{64}$/u.test(h)))].sort();
const revision = v => Number.isSafeInteger(v) && v > 0 ? v : 1;
const statuses = new Set(["active", "paused", "cancelled", "expired"]);

export function normalizeWatchDraft(value) {
  const topic = text(value?.topic, 81);
  const source = value?.source ?? "all";
  const priority = value?.priority ?? "quiet";
  const durationHours = value?.durationHours ?? 4;
  if (!topic || topic.length > 80 || !Object.hasOwn(WATCH_SOURCES, source)
    || !Object.hasOwn(WATCH_PRIORITIES, priority)
    || !Number.isInteger(durationHours) || durationHours < 1 || durationHours > 24) {
    throw new Error("WATCH_DRAFT_INVALID：主题1–80字，时长1–24小时，须使用受支持的来源与提醒方式");
  }
  return { topic, source, priority, durationHours };
}

function normalizeEntry(e) {
  const cardId = text(e?.cardId);
  const variableId = text(e?.variableId);
  const catalystIdentityKey = text(e?.catalystIdentityKey);
  if (!cardId || !(catalystIdentityKey || variableId)) return null;
  return { cardId, title: text(e.title) || "待复核变量", variableId, catalystIdentityKey,
    key: catalystIdentityKey ? `catalyst:${catalystIdentityKey}` : `variable:${variableId}`,
    revision: revision(e.revision), evidenceHashes: hashes(e.evidenceHashes),
    searchText: text(e.searchText || e.title, 2000).toLocaleLowerCase("zh-CN"),
    sourceNamespaces: [...new Set((Array.isArray(e.sourceNamespaces) ? e.sourceNamespaces : []).map(s => text(s, 80)))],
    tier: e.tier === "MUST_REVIEW" ? "MUST_REVIEW" : "NORMAL",
    watermark: text(e.watermark, 256) || null, materialAt: instant(e.materialAt), scannedAt: instant(e.scannedAt) };
}

function mainlines(entries) {
  const map = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const e = normalizeEntry(raw);
    if (!e) continue;
    const prior = map.get(e.key);
    if (prior) {
      const winner = prior.revision > e.revision ? prior : e;
      map.set(e.key, { ...winner, evidenceHashes: hashes([...prior.evidenceHashes, ...e.evidenceHashes]),
        searchText: `${prior.searchText} ${e.searchText}`.slice(0, 4000),
        sourceNamespaces: [...new Set([...prior.sourceNamespaces, ...e.sourceNamespaces])] });
    } else map.set(e.key, e);
  }
  return [...map.values()];
}

function matches(task, e) {
  const sources = { wechat: ["local.wechat"], expert: ["local.gangtise", "local.liudu"],
    research: ["local.morning-review", "local.evening-review"] };
  return (task.source === "all" || sources[task.source]?.some(s => e.sourceNamespaces.includes(s)))
    && (task.topic === "*" || task.topic.toLocaleLowerCase("zh-CN").split(/\s+/u).every(t => e.searchText.includes(t)));
}

function alertFrom(e, taskIds, kind, id, createdAt, speechStatus) {
  const level = e.tier === "MUST_REVIEW" ? "priority" : "material";
  return { id, cardId: e.cardId, title: e.title, taskIds, kind, level, createdAt, speechStatus,
    summary: `${kind === "new-card" ? "新入库卡片" : "同催化新增证据"}：${e.title}。${level === "priority" ? "系统标为优先复核；" : ""}仅供人工复核，不代表买入机会。`,
    trace: { variableId: e.variableId, catalystIdentityKey: e.catalystIdentityKey, revision: e.revision,
      evidenceHashes: e.evidenceHashes, watermark: e.watermark, materialAt: e.materialAt, scannedAt: e.scannedAt } };
}

export function createWatchState(saved) {
  const state = { schema: SCHEMA, tasks: [], alerts: [], sequence: 0 };
  if (saved?.schema !== SCHEMA) return state;
  state.sequence = Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 ? saved.sequence : 0;
  for (const t of (Array.isArray(saved.tasks) ? saved.tasks : []).slice(0, MAX_TASKS)) {
    try {
      const draft = normalizeWatchDraft(t);
      if (!text(t.id, 100) || state.tasks.some(task => task.id === t.id) || !statuses.has(t.status)
        || !Number.isFinite(t.createdAt) || !Number.isFinite(t.expiresAt) || t.expiresAt <= t.createdAt
        || t.expiresAt > t.createdAt + 24 * 3600000 || !Array.isArray(t.seen)) continue;
      const seen = t.seen.filter(e => typeof e?.key === "string" && e.key.length <= 260
        && Number.isSafeInteger(e.revision) && Array.isArray(e.hashes));
      const invalid = seen.length !== t.seen.length || seen.length > MAX_SEEN
        || new Set(seen.map(e => e.key)).size !== seen.length
        || seen.some(e => e.hashes.length > MAX_HASHES || hashes(e.hashes).length !== e.hashes.length);
      state.tasks.push({ id: text(t.id, 100), ...draft, status: invalid ? "paused" : t.status,
        createdAt: t.createdAt, expiresAt: t.expiresAt, seen: invalid ? [] : seen.map(e => ({ key: e.key, revision: e.revision, hashes: hashes(e.hashes) })),
        issue: invalid ? "去重记录异常，已暂停，请重新创建关注" : text(t.issue, 100) });
    } catch { /* Malformed local data cannot activate a task. */ }
  }
  for (const a of (Array.isArray(saved.alerts) ? saved.alerts : []).slice(-60)) {
    const e = normalizeEntry({ ...a.trace, cardId: a.cardId, title: a.title, tier: a.level === "priority" ? "MUST_REVIEW" : "NORMAL" });
    const taskIds = (Array.isArray(a.taskIds) ? a.taskIds : []).filter(id => state.tasks.some(t => t.id === id));
    if (!e || !text(a.id, 100) || !taskIds.length || !["new-card", "evidence-added"].includes(a.kind)
      || !Number.isFinite(a.createdAt) || !["pending", "queued", "suppressed"].includes(a.speechStatus)) continue;
    state.alerts.push(alertFrom(e, taskIds, a.kind, text(a.id, 100), a.createdAt, a.speechStatus));
  }
  return state;
}

function observeTask(task, entries) {
  const seen = new Map(task.seen.map(e => [e.key, e]));
  const changes = [];
  for (const e of entries.filter(e => matches(task, e))) {
    const old = seen.get(e.key);
    if (old && e.revision < old.revision) continue;
    const combined = hashes([...(old?.hashes || []), ...e.evidenceHashes]);
    if ((!old && seen.size >= MAX_SEEN) || combined.length > MAX_HASHES) {
      task.status = "paused";
      task.issue = "去重记录达到容量，已暂停，请重新创建关注";
      return [];
    }
    if (!old || e.evidenceHashes.some(h => !old.hashes.includes(h))) changes.push({ e, kind: old ? "evidence-added" : "new-card" });
    seen.set(e.key, { key: e.key, revision: e.revision, hashes: combined });
  }
  task.seen = [...seen.values()];
  return changes;
}

export function addWatchTask(value, raw, entries, { now = Date.now(), id = `watch-${now}` } = {}) {
  const state = createWatchState(value);
  const draft = normalizeWatchDraft(raw);
  if (state.tasks.some(t => t.status === "active" && t.expiresAt > now
    && t.topic === draft.topic && t.source === draft.source && t.priority === draft.priority)) return state;
  if (state.tasks.length >= MAX_TASKS) throw new Error("WATCH_CAPACITY：最多保留20个任务，请清理已结束任务");
  if (!text(id, 100) || state.tasks.some(t => t.id === id)) throw new Error("WATCH_ID_INVALID");
  const task = { id: text(id, 100), ...draft, status: "active", createdAt: now,
    expiresAt: now + draft.durationHours * 3600000, seen: [], issue: "" };
  observeTask(task, mainlines(entries)); // Initial snapshot is a baseline, not news.
  state.tasks.push(task);
  return state;
}

function suppressInactive(state, now) {
  for (const a of state.alerts) if (a.speechStatus === "pending" && !a.taskIds.some(id => {
    const t = state.tasks.find(t => t.id === id);
    return t?.status === "active" && t.expiresAt > now && (t.priority === "material" || (t.priority === "priority" && a.level === "priority"));
  })) a.speechStatus = "suppressed";
}

export function setWatchTaskStatus(value, id, status, { now = Date.now() } = {}) {
  if (!["active", "paused", "cancelled"].includes(status)) throw new Error("WATCH_STATUS_INVALID");
  const state = createWatchState(value);
  const t = state.tasks.find(t => t.id === id);
  if (t && !["cancelled", "expired"].includes(t.status) && (!t.issue || status === "cancelled")) t.status = t.expiresAt <= now ? "expired" : status;
  suppressInactive(state, now);
  return state;
}

export function observeWatchTasks(value, entries, { now = Date.now(), projectionStatus } = {}) {
  const state = createWatchState(value);
  const changes = new Map();
  for (const task of state.tasks) {
    if (["active", "paused"].includes(task.status) && task.expiresAt <= now) task.status = "expired";
    if (task.status !== "active" || projectionStatus !== "COMPLETE") continue;
    for (const { e, kind } of observeTask(task, mainlines(entries))) {
      const prior = changes.get(e.key);
      if (prior) prior.taskIds.push(task.id);
      else changes.set(e.key, { e, kind, taskIds: [task.id] });
    }
  }
  const alerts = [...changes.values()].map(({ e, kind, taskIds }) => alertFrom(e, taskIds, kind,
    `watch-alert-${now}-${++state.sequence}`, now, "pending"));
  state.alerts = [...state.alerts, ...alerts].slice(-60);
  suppressInactive(state, now);
  return { state, alerts };
}

export function markWatchAlertQueued(value, id) {
  const state = createWatchState(value);
  const a = state.alerts.find(a => a.id === id);
  if (a?.speechStatus === "pending") a.speechStatus = "queued";
  return state;
}

// Only this bounded memory goes to the model. Cursor hashes and private source text stay local.
export function watchTaskContext(value, now = Date.now()) {
  const state = createWatchState(value);
  return { executionScope: "browser-open", confirmationRequired: true,
    tasks: state.tasks.filter(t => !["cancelled", "expired"].includes(t.status) && t.expiresAt > now).map(t => ({
      id: t.id, topic: t.topic, source: t.source, priority: t.priority, status: t.status,
      expiresAt: new Date(t.expiresAt).toISOString() })),
    recentAlerts: state.alerts.slice(-5).map(a => ({ cardId: a.cardId, title: a.title, kind: a.kind, level: a.level })) };
}

export function normalizeWatchMemory(value) {
  return { executionScope: "browser-open", confirmationRequired: true,
    tasks: (Array.isArray(value?.tasks) ? value.tasks : []).slice(0, MAX_TASKS).flatMap(t => {
      try { const d = normalizeWatchDraft(t); return [{ id: text(t.id, 100), topic: d.topic, source: d.source,
        priority: d.priority, status: ["active", "paused"].includes(t.status) ? t.status : "unknown", expiresAt: instant(t.expiresAt) }]; }
      catch { return []; }
    }),
    recentAlerts: (Array.isArray(value?.recentAlerts) ? value.recentAlerts : []).slice(-5).map(a => ({
      cardId: text(a.cardId), title: text(a.title), kind: a.kind === "new-card" ? "new-card" : "evidence-added",
      level: a.level === "priority" ? "priority" : "material" })) };
}
