// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";

import { buildCanonicalDecisionInput } from "../decision/canonical-input.mjs";
import { auditTimeGates } from "../decision/time-gate.mjs";
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { resolveSourceAvailability } from "./source-time.mjs";

const BUILDER_VERSION = "live-scan-v1";
const POLICY_VERSION = "live-source-screen-v1";
const REGISTRY_VERSION = "source-registry-live-v1";

function fail(message) {
  const error = new Error(message);
  error.code = "LIVE_SOURCE_INVALID";
  throw error;
}

function assertItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fail("live source item required");
  }
  for (const key of [
    "sourceNamespace",
    "sourceDocumentKey",
    "sourceKind",
    "rawUri",
    "contentHash",
  ]) {
    if (typeof item[key] !== "string" || !item[key]) {
      fail(`live source ${key} required`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(item.contentHash)) {
    fail("live source contentHash must be SHA-256");
  }
  if (!path.isAbsolute(item.rawUri) || item.rawUri.includes("\0")) {
    fail("live source rawUri must be an absolute local file");
  }
  if (String(item.excerpt || "").length > 16_000) {
    fail("live source excerpt exceeded limit");
  }
}

function envelope({ schema, id, now, targetCommitGroupId, correlationId, extra }) {
  return {
    schema,
    id,
    createdAt: now,
    recordedAt: now,
    actorType: "SYSTEM",
    actorId: "system:source-worker",
    correlationId,
    commitGroupId: targetCommitGroupId,
    supersedesId: null,
    policyVersion: POLICY_VERSION,
    ...extra,
  };
}

function buildMembers({
  assignId,
  targetCommitGroupId,
  canonicalCommandInput,
  now,
  item,
}) {
  const correlationId = canonicalCommandInput.correlationId;
  const coverageId = assignId("source-coverage-receipt-v1", "coverage");
  const scanRunId = assignId("scan-run-v1", "run");
  const sourceItemId = assignId("source-item-v1", "source");
  const exposureId = assignId("scan-exposure-v1", "exposure");
  const contextId = assignId("decision-context-v1", "context");
  const auditId = assignId("time-gate-audit-v1", "audit");
  const attemptId = assignId("screening-attempt-v1", "attempt");
  const receiptId = assignId("scan-receipt-v1", "receipt");
  const availability = resolveSourceAvailability({
    declaredPublishedAt: item.declaredPublishedAt || null,
    retrievedAt: item.firstRetrievedAt || now,
  });
  const identityManifest = [
    {
      sourceNamespace: item.sourceNamespace,
      sourceDocumentKey: item.sourceDocumentKey,
      contentHash: item.contentHash,
    },
  ];
  const sourceManifests = [
    {
      sourceNamespace: item.sourceNamespace,
      querySpecHash: canonicalHash({
        connectorId: item.connectorId || item.sourceNamespace,
        sourceDocumentKey: item.sourceDocumentKey,
      }),
      rangeStart: item.declaredPublishedAt || null,
      rangeEnd: item.declaredPublishedAt || null,
      cursorStart: item.sourceDocumentKey,
      cursorEnd: item.sourceDocumentKey,
      sourceWatermark: item.contentHash,
      adapterVersion: canonicalCommandInput.adapterVersion,
      itemIdentityManifestRef: `runtime://${item.sourceNamespace}/${item.contentHash}`,
      itemIdentityManifestHash: canonicalHash(identityManifest),
      expectedItemCount: 1,
      enumerationStatus: "COMPLETE",
    },
  ];
  const contextItem = {
    id: `ctxi_${sourceItemId}`,
    stream: "FOCAL",
    refType: "SOURCE_ITEM",
    refId: sourceItemId,
    availabilityReceiptId: null,
    resolutionReceiptId: null,
    availableAt: availability.availableAt,
    resolvedAt: null,
    contentHash: item.contentHash,
    memberRefs: [],
    payload: {
      structuredInput: {
        sourceNamespace: item.sourceNamespace,
        sourceDocumentKey: item.sourceDocumentKey,
        contentHash: item.contentHash,
        rawUri: item.rawUri,
      },
    },
  };
  const canonical = buildCanonicalDecisionInput({
    decisionType: "SCREENING",
    subjectRef: { type: "SCAN_EXPOSURE", id: exposureId },
    focalEventInstanceId: null,
    contextCutoffAt: now,
    contextItems: [contextItem],
    engine: {
      engineType: "MODEL",
      modelVersion: canonicalCommandInput.modelVersion,
      promptVersion: canonicalCommandInput.promptVersion,
      canonicalDecisionInput: {
        modelRequest: {
          action: "EVIDENCE_CATALYST_ANALYSIS",
          sourceItemId,
          contentHash: item.contentHash,
        },
      },
    },
    policyVersion: POLICY_VERSION,
  });
  const audit = auditTimeGates({
    contextCutoffAt: now,
    contextItems: canonical.contextItems,
  });
  const blocked = audit.overallResult !== "PASS";
  const records = [
    envelope({
      schema: "source-coverage-receipt-v1",
      id: coverageId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        sourceRegistryVersion: REGISTRY_VERSION,
        sourceManifests,
        expectedCount: 1,
        manifestHash: canonicalHash(sourceManifests),
        hashAlgorithm: "SHA-256",
        canonicalizationVersion: "canonical-json-v1",
        capturedAt: now,
      },
    }),
    envelope({
      schema: "scan-run-v1",
      id: scanRunId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        sourceRegistryVersion: REGISTRY_VERSION,
        sourceCoverageReceiptId: coverageId,
        startedAt: now,
      },
    }),
    envelope({
      schema: "source-item-v1",
      id: sourceItemId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        sourceNamespace: item.sourceNamespace,
        sourceDocumentKey: item.sourceDocumentKey,
        sourceKind: item.sourceKind,
        rawUri: item.rawUri,
        contentHash: item.contentHash,
        quoteSpan:
          Number.isInteger(item.lineStart) && Number.isInteger(item.lineEnd)
            ? { start: item.lineStart, end: item.lineEnd }
            : null,
        excerpt: String(item.excerpt || "").slice(0, 16_000),
        declaredPublishedAt: availability.declaredPublishedAt,
        firstRetrievedAt: item.firstRetrievedAt || now,
        availableAt: availability.availableAt,
        sourceTimeConfidence: availability.sourceTimeConfidence,
        sensitivity: item.sensitivity || "INTERNAL",
        modelUseAllowed: item.modelUseAllowed === true,
        exportAllowed: item.exportAllowed === true,
        accessScope: Array.isArray(item.accessScope) ? item.accessScope : ["local"],
      },
    }),
    envelope({
      schema: "scan-exposure-v1",
      id: exposureId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        scanRunId,
        sourceItemId,
        sourceCursor: item.sourceDocumentKey,
        sequence: 1,
        eligibleAt: now,
        eligibilityRuleVersion: "live-source-eligibility-v1",
      },
    }),
    envelope({
      schema: "decision-context-v1",
      id: contextId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        decisionType: canonical.decisionType,
        subjectRef: canonical.subjectRef,
        engine: canonical.engine,
        contextCutoffAt: canonical.contextCutoffAt,
        focalEventInstanceId: canonical.focalEventInstanceId,
        contextItems: canonical.contextItems,
        serializationVersion: canonical.serializationVersion,
        hashAlgorithm: "SHA-256",
        contextHash: canonical.contextHash,
      },
    }),
    envelope({
      schema: "time-gate-audit-v1",
      id: auditId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        decisionContextId: contextId,
        itemResults: audit.itemResults,
        gates: audit.gates,
        overallResult: audit.overallResult,
        failureCodes: audit.failureCodes,
        auditedAt: now,
      },
    }),
    envelope({
      schema: "screening-attempt-v1",
      id: attemptId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        scanExposureId: exposureId,
        decisionContextId: contextId,
        timeGateAuditId: auditId,
        result: blocked ? "BLOCKED_TIME_AUDIT" : "ENGINE_FAILED",
        screeningDecisionId: null,
        failureCode: blocked
          ? audit.failureCodes[0] || "TIME_AUDIT_FAILED"
          : "CARD_SYNTHESIS_DEFERRED",
        terminalAt: now,
      },
    }),
    envelope({
      schema: "scan-receipt-v1",
      id: receiptId,
      now,
      targetCommitGroupId,
      correlationId,
      extra: {
        scanRunId,
        sourceCoverageReceiptId: coverageId,
        coverageStatus: blocked ? "NOT_COMPUTABLE" : "COMPUTABLE",
        runHealth: blocked ? "FAILED" : "SUCCESS",
        contentOutcome: blocked ? "UNKNOWN" : "HAS_CANDIDATE",
        counts: {
          expected: 1,
          seen: 1,
          terminalScreeningAttempts: 1,
          blockedTimeAudit: blocked ? 1 : 0,
          engineFailed: blocked ? 0 : 1,
          duplicates: 0,
          candidates: blocked ? 0 : 1,
          cardsCreated: 0,
        },
        sourceFailures: [],
        lastSuccessfulAt: blocked ? null : now,
        completedAt: now,
        gaps: blocked ? [{ reason: "TIME_AUDIT_FAILED" }] : [],
      },
    }),
  ];
  return records.map((record) => ({
    file: record.schema === "source-item-v1" ? "source_items" : "events",
    record,
  }));
}

