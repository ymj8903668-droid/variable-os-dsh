// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const OUTCOME_KINDS = new Set([
  "MARKET_OBSERVATION",
  "HUMAN_LABEL",
  "FERMENTATION_EVALUATION",
  "MAPPING_EVALUATION",
  "REFLECTION",
]);

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  return [0, 31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month
  ];
}

function parseInstant(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = RFC3339.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const sign = match[8][0] === "-" ? -1 : 1;
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const fraction = match[7]
    ? Number(match[7].padEnd(3, "0").slice(0, 3))
    : 0;
  const utcWall = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  const instant = utcWall - offsetMinutes * 60_000;
  const check = new Date(utcWall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  return instant;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function outcomeToken(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.toUpperCase().replace(/-/g, "_").replace(/_V\d+$/, "");
}

function isOutcomeItem(item) {
  const tokens = [
    item.recordKind,
    item.refType,
    item.schema,
    item.payload && item.payload.schema,
  ];
  return tokens.some((token) => OUTCOME_KINDS.has(outcomeToken(token)));
}

function resultOf({
  overallResult,
  failureCodes,
  gates,
  itemResults,
}) {
  const unique = [...new Set(failureCodes)];
  return {
    overallResult,
    failureCodes: unique,
    gates,
    itemResults,
    actionable: overallResult === "PASS",
    runStatus: overallResult === "PASS" ? null : "BLOCKED_TIME_AUDIT",
  };
}

function failAll(codes, itemResults = []) {
  return resultOf({
    overallResult: "TIME_AUDIT_FAILED",
    failureCodes: codes,
    gates: {
      evidenceTime: "FAIL",
      derivedLineage: "FAIL",
      outcomeClosure: "FAIL",
    },
    itemResults,
  });
}

function sortMembers(members) {
  return [...members].sort((left, right) => {
    if (left.schema !== right.schema) {
      return left.schema < right.schema ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function auditThemeItem(item, cutoffMs, itemResults, failureCodes) {
  const push = (reasonCode) => {
    failureCodes.push(reasonCode);
    itemResults.push({
      contextItemId: item && item.id ? item.id : null,
      refId: item && item.refId ? item.refId : null,
      gate: "DERIVED_LINEAGE",
      result: "FAIL",
      reasonCode,
    });
  };
  const receipt = item.caseResolutionReceipt;
  const snapshot = item.themeMemorySnapshot;
  if (!receipt || !snapshot || !item.resolutionReceiptId) {
    push("MISSING_CASE_RESOLUTION");
    return;
  }
  if (
    item.resolutionReceiptId !== receipt.id ||
    snapshot.caseResolutionReceiptId !== receipt.id
  ) {
    push("RECEIPT_MISMATCH");
    return;
  }
  if (
    snapshot.opportunityId !== receipt.opportunityId ||
    snapshot.cardRevisionId !== receipt.cardRevisionId
  ) {
    push("CROSS_CASE_RECEIPT");
    return;
  }
  if (!Array.isArray(receipt.members) || receipt.members.length === 0) {
    push("MISSING_MEMBERS");
    return;
  }
  if (
    receipt.members.some(
      (row) =>
        !row ||
        typeof row.schema !== "string" ||
        typeof row.id !== "string" ||
        typeof row.recordHash !== "string" ||
        parseInstant(row.completedAt) === null,
    )
  ) {
    push("INVALID_MEMBER_MANIFEST");
    return;
  }
  const sorted = sortMembers(receipt.members);
  const expectedHash = canonicalHash({
    opportunityId: receipt.opportunityId,
    cardRevisionId: receipt.cardRevisionId,
    members: sorted,
  });
  if (receipt.resolutionHash !== expectedHash) {
    push("RECEIPT_HASH_MISMATCH");
    return;
  }
  const snapshotMembers = Array.isArray(snapshot.members)
    ? sortMembers(snapshot.members)
    : [];
  if (canonicalHash(snapshotMembers) !== canonicalHash(sorted)) {
    push("MEMBER_MANIFEST_MISMATCH");
    return;
  }
  const memberIds = new Set(sorted.map((row) => row.id));
  const required = [
    ...(receipt.requiredHumanDecisionIds || []),
    ...(receipt.requiredEvaluationIds || []),
  ];
  if (required.some((id) => !memberIds.has(id))) {
    push("MISSING_REQUIRED_MEMBER");
    return;
  }
  if (!memberIds.has(snapshot.themeHypothesisId)) {
    push("THEME_NOT_IN_MANIFEST");
    return;
  }
  const completed = sorted.map((row) => parseInstant(row.completedAt));
  if (completed.some((stamp) => stamp === null)) {
    push("INVALID_TIME");
    return;
  }
  const recomputed = Math.max(...completed);
  const resolvedMs = parseInstant(receipt.resolvedAt);
  if (resolvedMs === null || resolvedMs !== recomputed) {
    push("RESOLVED_AT_MISMATCH");
    return;
  }
  const itemResolved = parseInstant(item.resolvedAt);
  if (itemResolved !== resolvedMs) {
    push("RESOLVED_AT_MISMATCH");
    return;
  }
  const recordedMs = parseInstant(snapshot.recordedAt);
  if (recordedMs === null) {
    push("INVALID_TIME");
    return;
  }
  if (item.refId !== snapshot.id) {
    push("THEME_REF_MISMATCH");
    return;
  }
  const expectedIds = sorted.map((row) => row.id);
  const refs = item.memberRefs;
  if (
    !Array.isArray(refs) ||
    refs.length !== expectedIds.length ||
    new Set(refs).size !== refs.length ||
    refs.some((id, index) => id !== expectedIds[index])
  ) {
    push("MEMBER_REFS_MISMATCH");
    return;
  }
  const lockedAvailable = Math.max(recordedMs, resolvedMs);
  const availableMs = parseInstant(item.availableAt);
  if (availableMs === null || availableMs !== lockedAvailable) {
    push("AVAILABLE_AT_MISMATCH");
    return;
  }
  if (!(availableMs < cutoffMs)) {
    push("THEME_NOT_BEFORE_CUTOFF");
    return;
  }
  const expectedSnapshot = canonicalHash({
    opportunityId: snapshot.opportunityId,
    cardRevisionId: snapshot.cardRevisionId,
    themeHypothesisId: snapshot.themeHypothesisId,
    members: sorted,
  });
  if (snapshot.snapshotHash !== expectedSnapshot) {
    push("SNAPSHOT_HASH_MISMATCH");
    return;
  }
  if (item.contentHash !== snapshot.snapshotHash) {
    push("CONTENT_HASH_MISMATCH");
    return;
  }
  itemResults.push({
    contextItemId: item.id,
    refId: item.refId,
    gate: "DERIVED_LINEAGE",
    result: "PASS",
    reasonCode: null,
  });
}

export function auditTimeGates(input) {
  const itemResults = [];
  const failureCodes = [];
  if (!input || typeof input !== "object") {
    return failAll(["INVALID_INPUT"]);
  }
  const cutoffMs = parseInstant(input.contextCutoffAt);
  const items = Array.isArray(input.contextItems) ? input.contextItems : null;
  if (cutoffMs === null || items === null) {
    return failAll(["INVALID_TIME"]);
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      failureCodes.push("INVALID_CONTEXT_ITEM");
      itemResults.push({
        contextItemId: null,
        refId: null,
        gate: "EVIDENCE_TIME",
        result: "FAIL",
        reasonCode: "INVALID_CONTEXT_ITEM",
      });
      continue;
    }
    if (
      item.stream === "SKILL" ||
      item.stream === "EPISODE" ||
      item.refType === "SKILL" ||
      item.refType === "EPISODE"
    ) {
      failureCodes.push("SKILL_EPISODE_FORBIDDEN");
      itemResults.push({
        contextItemId: item.id ?? null,
        refId: item.refId ?? null,
        gate: "DERIVED_LINEAGE",
        result: "FAIL",
        reasonCode: "SKILL_EPISODE_FORBIDDEN",
      });
      continue;
    }
    if (item.stream === "THEME") {
      auditThemeItem(item, cutoffMs, itemResults, failureCodes);
      continue;
    }
    const availableMs = parseInstant(item.availableAt);
    if (availableMs === null) {
      failureCodes.push("INVALID_TIME");
      itemResults.push({
        contextItemId: item.id ?? null,
        refId: item.refId ?? null,
        gate: "EVIDENCE_TIME",
        result: "FAIL",
        reasonCode: "INVALID_TIME",
      });
      continue;
    }
    if (item.stream === "PRIOR") {
      if (!(availableMs < cutoffMs)) {
        failureCodes.push("HISTORICAL_NOT_BEFORE_CUTOFF");
        itemResults.push({
          contextItemId: item.id ?? null,
          refId: item.refId ?? null,
          gate: "EVIDENCE_TIME",
          result: "FAIL",
          reasonCode: "HISTORICAL_NOT_BEFORE_CUTOFF",
        });
        continue;
      }
    } else if (item.stream === "FOCAL" || item.stream === "CONCURRENT") {
      if (availableMs > cutoffMs) {
        failureCodes.push("FUTURE_EVIDENCE");
        itemResults.push({
          contextItemId: item.id ?? null,
          refId: item.refId ?? null,
          gate: "EVIDENCE_TIME",
          result: "FAIL",
          reasonCode: "FUTURE_EVIDENCE",
        });
        continue;
      }
    } else {
      failureCodes.push("UNKNOWN_STREAM");
      itemResults.push({
        contextItemId: item.id ?? null,
        refId: item.refId ?? null,
        gate: "EVIDENCE_TIME",
        result: "FAIL",
        reasonCode: "UNKNOWN_STREAM",
      });
      continue;
    }
    itemResults.push({
      contextItemId: item.id ?? null,
      refId: item.refId ?? null,
      gate: "EVIDENCE_TIME",
      result: "PASS",
      reasonCode: null,
    });
  }

  for (const item of items) {
    if (!item || !isOutcomeItem(item)) {
      continue;
    }
    const stamp = parseInstant(item.availableAt);
    if (stamp === null || stamp >= cutoffMs) {
      failureCodes.push("FUTURE_OUTCOME");
      itemResults.push({
        contextItemId: item.id ?? null,
        refId: item.refId ?? null,
        gate: "OUTCOME_CLOSURE",
        result: "FAIL",
        reasonCode: "FUTURE_OUTCOME",
      });
    }
  }

  const timing = input.decisionTiming;
  if (timing != null && !isPlainObject(timing)) {
    failureCodes.push("INVALID_DECISION_CLOCK");
    itemResults.push({
      contextItemId: null,
      refId: null,
      gate: "OUTCOME_CLOSURE",
      result: "FAIL",
      reasonCode: "INVALID_DECISION_CLOCK",
    });
  } else if (timing) {
    const systemMs = parseInstant(timing.systemDecisionAt);
    if (systemMs === null) {
      failureCodes.push("INVALID_TIME");
      itemResults.push({
        contextItemId: null,
        refId: null,
        gate: "OUTCOME_CLOSURE",
        result: "FAIL",
        reasonCode: "INVALID_DECISION_CLOCK",
      });
    } else {
      if (systemMs < cutoffMs) {
        failureCodes.push("DECISION_BEFORE_CUTOFF");
        itemResults.push({
          contextItemId: null,
          refId: null,
          gate: "OUTCOME_CLOSURE",
          result: "FAIL",
          reasonCode: "DECISION_BEFORE_CUTOFF",
        });
      }
      if (timing.engineCompletedAt != null) {
        const engineMs = parseInstant(timing.engineCompletedAt);
        if (engineMs === null || engineMs < cutoffMs) {
          failureCodes.push("ENGINE_BEFORE_CUTOFF");
          itemResults.push({
            contextItemId: null,
            refId: null,
            gate: "OUTCOME_CLOSURE",
            result: "FAIL",
            reasonCode: "ENGINE_BEFORE_CUTOFF",
          });
        }
      }
      if (timing.enqueuedAt !== null && timing.enqueuedAt !== undefined) {
        const enqueuedMs = parseInstant(timing.enqueuedAt);
        if (enqueuedMs === null) {
          failureCodes.push("INVALID_TIME");
          itemResults.push({
            contextItemId: null,
            refId: null,
            gate: "OUTCOME_CLOSURE",
            result: "FAIL",
            reasonCode: "INVALID_ENQUEUE_TIME",
          });
        } else if (systemMs > enqueuedMs) {
          failureCodes.push("DECISION_AFTER_ENQUEUE");
          itemResults.push({
            contextItemId: null,
            refId: null,
            gate: "OUTCOME_CLOSURE",
            result: "FAIL",
            reasonCode: "DECISION_AFTER_ENQUEUE",
          });
        }
      }
    }
  }

  const gateStatus = (name) =>
    itemResults.some((row) => row.gate === name && row.result === "FAIL")
      ? "FAIL"
      : "PASS";
  const gates = {
    evidenceTime: gateStatus("EVIDENCE_TIME"),
    derivedLineage: gateStatus("DERIVED_LINEAGE"),
    outcomeClosure: gateStatus("OUTCOME_CLOSURE"),
  };
  const overallResult =
    failureCodes.length === 0 ? "PASS" : "TIME_AUDIT_FAILED";
  return resultOf({
    overallResult,
    failureCodes,
    gates,
    itemResults,
  });
}
