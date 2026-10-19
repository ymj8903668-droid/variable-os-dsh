// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only

/** Metadata-only retirement observation. Never starts or retries a call. */
export async function observePersonalVoiceReadiness({ read, onState, signal, intervalMs = 1000 }) {
  while (!signal.aborted) {
    let value;
    try { value = await read({ signal }); }
    catch (error) { if (signal.aborted) return; throw error; }
    if (signal.aborted) return;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3
      || typeof value.configured !== "boolean" || typeof value.active !== "boolean"
      || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) {
      throw Object.assign(Error("VOICE_STATUS_INVALID"), { code: "VOICE_STATUS_INVALID" });
    }
    onState(Object.freeze({ configured: value.configured, active: value.active, revision: value.revision }));
    if (!value.active || signal.aborted) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
