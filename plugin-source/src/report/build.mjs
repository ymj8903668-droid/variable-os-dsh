// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { fail } from "./errors.mjs";
import { freezeLedgerHeads } from "../feedback/watermark.mjs";
import { findAuthority } from "./authority.mjs";
import {
  loadDemoMetricPolicy,
  rejectOverrides,
  selectorVersionsOf,
} from "./policy.mjs";
import { eventsAtAsOf } from "../ledger/as-of.mjs";
import {
  assembleMembers,
  buildCohortUniverse,
  cohortIntegrity,
} from "./universe.mjs";
import {
  attachAuditSampleRefs,
  collectAuditInclusion,
} from "../audit/inclusion.mjs";

const ACTOR_ID = "system:demo-runner";
const ACTOR_TYPE = "SYSTEM";
const POLICY_VERSION = "metric-cohort-snapshot-v1";
const COHORT_NAME = "OBSERVED_TIMELY_DISCOVERY_BASE";

function clockOf(now) {
  if (typeof now === "function") {
    return now;
  }
  if (typeof now === "string") {
    return () => now;
  }
  return () => new Date().toISOString();
}

export function watermarkManifest(projected) {
  const eventsHead =
    projected.events && projected.events.length
      ? projected.events[projected.events.length - 1].id
      : null;
  const sourceHead =
    projected.sourceItems && projected.sourceItems.length
      ? projected.sourceItems[projected.sourceItems.length - 1].id
      : null;
  const receipts = (projected.events || [])
    .filter((row) => row.schema === "commit-group-receipt-v1")
    .map((row) => [row.id, row.groupHash])
    .sort((left, right) => (left[0] < right[0] ? -1 : 1));
  return { eventsHead, sourceHead, receipts };
}

export function snapshotIdentity(fields) {
  const selectorVersions = selectorVersionsOf(fields);
  return {
    reportAuthorityReceiptId: fields.reportAuthorityReceiptId,
    reportAuthorityHash: fields.reportAuthorityHash,
    cohortName: fields.cohortName,
    cohortVersion: fields.cohortVersion,
    reportWindowStartAt: fields.reportWindowStartAt,
    reportWindowEndAt: fields.reportWindowEndAt,
    asOf: fields.asOf,
    inputLedgerWatermarkReceiptId: fields.inputLedgerWatermarkReceiptId,
    inputWatermarkHash: fields.inputWatermarkHash,
    cohortUniverseHash: fields.cohortUniverseHash,
    membersHash: fields.membersHash,
    auditReceiptManifestHash: fields.auditReceiptManifestHash,
    selectorVersions,
    ruleVersions: fields.ruleVersions,
  };
}

export function membersManifest(members) {
  return [...(members || [])]
    .map((row) => ({ ...row }))
    .sort((left, right) =>
      left.opportunityClassId < right.opportunityClassId
        ? -1
        : left.opportunityClassId > right.opportunityClassId
          ? 1
          : 0,
    );
}

export function membersHashOf(members) {
  return canonicalHash(membersManifest(members));
}

export function sliceProjection(projected, { eventsHead, sourceHead, expectedHash }) {
  const events = Array.isArray(projected.events) ? projected.events : [];
  const sources = Array.isArray(projected.sourceItems) ? projected.sourceItems : [];
  let slicedEvents = events;
  if (eventsHead) {
    const index = events.findIndex((row) => row.id === eventsHead);
    if (index < 0) {
      return { ok: false, reason: "EVENTS_HEAD_MISSING" };
    }
    slicedEvents = events.slice(0, index + 1);
  } else if (events.length > 0) {
    return { ok: false, reason: "EVENTS_HEAD_MISSING" };
  }
  let slicedSources = sources;
  if (sourceHead) {
    const index = sources.findIndex((row) => row.id === sourceHead);
    if (index < 0) {
      return { ok: false, reason: "SOURCE_HEAD_MISSING" };
    }
    slicedSources = sources.slice(0, index + 1);
  } else if (sources.length > 0) {
    return { ok: false, reason: "SOURCE_HEAD_MISSING" };
  }
  const sliced = { events: slicedEvents, sourceItems: slicedSources };
  const manifest = watermarkManifest(sliced);
  const hash = canonicalHash(manifest);
  if (manifest.eventsHead !== (eventsHead || null)) {
    return { ok: false, reason: "WATERMARK_HEAD_MISMATCH" };
  }
  if (manifest.sourceHead !== (sourceHead || null)) {
    return { ok: false, reason: "WATERMARK_HEAD_MISMATCH" };
  }
  if (expectedHash && hash !== expectedHash) {
    return { ok: false, reason: "WATERMARK_HASH_MISMATCH" };
  }
  return { ok: true, ...sliced, hash, manifest };
}

