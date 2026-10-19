// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomBytes } from "node:crypto";

export const MODEL_SETTINGS_METHODS = new Set([
  "modelServiceStatus", "modelServiceCredentials", "modelServiceSelect", "modelServiceRoute",
]);
export const MODEL_SETTINGS_CODES = new Set([
  "MODEL_SETTINGS_UNAVAILABLE", "MODEL_SETTINGS_INVALID", "MODEL_SETTINGS_CHANGED",
  "MODEL_SETTINGS_WRITE_FAILED", "MODEL_SETTINGS_RECHECK_REQUIRED",
  "MODEL_CREDENTIAL_REQUIRED", "MODEL_CREDENTIAL_READ_ONLY",
  "MODEL_ROUTE_CREDENTIAL_PRESENT", "MODEL_ROUTE_UNMANAGED", "MODEL_ROUTE_IN_USE",
]);
const fail = code => Object.assign(new Error(code), { code });

// Read-only consumers have no model binding. Keep the original RPC shape, but
// never inspect or write Host global services, even if legacy options are given.
// Optional personal research explicitly injects createPersonalModelSettings.
export function createModelServiceSettings() {
  const revision = randomBytes(32).toString("hex");
  const check = signal => { if (signal?.aborted) throw fail("CANCELLED"); };
  const readiness = () => ({ ready: false, code: "MODEL_SETTINGS_UNAVAILABLE", connection: "NOT_CHECKED" });
  const status = () => ({
    available: false, writable: false, selection: null, providers: [], connection: "NOT_CHECKED",
    readiness: readiness(), revision,
    customRoute: { available: false, configured: false, managed: true, endpoint: "",
      protocol: "openai-completions", model: "", allowLoopbackHttp: false, credentialConfigured: false },
  });
  return {
    async inspectReadiness({ signal } = {}) {
      check(signal);return { value: readiness(), assertCurrent: () => check(signal) };
    },
    async call(method, params = {}, { signal } = {}) {
      if (!MODEL_SETTINGS_METHODS.has(method)) throw fail("METHOD_NOT_ALLOWED");
      const fields = method === "modelServiceStatus" ? [] : method === "modelServiceCredentials"
        ? ["provider", "apiKey", "revision"] : method === "modelServiceSelect"
          ? ["provider", "model", "revision"] : params?.action === "remove" ? ["action", "revision"]
            : ["action", "endpoint", "protocol", "model", "allowLoopbackHttp", "revision"];
      if (!params || ![Object.prototype, null].includes(Object.getPrototypeOf(params))
        || Reflect.ownKeys(params).some(key => !fields.includes(key))) throw fail("MODEL_SETTINGS_INVALID");
      check(signal);
      if (method !== "modelServiceStatus") throw fail("MODEL_SETTINGS_UNAVAILABLE");
      return status();
    },
  };
}
