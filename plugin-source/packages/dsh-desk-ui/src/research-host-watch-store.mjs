// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createWatchState, normalizeWatchDraft } from "../../../src/runtime/harness-research-host-watch.mjs";

export const WATCH_STORAGE_KEY = "variable-os.xiaomei-watch.v1";

// A Web Lock serializes updates from duplicate surfaces. Storage is scoped to
// this browser tab, as required by the desk's no-long-term-storage contract.
export function createWatchStore({ storage, lock } = {}) {
  let current = { state: createWatchState(), draft: null, error: "" };
  const listeners = new Set();
  const publish = patch => {
    if (patch.state && JSON.stringify(patch.state) === JSON.stringify(current.state)) patch.state = current.state;
    if (Object.entries(patch).every(([key, value]) => current[key] === value)) return;
    current = { ...current, ...patch };
    for (const listener of listeners) listener(current);
  };
  const read = () => {
    const raw = storage().getItem(WATCH_STORAGE_KEY);
    return createWatchState(raw ? JSON.parse(raw) : undefined);
  };
  const refresh = () => {
    try { publish({ state: read(), error: "" }); }
    catch { publish({ error: "任务存储读取失败，关注已停止；请检查浏览器存储设置。" }); }
  };
  refresh();
  return {
    snapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    draft(value) { publish({ draft: value ? normalizeWatchDraft(value) : null }); },
    async transact(update, afterCommit) {
      if (typeof lock !== "function") {
        publish({ error: "浏览器不支持任务互斥锁，未启用关注；请使用当前版 Chrome。" });
        return false;
      }
      try {
        return await lock(() => {
          const before = read();
          const next = createWatchState(update(before));
          const encoded = JSON.stringify(next);
          if (encoded !== JSON.stringify(before)) storage().setItem(WATCH_STORAGE_KEY, encoded);
          publish({ state: next, error: "" });
          try { afterCommit?.(next); }
          catch { publish({ error: "任务已保存，但短播未成功入队。请检查本机语音状态后手动重试。" }); }
          return true;
        });
      } catch (error) {
        publish({ error: `任务保存失败，未执行本次变更或播报。${String(error?.message || "").startsWith("WATCH_") ? error.message : "请检查浏览器存储设置。"}` });
        return false;
      }
    },
  };
}
