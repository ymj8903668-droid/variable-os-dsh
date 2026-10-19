// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { JsonlStore } from "../ledger/jsonl-store.mjs";
import { runLiveScan } from "../scan/live-scan.mjs";
import { materializeFromExposure } from "../card/materialize.mjs";
import { toCardEngineOutput } from "../runtime/evidence-catalyst-analyzer.mjs";
import { presentIncrementalCards } from "../presentation/present.mjs";
import { activateCompleteSnapshot, readActiveManifest } from "./snapshot-store.mjs";
import { rebuildResearchProjection } from "./projection.mjs";
import { assertWindowsPrivateTree, windowsPrivateDirectory, writeWindowsPrivateFile,
  invalidWindowsPrivateState } from "../runtime/windows-private-files.mjs";

const PRIVATE_WINDOWS = process.platform === "win32";

async function copyPrivateLedgerFile(source, destination) {
  const { openPrivateLedgerFile } = await import("../ledger/windows-private-ledger.mjs");
  const { createWindowsPrivateFile } = await import("../../packages/dsh-desk-ui/lib/windows-private-state.js");
  const input = await openPrivateLedgerFile(source);
  if (!input) return;
  let output;
  try {
    createWindowsPrivateFile(destination);
    output = await openPrivateLedgerFile(destination, { append: true });
    const buffer = Buffer.alloc(65536);
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await output.writeFile(buffer.subarray(0, bytesRead));
    }
    await output.sync();
  } finally {
    try { await input.close(); } finally { await output?.close(); }
  }
}

