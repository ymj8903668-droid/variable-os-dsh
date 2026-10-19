// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash, randomUUID } from "node:crypto";

export const VOICE_CREDENTIAL_REF = "VARIABLE_OS_DUPLEX_API_KEY";
export const VOICE_SETTINGS_METHODS = new Set(["voiceServiceStatus", "voiceServiceCredentials"]);
export const VOICE_SETTINGS_CODES = new Set([
  "VOICE_SETTINGS_INVALID", "VOICE_SETTINGS_UNAVAILABLE", "VOICE_SETTINGS_CHANGED",
  "VOICE_CREDENTIAL_READ_ONLY", "VOICE_SETTINGS_WRITE_FAILED", "VOICE_SETTINGS_RECHECK_REQUIRED",
]);
const fail = code => Object.assign(new Error(code), { code });
const identity = value => value?.[Symbol.for("cordis.original")] ?? value;

function inspect(work, signal) {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(fail("CANCELLED")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(value => {
      signal.removeEventListener("abort", abort); resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

// Uses native credential storage only. Describing or editing a key never
// resolves its value, connects to a provider, or grants microphone consent.
export function createVoiceServiceSettings({ services = () => ({}) } = {}) {
  let epoch = randomUUID(), writing = null;
  const lifetime = new AbortController();
  const ids = new WeakMap();
  async function read(signal) {
    if (signal?.aborted) throw fail("CANCELLED");
    const before = epoch, credentials = services().credentials;
    const available = ["describe", "set", "unset"].every(key => typeof credentials?.[key] === "function");
    const service = identity(credentials);
    if (available && !ids.has(service)) ids.set(service, randomUUID());
    let metadata;
    try { metadata = available ? await inspect(credentials.describe(VOICE_CREDENTIAL_REF), signal) : null; }
    catch (error) { throw fail(signal?.aborted ? "CANCELLED" : "VOICE_SETTINGS_UNAVAILABLE"); }
    if (signal?.aborted) throw fail("CANCELLED");
    if (before !== epoch || identity(services().credentials) !== service) throw fail("VOICE_SETTINGS_CHANGED");
    if (available && (!metadata || typeof metadata.configured !== "boolean" || typeof metadata.writable !== "boolean")) {
      throw fail("VOICE_SETTINGS_UNAVAILABLE");
    }
    const value = { available, configured: available && metadata.configured,
      writable: available && metadata.writable, connection: "NOT_CHECKED" };
    return { credentials, service, public: { ...value, revision: createHash("sha256")
      .update(JSON.stringify([before, available ? ids.get(service) : null, value])).digest("hex") } };
  }
  return Object.freeze({
    close() { lifetime.abort(); return writing ?? Promise.resolve(); },
    async call(method, params = {}, { signal, beforeWrite } = {}) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      if (signal.aborted) throw fail("CANCELLED");
      if (!VOICE_SETTINGS_METHODS.has(method)) throw fail("METHOD_NOT_ALLOWED");
      const write = method === "voiceServiceCredentials";
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some(key => !(write ? ["apiKey", "revision"] : []).includes(key))
        || write && (typeof params.revision !== "string" || !/^[a-f0-9]{64}$/.test(params.revision)
          || params.apiKey !== null && (typeof params.apiKey !== "string"
            || !/^[A-Za-z0-9._~-]{1,512}$/.test(params.apiKey)))) throw fail("VOICE_SETTINGS_INVALID");
      if (writing) throw fail("CLIENT_BUSY");
      const current = await read(signal);
      if (signal.aborted) throw fail("CANCELLED");
      if (writing) throw fail("CLIENT_BUSY");
      if (!write) return current.public;
      if (!current.public.available) throw fail("VOICE_SETTINGS_UNAVAILABLE");
      if (params.revision !== current.public.revision) throw fail("VOICE_SETTINGS_CHANGED");
      if (!current.public.writable) throw fail("VOICE_CREDENTIAL_READ_ONLY");
      const completion = Promise.withResolvers();
      writing = completion.promise;
      try {
        await beforeWrite?.();
        if (signal.aborted) throw fail("CANCELLED");
        const prepared = await read(signal);
        if (prepared.public.revision !== current.public.revision) throw fail("VOICE_SETTINGS_CHANGED");
        // Native writes have no cancellation contract. Keep ownership until
        // settlement even if the browser disconnects; never race another write.
        try {
          if (params.apiKey === null) await current.credentials.unset(VOICE_CREDENTIAL_REF);
          else await current.credentials.set(VOICE_CREDENTIAL_REF, params.apiKey);
        } catch { throw fail("VOICE_SETTINGS_WRITE_FAILED"); }
        finally { epoch = randomUUID(); }
        if (signal?.aborted || identity(services().credentials) !== current.service) {
          throw fail("VOICE_SETTINGS_RECHECK_REQUIRED");
        }
        try { return (await read(signal)).public; }
        catch { throw fail("VOICE_SETTINGS_RECHECK_REQUIRED"); }
      } finally { writing = null; completion.resolve(); }
    },
  });
}
