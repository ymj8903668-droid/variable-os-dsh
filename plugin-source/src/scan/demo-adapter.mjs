// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "../schema/canonical-json.mjs";

export class ScanError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ScanError";
    this.code = code;
    this.details = details;
  }
}

export const ALLOWED_SOURCE_FILES = Object.freeze([
  "demo-wechat-group.json",
  "demo-public-account.json",
  "full-success.json",
  "partial-fail.json",
  "count-mismatch.json",
  "demo-reprints.json",
  "golden-reprints.json",
]);

export const ALLOWED_NAMESPACES = Object.freeze([
  "demo.wechat-group",
  "demo.public-account",
]);

export const defaultFixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/sources",
);

const allowedFiles = new Set(ALLOWED_SOURCE_FILES);
const allowedNamespaces = new Set(ALLOWED_NAMESPACES);

export function resolveAllowlistedFile(file, fixturesRoot) {
  if (typeof file !== "string" || file.length === 0) {
    throw new ScanError("FIXTURE_PATH_FORBIDDEN", "file required");
  }
  if (path.isAbsolute(file) || file.includes("\0")) {
    throw new ScanError("FIXTURE_PATH_FORBIDDEN", "absolute or nul path");
  }
  if (file.includes("..") || file.includes("/") || file.includes("\\")) {
    throw new ScanError("FIXTURE_PATH_FORBIDDEN", "path traversal");
  }
  if (!allowedFiles.has(file)) {
    throw new ScanError("FIXTURE_PATH_FORBIDDEN", "file not allowlisted");
  }
  const root = path.resolve(fixturesRoot);
  const full = path.resolve(root, file);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel !== file) {
    throw new ScanError("FIXTURE_PATH_FORBIDDEN", "escaped fixtures root");
  }
  return full;
}

export async function loadDemoSource({
  sourceNamespace,
  file,
  mode,
  fixturesRoot = defaultFixturesRoot,
}) {
  if (mode !== "demo") {
    throw new ScanError("MODE_FORBIDDEN", "demo adapter requires demo mode");
  }
  if (!allowedNamespaces.has(sourceNamespace)) {
    throw new ScanError("UNKNOWN_SOURCE", `unknown source ${sourceNamespace}`);
  }
  const full = resolveAllowlistedFile(file, fixturesRoot);
  const parsed = JSON.parse(await fs.readFile(full, "utf8"));
  if (!parsed || parsed.synthetic !== true) {
    throw new ScanError("INVALID_FIXTURE", "fixture must be synthetic");
  }
  if (parsed.sourceNamespace && parsed.sourceNamespace !== sourceNamespace) {
    throw new ScanError("UNKNOWN_SOURCE", "namespace mismatch");
  }
  return parsed;
}

export async function loadScanFixture({
  fixtureId,
  mode,
  fixturesRoot = defaultFixturesRoot,
}) {
  if (mode !== "demo") {
    throw new ScanError("MODE_FORBIDDEN", "demo adapter requires demo mode");
  }
  const file = `${fixtureId}.json`;
  const full = resolveAllowlistedFile(file, fixturesRoot);
  const parsed = JSON.parse(await fs.readFile(full, "utf8"));
  if (!parsed || parsed.synthetic !== true || parsed.id !== fixtureId) {
    throw new ScanError("INVALID_FIXTURE", "invalid scan fixture");
  }
  return parsed;
}

export function itemIdentity(sourceNamespace, item) {
  const contentHash = canonicalHash({
    sourceNamespace,
    text: item.text,
  });
  return {
    sourceNamespace,
    sourceDocumentKey: item.sourceDocumentKey,
    contentHash,
  };
}

export async function enumerateFixtureSources({
  fixture,
  mode,
  fixturesRoot = defaultFixturesRoot,
}) {
  const plans = [];
  for (const source of fixture.sources) {
    if (!allowedNamespaces.has(source.sourceNamespace)) {
      throw new ScanError("UNKNOWN_SOURCE", source.sourceNamespace);
    }
    const catalog = await loadDemoSource({
      sourceNamespace: source.sourceNamespace,
      file: source.file,
      mode,
      fixturesRoot,
    });
    const identities = (catalog.items || []).map((item) =>
      itemIdentity(source.sourceNamespace, item),
    );
    const failed = source.enumerationStatus === "FAILED";
    const seenLimit =
      Number.isInteger(source.seenLimit) && source.seenLimit >= 0
        ? source.seenLimit
        : identities.length;
    const seenItems = failed ? [] : (catalog.items || []).slice(0, seenLimit);
    plans.push({
      sourceNamespace: source.sourceNamespace,
      file: source.file,
      sourceKind: catalog.sourceKind,
      adapterVersion: catalog.adapterVersion || "demo-adapter-v1",
      enumerationStatus: failed ? "FAILED" : "COMPLETE",
      failureCode: failed ? source.failureCode || "ADAPTER_ENUMERATION_FAILED" : null,
      identities,
      expectedItemCount: identities.length,
      seenItems,
      catalog,
    });
  }
  return plans;
}
