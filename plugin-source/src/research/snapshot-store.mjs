// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalHash } from "../schema/canonical-json.mjs";
import { assertWindowsPrivateTree, validatePrivateWindowsMode, writeWindowsPrivateJson,
  invalidWindowsPrivateState, windowsPrivateDirectory } from "../runtime/windows-private-files.mjs";
import { fail, ResearchError } from "./errors.mjs";

async function writeJson(file, value, privateWindows) {
  if (privateWindows) return writeWindowsPrivateJson(file, value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(file, value, privateWindows) {
  if (privateWindows) return writeWindowsPrivateJson(file, value, { atomic: true });
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function crashIf(crashAfter, label) {
  if (crashAfter === label) {
    fail("INJECTED_CRASH", `injected crash after ${label}`);
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function logicalNodes(nodes) {
  return (nodes || []).map((node) => ({
    evidenceId: node.evidenceId,
    summary: node.summary,
    eventAt: node.eventAt,
    timePrecision: node.timePrecision,
    evidenceLevel: node.evidenceLevel ?? null,
    sourceKind: node.sourceKind ?? null,
    sourceType: node.sourceType ?? null,
    sourceChannel: node.sourceChannel ?? null,
    suggestedNodeType: node.suggestedNodeType ?? null,
  }));
}

export function immutableSnapshotDigest(snapshot, evidenceRecords) {
  const payload = {
    schema: snapshot.schema,
    id: snapshot.id,
    builderVersion: snapshot.builderVersion,
    status: snapshot.status,
    cases: (snapshot.cases || []).map((row) => ({
      caseId: row.caseId,
      title: row.title,
      kind: row.kind,
      evidenceIds: row.evidenceIds,
      nodes: logicalNodes(row.nodes),
    })),
    sources: snapshot.sources,
    watermarks: snapshot.watermarks,
    market: snapshot.market,
    evidenceCount: snapshot.evidenceCount,
    evidenceRecords: evidenceRecords || [],
  };
  return canonicalHash(payload);
}

async function verifyImmutableSnapshotDir(finalDir, snapshot, evidenceRecords) {
  const snapshotFile = path.join(finalDir, "snapshot.json");
  const evidenceFile = path.join(finalDir, "evidence.json");
  if (!(await pathExists(snapshotFile)) || !(await pathExists(evidenceFile))) {
    fail(
      "SNAPSHOT_DIR_INVALID",
      "complete snapshot directory is missing required files",
    );
  }
  const savedSnapshot = await readJson(snapshotFile);
  const savedEvidence = await readJson(evidenceFile);
  if (
    !savedSnapshot ||
    savedSnapshot.status !== "COMPLETE" ||
    savedSnapshot.id !== snapshot.id
  ) {
    fail(
      "SNAPSHOT_DIR_INVALID",
      "existing directory is not the complete immutable snapshot",
    );
  }
  if (!Array.isArray(savedSnapshot.cases) || !Array.isArray(savedEvidence)) {
    fail("SNAPSHOT_DIR_INVALID", "complete snapshot files are malformed");
  }
  if (
    immutableSnapshotDigest(savedSnapshot, savedEvidence) !==
    immutableSnapshotDigest(snapshot, evidenceRecords)
  ) {
    fail(
      "SNAPSHOT_IMMUTABLE_CONFLICT",
      "same-id snapshot or evidence digest does not match",
    );
  }
}

export async function readActiveManifest(derivedRoot) {
  try {
    const raw = await fs.readFile(path.join(derivedRoot, "active.json"), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function activateCompleteSnapshot({
  derivedRoot,
  snapshot,
  evidenceRecords,
  now,
  crashAfter = null,
  privateWindows = false,
}) {
  validatePrivateWindowsMode(privateWindows);
  if (!derivedRoot) {
    fail("DERIVED_ROOT_MISSING", "derivedRoot required");
  }
  if (!snapshot || snapshot.status !== "COMPLETE") {
    fail("SNAPSHOT_NOT_COMPLETE", "cannot activate incomplete snapshot");
  }
  if (privateWindows) {
    await assertWindowsPrivateTree(derivedRoot);
    if (!/^rsnap_[a-f0-9]{64}$/.test(snapshot.id)) invalidWindowsPrivateState();
  }
  const finalDir = path.join(derivedRoot, "snapshots", snapshot.id);
  const manifest = Object.freeze({
    schema: "research-active-manifest-v1",
    snapshotId: snapshot.id,
    snapshotPath: path.join(finalDir, "snapshot.json"),
    status: "COMPLETE",
    activatedAt: now,
  });

  if (await pathExists(finalDir)) {
    await verifyImmutableSnapshotDir(finalDir, snapshot, evidenceRecords);
    crashIf(crashAfter, "reused");
    await writeJsonAtomic(path.join(derivedRoot, "active.json"), manifest, privateWindows);
    return manifest;
  }

  const tmpDir = path.join(
    derivedRoot,
    "tmp",
    `build-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  if (privateWindows) {
    await windowsPrivateDirectory(path.dirname(tmpDir), { create: true });
    await windowsPrivateDirectory(tmpDir, { create: true });
  } else await fs.mkdir(tmpDir, { recursive: true });
  try {
    await writeJson(path.join(tmpDir, "snapshot.json"), snapshot, privateWindows);
    await writeJson(path.join(tmpDir, "evidence.json"), evidenceRecords, privateWindows);
    if (privateWindows) await windowsPrivateDirectory(path.join(derivedRoot, "snapshots"), { create: true });
    else await fs.mkdir(path.join(derivedRoot, "snapshots"), { recursive: true });
    crashIf(crashAfter, "staged");
    await fs.rename(tmpDir, finalDir);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
  crashIf(crashAfter, "promoted");
  await writeJsonAtomic(path.join(derivedRoot, "active.json"), manifest, privateWindows);
  return manifest;
}

export async function buildAndActivate({ derivedRoot, build, now, crashAfter = null }) {
  const previous = await readActiveManifest(derivedRoot);
  try {
    const result = await build();
    if (!result || !result.snapshot || result.snapshot.status !== "COMPLETE") {
      return {
        ok: false,
        active: previous,
        error: new ResearchError(
          "SNAPSHOT_NOT_COMPLETE",
          "build did not complete",
        ),
      };
    }
    const active = await activateCompleteSnapshot({
      derivedRoot,
      snapshot: result.snapshot,
      evidenceRecords: result.evidenceRecords || [],
      now,
      crashAfter,
    });
    return {
      ok: true,
      active,
      snapshot: result.snapshot,
      evidenceRecords: result.evidenceRecords || [],
    };
  } catch (error) {
    return { ok: false, active: previous, error };
  }
}
