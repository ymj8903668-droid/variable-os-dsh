// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const BUSINESS_TIME_FIELDS = Object.freeze({
  "delivery-interaction-v1": ["occurredAt"],
  "opportunity-relation-decision-v1": ["decidedAt"],
  "opportunity-relation-event-v1": ["effectiveAt"],
  "presentation-decision-v1": ["decisionAt"],
  "opportunity-adjudication-v1": ["adjudicatedAt"],
  "variable-card-revision-v1": ["systemDecisionAt"],
  "screening-attempt-v1": ["terminalAt"],
  "human-clue-v1": ["firstHumanClueAt"],
  "reaction-search-assessment-v1": ["dataAsOf"],
});

export function eventStamp(row) {
  if (!row || typeof row !== "object") {
    return "";
  }
  return typeof row.recordedAt === "string" ? row.recordedAt : "";
}

export function visibleAtAsOf(row, asOf) {
  if (!asOf || !row) {
    return Boolean(row);
  }
  if (typeof row.recordedAt !== "string" || row.recordedAt > asOf) {
    return false;
  }
  const fields = BUSINESS_TIME_FIELDS[row.schema] || [];
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value > asOf) {
      return false;
    }
  }
  return true;
}

export function eventsAtAsOf(events, asOf) {
  if (!asOf) {
    return Array.isArray(events) ? events : [];
  }
  return (events || []).filter((row) => visibleAtAsOf(row, asOf));
}
