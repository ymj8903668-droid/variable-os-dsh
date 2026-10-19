// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export const SOURCE_CONNECTION_INFO_LIMIT = 32768;
const invalid = () => Object.assign(new Error("SOURCE_IMPORT_INVALID"), { code: "SOURCE_IMPORT_INVALID" });

export function parseSourceConnectionEndpoint(input) {
  try {
    if (typeof input !== "string" || input.length > 2048) throw Error();
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password
      || input !== url.origin && input !== `${url.origin}/mcp`) throw Error();
    return url.origin;
  } catch { throw invalid(); }
}

export function parseSourceConnectionInfo(text) {
  try {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > SOURCE_CONNECTION_INFO_LIMIT) throw Error();
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.values(value).some(field => typeof field !== "string")) throw Error();
    const keys = Object.keys(value).sort().join(",");
    if (keys === "ca,endpoint,spki,transport") {
      if (value.transport !== "stdio") throw Error();
    } else if (keys === "authentication,ca,endpoint,mcpUrl,schema,spki,transport") {
      if (value.schema !== "variable-os-remote-mcp-v1" || value.transport !== "streamable-http"
        || value.authentication !== "bearer" || value.mcpUrl !== `${value.endpoint}/mcp`) throw Error();
    } else throw Error();
    // All fields are strings; extra lexical tokens expose duplicate keys, including escaped aliases.
    if ([...text.matchAll(/"(?:\\.|[^"\\])*"/g)].length !== Object.keys(value).length * 2) throw Error();
    if (parseSourceConnectionEndpoint(value.endpoint) !== value.endpoint
      || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.spki)
      || value.ca.length > 16384 || value.ca !== ""
        && !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(value.ca)) throw Error();
    return Object.freeze({ endpoint: value.endpoint, spki: value.spki, caCertificate: value.ca });
  } catch { throw invalid(); }
}
