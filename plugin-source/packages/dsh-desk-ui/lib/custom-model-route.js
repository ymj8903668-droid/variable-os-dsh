// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { isDeepStrictEqual } from "node:util";

export const CUSTOM_MODEL_PROVIDER = "variable-os-custom";
export const CUSTOM_MODEL_CREDENTIAL = "VARIABLE_OS_CUSTOM_MODEL_KEY";
const title = "自定义模型 API";
const protocols = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const invalid = () => { throw Object.assign(Error("MODEL_SETTINGS_INVALID"), { code: "MODEL_SETTINGS_INVALID" }); };
const route = section => section?.providers?.[CUSTOM_MODEL_PROVIDER];
const occupied = section => section?.providers != null && Object.hasOwn(section.providers, CUSTOM_MODEL_PROVIDER);
const invalidContainer = section => section && Object.hasOwn(section, "providers")
  && (!section.providers || typeof section.providers !== "object" || Array.isArray(section.providers));

export function customModelProfile({ endpoint, protocol, model, allowLoopbackHttp }) {
  if (typeof endpoint !== "string" || endpoint.length > 2048 || /[\s\x00-\x1f\x7f?#]/.test(endpoint)
    || !protocols.has(protocol) || typeof model !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model) || typeof allowLoopbackHttp !== "boolean") invalid();
  let url;
  try { url = new URL(endpoint); } catch { invalid(); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:"
    || allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) invalid();
  return { apiKeyEnv: CUSTOM_MODEL_CREDENTIAL, displayName: title, api: protocol,
    baseURL: url.href.replace(/\/+$/, ""), models: [{ id: model, input: ["text"] }] };
}

// Only this reserved, exact user-layer declaration is editable here. Native
// composition routes or hidden/custom fields belong to their own settings UI.
export function inspectCustomModel(descriptor) {
  const value = route(descriptor?.value), user = route(descriptor?.user);
  const declared = Boolean(value) || occupied(descriptor?.user) || occupied(descriptor?.base);
  const empty = { configured: declared, managed: !declared,
    endpoint: "", protocol: "openai-completions", model: "", allowLoopbackHttp: false };
  if (invalidContainer(descriptor?.user) || invalidContainer(descriptor?.base)) return { ...empty, managed: false };
  if (!value) return empty;
  if (occupied(descriptor.base) || descriptor.secrets?.some(row =>
    row.path?.[0] === "providers" && row.path?.[1] === CUSTOM_MODEL_PROVIDER)) return empty;
  try {
    const fields = { endpoint: user?.baseURL, protocol: user?.api, model: user?.models?.[0]?.id,
      allowLoopbackHttp: user?.baseURL?.startsWith("http:") === true };
    if (!isDeepStrictEqual(user, customModelProfile(fields))) return empty;
    if (value.apiKeyEnv !== CUSTOM_MODEL_CREDENTIAL || value.baseURL !== user.baseURL
      || value.api !== user.api || value.models?.length !== 1 || value.models[0].id !== fields.model) return empty;
    return { configured: true, managed: true, ...fields };
  } catch { return empty; }
}
