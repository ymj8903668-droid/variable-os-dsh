// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export async function readRemoteStream({
  request = fetch, csrf, datasetId, signal, resume, onEvent, onState,
}) {
  let terminal = false;
  try {
    const params = new URLSearchParams(datasetId ? { datasetId } : {});
    const response = await request(`/variable-os-desk/remote-events${params.size ? `?${params}` : ""}`, {
      headers: { "x-variable-os-csrf": csrf, ...(resume.current ? { "last-event-id": resume.current } : {}) },
      cache: "no-store", credentials: "same-origin", signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw Error();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 65536) { await reader.cancel(); throw Error(); }
      let at;
      while ((at = pending.indexOf("\n\n")) >= 0) {
        const lines = pending.slice(0, at).split("\n"); pending = pending.slice(at + 2);
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
        const data = JSON.parse(lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n"));
        if (event === "connection") {
          await onState(data);
          if (data.code === "RESYNC_REQUIRED") terminal = true;
        } else if (["card.committed", "card.revised", "card.withdrawn", "evidence.withdrawn"].includes(event)) {
          if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id || "")) throw Error();
          if (resume.current === id) continue;
          await onEvent({ event, id, data });
          resume.current = id;
        }
      }
    }
    if (!signal?.aborted && !terminal) await onState({ code: "DISCONNECTED" });
  } catch { if (!signal?.aborted) await onState({ code: "DISCONNECTED" }); }
}

export async function resyncRemote(call, datasetId) {
  let cursor = "start";
  const seen = new Set();
  for (let page = 0; page < 32; page++) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const result = await call("changes", { cursor, ...(datasetId ? { datasetId } : {}) });
    if (!result.nextCursor) return;
    cursor = result.nextCursor;
  }
  throw Object.assign(Error("RESYNC_REQUIRED"), { code: "RESYNC_REQUIRED" });
}
