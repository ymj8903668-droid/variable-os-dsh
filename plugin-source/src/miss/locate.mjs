// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { ALLOWED_NAMESPACES } from "../scan/demo-adapter.mjs";

const ALLOWED = new Set(ALLOWED_NAMESPACES);

export function namespaceHint(kind, ref) {
  const text = String(ref || "");
  if (text.includes("demo.wechat-group")) {
    return "demo.wechat-group";
  }
  if (text.includes("demo.public-account")) {
    return "demo.public-account";
  }
  if (kind === "URL" && /^https?:\/\//i.test(text)) {
    try {
      const host = new URL(text).hostname;
      if (ALLOWED.has(host)) {
        return host;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function hashFor(namespace, text) {
  return canonicalHash({ sourceNamespace: namespace, text });
}

export function findSourceItem(committed, { kind, ref }) {
  const sources = Array.isArray(committed.sourceItems) ? committed.sourceItems : [];
  const events = Array.isArray(committed.events) ? committed.events : [];
  const value = String(ref || "");
  const hinted = namespaceHint(kind, value);

  if (kind === "URL" && /^https?:\/\//i.test(value) && !hinted) {
    return { resolution: "SOURCE_OUT_OF_SCOPE", source: null };
  }

  const byId = sources.find((row) => row.id === value);
  if (byId) {
    return { resolution: "MATCHED_SOURCE_ITEM", source: byId };
  }
  const byKey = sources.find(
    (row) =>
      row.sourceDocumentKey === value ||
      row.rawUri === value ||
      (typeof row.rawUri === "string" && row.rawUri.endsWith(`/${value}`)),
  );
  if (byKey) {
    return { resolution: "MATCHED_SOURCE_ITEM", source: byKey };
  }
  const namespaces = hinted ? [hinted] : [...ALLOWED];
  for (const ns of namespaces) {
    const digest = hashFor(ns, value);
    const byHash = sources.find(
      (row) => row.sourceNamespace === ns && row.contentHash === digest,
    );
    if (byHash) {
      return { resolution: "MATCHED_SOURCE_ITEM", source: byHash };
    }
  }
  const byContains = sources.find(
    (row) =>
      typeof row.sourceDocumentKey === "string" &&
      value.includes(row.sourceDocumentKey),
  );
  if (byContains) {
    return { resolution: "MATCHED_SOURCE_ITEM", source: byContains };
  }
  void events;
  if (kind === "URL" && hinted) {
    return { resolution: "SOURCE_ITEM_NOT_FOUND", source: null };
  }
  if (kind === "URL" && !hinted) {
    return { resolution: "SOURCE_OUT_OF_SCOPE", source: null };
  }
  return { resolution: "SOURCE_ITEM_NOT_FOUND", source: null };
}

function terminalAttempt(events, exposureId) {
  const rows = events.filter(
    (row) =>
      row &&
      row.schema === "screening-attempt-v1" &&
      row.scanExposureId === exposureId,
  );
  const decided = rows.filter((row) => row.result === "DECIDED" && row.screeningDecisionId);
  if (decided.length) {
    return decided[decided.length - 1];
  }
  return rows.length ? rows[rows.length - 1] : null;
}

export function locateMissPath(committed, source) {
  const events = committed.events || [];
  if (!source) {
    return {
      exposure: null,
      attempt: null,
      decision: null,
      card: null,
      opportunity: null,
    };
  }
  const exposure = events.find(
    (row) =>
      row.schema === "scan-exposure-v1" && row.sourceItemId === source.id,
  );
  const attempt = exposure ? terminalAttempt(events, exposure.id) : null;
  const decision = attempt && attempt.screeningDecisionId
    ? events.find((row) => row.id === attempt.screeningDecisionId)
    : null;
  const card = exposure
    ? events.find(
        (row) =>
          row.schema === "variable-card-revision-v1" &&
          row.triggerScanExposureId === exposure.id &&
          row.origin === "AI_DISCOVERED",
      )
    : null;
  const opportunity = card
    ? events.find(
        (row) => row.schema === "opportunity-v1" && row.id === card.opportunityId,
      )
    : events.find(
        (row) =>
          row.schema === "opportunity-v1" &&
          exposure &&
          row.triggerScanExposureId === exposure.id,
      );
  return { exposure, attempt, decision, card, opportunity };
}

export function deriveRootCause({ resolution, path, events }) {
  if (resolution === "SOURCE_OUT_OF_SCOPE") {
    return "SOURCE_OUT_OF_SCOPE";
  }
  if (resolution === "SOURCE_ITEM_NOT_FOUND") {
    return "SOURCE_UNSEEN";
  }
  const decision = path.decision;
  if (decision && decision.reasonCode === "DUPLICATE_OR_UPDATE") {
    return "DEDUP_SUPPRESSION";
  }
  if (decision && decision.decision === "CREATE_CARD") {
    const presented = (events || []).some(
      (row) =>
        row.schema === "presentation-decision-v1" &&
        path.card &&
        row.cardRevisionId === path.card.id &&
        row.tier === "MUST_REVIEW",
    );
    if (!presented) {
      return "PRESENTATION_DEFERRED";
    }
  }
  if (decision && decision.decision === "REJECT") {
    return "TRADABILITY_REASONING_FAILURE";
  }
  if (path.exposure && !decision) {
    return "TRADABILITY_REASONING_FAILURE";
  }
  return "UNKNOWN";
}
