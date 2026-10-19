// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { fail } from "./errors.mjs";
import {
  AUTHORITY_FROZEN_KEYS,
  assertAuthorityTimeOrder,
  authorityCanonical,
  authorityHash,
  authorityKeyOf,
  clockOf,
  envelope,
  loadDemoAuditPolicy,
  rejectOverrides,
} from "./policy.mjs";

const ACTOR_ID = "system:demo-runner";
const ACTOR_TYPE = "SYSTEM";
const POLICY_VERSION = "audit-period-authority-v1";

export async function createAuditPeriodAuthority({ store, now, command = {} }) {
  const policy = await loadDemoAuditPolicy();
  rejectOverrides(command.payload || command, AUTHORITY_FROZEN_KEYS);
  const clock = clockOf(now);
  const semanticKey = `audit-authority-v1:${policy.auditPeriodId}`;
  const runtime = new CommandRuntime({ store, now: clock });
  return runtime.execute({
    commandType: "createAuditPeriodAuthority",
    idempotencyKey: semanticKey,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId: `aauth:${policy.auditPeriodId}`,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      auditPeriodId: policy.auditPeriodId,
      approvedPolicySnapshotHash: canonicalHash(policy),
    },
    immutableInputRefs: [
      {
        type: "AUDIT_POLICY",
        id: policy.policyId,
        hash: canonicalHash(policy),
      },
    ],
    builderVersion: "audit-authority-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({ targetCommitGroupId, now: stamped }) => {
      assertAuthorityTimeOrder({
        policyApprovedAt: policy.approvedAt,
        recordedAt: stamped,
        auditPeriodStartAt: policy.auditPeriodStartAt,
        auditPeriodEndAt: policy.auditPeriodEndAt,
        selectionCutoffAt: policy.selectionCutoffAt,
        universeAsOf: policy.universeAsOf,
        responseDeadline: policy.responseDeadline,
      });
      const canonical = authorityCanonical(policy, stamped);
      const hash = authorityHash(policy, stamped);
      const id = brandedId("aauth_", {
        auditPeriodId: policy.auditPeriodId,
        authorityHash: hash,
      });
      return [
        {
          file: "events",
          record: envelope({
            schema: "audit-period-authority-receipt-v1",
            id,
            now: stamped,
            actorType: ACTOR_TYPE,
            actorId: ACTOR_ID,
            correlationId: `aauth:${policy.auditPeriodId}`,
            targetCommitGroupId,
            supersedesId: null,
            policyVersion: POLICY_VERSION,
            extra: {
              auditPeriodId: canonical.auditPeriodId,
              authorityPolicyVersion: canonical.authorityPolicyVersion,
              approvedPolicySnapshotRef: canonical.approvedPolicySnapshotRef,
              approvedPolicySnapshotHash: canonical.approvedPolicySnapshotHash,
              policyApprovedAt: canonical.policyApprovedAt,
              auditPeriodStartAt: canonical.auditPeriodStartAt,
              auditPeriodEndAt: canonical.auditPeriodEndAt,
              selectionCutoffAt: canonical.selectionCutoffAt,
              responseDeadline: canonical.responseDeadline,
              sampleSize: canonical.sampleSize,
              calendarRuleVersion: canonical.calendarRuleVersion,
              universeRuleVersion: canonical.universeRuleVersion,
              seedDerivationVersion: canonical.seedDerivationVersion,
              algorithmVersion: canonical.algorithmVersion,
              watermarkCaptureGraceMs: canonical.watermarkCaptureGraceMs,
              authorityHash: hash,
              authorityKey: authorityKeyOf(policy),
            },
          }),
        },
      ];
    },
  });
}

export function findAuditAuthority(events, auditPeriodId) {
  const rows = (events || []).filter(
    (row) =>
      row &&
      row.schema === "audit-period-authority-receipt-v1" &&
      (!auditPeriodId || row.auditPeriodId === auditPeriodId),
  );
  if (rows.length > 1) {
    fail("HEAD_AMBIGUOUS", "multiple audit period authorities");
  }
  return rows[0] || null;
}
