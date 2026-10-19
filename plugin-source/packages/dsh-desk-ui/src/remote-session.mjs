// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const cleanCode = (value) => typeof value === "string" && /^[A-Z_]{2,64}$/.test(value) ? value : "SOURCE_UNAVAILABLE";

export function createRemoteSession({ call }) {
  let state = { rows: [], record: null, research: null, receipt: null, nextCursor: null, error: null, busy: false, streamCode: "CONNECTING" };
  const listeners = new Set();
  let generation = 0;
  let abort;
  const update = (patch) => { state = { ...state, ...patch }; for (const notify of listeners) notify(state); };
  const clear = () => ({ rows: [], record: null, research: null, receipt: null, nextCursor: null });
  async function run(method, params, kind) {
    const own = ++generation;
    abort?.abort();
    abort = new AbortController();
    update({ ...clear(), error: null, busy: true });
    try {
      const result = await call(method, params, { signal: abort.signal });
      if (generation !== own) return;
      update(kind === "research" ? { research: result, receipt: result.receipt } : {
        rows: result.items ?? result.hits ?? result.entries ?? result.cards ?? [],
        record: result.item ?? null, receipt: result.receipt ?? null, nextCursor: result.nextCursor ?? null,
      });
    } catch (error) {
      if (generation === own) update({ ...clear(), error: cleanCode(error?.code) });
    } finally { if (generation === own) update({ busy: false }); }
  }
  return {
    snapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    load: (method, params = {}) => run(method, params, "read"),
    research: (topic) => run("deepResearch", { topic, modelUseAllowed: true, webSearchAllowed: false }, "research"),
    connection(code) { update({ streamCode: cleanCode(code) }); },
    failure(code) { generation++; abort?.abort(); update({ ...clear(), busy: false, error: cleanCode(code) }); },
    invalidate(code) {
      generation++;
      abort?.abort();
      update({ ...clear(), error: null, busy: false, streamCode: code });
    },
    close() { generation++; abort?.abort(); listeners.clear(); },
  };
}