export async function runLiveScan({
  store,
  now = () => new Date().toISOString(),
  item,
  idempotencyKey,
  adapterVersion = "live-source-adapter-v1",
  modelVersion = "pending-analysis",
  promptVersion = "evidence-catalyst-v2",
} = {}) {
  assertItem(item);
  if (!store || typeof store.readAll !== "function") {
    fail("ledger store required");
  }
  if (typeof idempotencyKey !== "string" || !idempotencyKey) {
    fail("idempotencyKey required");
  }
  const clock = typeof now === "function" ? now : () => now;
  const correlationId = `live-scan:${item.sourceNamespace}:${item.contentHash}`;
  const runtime = new CommandRuntime({ store, now: clock, cooperativeWrites: true });
  const executed = await runtime.execute({
    commandType: "scanLiveSourceOnce",
    idempotencyKey,
    actorType: "SYSTEM",
    actorId: "system:source-worker",
    correlationId,
    policyVersion: POLICY_VERSION,
    canonicalCommandInput: {
      sourceNamespace: item.sourceNamespace,
      sourceDocumentKey: item.sourceDocumentKey,
      contentHash: item.contentHash,
      adapterVersion,
      modelVersion,
      promptVersion,
      registryVersion: REGISTRY_VERSION,
      correlationId,
    },
    immutableInputRefs: [],
    builderVersion: BUILDER_VERSION,
    engineResultId: null,
    expectedHeads: [],
    buildMembers: (args) => buildMembers({ ...args, item }),
  });
  const events = await store.readAll("events");
  const members = events.filter((row) => executed.memberRecordIds.includes(row.id));
  const receipt = members.find((row) => row.schema === "scan-receipt-v1");
  const exposure = members.find((row) => row.schema === "scan-exposure-v1");
  if (!receipt || !exposure) {
    fail("live scan receipt or exposure missing after commit");
  }
  return {
    runHealth: receipt.runHealth,
    contentOutcome: receipt.contentOutcome,
    coverageStatus: receipt.coverageStatus,
    counts: receipt.counts,
    failures: receipt.sourceFailures,
    gaps: receipt.gaps || [],
    scanRunId: receipt.scanRunId,
    scanExposureId: exposure.id,
    sourceItemId: exposure.sourceItemId,
    commitGroupId: executed.commitGroupId,
    reused: executed.reused,
    memberRecordIds: executed.memberRecordIds,
  };
}
