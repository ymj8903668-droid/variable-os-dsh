// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export function personalResearchPlan(value) {
  const invalid = () => { throw Object.assign(Error("INVALID_REQUEST"), { code: "INVALID_REQUEST" }); };
  if (value === undefined) return Object.freeze({ scope: "current", webSearchAllowed: false, sourceRevision: null });
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !["scope", "webSearchAllowed", "sourceRevision", "webServiceRevision"].includes(key)) ||
    !["current", "published"].includes(value.scope) || typeof value.webSearchAllowed !== "boolean") invalid();
  if (value.scope === "current" && (value.webSearchAllowed ||
    value.sourceRevision !== undefined && value.sourceRevision !== null)) invalid();
  if (value.scope === "published" && !/^[a-f0-9]{64}$/.test(value.sourceRevision ?? "")) invalid();
  if (value.webSearchAllowed ? !/^[a-f0-9]{64}$/.test(value.webServiceRevision ?? "")
    : value.webServiceRevision !== undefined && value.webServiceRevision !== null) invalid();
  return Object.freeze({ scope: value.scope, webSearchAllowed: value.webSearchAllowed,
    sourceRevision: value.scope === "published" ? value.sourceRevision : null,
    ...(value.webSearchAllowed ? { webServiceRevision: value.webServiceRevision } : {}) });
}
