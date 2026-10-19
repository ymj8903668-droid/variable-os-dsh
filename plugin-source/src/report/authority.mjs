// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { fail } from "./errors.mjs";
import {
  assertAuthorityTimeOrder,
  authorityCanonical,
  authorityHash,
  loadDemoMetricPolicy,
  rejectOverrides,
} from "./policy.mjs";

const ACTOR_ID = "system:demo-runner";
const ACTOR_TYPE = "SYSTEM";
const POLICY_VERSION = "metric-report-authority-v1";

function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

export async function createMetricReportAuthority({ store, now, command = {} }) {
  const policy = await loadDemoMetricPolicy();
  rejectOverrides(command.payload || command, policy);
  const clock = clockOf(now);
  const semanticKey = `metric-authority-v1:${policy.reportId}`;
  const runtime = new CommandRuntime({ store, now: clock });
  return runtime.execute({
    commandType: "createMetricReportAuthority",
    idempotencyKey: semanticKey,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId: `mauth:${policy.reportId}`,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      reportId: policy.reportId,
      approvedMetricPolicySnapshotHash: canonicalHash(policy),
    },
    immutableInputRefs: [
      {
        type: "METRIC_POLICY",
        id: policy.policyId,
        hash: canonicalHash(policy),
      },
    ],
    builderVersion: "metric-authority-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({ targetCommitGroupId, now: stamped }) => {
      assertAuthorityTimeOrder({
        policyApprovedAt: policy.approvedAt,
        recordedAt: stamped,
        reportWindowStartAt: policy.reportWindowStartAt,
        reportWindowEndAt: policy.reportWindowEndAt,
        asOf: policy.asOf,
      });
      const canonical = authorityCanonical(policy, stamped);
      const hash = authorityHash(policy, stamped);
      const id = brandedId("mauth_", {
        reportId: policy.reportId,
        authorityHash: hash,
      });
      return [
        {
          file: "events",
          record: {
            schema: "metric-report-authority-receipt-v1",
            id,
            createdAt: stamped,
            recordedAt: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId: `mauth:${policy.reportId}`,
            commitGroupId: targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            reportId: canonical.reportId,
            approvedMetricPolicySnapshotRef: canonical.approvedMetricPolicySnapshotRef,
            approvedMetricPolicySnapshotHash:
              canonical.approvedMetricPolicySnapshotHash,
            policyApprovedAt: canonical.policyApprovedAt,
            cohortName: canonical.cohortName,
            cohortVersion: canonical.cohortVersion,
            reportWindowStartAt: canonical.reportWindowStartAt,
            reportWindowEndAt: canonical.reportWindowEndAt,
            asOf: canonical.asOf,
            selectorVersions: canonical.selectorVersions,
            ruleVersions: canonical.ruleVersions,
            requiredAuditPeriodIds: canonical.requiredAuditPeriodIds,
            authorityHash: hash,
          },
        },
      ];
    },
  });
}

export function findAuthority(events, reportId) {
  const rows = (events || []).filter(
    (row) =>
      row &&
      row.schema === "metric-report-authority-receipt-v1" &&
      (!reportId || row.reportId === reportId),
  );
  if (rows.length > 1) {
    fail("HEAD_AMBIGUOUS", "multiple metric report authorities");
  }
  return rows[0] || null;
}
