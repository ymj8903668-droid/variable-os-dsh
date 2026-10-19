// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { MODEL_SETTINGS_METHODS, MODEL_SETTINGS_CODES } from "./model-service-settings.js";
import { CUSTOM_MODEL_PROVIDER as provider, customModelProfile } from "./custom-model-route.js";
import { personalModelCredentialKey, isPersonalModelCredential,
  NATIVE_MODEL_PROVIDER, nativeModelCatalog, registerPersonalModelAdapter } from "./personal-model-adapter.js";
import { NATIVE_MODEL_CREDENTIAL_REF, createPersonalModelProfile } from "./personal-model-profile.js";

// Both plugin entries share an explicitly owned profile and credential records.
// Constructing these services does not import the Host's global model selection.
export function createPersonalModelServices(ctx, { file }) {
  const profile = createPersonalModelProfile({ file });
  const adapter = registerPersonalModelAdapter(ctx, { profile });
  return {
    modelSettings: createPersonalModelSettings({ ctx, profile, adapter }),
    currentSelection: adapter.currentSelection,
  };
}

const fail = code => Object.assign(Error(code), { code });
const identity = value => value?.[Symbol.for("cordis.original")] ?? value;
const plain = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const manageable = value => value === undefined || plain(value) && value.kind === "api-key"
  && Reflect.ownKeys(value).every(key => ["kind", "key"].includes(key))
  && (!Object.hasOwn(value, "key") || typeof value.key === "string");
