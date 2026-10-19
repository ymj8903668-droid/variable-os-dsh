// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { JsonlStore } from "../ledger/jsonl-store.mjs";
import { SourceRuntimeStore } from "../runtime/source-runtime-store.mjs";
import { createDeskService } from "./desk-service-core.mjs";
import { queryEvidence } from "./query.mjs";
import { researchSnapshotId } from "./snapshot.mjs";
import { activateCompleteSnapshot } from "./snapshot-store.mjs";
import { rebuildResearchProjection } from "./projection.mjs";
import { createPublicationIntakeStore, validatePublicationBatch } from "../runtime/publication-intake-store.mjs";
import { createImaCandidateIntakeStore } from "../runtime/ima-candidate-intake-store.mjs";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { validateAnalysisOutput } from "../runtime/evidence-catalyst-analyzer.mjs";
import { personalCardSchemaDiagnostic } from "./personal-card-schema-diagnostic.mjs";
import { getAnnouncedCalendar } from "../card/announced-calendar.mjs";
import { resolveAShareHorizons } from "../card/horizon.mjs";
import { preparePersonalCard, copyPersonalGeneration } from "./personal-materialize.mjs";
import { handleCommand } from "../http/command.mjs";
import { imaCardIdentity, normalizeImaCardInput, imaCardDependency } from "../runtime/ima-card-input.mjs";
import { activatePersonalGeneration } from "./personal-activation.mjs";
import { validateWindowsPrivatePath, windowsPrivateDirectory, assertWindowsPrivateFile,
  createWindowsPrivateFile } from "../../packages/dsh-desk-ui/lib/windows-private-state.js";
import { assertWindowsPrivateEntries } from "../../packages/dsh-desk-ui/lib/windows-private-inspection.js";
import { assertWindowsPrivateTree } from "../runtime/windows-private-files.mjs";
import { disclosureSize } from "./disclosure-fragments.mjs";

const WORKSPACE_SCHEMA = "personal-desk-workspace-v1";
const SOURCE_SCHEMA = "personal-desk-source-v1";
const READ_METHODS = new Set(["bootstrap", "health", "sourceHealth", "inbox", "casefile",
  "evidence", "feedback", "report", "catalystWatchList", "catalystWatchDetail",
  "catalystAuditOverview", "catalystSourceList"]);
const PERSONAL_COMMANDS = new Set(["recordDeliveryInteraction", "submitHumanLabel", "submitMappingReview", "revealOutcome"]);
const capabilities = Object.freeze({
  stateAuthority: "PERSONAL_LEDGER", personalReads: true, personalWrites: false,
  sharedWrites: false, sourceIntake: false, cardGeneration: false,
  deepResearch: false, narration: false, realtimeVoice: false,
  modelUseAllowed: false, rawRead: false, frozenEvidenceOnly: true,
});
const failure = code => ({ ok: false, error: { code, message: code } });
const invalid = () => { throw Object.assign(Error("PERSONAL_WORKSPACE_INVALID"), { code: "PERSONAL_WORKSPACE_INVALID" }); };
const stop = code => { throw Object.assign(Error(code), { code }); };
const owner = stat => typeof process.getuid !== "function" || stat.uid === process.getuid();
const identityOf = record => [record.datasetId, record.sourceFamily, record.evidenceId];
const recordHash = ({ datasetVersion: _version, ...record }) => canonicalHash(record);
const GENERATION_LEASE = "personal-card-generation";
const GENERATION_SCHEMA = "personal-card-generation-v1";
const PRIVATE_WINDOWS = process.platform === "win32";

async function directory(target, { create = false, privateRoot = false } = {}) {
  if (process.platform === "win32") {
    if (!windowsPrivateDirectory(target, { create })) invalid();
    return;
  }
  if (create) await fs.mkdir(target, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || !owner(stat) || privateRoot && (stat.mode & 0o077)) invalid();
}

async function readJson(file, { optional = false, maxBytes = 65536 } = {}) {
  let handle;
  try {
    let before;
    if (process.platform === "win32") {
      before = await fs.lstat(file);
      assertWindowsPrivateFile(file, before);
    }
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !owner(stat) || stat.size > maxBytes) invalid();
    if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) invalid();
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) invalid();
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (optional && handle === undefined && error.code === "ENOENT") return null;
    invalid();
  } finally { await handle?.close(); }
}

function generationPaths(base, id) {
  const root = path.join(path.dirname(base.sourceRuntimeDb), "generations", id);
  return Object.freeze({ ledgerRoot: path.join(root, "ledger"), researchRoot: path.join(root, "research"),
    sourceRuntimeDb: base.sourceRuntimeDb });
}

async function readGeneration(base) {
  const root = path.dirname(base.sourceRuntimeDb), pointer = path.join(root, "personal-generation.json");
  await verifyFile(root, pointer);
  const active = await readJson(pointer, { optional: true });
  if (!active) return { paths: base, pointer: null, manifest: { schema: GENERATION_SCHEMA, id: null, inputs: [] } };
  if (Object.keys(active).sort().join(",") !== "id,manifestHash,schema" ||
    active.schema !== GENERATION_SCHEMA || !/^[a-f0-9]{64}$/.test(active.id) ||
    !/^[a-f0-9]{64}$/.test(active.manifestHash)) invalid();
  const paths = generationPaths(base, active.id);
  const manifestFile = path.join(path.dirname(paths.ledgerRoot), "generation.json");
  await verifyFile(root, manifestFile);
  const manifest = await readJson(manifestFile, { maxBytes: 4 * 1024 * 1024 });
  if (canonicalHash(manifest) !== active.manifestHash || manifest.schema !== GENERATION_SCHEMA ||
    manifest.id !== active.id || !Array.isArray(manifest.inputs) || manifest.inputs.length > 5000 ||
    manifest.inputs.some(row => !/^[a-f0-9]{64}$/.test(row.inputHash) ||
      !Array.isArray(row.identity) || row.identity.length !== 3 ||
      row.identity.some(value => typeof value !== "string") ||
      !["CREATE_CARD", "REJECT"].includes(row.decision))) invalid();
  await verifyPointers(paths);
  return { paths, pointer: active, manifest };
}

