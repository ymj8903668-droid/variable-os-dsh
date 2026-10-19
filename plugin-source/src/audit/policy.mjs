// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { fail } from "./errors.mjs";

const policyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/audit/demo-policy-v1.json",
);

let cached = null;

export async function loadDemoAuditPolicy() {
  if (cached) {
    return cached;
  }
  const parsed = JSON.parse(await fs.readFile(policyPath, "utf8"));
  if (!parsed || parsed.policyId !== "audit-policy-demo-v1") {
    fail("INVALID_AUTHORITY", "demo audit policy is missing");
  }
  cached = parsed;
  return parsed;
}

export function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

export function envelope({
  schema,
  id,
  now,
  actorType,
  actorId,
  correlationId,
  targetCommitGroupId,
  supersedesId,
  policyVersion,
  extra,
}) {
  return {
    schema,
    id,
    createdAt: now,
    recordedAt: now,
    actorType,
    actorId,
    correlationId,
    commitGroupId: targetCommitGroupId,
    supersedesId: supersedesId ?? null,
    policyVersion: policyVersion ?? extra?.policyVersion ?? "audit-v1",
    ...extra,
  };
}

export const AUTHORITY_FROZEN_KEYS = Object.freeze([
  "auditPeriodId",
  "auditPeriodStartAt",
  "auditPeriodEndAt",
  "selectionCutoffAt",
  "universeAsOf",
  "responseDeadline",
  "sampleSize",
  "calendarRuleVersion",
  "universeRuleVersion",
  "seedDerivationVersion",
  "algorithmVersion",
  "watermarkCaptureGraceMs",
  "authorityPolicyVersion",
]);

export const SELECTION_FROZEN_KEYS = Object.freeze([
  "sampleSize",
  "calendarRuleVersion",
  "universeRuleVersion",
  "seedDerivationVersion",
  "algorithmVersion",
  "responseDeadline",
  "watermarkCaptureGraceMs",
  "selectionCutoffAt",
  "universeAsOf",
  "auditPeriodStartAt",
  "auditPeriodEndAt",
]);

export function rejectOverrides(payload, keys) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) {
      fail("OVERRIDE_FORBIDDEN", `${key} cannot be overridden by caller`);
    }
  }
}

export function authorityCanonical(policy, recordedAt) {
  return {
    auditPeriodId: policy.auditPeriodId,
    authorityPolicyVersion: policy.authorityPolicyVersion,
    approvedPolicySnapshotRef: policy.snapshotRef,
    approvedPolicySnapshotHash: canonicalHash(policy),
    policyApprovedAt: policy.approvedAt,
    auditPeriodStartAt: policy.auditPeriodStartAt,
    auditPeriodEndAt: policy.auditPeriodEndAt,
    selectionCutoffAt: policy.selectionCutoffAt,
    responseDeadline: policy.responseDeadline,
    sampleSize: policy.sampleSize,
    calendarRuleVersion: policy.calendarRuleVersion,
    universeRuleVersion: policy.universeRuleVersion,
    seedDerivationVersion: policy.seedDerivationVersion,
    algorithmVersion: policy.algorithmVersion,
    watermarkCaptureGraceMs: policy.watermarkCaptureGraceMs,
    recordedAt,
  };
}

export function authorityHash(policy, recordedAt) {
  return canonicalHash(authorityCanonical(policy, recordedAt));
}

export function authorityHashFromReceipt(row) {
  return canonicalHash({
    auditPeriodId: row.auditPeriodId,
    authorityPolicyVersion: row.authorityPolicyVersion,
    approvedPolicySnapshotRef: row.approvedPolicySnapshotRef,
    approvedPolicySnapshotHash: row.approvedPolicySnapshotHash,
    policyApprovedAt: row.policyApprovedAt,
    auditPeriodStartAt: row.auditPeriodStartAt,
    auditPeriodEndAt: row.auditPeriodEndAt,
    selectionCutoffAt: row.selectionCutoffAt,
    responseDeadline: row.responseDeadline,
    sampleSize: row.sampleSize,
    calendarRuleVersion: row.calendarRuleVersion,
    universeRuleVersion: row.universeRuleVersion,
    seedDerivationVersion: row.seedDerivationVersion,
    algorithmVersion: row.algorithmVersion,
    watermarkCaptureGraceMs: row.watermarkCaptureGraceMs,
    recordedAt: row.recordedAt,
  });
}

export function authorityKeyOf(policy) {
  return canonicalHash({
    auditPeriodId: policy.auditPeriodId,
    authorityPolicyVersion: policy.authorityPolicyVersion,
  });
}

export function assertAuthorityTimeOrder({
  policyApprovedAt,
  recordedAt,
  auditPeriodStartAt,
  auditPeriodEndAt,
  selectionCutoffAt,
  universeAsOf,
  responseDeadline,
}) {
  if (
    !(
      policyApprovedAt <= recordedAt &&
      recordedAt < auditPeriodStartAt &&
      auditPeriodStartAt < auditPeriodEndAt &&
      auditPeriodEndAt <= selectionCutoffAt &&
      selectionCutoffAt === universeAsOf &&
      selectionCutoffAt < responseDeadline
    )
  ) {
    fail(
      "INVALID_AUTHORITY",
      "policyApprovedAt <= recordedAt < periodStart < periodEnd <= selectionCutoff=universeAsOf < responseDeadline required",
    );
  }
}

export function assertWatermarkGrace({
  selectionCutoffAt,
  watermarkCapturedAt,
  watermarkCaptureGraceMs,
}) {
  const cutoffMs = Date.parse(selectionCutoffAt);
  const capturedMs = Date.parse(watermarkCapturedAt);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(capturedMs)) {
    fail("WATERMARK_GRACE_EXCEEDED", "watermark capture time is not computable");
  }
  if (capturedMs < cutoffMs || capturedMs > cutoffMs + watermarkCaptureGraceMs) {
    fail(
      "WATERMARK_GRACE_EXCEEDED",
      "watermarkCapturedAt must satisfy cutoff <= capturedAt <= cutoff + grace",
    );
  }
}
