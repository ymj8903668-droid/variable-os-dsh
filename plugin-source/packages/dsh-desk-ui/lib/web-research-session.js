// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { remoteError } from "../../dsh-tools/lib/remote/config.js";

export function createWebResearchSession({ settings, search, allowed, revision, signal }) {
  const checkSignal = other => {
    if (signal?.aborted || other?.aborted) throw remoteError("CANCELLED");
  };
  checkSignal();
  if (!allowed) return { tavily: "off", assertCurrent: checkSignal };
  const selection = settings.capture(revision);
  if (selection.mode === "off" || selection.mode === "own" && !selection.configured) {
    throw remoteError("SOURCE_UNAVAILABLE");
  }
  const assertCurrent = other => { checkSignal(other); selection.assertCurrent(); };
  return {
    tavily: selection.mode === "edge" ? "edge" : "off",
    assertCurrent,
    ...(selection.mode === "own" ? {
      async ownWeb(topic, { signal: operationSignal } = {}) {
        const combined = signal && operationSignal ? AbortSignal.any([signal, operationSignal]) : signal ?? operationSignal;
        assertCurrent(combined);
        const result = await search({ query: topic, maxResults: 5, apiKey: selection.resolveKey() },
          { signal: combined, assertCurrent: () => assertCurrent(combined) });
        assertCurrent(combined);
        return {
          web: { status: result.status, results: result.results },
          refs: result.results.map(item => ({
            sourceType: "web", ref: item.ref, title: item.title, url: item.url, excerpt: item.snippet,
          })),
          webObservation: result.observation,
          webService: { mode: "own", revision },
        };
      },
    } : {}),
  };
}