function abortable(signal, task) {
  if (signal.aborted) return Promise.reject(Object.assign(Error("CANCELLED"), { code: "CANCELLED" }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(Error("CANCELLED"), { code: "CANCELLED" }));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function writeMarker(file, value) {
  const windows = process.platform === "win32";
  if (windows) createWindowsPrivateFile(file);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_NOFOLLOW |
    (windows ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    if (windows) assertWindowsPrivateFile(file, await handle.stat());
    await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync();
  }
  finally { await handle.close(); }
}

async function discardUnlockedCandidate(root) {
  // Unconfirmed helper termination retains its lock and the enclosing state.
  try {
    await fs.lstat(path.join(root, "ledger", ".write-lock"));
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.rm(root, { recursive: true, force: true });
}

// Reject redirected files before any native reader opens the workspace. The
// root is owner-private; an actively hostile process with the same uid is not
// isolated by filesystem permissions.
async function verifyTree(root) {
  if (PRIVATE_WINDOWS) return assertWindowsPrivateTree(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name), stat = await fs.lstat(target);
    if (!owner(stat)) invalid();
    if (stat.isDirectory()) await verifyTree(target);
    else if (!stat.isFile() || stat.nlink !== 1) invalid();
  }
}

async function verifyFile(root, target) {
  if (PRIVATE_WINDOWS) return verifyFiles(root, [target]);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) invalid();
  const parts = relative.split(path.sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!owner(stat) || (i < parts.length - 1
      ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) invalid();
  }
}

async function verifyFiles(root, targets, directories = []) {
  if (!PRIVATE_WINDOWS) {
    for (const file of directories) await directory(file, { privateRoot: true });
    for (const file of targets) await verifyFile(root, file);
    return;
  }
  const entries = new Map(directories.map(file => [file, { file, directory: true }]));
  for (const target of targets) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) invalid();
    const parts = relative.split(path.sep);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) { if (error.code === "ENOENT") break; throw error; }
      const isDirectory = i < parts.length - 1;
      if (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) invalid();
      entries.set(current, { file: current, directory: isDirectory });
    }
  }
  assertWindowsPrivateEntries([...entries.values()]);
}

async function verifyPointers(paths) {
  const root = path.dirname(paths.sourceRuntimeDb);
  const sourcesRoot = path.dirname(root), workspaceRoot = path.dirname(sourcesRoot);
  const activeFile = path.join(paths.researchRoot, "active.json");
  const projectionFile = path.join(paths.researchRoot, "projection", "active.json");
  await verifyFiles(root, [activeFile, projectionFile, paths.sourceRuntimeDb,
    `${paths.sourceRuntimeDb}-wal`, `${paths.sourceRuntimeDb}-shm`, `${paths.sourceRuntimeDb}-journal`,
    path.join(paths.ledgerRoot, "events.jsonl"), path.join(paths.ledgerRoot, "source_items.jsonl")],
  [workspaceRoot, sourcesRoot, root]);
  const active = await readJson(activeFile, { optional: true });
  if (active && (!/^rsnap_[a-f0-9]{64}$/.test(active.snapshotId) ||
    active.snapshotPath !== path.join(paths.researchRoot, "snapshots", active.snapshotId, "snapshot.json"))) invalid();
  if (active) {
    await verifyFiles(root, [active.snapshotPath, path.join(path.dirname(active.snapshotPath), "evidence.json")]);
  }
  const projection = await readJson(projectionFile, { optional: true });
  if (projection && (!/^[a-f0-9]{64}$/.test(projection.digest) ||
    projection.dbPath !== path.join(paths.researchRoot, "projection", "complete", `${projection.digest}.sqlite`))) invalid();
  if (projection) await verifyFile(root, projection.dbPath);
}

async function initialize(paths, now) {
  await directory(paths.ledgerRoot, { create: true });
  await directory(paths.researchRoot, { create: true });
  const runtime = new SourceRuntimeStore({ dbPath: paths.sourceRuntimeDb, derivedRoot: path.dirname(paths.sourceRuntimeDb),
    privateWindows: PRIVATE_WINDOWS });
  runtime.close();
  // This is an actually empty personal corpus, not the owner's canned cases,
  // nor a claim that an unqueried published source was completely retrieved.
  const content = {
    schema: "research-snapshot-v1", builderVersion: "personal-desk-v1",
    cases: [], sources: [],
    market: { status: "UNKNOWN", cutoff: null, reasonCode: "PROVIDER_UNAVAILABLE", observations: [] },
  };
  const snapshot = {
    ...content, id: researchSnapshotId(content), status: "COMPLETE", createdAt: now,
    watermarks: {}, evidenceCount: 0,
  };
  await activateCompleteSnapshot({ derivedRoot: paths.researchRoot, snapshot, evidenceRecords: [], now,
    privateWindows: PRIVATE_WINDOWS });
  const built = await rebuildResearchProjection({
    derivedRoot: paths.researchRoot, ledgerRoot: paths.ledgerRoot, now,
    store: new JsonlStore({ root: paths.ledgerRoot, privateWindows: PRIVATE_WINDOWS,
      privateInspectionSession: PRIVATE_WINDOWS }), privateWindows: PRIVATE_WINDOWS,
  });
  if (!built.ok) invalid();
}

