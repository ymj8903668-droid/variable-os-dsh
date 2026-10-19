// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPrivateJsonProfile } from "./private-json-profile.js";

const codes = ["WEB_SERVICE_INVALID", "WEB_SERVICE_UNAVAILABLE", "WEB_SERVICE_WRITE_FAILED",
  "SOURCE_CHANGED", "INVALID_REQUEST", "CLIENT_BUSY"];
export const WEB_SERVICE_CODES = new Set(codes);
const fail = code => Object.assign(Error(code), { code });
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const key = value => value === null || typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);
const modes = new Set(["off", "edge", "own"]);
const randomRevision = () => randomBytes(32).toString("hex");
const initial = () => ({ schema: 1, mode: "edge", apiKey: null, revision: randomRevision() });
const exact = (value, required, optional = []) => plain(value)
  && required.every(field => Object.hasOwn(value, field))
  && Reflect.ownKeys(value).every(field => [...required, ...optional].includes(field));

function settingsPath(env) {
  const explicit = env.VARIABLE_OS_WEB_SETTINGS_FILE;
  const home = env.DSH_HOME;
  const valid = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
  if (explicit !== undefined && explicit !== null) {
    if (!valid(explicit)) throw fail("WEB_SERVICE_INVALID");
    return path.normalize(explicit);
  }
  if (home === undefined || home === null || home === "") return null;
  if (!valid(home)) throw fail("WEB_SERVICE_INVALID");
  return path.join(home, "variable-os", "web-service.json");
}

/** One Host-private record owns both mode and key; no environment credential fallback. */
export function createWebServiceSettings({ env = {} } = {}) {
  const file = settingsPath(env);
  const store = createPrivateJsonProfile({ file, initial, maxBytes: 4096, temporaryPrefix: ".web-",
    validate: record => exact(record, ["schema", "mode", "apiKey", "revision"]) && record.schema === 1
      && modes.has(record.mode) && key(record.apiKey) && revision(record.revision),
    errors: { invalid: "WEB_SERVICE_INVALID", unavailable: "WEB_SERVICE_UNAVAILABLE",
      write: "WEB_SERVICE_WRITE_FAILED", changed: "SOURCE_CHANGED", busy: "CLIENT_BUSY" },
  });
  const current = store.current;
  const project = record => Object.freeze({
    mode: record.mode, configured: record.apiKey !== null,
    persistence: file ? "HOST_FILE" : "SESSION_ONLY",
    revision: record.revision, connection: "NOT_CHECKED",
  });
  const expected = value => {
    if (!revision(value)) throw fail("INVALID_REQUEST");
    const selected = current();
    if (value !== selected.record.revision) throw fail("SOURCE_CHANGED");
    return selected;
  };
  const write = (record, selected) => project(store.write(record, selected));
  return Object.freeze({
    snapshot: () => project(current().record),
    configure(params) {
      if (!exact(params, ["revision", "mode"], ["apiKey"]) || !revision(params.revision)) {
        throw fail("INVALID_REQUEST");
      }
      if (!modes.has(params.mode) || Object.hasOwn(params, "apiKey") && !key(params.apiKey)) {
        throw fail("WEB_SERVICE_INVALID");
      }
      const selected = expected(params.revision);
      return write({ schema: 1, mode: params.mode,
        apiKey: Object.hasOwn(params, "apiKey") ? params.apiKey : selected.record.apiKey,
        revision: randomRevision() }, selected);
    },
    remove(params) {
      if (!exact(params, ["revision"])) throw fail("INVALID_REQUEST");
      const selected = expected(params.revision);
      return write({ schema: 1, mode: "off", apiKey: null, revision: randomRevision() }, selected);
    },
    capture(value) {
      const selected = expected(value);
      let retired = false;
      const check = () => {
        if (retired) throw fail("SOURCE_CHANGED");
        let latest;
        try { latest = current(); }
        catch (error) { retired = true; throw error; }
        if (latest.stamp !== selected.stamp) {
          retired = true; throw fail("SOURCE_CHANGED");
        }
        return latest.record;
      };
      return Object.freeze({
        mode: selected.record.mode, configured: selected.record.apiKey !== null,
        assertCurrent() { check(); },
        resolveKey() {
          const value = check();
          if (value.mode !== "own" || value.apiKey === null) throw fail("WEB_SERVICE_UNAVAILABLE");
          return value.apiKey;
        },
      });
    },
  });
}