const empty = value => value === undefined || manageable(value) && !Object.hasOwn(value, "key");
const configurationKey = credentialKey("variable-os-desk-ui", "model-configuration");
const safeFailure = (error, fallback = "MODEL_SETTINGS_UNAVAILABLE") => fail(
  MODEL_SETTINGS_CODES.has(error?.code) || ["CANCELLED", "CLIENT_BUSY"].includes(error?.code) ? error.code : fallback,
);
function untilCancelled(work, signal, code = () => "CANCELLED") {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(fail(code())); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createPersonalModelSettings({ ctx, profile, adapter }) {
  let busy = false, closed = false, epoch = 0;
  const salt = randomBytes(32), services = new WeakMap();
  const digest = value => createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex");
  const serviceId = value => {
    value = identity(value);
    if (!value) return null;
    if (!services.has(value)) services.set(value, randomUUID());
    return services.get(value);
  };
  const check = signal => {
    if (closed || signal?.aborted) throw fail("CANCELLED");
  };
  ctx.effect(() => {
    const unsubscribe = ctx.on("credentials/record-updated", address => {
      if (typeof address === "string" && address.startsWith("variable-os-desk-ui/model-")) {
        epoch++; adapter.invalidate();
      }
    });
    return () => { closed = true; adapter.invalidate(); unsubscribe(); };
  });
  async function read(signal) {
    check(signal);
    const value = profile.snapshot(), proof = profile.capture(value.revision);
    const credentials = ctx.get("credentials"), llm = ctx.llm, observedEpoch = epoch;
    const available = ["readRecord", "describeRecord", "modifyRecord"]
      .every(name => typeof credentials?.[name] === "function") && typeof llm?.listProviders === "function";
    // Native adapter withdrawal does not edit the private profile or emit a
    // credential event. Include its effective routing in asynchronous proofs.
    const providers = () => available ? llm.listProviders()
      .filter(row => [provider, NATIVE_MODEL_PROVIDER].includes(row.id)).map(row => row.id).sort() : null;
    const inspectedProviders = digest(providers());
    const selectionProof = () => digest(available ? adapter.currentSelection() : null);
    const inspectedSelection = selectionProof();
    const address = value.credentialRef ? personalModelCredentialKey(value.credentialRef) : configurationKey;
    const assertServicesCurrent = () => {
      check(signal);
      if (identity(ctx.get("credentials")) !== identity(credentials)
        || identity(ctx.llm) !== identity(llm) || digest(providers()) !== inspectedProviders) {
        throw fail("MODEL_SETTINGS_CHANGED");
      }
    };
    const assertCurrent = () => {
      check(signal); proof.assertCurrent(); assertServicesCurrent();
      if (epoch !== observedEpoch || selectionProof() !== inspectedSelection) throw fail("MODEL_SETTINGS_CHANGED");
    };
    const inspect = async address => {
      const record = available ? await untilCancelled(credentials.readRecord(address), signal) : undefined;
      assertCurrent();
      const descriptor = available ? await untilCancelled(credentials.describeRecord(address), signal) : null;
      assertCurrent();
      const managed = manageable(record);
      return { address, recordDigest: digest(record ?? null), recordEmpty: empty(record), managed,
        configured: isPersonalModelCredential(record), writable: available && descriptor.writable === true && managed };
    };
    const custom = await inspect(address);
    const native = await inspect(personalModelCredentialKey(NATIVE_MODEL_CREDENTIAL_REF));
    const { recordDigest, managed, configured, writable } = custom;
    const active = available && llm.listProviders().some(row => row.id === provider);
    const nativeActive = available && llm.listProviders().some(row => row.id === NATIVE_MODEL_PROVIDER);
    const selection = available ? adapter.currentSelection() : null;
    const chosenNative = selection?.provider === NATIVE_MODEL_PROVIDER, chosen = chosenNative ? native : custom;
    const code = !available ? "MODEL_SETTINGS_UNAVAILABLE" : !chosen.managed ? "MODEL_SETTINGS_INVALID"
      : !selection ? "MODEL_SELECTION_REQUIRED" : !(chosenNative ? nativeActive : active) ? "MODEL_PROVIDER_UNAVAILABLE"
        : !chosen.configured ? "MODEL_CREDENTIAL_REQUIRED" : "MODEL_CONFIGURED";
    const result = {
      available, writable: writable || native.writable, selection, connection: "NOT_CHECKED",
      providers: [...(value.route ? [{ provider, name: customModelProfile(value.route).displayName,
        models: [{ id: value.route.model, name: value.route.model }],
        credentialConfigured: configured, credentialWritable: writable }] : []),
      ...(nativeActive ? [{ provider: NATIVE_MODEL_PROVIDER, name: "DeepSeek (DSH)", models: nativeModelCatalog(),
        credentialConfigured: native.configured, credentialWritable: native.writable }] : [])],
      readiness: { ready: code === "MODEL_CONFIGURED", code, connection: "NOT_CHECKED" },
      customRoute: { available: writable && active, managed, configured: Boolean(value.route),
        endpoint: value.route?.endpoint ?? "", protocol: value.route?.protocol ?? "openai-completions",
        model: value.route?.model ?? "", allowLoopbackHttp: value.route?.allowLoopbackHttp === true,
        credentialConfigured: configured },
    };
    assertCurrent();
    return { value, credentials, address, recordDigest, recordEmpty: custom.recordEmpty, active, nativeActive,
      custom, native, assertCurrent, assertServicesCurrent,
      public: { ...result, revision: digest([value, result, recordDigest, native.recordDigest, observedEpoch,
        serviceId(credentials), serviceId(llm)]) } };
  }
  return Object.freeze({
    async inspectReadiness({ signal } = {}) {
      if (busy) throw fail("CLIENT_BUSY");
      const current = await read(signal);
      return { value: current.public.readiness, assertCurrent: current.assertCurrent };
    },
    async call(method, params = {}, { signal, beforeWrite = () => {}, writeRefused = () => {} } = {}) {
      check(signal);
      if (!MODEL_SETTINGS_METHODS.has(method)) throw fail("METHOD_NOT_ALLOWED");
      const routeWrite = method === "modelServiceRoute", credentialWrite = method === "modelServiceCredentials";
      const fields = method === "modelServiceStatus" ? [] : routeWrite
        ? params?.action === "remove" ? ["action", "revision"]
          : ["action", "revision", "endpoint", "protocol", "model", "allowLoopbackHttp"]
        : credentialWrite ? ["provider", "apiKey", "revision"] : ["provider", "model", "revision"];
      if (!plain(params) || Reflect.ownKeys(params).length !== fields.length
        || fields.some(field => !Object.hasOwn(params, field))) throw fail("MODEL_SETTINGS_INVALID");
      if (busy) throw fail("CLIENT_BUSY");
      let current;
      try { current = await read(signal); } catch (error) { throw safeFailure(error); }
      if (method === "modelServiceStatus") return current.public;
      if (busy) throw fail("CLIENT_BUSY");
      const native = !routeWrite && params.provider === NATIVE_MODEL_PROVIDER;
      const target = native ? current.native : current.custom;
      if (!current.public.available || !(native ? current.nativeActive : current.active)) throw fail("MODEL_SETTINGS_UNAVAILABLE");
      if (current.public.revision !== params.revision) throw fail("MODEL_SETTINGS_CHANGED");
      if (!target.managed) throw fail("MODEL_ROUTE_UNMANAGED");
      if (!target.writable) throw fail("MODEL_CREDENTIAL_READ_ONLY");
      if (routeWrite) {
        if (!["save", "remove"].includes(params.action)) throw fail("MODEL_SETTINGS_INVALID");
        if (params.action === "save") customModelProfile(params);
        if (!current.recordEmpty) throw fail("MODEL_ROUTE_CREDENTIAL_PRESENT");
        if (params.action === "remove" && current.value.selectedModel) throw fail("MODEL_ROUTE_IN_USE");
      } else {
        if (!native && (params.provider !== provider || !current.value.route)) throw fail("MODEL_SETTINGS_INVALID");
        if (credentialWrite) {
          if (params.apiKey !== null && !isPersonalModelCredential({ kind: "api-key", key: params.apiKey })) {
            throw fail("MODEL_SETTINGS_INVALID");
          }
        } else {
          if (native ? !nativeModelCatalog().some(row => row.id === params.model)
            : params.model !== current.value.route.model) throw fail("MODEL_SETTINGS_INVALID");
          if (!target.configured) throw fail("MODEL_CREDENTIAL_REQUIRED");
        }
      }
      current.assertCurrent();
      busy = true;
      let attempted = false, checkpoint;
      // All cooperating model mutations use the native record writer lock.
      // Credential changes first retire the selected model; no stale key is
      // usable while the native provider finishes persistence.
      const operation = Promise.resolve().then(() => current.credentials.modifyRecord(target.address, async record => {
        current.assertCurrent();
        if (digest(record ?? null) !== target.recordDigest) throw fail("MODEL_SETTINGS_CHANGED");
        beforeWrite(); adapter.invalidate(); check(signal);
        attempted = true;
        let saved;
        try {
          saved = routeWrite ? params.action === "remove" ? profile.clear({ revision: current.value.revision })
            : profile.save({ revision: current.value.revision, endpoint: params.endpoint,
              protocol: params.protocol, model: params.model, allowLoopbackHttp: params.allowLoopbackHttp })
            : native ? credentialWrite ? profile.prepareNative({ revision: current.value.revision })
              : profile.selectNative({
                revision: current.value.nativeCredentialRef ? current.value.revision
                  : profile.prepareNative({ revision: current.value.revision }).revision,
                model: params.model,
              })
              : credentialWrite ? profile.save({ revision: current.value.revision, ...current.value.route })
                : profile.select({ revision: current.value.revision, model: params.model });
        } catch (error) {
          if (["MODEL_SETTINGS_CHANGED", "CLIENT_BUSY", "MODEL_SETTINGS_INVALID"].includes(error?.code)) {
            attempted = false; writeRefused();
          }
          throw error;
        }
        checkpoint = profile.capture(saved.revision);
        // Native undefined means leave unchanged, not delete. An owned empty
        // API-key record atomically removes the key without ambient fallback.
        return credentialWrite ? params.apiKey === null ? { kind: "api-key" }
          : { kind: "api-key", key: params.apiKey } : undefined;
      })).then(async () => {
        check(signal); current.assertServicesCurrent(); checkpoint.assertCurrent();
        const next = await read(signal);
        current.assertServicesCurrent(); checkpoint.assertCurrent();
        if (credentialWrite && (native ? next.native.recordDigest : next.recordDigest) !== digest(params.apiKey === null
          ? { kind: "api-key" } : { kind: "api-key", key: params.apiKey })) throw fail("MODEL_SETTINGS_CHANGED");
        return next.public;
      }).catch(error => {
        throw attempted ? fail("MODEL_SETTINGS_RECHECK_REQUIRED") : safeFailure(error, "MODEL_SETTINGS_WRITE_FAILED");
      }).finally(() => { busy = false; });
      return untilCancelled(operation, signal, () => attempted ? "MODEL_SETTINGS_RECHECK_REQUIRED" : "CANCELLED");
    },
  });
}