/** Private native data contract. The Host owns selection and the UI sees no paths. */
export async function createPersonalDesk({
  workspaceRoot, sourceRevision, currentSourceRevision = () => sourceRevision,
  now = () => new Date().toISOString(), readPublishedEvidence, provePublishedEvidence = readPublishedEvidence,
  analyzePublishedEvidence, readImaCandidates,
  cardSource = readImaCandidates ? "ima" : "api", imaEvidenceId, openImaCardSession,
} = {}) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot) || workspaceRoot.includes("\0") ||
    typeof sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(sourceRevision) ||
    typeof currentSourceRevision !== "function" || typeof now !== "function" ||
    readImaCandidates !== undefined && typeof readImaCandidates !== "function" ||
    !["api", "ima"].includes(cardSource) || cardSource === "ima" && readPublishedEvidence ||
    cardSource === "api" && (readImaCandidates || imaEvidenceId !== undefined || openImaCardSession !== undefined) ||
    openImaCardSession !== undefined && typeof openImaCardSession !== "function") invalid();
  const imaIdentity = imaEvidenceId === undefined ? null : imaCardIdentity(imaEvidenceId);
  const storageRevision = imaIdentity ? canonicalHash({ sourceRevision, imaEvidenceId }) : sourceRevision;
  if (process.platform === "win32") {
    try { validateWindowsPrivatePath(workspaceRoot); } catch { invalid(); }
  }
  workspaceRoot = path.resolve(workspaceRoot);
  let paths;
  try {
    await directory(workspaceRoot, { create: true, privateRoot: true });
    const markerFile = path.join(workspaceRoot, "workspace.json");
    const marker = await readJson(markerFile, { optional: true });
    if (marker) {
      if (JSON.stringify(marker) !== JSON.stringify({ schema: WORKSPACE_SCHEMA })) invalid();
    } else {
      if ((await fs.readdir(workspaceRoot)).length) invalid();
      await writeMarker(markerFile, { schema: WORKSPACE_SCHEMA });
    }
    const lock = new JsonlStore({ root: workspaceRoot, privateWindows: PRIVATE_WINDOWS,
      privateInspectionSession: PRIVATE_WINDOWS });
    await lock.withLock(async () => {
      const sourcesRoot = path.join(workspaceRoot, "sources");
      await directory(sourcesRoot, { create: true, privateRoot: true });
      const root = path.join(sourcesRoot, storageRevision);
      await directory(root, { create: true, privateRoot: true });
      paths = Object.freeze({ ledgerRoot: path.join(root, "ledger"),
        researchRoot: path.join(root, "research"), sourceRuntimeDb: path.join(root, "source-runtime.sqlite") });
      const sourceFile = path.join(root, "source.json");
      const source = await readJson(sourceFile, { optional: true });
      const identity = { schema: SOURCE_SCHEMA, revision: sourceRevision,
        ...(imaIdentity ? { imaEvidenceId } : {}) };
      if (source) {
        if (JSON.stringify(source) !== JSON.stringify(identity)) invalid();
        await verifyTree(root);
        await verifyPointers(paths);
      } else {
        if ((await fs.readdir(root)).length) invalid();
        await initialize(paths, now());
        await writeMarker(sourceFile, identity);
      }
    });
  } catch { invalid(); }
  const basePaths = paths;
  paths = (await readGeneration(basePaths)).paths;
  const personalCapabilities = Object.freeze({ ...capabilities,
    personalWrites: typeof readPublishedEvidence === "function" || Boolean(imaIdentity) && typeof openImaCardSession === "function",
    sourceIntake: typeof readPublishedEvidence === "function" || typeof readImaCandidates === "function",
    cardGeneration: (typeof readPublishedEvidence === "function" ||
      Boolean(imaIdentity) && typeof openImaCardSession === "function") && typeof analyzePublishedEvidence === "function" });
  const intakeStore = cardSource === "ima" ? createImaCandidateIntakeStore : createPublicationIntakeStore;
  const refreshGeneration = async () => {
    const current = await readGeneration(basePaths);
    paths = current.paths;
    return current;
  };
  const openRuntime = () => new SourceRuntimeStore({
    dbPath: paths.sourceRuntimeDb, derivedRoot: path.dirname(paths.sourceRuntimeDb),
    privateWindows: PRIVATE_WINDOWS,
  });
  const intakeStatus = () => {
    const runtime = openRuntime();
    try { return intakeStore(runtime).status(now()); } finally { runtime.close(); }
  };
  const storage = Object.freeze({ configuredMode: "jsonl", writerKind: "jsonl",
    authorityMode: "JSONL", authorityGeneration: null });
  const serviceFor = paths => createDeskService({
    env: {},
    pathResolver: () => ({ sourceRoot: null, liuduRoot: null, wechatMdDir: null,
      gangtiseCluesDir: null, radarSyncUrl: null, llmModel: null }),
    runtimeFactory: async () => ({
      store: new JsonlStore({ root: paths.ledgerRoot, privateWindows: PRIVATE_WINDOWS,
        privateInspectionSession: PRIVATE_WINDOWS }), storage, now: now(), researchRoot: paths.researchRoot,
      config: { mode: "personal", ledgerRoot: paths.ledgerRoot },
    }),
    operations: {
      readSourceRuntimeHealth: () => {
        const runtime = new SourceRuntimeStore({ dbPath: paths.sourceRuntimeDb, derivedRoot: path.dirname(paths.sourceRuntimeDb),
          privateWindows: PRIVATE_WINDOWS });
        try { return runtime.readHealth({ now: now() }); } finally { runtime.close(); }
      },
      queryEvidence: input => queryEvidence({ ...input, expandEvidence: async ({ frozenQuote }) => ({
        fullQuote: frozenQuote, matchKind: "FROZEN_QUOTE_ONLY", sourceFileHash: null,
      }) }),
    },
  });
  let closed = false, syncing = false, generating = false, writing = false;
  const lifetime = new AbortController();
  const unavailable = signal => closed || signal?.aborted ? "CANCELLED"
    : currentSourceRevision() !== sourceRevision ? "SOURCE_CHANGED" : null;
  const revalidationError = (error, signal) => unavailable(signal) ??
    (error.code === "SOURCE_CHANGED" || cardSource === "ima" && error.code === "FORBIDDEN_SCOPE"
      ? error.code : "SOURCE_UNAVAILABLE");
  const assertActive = signal => { const code = unavailable(signal); if (code) stop(code); };
  const readIma = async (session, signal, modelUseAllowed = false) => {
    if (!imaIdentity || typeof session?.readCardInput !== "function") stop("SOURCE_UNAVAILABLE");
    const row = await abortable(signal, () => session.readCardInput({ evidenceId: imaEvidenceId, modelUseAllowed, signal }));
    assertActive(signal);
    session.assertActive();
    return normalizeImaCardInput(row, { evidenceId: imaEvidenceId, modelUseAllowed, now: now() });
  };
  const revalidate = async (inputs, signal, session, modelUseAllowed = false) => {
    if (!inputs.length) return;
    if (cardSource === "ima") {
      const row = await readIma(session, signal, modelUseAllowed);
      const dependency = imaCardDependency(row), inputHash = canonicalHash(dependency);
      if (inputs.some(input => input.inputHash !== inputHash ||
        JSON.stringify(input.identity) !== JSON.stringify(dependency.identity))) stop("SOURCE_CHANGED");
      return row;
    }
    if (typeof provePublishedEvidence !== "function") stop("SOURCE_UNAVAILABLE");
    const asOf = now();
    const batch = await abortable(signal, () => provePublishedEvidence({ signal, asOf }));
    assertActive(signal);
    validatePublicationBatch(batch, asOf);
    if (batch.asOf !== asOf || batch.knownAt !== asOf) stop("RESPONSE_INVALID");
    const current = new Map(batch.records.map(row => [JSON.stringify(identityOf(row)), recordHash(row)]));
    for (const input of inputs) {
      if (current.get(JSON.stringify(input.identity)) !== input.inputHash) stop("SOURCE_CHANGED");
    }
    const identities = new Set(inputs.map(input => JSON.stringify(input.identity)));
    return batch.records.filter(row => identities.has(JSON.stringify(identityOf(row))));
  };
  const generate = async (params, signal) => {
    if (!personalCapabilities.cardGeneration) return failure("METHOD_NOT_ALLOWED");
    if (!params || typeof params !== "object" || Array.isArray(params) ||
      Object.keys(params).some(key => key !== "modelUseAllowed")) return failure("INVALID_REQUEST");
    if (params.modelUseAllowed !== true) return failure("MODEL_CONSENT_REQUIRED");
    if (generating || syncing || writing) return failure("CLIENT_BUSY");
    generating = true;
    let combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]);
    let runtime, runId, candidateRoot, temporaryPointer, session, schemaDiagnostic, activated = false;
    try {
      await refreshGeneration();
      await verifyPointers(paths);
      assertActive(combined);
      const anchor = now();
      resolveAShareHorizons({ evaluationAnchorAt: anchor, calendar: getAnnouncedCalendar("sse-szse-2026-v1") });
      runtime = openRuntime();
      runId = randomUUID();
      if (!runtime.acquireWorkerLease({ name: GENERATION_LEASE, owner: runId, now: anchor, leaseSeconds: 120 })) {
        runId = null; stop("CLIENT_BUSY");
      }
      const previous = await refreshGeneration();
      await verifyPointers(previous.paths);
      assertActive(combined);
      const intake = intakeStore(runtime);
      const received = intake.readSnapshot(anchor);
      const completed = new Set(previous.manifest.inputs.map(row => row.inputHash));
      let record, input;
      if (cardSource === "ima") {
        if (!received.batch.records.some(row => row.evidenceId === imaEvidenceId && row.datasetId === imaIdentity.datasetId)) {
          stop("SOURCE_CHANGED");
        }
        session = await abortable(combined, () => openImaCardSession({ signal: combined }));
        combined = AbortSignal.any([combined, session.signal]);
        record = await readIma(session, combined, true);
        const dependency = imaCardDependency(record);
        input = { inputHash: canonicalHash(dependency), identity: dependency.identity };
        // A scope never mixes body versions. An explicit source-profile/content
        // selection starts a separate scope; old derivatives remain withheld.
        if (previous.manifest.inputs.some(row => row.inputHash !== input.inputHash)) stop("SOURCE_CHANGED");
        if (completed.has(input.inputHash)) record = null;
      } else {
        record = received.batch.records.find(row => !completed.has(recordHash(row)));
        if (record) input = { inputHash: recordHash(record), identity: identityOf(record) };
      }
      if (!record) return { ok: true, result: { status: "NO_NEW_EVIDENCE", createdCardCount: 0, cardRevisionId: null } };
      if (previous.manifest.inputs.length >= 5000) stop("INTAKE_LIMIT");
      const dependencies = [...previous.manifest.inputs, input];
      if (cardSource !== "ima") await revalidate(dependencies, combined);
      const result = await abortable(combined, () => analyzePublishedEvidence({
        record: structuredClone(record), signal: combined,
      }));
      assertActive(combined);
      const validName = value => typeof value === "string" && value.length > 0 &&
        value.length <= 160 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
      if (!validName(result?.modelVersion) || !validName(result?.promptVersion) ||
        result.provider !== undefined && !validName(result.provider)) stop("RESPONSE_INVALID");
      let analysis;
      try {
        analysis = validateAnalysisOutput(result.analysis, { sourceText: cardSource === "ima" ? record.content : record.excerpt });
      } catch (error) {
        schemaDiagnostic = personalCardSchemaDiagnostic(error);
        throw Object.assign(error, { outputStage: "schema" });
      }
      await revalidate(dependencies, combined, session, true);
      await verifyPointers(previous.paths);
      assertActive(combined);
      const generationsRoot = path.join(path.dirname(basePaths.sourceRuntimeDb), "generations");
      await directory(generationsRoot, { create: true, privateRoot: true });
      const id = randomBytes(32).toString("hex"), next = generationPaths(basePaths, id);
      candidateRoot = path.dirname(next.ledgerRoot);
      await directory(candidateRoot, { create: true, privateRoot: true });
      const check = () => {
        assertActive(combined);
        session?.assertActive();
        if (!runtime.ownsWorkerLease({ name: GENERATION_LEASE, owner: runId, now: now() })) stop("GENERATION_LEASE_EXPIRED");
      };
      const outcome = await preparePersonalCard({
        previous: previous.paths, next, record, inputHash: input.inputHash, analysis,
        modelVersion: result.modelVersion, promptVersion: result.promptVersion,
        provider: result.provider ?? null,
        receivedAt: cardSource === "ima" ? record.wikiOrigin.observedAt : received.batch.asOf,
        now: cardSource === "ima" ? now() : anchor, assertActive: check,
      });
      const manifest = { schema: GENERATION_SCHEMA, id, inputs: [...previous.manifest.inputs, { ...input, ...outcome }] };
      await writeMarker(path.join(candidateRoot, "generation.json"), manifest);
      await verifyTree(candidateRoot);
      await verifyPointers(next);
      await revalidate(dependencies, combined, session, true);
      temporaryPointer = path.join(path.dirname(basePaths.sourceRuntimeDb), `.personal-generation-${id}.tmp`);
      await writeMarker(temporaryPointer, { schema: GENERATION_SCHEMA, id, manifestHash: canonicalHash(manifest) });
      // No await between the final lease/cache checks and atomic activation.
      const activation = activatePersonalGeneration({
        db: runtime.db, temporaryPointer, expectedPointer: previous.pointer,
        pointer: path.join(path.dirname(basePaths.sourceRuntimeDb), "personal-generation.json"),
        check() {
          check();
          if (intake.readSnapshot(now()).runId !== received.runId) stop("SOURCE_CHANGED");
        },
      });
      activated = activation.activated !== false;
      if (activation.status !== "ACTIVATED") stop(activation.errorCode);
      paths = next;
      return { ok: true, projectionStatus: "COMPLETE", result: {
        status: outcome.cardRevisionId ? "CREATED" : "REJECTED",
        createdCardCount: outcome.cardRevisionId ? 1 : 0, cardRevisionId: outcome.cardRevisionId,
      } };
    } catch (error) {
      const safe = new Set(["MODEL_CONSENT_REQUIRED", "MODEL_SELECTION_REQUIRED", "INTAKE_REQUIRED", "INTAKE_LIMIT",
        "CLIENT_BUSY", "SOURCE_CHANGED", "RESPONSE_INVALID", "GENERATION_LEASE_EXPIRED", "GENERATION_ACTIVATION_UNKNOWN",
        "HORIZON_OUT_OF_RANGE", "LLM_OUTPUT_INVALID", "LLM_OUTPUT_UNSAFE", "LLM_OUTPUT_TOO_LARGE",
        "LLM_EVIDENCE_COVERAGE_INVALID", "PERSONAL_WORKSPACE_INVALID", "AUTH_REQUIRED", "FORBIDDEN_SCOPE"]);
      const response = failure(error.code === "GENERATION_ACTIVATION_UNKNOWN" ? error.code
        : unavailable(combined) ?? (safe.has(error.code) ? error.code : "SOURCE_UNAVAILABLE"));
      // Only fixed categories cross the Host boundary, never model text or arbitrary validation details.
      if (["LLM_OUTPUT_INVALID", "LLM_OUTPUT_UNSAFE", "LLM_OUTPUT_TOO_LARGE",
        "LLM_EVIDENCE_COVERAGE_INVALID"].includes(response.error.code) &&
        ["stream_limit", "incomplete", "tool_call", "empty", "text_limit", "json", "schema"].includes(error.outputStage)) {
        response.error.outputStage = error.outputStage;
      }
      if (schemaDiagnostic && response.error.outputStage === "schema") response.error.schemaDiagnostic = schemaDiagnostic;
      if (response.error.code === "LLM_OUTPUT_INVALID" && response.error.outputStage === "incomplete" &&
        ["max_tokens", "tool_calls", "provider_aborted", "provider_error", "missing_finish",
          "invalid_finish", "after_finish", "assembly_mismatch"].includes(error.terminalReason)) {
        response.error.terminalReason = error.terminalReason;
      }
      return response;
    } finally {
      try {
        for (const cleanup of [
          () => session?.close(),
          () => runId && runtime?.releaseWorkerLease({ name: GENERATION_LEASE, owner: runId }),
          () => runtime?.close(),
          () => temporaryPointer && fs.rm(temporaryPointer, { force: true }),
          () => candidateRoot && !activated && discardUnlockedCandidate(candidateRoot),
        ]) {
          try { await cleanup(); } catch {
            // I/O cleanup cannot undo activation or replace its outcome. An
            // unreleased durable lease expires; never unlock another owner.
          }
        }
      } finally { generating = false; }
    }
  };
  const sync = async (params, signal) => {
    if (!personalCapabilities.sourceIntake) return failure("METHOD_NOT_ALLOWED");
    if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) return failure("INVALID_REQUEST");
    if (syncing || generating || writing) return failure("CLIENT_BUSY");
    syncing = true;
    let runtime, intake, runId, metadataOwner;
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]);
    try {
      await verifyPointers(paths);
      const code = unavailable(combined);
      if (code) return failure(code);
      runtime = openRuntime();
      if (imaIdentity) {
        // A different HTTP request must not replace a model's accepted receipt.
        metadataOwner = randomUUID();
        if (!runtime.acquireWorkerLease({ name: GENERATION_LEASE, owner: metadataOwner, now: now(), leaseSeconds: 120 })) {
          metadataOwner = null; stop("CLIENT_BUSY");
        }
      }
      intake = intakeStore(runtime);
      runId = intake.begin(now());
      const asOf = now();
      const batch = await abortable(combined, () => readImaCandidates
        ? readImaCandidates({ signal: combined }) : readPublishedEvidence({ signal: combined, asOf }));
      const stopped = unavailable(combined);
      if (stopped) throw Object.assign(Error(stopped), { code: stopped });
      await verifyPointers(paths);
      const afterCheck = unavailable(combined);
      if (afterCheck) throw Object.assign(Error(afterCheck), { code: afterCheck });
      if (!readImaCandidates && (batch?.asOf !== asOf || batch?.knownAt !== asOf)) {
        throw Object.assign(Error("RESPONSE_INVALID"), { code: "RESPONSE_INVALID" });
      }
      return { ok: true, result: intake.commit(runId, batch, now()) };
    } catch (error) {
      const safeCodes = new Set(["AUTH_REQUIRED", "FORBIDDEN_SCOPE", "SOURCE_CHANGED", "CANCELLED",
        "CLIENT_BUSY", "RESPONSE_INVALID", "INTAKE_REQUIRED", "INTAKE_LIMIT", "INTAKE_INCOMPLETE", "INTAKE_LEASE_EXPIRED",
        "SPKI_MISMATCH", "TLS_REJECTED", "RATE_LIMITED", "EDGE_TIMEOUT", "RESYNC_REQUIRED"]);
      const code = unavailable(combined) ?? (safeCodes.has(error.code) ? error.code : "SOURCE_UNAVAILABLE");
      if (runId) intake.failed(runId, code, now());
      return failure(code);
    } finally {
      try { if (runId) intake.release(runId); }
      finally {
        try { if (metadataOwner) runtime.releaseWorkerLease({ name: GENERATION_LEASE, owner: metadataOwner }); }
        finally { runtime?.close(); syncing = false; }
      }
    }
  };
  const command = async (params, signal) => {
    if (!personalCapabilities.personalWrites || !PERSONAL_COMMANDS.has(params?.commandType)) return failure("METHOD_NOT_ALLOWED");
    if (!params || typeof params !== "object" || Array.isArray(params) ||
      Object.keys(params).some(key => !["commandType", "idempotencyKey", "expectedHeads", "actorType", "actorId", "payload"].includes(key)) ||
      typeof params.payload?.cardRevisionId !== "string") return failure("INVALID_COMMAND");
    if (writing || generating || syncing) return failure("CLIENT_BUSY");
    writing = true;
    let combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]);
    let runtime, ownerId, candidateRoot, temporaryPointer, session, activated = false;
    try {
      await refreshGeneration();
      await verifyPointers(paths);
      assertActive(combined);
      runtime = openRuntime();
      ownerId = randomUUID();
      if (!runtime.acquireWorkerLease({ name: GENERATION_LEASE, owner: ownerId, now: now(), leaseSeconds: 120 })) {
        ownerId = null; stop("CLIENT_BUSY");
      }
      const previous = await refreshGeneration();
      await verifyPointers(previous.paths);
      const inputs = previous.manifest.inputs;
      const intake = intakeStore(runtime), received = intake.readSnapshot(now());
      if (!inputs.some(input => input.cardRevisionId === params.payload.cardRevisionId)) stop("NO_RESULT");
      const dossier = await serviceFor(previous.paths).call("casefile", { card: params.payload.cardRevisionId });
      if (!dossier.ok) stop(dossier.error.code);
      if (params.commandType === "submitHumanLabel") {
        const ids = new Set(dossier.result.evidence
          .filter(row => row.cardRevisionId === params.payload.cardRevisionId).map(row => row.id));
        if (!Array.isArray(params.payload.selectedEvidenceIds) ||
          params.payload.selectedEvidenceIds.some(id => !ids.has(id))) stop("INPUT_REF_MISMATCH");
      }
      if (imaIdentity) {
        session = await abortable(combined, () => openImaCardSession({ signal: combined }));
        combined = AbortSignal.any([combined, session.signal]);
      }
      const check = () => {
        assertActive(combined);
        session?.assertActive();
        if (!runtime.ownsWorkerLease({ name: GENERATION_LEASE, owner: ownerId, now: now() })) stop("GENERATION_LEASE_EXPIRED");
      };
      await revalidate(inputs, combined, session);
      check();
      const generationsRoot = path.join(path.dirname(basePaths.sourceRuntimeDb), "generations");
      await directory(generationsRoot, { create: true, privateRoot: true });
      const id = randomBytes(32).toString("hex"), next = generationPaths(basePaths, id);
      candidateRoot = path.dirname(next.ledgerRoot);
      await directory(candidateRoot, { create: true, privateRoot: true });
      await copyPersonalGeneration({ previous: previous.paths, next, now: now() });
      check();
      const candidateStore = new JsonlStore({ root: next.ledgerRoot, privateWindows: PRIVATE_WINDOWS,
        privateInspectionSession: PRIVATE_WINDOWS });
      const result = await handleCommand({ store: candidateStore, now: now(), body: params,
        watchCalendar: getAnnouncedCalendar("sse-szse-2026-v1") });
      check();
      const built = await rebuildResearchProjection({ derivedRoot: next.researchRoot, ledgerRoot: next.ledgerRoot,
        store: candidateStore, now: now(), privateWindows: PRIVATE_WINDOWS });
      if (!built.ok) stop("PROJECTION_STALE");
      const manifest = { ...previous.manifest, id };
      await writeMarker(path.join(candidateRoot, "generation.json"), manifest);
      await verifyTree(candidateRoot);
      await verifyPointers(next);
      await revalidate(inputs, combined, session);
      temporaryPointer = path.join(path.dirname(basePaths.sourceRuntimeDb), `.personal-generation-${id}.tmp`);
      await writeMarker(temporaryPointer, { schema: GENERATION_SCHEMA, id, manifestHash: canonicalHash(manifest) });
      const activation = activatePersonalGeneration({
        db: runtime.db, temporaryPointer, expectedPointer: previous.pointer,
        pointer: path.join(path.dirname(basePaths.sourceRuntimeDb), "personal-generation.json"),
        check() {
          check();
          if (intake.readSnapshot(now()).runId !== received.runId) stop("SOURCE_CHANGED");
        },
      });
      activated = activation.activated !== false;
      if (activation.status !== "ACTIVATED") stop(activation.errorCode);
      paths = next;
      return { ok: true, projectionStatus: "COMPLETE", result, receipt: result.commitGroupReceipt ?? null };
    } catch (error) {
      return failure(error.code === "GENERATION_ACTIVATION_UNKNOWN" ? error.code
        : unavailable(combined) ?? (/^[A-Z_]{2,64}$/.test(error.code) ? error.code : "SOURCE_UNAVAILABLE"));
    } finally {
      for (const cleanup of [
        () => session?.close(),
        () => ownerId && runtime?.releaseWorkerLease({ name: GENERATION_LEASE, owner: ownerId }),
        () => runtime?.close(),
        () => temporaryPointer && fs.rm(temporaryPointer, { force: true }),
        () => candidateRoot && !activated && discardUnlockedCandidate(candidateRoot),
      ]) {
        try { await cleanup(); } catch { /* Preserve uncertain activation; a retained lease expires naturally. */ }
      }
      writing = false;
    }
  };
  return Object.freeze({
    get paths() { return paths; }, capabilities: personalCapabilities,
    close() { closed = true; lifetime.abort(); },
    // Host-only transfer of observed metadata, never an RPC or an authorization grant.
    async readImaCandidateSnapshot({ signal } = {}) {
      if (cardSource !== "ima") stop("METHOD_NOT_ALLOWED");
      assertActive(signal);
      await verifyPointers(paths);
      assertActive(signal);
      const runtime = openRuntime();
      try { return createImaCandidateIntakeStore(runtime).readSnapshot(now()).batch; }
      finally { runtime.close(); }
    },
    // Host-only transaction: buffer all model/UI events inside operation and
    // release them only after this method returns. Mid-turn proof pins the
    // local dossier; live source authorization is checked at both boundaries.
    async withResearchTurn(params, operation, { signal } = {}) {
      if (params?.modelUseAllowed !== true) stop("MODEL_CONSENT_REQUIRED");
      if (!params || typeof params !== "object" || Array.isArray(params) ||
        Object.keys(params).some(key => !["card", "modelUseAllowed"].includes(key)) ||
        typeof params.card !== "string" || !params.card || params.card.length > 200 ||
        typeof operation !== "function") stop("INVALID_REQUEST");
      const card = params.card;
      const turn = new AbortController();
      let combined = AbortSignal.any([lifetime.signal, turn.signal, AbortSignal.timeout(110_000),
        ...(signal ? [signal] : [])]);
      let session, protectedBody;
      const compact = value => value.normalize("NFC").replace(/\s+/gu, "");
      const assertDerived = (value, fragments = []) => {
        if (!protectedBody) return;
        const strings = [];
        const visit = item => {
          if (typeof item === "string") strings.push(compact(item));
          else if (item && typeof item === "object") for (const child of Object.values(item)) visit(child);
        };
        visit(value);
        if (strings.some(text => text.includes(protectedBody)) || strings.join("").includes(protectedBody)) {
          stop("SOURCE_UNAVAILABLE");
        }
        // Bound the aggregate natural-language payload, not just verbatim
        // matches: wrappers and quote order must not hide whole-body coverage.
        // Short inputs may be refused even when the derivative is not a copy.
        const textSize = disclosureSize(fragments, value);
        if (textSize >= protectedBody.length) stop("SOURCE_UNAVAILABLE");
      };
      const safe = error => {
        const code = ["CANCELLED", "SOURCE_CHANGED", "SOURCE_UNAVAILABLE", "FORBIDDEN_SCOPE",
          "PERSONAL_WORKSPACE_INVALID", "PROJECTION_STALE", "RESEARCH_DISCLOSURE_UNAVAILABLE",
          "AUTO_JUDGMENT_CAPACITY"].includes(error?.code)
          ? error.code : "SOURCE_UNAVAILABLE";
        stop(code);
      };
      try {
        assertActive(combined);
        const current = await abortable(combined, () => readGeneration(basePaths));
        if (!current.pointer || !current.manifest.inputs.some(input =>
          input.decision === "CREATE_CARD" && input.cardRevisionId === card)) stop("FORBIDDEN_SCOPE");
        if (cardSource === "ima") {
          if (!imaIdentity || typeof openImaCardSession !== "function") stop("SOURCE_UNAVAILABLE");
          await abortable(combined, async () => {
            assertActive(combined);
            const opened = await openImaCardSession({ signal: combined });
            // Cancellation can settle the caller before a factory returns.
            // A late handle is still ours to close, never a new active turn.
            if (combined.aborted) { opened.close(); stop("CANCELLED"); }
            session = opened;
            assertActive(combined);
          });
          combined = AbortSignal.any([combined, session.signal]);
        }
        const active = () => { assertActive(combined); session?.assertActive(); };
        const service = serviceFor(current.paths);
        const readCase = () => abortable(combined, async () => {
          active();
          const latest = await readGeneration(basePaths);
          if (canonicalHash(latest.pointer) !== canonicalHash(current.pointer)) stop("SOURCE_CHANGED");
          const response = await service.call("casefile", { card });
          active();
          const after = await readGeneration(basePaths);
          if (canonicalHash(after.pointer) !== canonicalHash(current.pointer)) stop("SOURCE_CHANGED");
          active();
          if (!response.ok) stop(response.error?.code || "SOURCE_UNAVAILABLE");
          if (response.projectionStatus !== "COMPLETE" || response.result.cardRevisionId !== card) {
            stop("SOURCE_CHANGED");
          }
          return response.result;
        });
        const admitted = await revalidate(current.manifest.inputs, combined, session, true);
        if (cardSource === "ima") protectedBody = compact(admitted.content);
        const dossier = await readCase(), dossierHash = canonicalHash(dossier);
        const node = dossier.case.nodes.find(row => row.isCurrent && row.resultVisibility === "PROCESS");
        const evidence = dossier.evidence.map(row => ({
          id: row.id, contentHash: row.sha256, summary: row.summary, sourceLabel: row.sourceType,
          materialAt: node?.availableAt ?? null,
        }));
        const proof = {
          scopeKey: canonicalHash({ schema: "personal-research-turn-v1", sourceRevision,
            cardSource, imaEvidenceId: imaEvidenceId ?? null, generation: current.pointer, dossierHash }),
          context: {
            cardId: card, title: dossier.case.title,
            revision: node?.revision ?? 1, summary: node?.summary ?? "",
            stageId: node?.nodeType ?? "", stageLabel: node?.title ?? "",
            timelineNodeTitle: node?.title ?? "", projectionStatus: "COMPLETE",
            watermark: dossier.asOfWatermark, materialAt: node?.availableAt ?? null,
            scannedAt: node?.observedAt ?? node?.recordedAt ?? null,
            evidence, evidenceRefs: evidence.map(row => ({ id: row.id, contentHash: row.contentHash })),
            evidenceHashes: [...new Set(evidence.map(row => row.contentHash).filter(Boolean))],
          },
        };
        assertDerived(proof, [proof.context.title, proof.context.summary, ...evidence.map(row => row.summary)]);
        const copyOutput = value => {
          const fragments = [proof.context.title, proof.context.summary, ...evidence.map(row => row.summary)];
          const inspect = (item, depth = 0, key = "") => {
            if (depth > 20) stop("SOURCE_UNAVAILABLE");
            if (typeof item === "string") {
              if (["text", "finalText", "spokenText", "summary", "fullQuote", "synthesisMarkdown", "note"].includes(key)) fragments.push(item);
              if (key === "dataJson" && item !== "") inspect(JSON.parse(item), depth + 1);
            } else if (item && typeof item === "object") {
              if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
                stop("SOURCE_UNAVAILABLE");
              }
              for (const [name, child] of Object.entries(item)) inspect(child, depth + 1, name);
            } else if (!["boolean", "number", "undefined"].includes(typeof item) && item !== null ||
              typeof item === "number" && !Number.isFinite(item)) stop("SOURCE_UNAVAILABLE");
          };
          inspect(value);
          const serialized = JSON.stringify(value);
          if (serialized === undefined) return undefined;
          if (Buffer.byteLength(serialized) > 256 * 1024) stop("SOURCE_UNAVAILABLE");
          const snapshot = JSON.parse(serialized);
          assertDerived(snapshot, fragments);
          return snapshot;
        };
        const checkPinned = async () => {
          if (canonicalHash(await readCase()) !== dossierHash) stop("SOURCE_CHANGED");
          active();
        };
        const allowed = new Set(evidence.map(row => row.id));
        const selectedInputs = new Set(current.manifest.inputs.filter(input => input.cardRevisionId === card)
          .map(input => JSON.stringify(input.identity)));
        const scope = Object.freeze({
          signal: combined,
          validateOutput(value) {
            try { active(); return copyOutput(value); } catch (error) { safe(error); }
          },
          async withResearchInput(operation) {
            try {
              active();
              if (typeof operation !== "function") stop("SOURCE_UNAVAILABLE");
              await checkPinned();
              const input = cardSource === "ima"
                ? { record: structuredClone(admitted),
                  readScope: { coverage: "SELECTED_IMA_DOCUMENT", ...imaIdentity, historyComplete: false, version: null } }
                : { records: structuredClone(admitted.filter(row => selectedInputs.has(JSON.stringify(identityOf(row))))),
                  readScope: { coverage: "CURRENT_CARD_PUBLISHED_INPUTS", cardId: card, historyComplete: false } };
              const result = copyOutput(await abortable(combined, () => operation({
                ...input, kind: cardSource, signal: combined,
              })));
              await checkPinned();
              return result;
            } catch (error) { safe(error); }
          },
          async proveSource() {
            try { await checkPinned(); return structuredClone(proof); } catch (error) { safe(error); }
          },
          async readEvidence(id) {
            try {
              active();
              if (!allowed.has(id)) stop("FORBIDDEN_SCOPE");
              await checkPinned();
              const response = await abortable(combined, () => service.call("evidence", { id }));
              if (!response.ok) stop(response.error?.code || "SOURCE_UNAVAILABLE");
              await checkPinned();
              assertDerived(response.result);
              return response.result;
            } catch (error) { safe(error); }
          },
        });
        const result = copyOutput(await abortable(combined, () => operation(scope)));
        active();
        await revalidate(current.manifest.inputs, combined, session, true);
        await checkPinned();
        return result;
      } catch (error) { safe(error); }
      finally {
        protectedBody = null;
        try { session?.close(); }
        catch { stop("SOURCE_UNAVAILABLE"); }
        finally { turn.abort(); }
      }
    },
    // Host-only callback: full input never becomes a browser RPC result.
    async withImaResearch({ card, modelUseAllowed, researchScope = "selected", query }, operation, { signal } = {}) {
      if (!imaIdentity || typeof operation !== "function" || typeof openImaCardSession !== "function") stop("METHOD_NOT_ALLOWED");
      if (modelUseAllowed !== true) stop("MODEL_CONSENT_REQUIRED");
      if (!["selected", "library"].includes(researchScope)) stop("INVALID_REQUEST");
      let combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]);
      let session;
      try {
        assertActive(combined);
        const current = await refreshGeneration();
        await verifyPointers(current.paths);
        const inputs = current.manifest.inputs;
        if (!inputs.some(input => input.cardRevisionId === card)) stop("NO_RESULT");
        const scope = await serviceFor(current.paths).call("casefile", { card });
        if (!scope.ok) stop("NO_RESULT");
        assertActive(combined);
        session = await abortable(combined, () => openImaCardSession({ signal: combined }));
        combined = AbortSignal.any([combined, session.signal]);
        if (researchScope === "library") {
          // The card is a private UI anchor, not an input to this fresh library query.
          const result = await session.withWikiResearchInputs({ query, signal: combined }, async ({ records, receipt, signal }) => {
            try { return { value: await operation({ records, readScope: { ...receipt, query }, signal }) }; }
            catch (error) { return { error }; }
          });
          assertActive(combined);
          if (Object.hasOwn(result, "error")) throw result.error;
          return result.value;
        }
        const prove = async () => {
          try { return await revalidate(inputs, combined, session, true); }
          catch (error) { stop(revalidationError(error, combined)); }
        };
        const record = await prove();
        const readScope = { coverage: "SELECTED_IMA_DOCUMENT", ...imaIdentity, historyComplete: false, version: null };
        const result = await abortable(combined, () => operation({ record, readScope, signal: combined }));
        await prove();
        assertActive(combined);
        return result;
      } finally { session?.close(); }
    },
    async call(method, params = {}, { signal } = {}) {
      try {
        let code = unavailable(signal);
        if (code) return failure(code);
        if (method === "sourceSync") return await sync(params, signal);
        if (method === "generateCards") return await generate(params, signal);
        if (method === "command") return await command(params, signal);
        if (!READ_METHODS.has(method)) return failure("METHOD_NOT_ALLOWED");
        const current = await refreshGeneration();
        await verifyPointers(current.paths);
        let combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]);
        let session, response;
        try {
          if (cardSource === "ima" && current.manifest.inputs.length) {
            session = await abortable(combined, () => openImaCardSession({ signal: combined }));
            combined = AbortSignal.any([combined, session.signal]);
          }
          await revalidate(current.manifest.inputs, combined, session);
          const service = serviceFor(current.paths);
          response = await service.call(method, params);
          // Both local health snapshots share the same live pre/post proof.
          if (method === "health" && response.ok) {
            const source = await service.call("sourceHealth");
            response = source.ok
              ? { ...response, result: { ...response.result, sourceRuntime: source.result } }
              : source;
          }
          await revalidate(current.manifest.inputs, combined, session);
        } catch (error) {
          return failure(revalidationError(error, combined));
        } finally { session?.close(); }
        code = unavailable(signal);
        if (code) return failure(code);
        if (!response.ok) return failure(/^[A-Z_]{2,64}$/.test(response.error?.code) ? response.error.code : "SOURCE_UNAVAILABLE");
        const readScope = imaIdentity ? { coverage: "SELECTED_IMA_DOCUMENT", ...imaIdentity,
          historyComplete: false, version: null } : null;
        if (method !== "bootstrap") return readScope ? { ...response, readScope } : response;
        return { ...response, result: { ...response.result, provider: "personal",
          capabilities: personalCapabilities, publicationIntake: cardSource === "ima" ? null : intakeStatus(),
          ...(cardSource === "ima" ? { wikiIntake: intakeStatus(), readScope } : {}) } };
      } catch { return failure("PERSONAL_WORKSPACE_INVALID"); }
    },
  });
}