export function expandSnapshotWatermark(projected, snapshot) {
  if (!snapshot || !snapshot.inputLedgerWatermarkReceiptId) {
    return { ok: false, reason: "MISSING_WATERMARK" };
  }
  const receipt = (projected.events || []).find(
    (row) => row.id === snapshot.inputLedgerWatermarkReceiptId,
  );
  if (!receipt || receipt.schema !== "ledger-watermark-receipt-v1") {
    return { ok: false, reason: "MISSING_WATERMARK" };
  }
  if (receipt.manifestHash !== snapshot.inputWatermarkHash) {
    return { ok: false, reason: "WATERMARK_HASH_MISMATCH" };
  }
  return sliceProjection(projected, {
    eventsHead: receipt.eventsHead,
    sourceHead: receipt.sourceHead,
    expectedHash: receipt.manifestHash,
  });
}

export async function createMetricCohortSnapshot({
  store,
  now,
  command = {},
  membersOverride,
}) {
  const policy = await loadDemoMetricPolicy();
  rejectOverrides(command.payload || {}, policy);
  const clock = clockOf(now);
  const runtime = new CommandRuntime({ store, now: clock });
  const projected = await runtime.project();
  const authority = findAuthority(projected.events, policy.reportId);
  if (!authority) {
    fail("INVALID_AUTHORITY", "metric report authority is not committed");
  }
  if (
    authority.cohortName !== COHORT_NAME ||
    authority.reportWindowStartAt !== policy.reportWindowStartAt ||
    authority.reportWindowEndAt !== policy.reportWindowEndAt ||
    authority.asOf !== policy.asOf ||
    canonicalHash(authority.selectorVersions) !==
      canonicalHash(policy.selectorVersions)
  ) {
    fail("OVERRIDE_FORBIDDEN", "snapshot window/selectors must match authority");
  }
  const liveManifest = watermarkManifest(projected);
  const liveHash = canonicalHash(liveManifest);
  const expected =
    command.payload && command.payload.expectedWatermarkHash
      ? command.payload.expectedWatermarkHash
      : null;
  const semanticKey = `metric-snapshot-v1:${authority.id}`;
  const frozen = await freezeLedgerHeads({
    store,
    projected,
    commandType: "createMetricCohortSnapshot",
    idempotencyKey: semanticKey,
  });
  const frozenInput = frozen.intent ? frozen.intent.canonicalCommandInput : null;
  const staleWatermark = frozenInput
    ? Boolean(frozenInput.staleWatermark)
    : Boolean(expected && expected !== liveHash);
  const inputWatermarkHash = frozenInput
    ? frozenInput.inputWatermarkHash
    : staleWatermark
      ? expected
      : liveHash;
  const eventsHead = frozenInput
    ? frozenInput.eventsHead
    : liveManifest.eventsHead;
  const sourceHead = frozenInput
    ? frozenInput.sourceHead
    : liveManifest.sourceHead;
  const asOf = authority.asOf;
  const stampedProbe = clock();
  if (!(authority.reportWindowEndAt <= asOf && asOf <= stampedProbe)) {
    fail("INVALID_AUTHORITY", "asOf is outside watermark capture window");
  }
  const correlationId = `coh:${authority.reportId}`;
  return runtime.execute({
    commandType: "createMetricCohortSnapshot",
    idempotencyKey: semanticKey,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      reportAuthorityReceiptId: authority.id,
      reportAuthorityHash: authority.authorityHash,
      inputWatermarkHash,
      staleWatermark,
      eventsHead,
      sourceHead,
      cohortName: authority.cohortName,
      asOf,
    },
    immutableInputRefs: [
      {
        type: "METRIC_REPORT_AUTHORITY",
        id: authority.id,
        hash: canonicalHash(authority),
      },
    ],
    builderVersion: "metric-cohort-v1",
    engineResultId: null,
    expectedHeads: [],
    buildMembers: ({
      assignId,
      targetCommitGroupId,
      now: stamped,
      committedProjection,
      canonicalCommandInput,
    }) => {
      const committed = committedProjection;
      const liveAuthority = findAuthority(committed.events, policy.reportId);
      if (!liveAuthority || liveAuthority.id !== authority.id) {
        fail("INVALID_AUTHORITY", "authority is not committed");
      }
      const sliced = sliceProjection(committed, {
        eventsHead: canonicalCommandInput.eventsHead,
        sourceHead: canonicalCommandInput.sourceHead,
        expectedHash: canonicalCommandInput.staleWatermark
          ? null
          : canonicalCommandInput.inputWatermarkHash,
      });
      const eventsForMembers = sliced.ok ? sliced.events : [];
      const asOfEvents = eventsAtAsOf(eventsForMembers, asOf);
      const universe = buildCohortUniverse(asOfEvents, asOf);
      let members = assembleMembers({
        events: asOfEvents,
        universe,
        asOf,
      });
      if (Array.isArray(membersOverride)) {
        members = membersOverride;
      }
      const audit = collectAuditInclusion(
        asOfEvents,
        liveAuthority.requiredAuditPeriodIds || [],
        {
          sourceItems: sliced.ok ? sliced.sourceItems : [],
        },
      );
      const attached = attachAuditSampleRefs({
        members,
        events: asOfEvents,
        asOf,
        receipts: audit.receipts,
      });
      members = attached.members;
      const integrity = cohortIntegrity(universe.classes, members);
      const auditIds = audit.ids;
      const auditReasons = [...audit.reasonCodes, ...attached.reasonCodes];
      const reasons = [
        ...(canonicalCommandInput.staleWatermark ? ["STALE_WATERMARK"] : []),
        ...(!sliced.ok ? [sliced.reason || "WATERMARK_DRIFT"] : []),
        ...integrity.reasonCodes,
        ...auditReasons,
      ];
      const auditManifestHash = canonicalHash(auditIds);
      const membersHash = membersHashOf(members);
      const watermarkId = assignId("ledger-watermark-receipt-v1", "metric-watermark");
      const snapshotFields = {
        reportAuthorityReceiptId: liveAuthority.id,
        reportAuthorityHash: liveAuthority.authorityHash,
        cohortName: liveAuthority.cohortName,
        cohortVersion: liveAuthority.cohortVersion,
        reportWindowStartAt: liveAuthority.reportWindowStartAt,
        reportWindowEndAt: liveAuthority.reportWindowEndAt,
        asOf,
        inputLedgerWatermarkReceiptId: watermarkId,
        inputWatermarkHash: canonicalCommandInput.inputWatermarkHash,
        cohortUniverseHash: universe.hash,
        membersHash,
        auditReceiptManifestHash: auditManifestHash,
        selectorVersions: selectorVersionsOf(liveAuthority),
        ruleVersions: liveAuthority.ruleVersions,
      };
      const snapshotHash = canonicalHash(snapshotIdentity(snapshotFields));
      const snapshotId = brandedId("coh_", {
        reportAuthorityReceiptId: liveAuthority.id,
        inputWatermarkHash: snapshotFields.inputWatermarkHash,
      });
      const watermark = {
        schema: "ledger-watermark-receipt-v1",
        id: watermarkId,
        createdAt: stamped,
        recordedAt: stamped,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        eventsHead: canonicalCommandInput.eventsHead,
        sourceHead: canonicalCommandInput.sourceHead,
        capturedAt: stamped,
        manifestHash: canonicalCommandInput.inputWatermarkHash,
      };
      const snapshot = {
        schema: "metric-cohort-snapshot-v1",
        id: snapshotId,
        createdAt: stamped,
        recordedAt: stamped,
        actorType: ACTOR_TYPE,
        actorId: ACTOR_ID,
        correlationId,
        commitGroupId: targetCommitGroupId,
        supersedesId: null,
        policyVersion: POLICY_VERSION,
        cohortName: liveAuthority.cohortName,
        cohortVersion: liveAuthority.cohortVersion,
        reportWindowStartAt: liveAuthority.reportWindowStartAt,
        reportWindowEndAt: liveAuthority.reportWindowEndAt,
        asOf,
        reportAuthorityReceiptId: liveAuthority.id,
        reportAuthorityHash: liveAuthority.authorityHash,
        computationStatus: reasons.length ? "NOT_COMPUTABLE" : "COMPUTABLE",
        notComputableReasonCodes: reasons,
        cohortUniverseRuleVersion:
          liveAuthority.selectorVersions.cohortUniverseRuleVersion,
        cohortUniverseManifestRef: `synthetic://cohort/${snapshotId}`,
        cohortUniverseCount: universe.count,
        cohortUniverseHash: universe.hash,
        members,
        memberCount: members.length,
        membersHash,
        opportunityRelationEventIds: eventsForMembers
          .filter((row) => row.schema === "opportunity-relation-event-v1")
          .map((row) => row.id)
          .sort(),
        opportunityRelationDecisionIds: eventsForMembers
          .filter((row) => row.schema === "opportunity-relation-decision-v1")
          .map((row) => row.id)
          .sort(),
        auditSampleSelectionReceiptIds: auditIds,
        auditReceiptInclusionRuleVersion:
          liveAuthority.selectorVersions.auditReceiptInclusionRuleVersion,
        auditReceiptManifestRef: auditIds.length
          ? `synthetic://audit/${canonicalHash(auditIds)}`
          : "synthetic://audit-empty",
        auditReceiptCount: auditIds.length,
        auditReceiptManifestHash: auditManifestHash,
        equivalenceResolverVersion:
          liveAuthority.selectorVersions.equivalenceResolverVersion,
        adjudicationSelectionRuleVersion:
          liveAuthority.selectorVersions.adjudicationSelectionRuleVersion,
        reactionAssessmentSelectionRuleVersion:
          liveAuthority.selectorVersions.reactionAssessmentSelectionRuleVersion,
        ruleVersions: liveAuthority.ruleVersions,
        inputLedgerWatermarkReceiptId: watermarkId,
        inputWatermarkHash: canonicalCommandInput.inputWatermarkHash,
        watermarkCapturedAt: stamped,
        snapshotHash,
        idempotencyKey: semanticKey,
      };
      return [
        { file: "events", record: watermark },
        { file: "events", record: snapshot },
      ];
    },
  });
}

export function findSnapshot(events, snapshotId) {
  const rows = (events || []).filter(
    (row) => row && row.schema === "metric-cohort-snapshot-v1",
  );
  if (snapshotId) {
    return rows.find((row) => row.id === snapshotId) || null;
  }
  return rows.length ? rows[rows.length - 1] : null;
}
