// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { customModelProfile } from "./custom-model-route.js";
import { createPrivateJsonProfile } from "./private-json-profile.js";

const fail = code => Object.assign(Error(code), { code });
const nonce = () => randomBytes(32).toString("hex");
export const NATIVE_MODEL_CREDENTIAL_REF = "VARIABLE_OS_NATIVE_DEEPSEEK";
const revision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const credentialRef = value => typeof value === "string" && /^VARIABLE_OS_MODEL_[A-F0-9]{32}$/.test(value);
const newCredentialRef = () => `VARIABLE_OS_MODEL_${randomBytes(16).toString("hex").toUpperCase()}`;
const modelId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value);
const retireNative = record => record.schema === 2 ? { nativeModel: null } : {};
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const routeFields = ["endpoint", "protocol", "model", "allowLoopbackHttp"];
function canonicalRoute(value) {
  if (!exact(value, routeFields)) throw fail("MODEL_SETTINGS_INVALID");
  const route = { ...value, endpoint: customModelProfile(value).baseURL };
  // URL escaping can expand a valid input beyond the persisted route limit.
  customModelProfile(route);
  return route;
}
const initial = () => ({ schema: 1, revision: nonce(), route: null, selectedModel: null, credentialRef: null });
function validRecord(record) {
  if (!exact(record, ["schema", "revision", "route", "selectedModel", "credentialRef",
    ...(record?.schema === 2 ? ["nativeModel", "nativeCredentialRef"] : [])])
    || ![1, 2].includes(record.schema) || !revision(record.revision)) return false;
  if (record.schema === 2 && (record.nativeCredentialRef !== NATIVE_MODEL_CREDENTIAL_REF
    || record.nativeCredentialRef === record.credentialRef
    || record.nativeModel !== null && (!modelId(record.nativeModel) || record.selectedModel !== null))) return false;
  if (record.route === null) return record.credentialRef === null && record.selectedModel === null;
  try {
    return isDeepStrictEqual(record.route, canonicalRoute(record.route))
      && credentialRef(record.credentialRef)
      && (record.selectedModel === null || record.selectedModel === record.route.model);
  } catch { return false; }
}

// Metadata only: this module cannot resolve keys, register a model or grant consent.
export function createPersonalModelProfile({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    throw fail("MODEL_SETTINGS_INVALID");
  }
  const store = createPrivateJsonProfile({
    file: path.normalize(file), initial, validate: validRecord, maxBytes: 4096, temporaryPrefix: ".model-",
    errors: { invalid: "MODEL_SETTINGS_INVALID", unavailable: "MODEL_SETTINGS_UNAVAILABLE",
      write: "MODEL_SETTINGS_RECHECK_REQUIRED", changed: "MODEL_SETTINGS_CHANGED", busy: "CLIENT_BUSY" },
  });
  const project = ({ schema, ...value }) => structuredClone(value);
  function expected(value) {
    if (!revision(value)) throw fail("MODEL_SETTINGS_INVALID");
    const current = store.current();
    if (current.record.revision !== value) throw fail("MODEL_SETTINGS_CHANGED");
    return current;
  }
  const write = (selected, changes) => project(store.write({
    ...selected.record, ...changes, revision: nonce(),
  }, selected));
  return Object.freeze({
    snapshot: () => project(store.current().record),
    save(params) {
      if (!exact(params, ["revision", ...routeFields])) throw fail("MODEL_SETTINGS_INVALID");
      const { revision: requested, ...draft } = params;
      const route = canonicalRoute(draft), selected = expected(requested);
      return write(selected, { route, selectedModel: null, ...retireNative(selected.record),
        credentialRef: selected.record.credentialRef ?? newCredentialRef() });
    },
    select(params) {
      if (!exact(params, ["revision", "model"])) throw fail("MODEL_SETTINGS_INVALID");
      const selected = expected(params.revision);
      if (!selected.record.route || params.model !== selected.record.route.model) throw fail("MODEL_SETTINGS_INVALID");
      return write(selected, { selectedModel: params.model, ...retireNative(selected.record) });
    },
    clear(params) {
      if (!exact(params, ["revision"])) throw fail("MODEL_SETTINGS_INVALID");
      const selected = expected(params.revision);
      return write(selected, { route: null, selectedModel: null, credentialRef: null, ...retireNative(selected.record) });
    },
    prepareNative(params) {
      if (!exact(params, ["revision"])) throw fail("MODEL_SETTINGS_INVALID");
      const selected = expected(params.revision);
      return write(selected, { schema: 2, selectedModel: null, nativeModel: null,
        nativeCredentialRef: NATIVE_MODEL_CREDENTIAL_REF });
    },
    selectNative(params) {
      if (!exact(params, ["revision", "model"]) || !modelId(params.model)) throw fail("MODEL_SETTINGS_INVALID");
      const selected = expected(params.revision);
      if (!selected.record.nativeCredentialRef) throw fail("MODEL_SETTINGS_INVALID");
      return write(selected, { selectedModel: null, nativeModel: params.model });
    },
    capture(value) {
      const selected = expected(value);
      const snapshot = project(selected.record);
      if (snapshot.route) Object.freeze(snapshot.route);
      let retired = false;
      return Object.freeze({
        value: Object.freeze(snapshot),
        assertCurrent() {
          if (retired) throw fail("MODEL_SETTINGS_CHANGED");
          try {
            if (store.current().stamp !== selected.stamp) throw fail("MODEL_SETTINGS_CHANGED");
          } catch (error) { retired = true; throw error; }
        },
      });
    },
  });
}
