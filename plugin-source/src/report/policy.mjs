// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { fail } from "./errors.mjs";

const policyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/metrics/demo-policy-v1.json",
);

let cached = null;

export async function loadDemoMetricPolicy() {
  if (cached) {
    return cached;
  }
  const parsed = JSON.parse(await fs.readFile(policyPath, "utf8"));
  if (!parsed || parsed.cohortName !== "OBSERVED_TIMELY_DISCOVERY_BASE") {
    fail("INVALID_AUTHORITY", "demo metric policy is missing");
  }
  cached = parsed;
  return parsed;
}

export const SELECTOR_VERSION_KEYS = [
  "cohortUniverseRuleVersion",
  "equivalenceResolverVersion",
  "adjudicationSelectionRuleVersion",
  "reactionAssessmentSelectionRuleVersion",
  "auditReceiptInclusionRuleVersion",
];

export function selectorVersionsOf(value) {
  const src = value && value.selectorVersions ? value.selectorVersions : value || {};
  const out = {};
  for (const key of SELECTOR_VERSION_KEYS) {
    out[key] = src[key];
  }
  return out;
}

export function sortRuleVersions(rows) {
  return [...(rows || [])]
    .map((row) => ({ role: row.role, version: row.version }))
    .sort((left, right) => {
      if (left.role !== right.role) {
        return left.role < right.role ? -1 : 1;
      }
      return left.version < right.version ? -1 : left.version > right.version ? 1 : 0;
    });
}

export function authorityCanonical(policy, recordedAt) {
  return {
    reportId: policy.reportId,
    approvedMetricPolicySnapshotRef: policy.snapshotRef,
    approvedMetricPolicySnapshotHash: canonicalHash(policy),
    policyApprovedAt: policy.approvedAt,
    cohortName: policy.cohortName,
    cohortVersion: policy.cohortVersion,
    reportWindowStartAt: policy.reportWindowStartAt,
    reportWindowEndAt: policy.reportWindowEndAt,
    asOf: policy.asOf,
    selectorVersions: selectorVersionsOf(policy.selectorVersions),
    ruleVersions: sortRuleVersions(policy.ruleVersions),
    requiredAuditPeriodIds: [...(policy.requiredAuditPeriodIds || [])].sort(),
    recordedAt,
  };
}

export function authorityHash(policy, recordedAt) {
  return canonicalHash(authorityCanonical(policy, recordedAt));
}

export function authorityHashFromReceipt(row) {
  return canonicalHash({
    reportId: row.reportId,
    approvedMetricPolicySnapshotRef: row.approvedMetricPolicySnapshotRef,
    approvedMetricPolicySnapshotHash: row.approvedMetricPolicySnapshotHash,
    policyApprovedAt: row.policyApprovedAt,
    cohortName: row.cohortName,
    cohortVersion: row.cohortVersion,
    reportWindowStartAt: row.reportWindowStartAt,
    reportWindowEndAt: row.reportWindowEndAt,
    asOf: row.asOf,
    selectorVersions: selectorVersionsOf(row),
    ruleVersions: sortRuleVersions(row.ruleVersions),
    requiredAuditPeriodIds: [...(row.requiredAuditPeriodIds || [])].sort(),
    recordedAt: row.recordedAt,
  });
}

export function assertAuthorityTimeOrder({
  policyApprovedAt,
  recordedAt,
  reportWindowStartAt,
  reportWindowEndAt,
  asOf,
}) {
  if (
    !(
      policyApprovedAt <= recordedAt &&
      recordedAt < reportWindowStartAt &&
      reportWindowStartAt < reportWindowEndAt &&
      reportWindowEndAt <= asOf
    )
  ) {
    fail(
      "INVALID_AUTHORITY",
      "policyApprovedAt <= recordedAt < windowStart < windowEnd <= asOf required",
    );
  }
}

export function rejectOverrides(payload, policy) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const frozen = [
    "reportWindowStartAt",
    "reportWindowEndAt",
    "asOf",
    "cohortName",
    "cohortVersion",
    "selectorVersions",
    "ruleVersions",
    "requiredAuditPeriodIds",
  ];
  for (const key of frozen) {
    if (payload[key] !== undefined && payload[key] !== null) {
      fail("OVERRIDE_FORBIDDEN", `${key} cannot be overridden by caller`);
    }
  }
  if (payload.policyId && payload.policyId !== policy.policyId) {
    fail("OVERRIDE_FORBIDDEN", "policyId cannot be overridden by caller");
  }
}
