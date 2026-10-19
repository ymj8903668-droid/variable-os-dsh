// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const valid = value => value && typeof value === "object" && !Array.isArray(value)
  && /^[a-f0-9]{64}$/.test(value.profileRevision)
  && ["local", "ima", "none"].includes(value.mode)
  && (value.libraryId === null || typeof value.libraryId === "string")
  && typeof value.modelUseAllowed === "boolean";

/** One same-origin status reader per window; never calls IMA or a model. */
export function createWikiSourceMonitor({
  schedule = setTimeout, cancelTimer = clearTimeout, intervalMs = 1000, timeoutMs = 5000,
} = {}) {
  let state = { status: "UNOBSERVED", value: null, generation: 0 };
  let watchers = 0, read, timer = null, request = null, epoch = 0;
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  function publish(status, value) {
    const changed = status !== state.status || value?.profileRevision !== state.value?.profileRevision;
    if (!changed && JSON.stringify(value) === JSON.stringify(state.value)) return;
    state = { status, value: value ? structuredClone(value) : null, generation: state.generation + Number(changed) };
    for (const listener of listeners) listener(snapshot());
  }
  const accept = value => valid(value) ? publish("READY", value) : publish("UNAVAILABLE", null);
  function queue() {
    if (watchers && !request && timer === null) {
      timer = schedule(() => { timer = null; void poll(); }, intervalMs);
    }
  }
  async function poll() {
    if (!watchers || request) return;
    const own = { epoch, controller: new AbortController() };
    request = own;
    const signal = own.controller.signal;
    const timeout = schedule(() => own.controller.abort(), timeoutMs);
    let aborted;
    try {
      const result = await new Promise((resolve, reject) => {
        aborted = () => reject(new Error("Wiki status read cancelled"));
        signal.addEventListener("abort", aborted, { once: true });
        Promise.resolve().then(() => {
          if (signal.aborted) throw new Error("Wiki status read cancelled");
          return read({ signal });
        }).then(resolve, reject);
      });
      if (watchers && own.epoch === epoch && !signal.aborted) accept(result);
    } catch {
      if (watchers && own.epoch === epoch) publish("UNAVAILABLE", null);
    } finally {
      signal.removeEventListener("abort", aborted);
      cancelTimer(timeout);
      if (request === own) request = null;
      queue();
    }
  }
  return {
    snapshot,
    researchRevision(expected) {
      if (state.status !== "READY" || expected !== undefined && expected !== state.value.profileRevision) {
        throw Object.assign(Error("WIKI_SOURCE_CHANGED"), { code: "WIKI_SOURCE_CHANGED" });
      }
      return state.value.profileRevision;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    observe(value) { epoch++; request?.controller.abort(); accept(value); },
    invalidate() { epoch++; request?.controller.abort(); publish("UNAVAILABLE", null); },
    watch(readStatus) {
      let closed = false;
      if (++watchers === 1) { read = readStatus; void poll(); }
      return () => {
        if (closed) return;
        closed = true;
        if (--watchers === 0) {
          epoch++; cancelTimer(timer); timer = null;
          request?.controller.abort();
          publish("UNOBSERVED", null);
        }
      };
    },
  };
}
export const wikiSourceMonitor = createWikiSourceMonitor();