export async function copyPersonalGeneration({ previous, next, now }) {
  let active;
  if (PRIVATE_WINDOWS) {
    await assertWindowsPrivateTree(previous.ledgerRoot);
    await assertWindowsPrivateTree(previous.researchRoot);
    if (path.dirname(next.ledgerRoot) !== path.dirname(next.researchRoot) ||
      !await windowsPrivateDirectory(path.dirname(next.ledgerRoot))) invalidWindowsPrivateState();
    for (const target of [next.ledgerRoot, next.researchRoot]) {
      try { await fs.lstat(target); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw Object.assign(Error("EEXIST"), { code: "EEXIST" });
    }
    active = await readActiveManifest(previous.researchRoot);
    if (active?.status !== "COMPLETE" || !/^rsnap_[a-f0-9]{64}$/.test(active.snapshotId) ||
      active.snapshotPath !== path.join(previous.researchRoot, "snapshots", active.snapshotId, "snapshot.json")) {
      invalidWindowsPrivateState();
    }
    const { createPrivateDirectoryExclusive } = await import("../ledger/windows-private-ledger.mjs");
    createPrivateDirectoryExclusive(next.ledgerRoot);
    createPrivateDirectoryExclusive(next.researchRoot);
  } else {
    await fs.mkdir(next.ledgerRoot, { mode: 0o700 });
    await fs.mkdir(next.researchRoot, { mode: 0o700 });
  }
  for (const name of ["events.jsonl", "source_items.jsonl"]) {
    if (PRIVATE_WINDOWS) {
      await copyPrivateLedgerFile(path.join(previous.ledgerRoot, name), path.join(next.ledgerRoot, name));
      continue;
    }
    try { await fs.copyFile(path.join(previous.ledgerRoot, name), path.join(next.ledgerRoot, name),
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  active ??= await readActiveManifest(previous.researchRoot);
  const snapshot = JSON.parse(await fs.readFile(active.snapshotPath, "utf8"));
  const evidenceRecords = JSON.parse(await fs.readFile(path.join(path.dirname(active.snapshotPath), "evidence.json"), "utf8"));
  await activateCompleteSnapshot({ derivedRoot: next.researchRoot, snapshot, evidenceRecords, now, privateWindows: PRIVATE_WINDOWS });
}

/** Builds a private candidate; only the caller can authorize and activate it. */
export async function preparePersonalCard({
  previous, next, record, inputHash, analysis, provider, modelVersion, promptVersion, receivedAt, now, assertActive,
}) {
  const root = path.dirname(next.ledgerRoot);
  const ima = record.wikiOrigin?.provider === "ima";
  const sourceKind = ima ? "ima-wiki-excerpt" : "published-excerpt";
  const operationKind = ima ? "ima" : "published";
  const excerpt = ima ? [...new Set((analysis.evidence ?? []).map(row => row.quote))].join("\n") : record.excerpt;
  const proof = ima ? {
    datasetId: record.datasetId, evidenceId: record.evidenceId, contentHash: record.contentHash,
    datasetVersion: "UNKNOWN", eventAt: null, availableAt: null,
    wikiOrigin: record.wikiOrigin, modelUseAllowed: true, exportAllowed: false,
  } : record;
  await copyPersonalGeneration({ previous, next, now });
  const excerptFile = path.join(root, `${sourceKind}.txt`);
  const proofFile = path.join(root, ima ? "ima-input-proof.json" : "publication-proof.json");
  const proofText = JSON.stringify({ record: proof, receivedAt, model: { provider, modelVersion, promptVersion } }) + "\n";
  if (PRIVATE_WINDOWS) {
    await writeWindowsPrivateFile(excerptFile, excerpt);
    await writeWindowsPrivateFile(proofFile, proofText);
  } else {
    await fs.writeFile(excerptFile, excerpt, { flag: "wx", mode: 0o600 });
    await fs.writeFile(proofFile, proofText, { flag: "wx", mode: 0o600 });
  }
  assertActive();
  const store = new JsonlStore({ root: next.ledgerRoot, privateWindows: PRIVATE_WINDOWS,
    privateInspectionSession: PRIVATE_WINDOWS });
  const scan = await runLiveScan({
    store, now: () => now, idempotencyKey: `personal-${operationKind}-scan:${inputHash}`,
    adapterVersion: ima ? "personal-ima-quote-v1" : "personal-published-excerpt-v1", modelVersion, promptVersion,
    item: {
      sourceNamespace: `${ima ? "ima" : "published"}.${record.datasetId}`,
      sourceDocumentKey: `${record.sourceFamily}:${record.evidenceId}:${ima ? record.contentHash : record.revision}:${inputHash}`,
      sourceKind, rawUri: excerptFile,
      contentHash: createHash("sha256").update(excerpt).digest("hex"), excerpt,
      declaredPublishedAt: null, firstRetrievedAt: receivedAt,
      sensitivity: "RESTRICTED", modelUseAllowed: true, exportAllowed: false, accessScope: ["personal"],
    },
  });
  assertActive();
  const modelOutput = toCardEngineOutput(analysis);
  const sourceReference = item => ({ ...item, sourceType: sourceKind,
    sourcePath: ima ? record.evidenceId : `publication/${record.sourceFamily}/${inputHash}` });
  const validatedModelOutput = modelOutput.decision === "REJECT" ? modelOutput : {
    ...modelOutput,
    evidence: modelOutput.evidence.map(sourceReference),
  };
  const card = await materializeFromExposure({
    store, now: () => now, scanExposureId: scan.scanExposureId, engineType: "MODEL",
    validatedModelOutput, modelVersion, promptVersion,
    idempotencyKey: `personal-${operationKind}-card:${inputHash}`, horizonCalendarId: "sse-szse-2026-v1",
  });
  if (card.runStatus !== "SUCCEEDED") throw Object.assign(Error("CARD_MATERIALIZATION_FAILED"), { code: "CARD_MATERIALIZATION_FAILED" });
  assertActive();
  if (card.cardRevisionId) {
    await presentIncrementalCards({ store, now: () => now, callerKey: `personal:${inputHash}`,
      budgetPeriodId: new Date(Date.parse(now) + 8 * 3600_000).toISOString().slice(0, 10),
      candidates: [{ cardRevisionId: card.cardRevisionId, budgetBucket: "NEW" }] });
  }
  assertActive();
  const built = await rebuildResearchProjection({ derivedRoot: next.researchRoot, ledgerRoot: next.ledgerRoot, store, now,
    privateWindows: PRIVATE_WINDOWS });
  if (!built.ok) throw Object.assign(Error("PROJECTION_STALE"), { code: "PROJECTION_STALE" });
  // The native ledger fsyncs its writes; also persist the locally frozen excerpt.
  for (const file of [excerptFile, proofFile]) {
    const handle = await fs.open(file, PRIVATE_WINDOWS ? "r+" : "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  assertActive();
  return { cardRevisionId: card.cardRevisionId, decision: card.decision };
}
