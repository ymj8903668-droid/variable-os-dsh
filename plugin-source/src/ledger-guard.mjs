// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";

export class LedgerGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LedgerGuardError";
    this.code = code;
  }
}

export function defaultAppRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function defaultRepoRoot(appRoot) {
  return path.dirname(path.dirname(appRoot));
}

function resolveMaybe(base, value) {
  if (path.isAbsolute(value)) {
    return path.normalize(value);
  }
  return path.resolve(base, value);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function forbiddenRoots(repoRoot) {
  return {
    raw: path.join(repoRoot, "raw"),
    canonical: path.join(repoRoot, "data", "variables"),
    signals: path.join(repoRoot, ".llm-wiki", "variable-signals"),
  };
}

export function assertPathAllowed(resolvedPath, { repoRoot, mode, allowCanonical }) {
  const roots = forbiddenRoots(repoRoot);
  if (isInside(resolvedPath, roots.raw)) {
    throw new LedgerGuardError(
      "LEDGER_PATH_FORBIDDEN",
      "path is inside raw/",
    );
  }
  if (isInside(resolvedPath, roots.signals)) {
    throw new LedgerGuardError(
      "LEDGER_PATH_FORBIDDEN",
      "path is inside .llm-wiki/variable-signals/",
    );
  }
  const canonicalForbidden = mode === "demo" || allowCanonical !== true;
  if (canonicalForbidden && isInside(resolvedPath, roots.canonical)) {
    throw new LedgerGuardError(
      "LEDGER_PATH_FORBIDDEN",
      "path is inside data/variables/",
    );
  }
}

export function assertReportsRoot(
  reportsRoot,
  { appRoot, repoRoot, mode, allowCanonical },
) {
  assertPathAllowed(reportsRoot, { repoRoot, mode, allowCanonical });
  const demoRoot = path.join(appRoot, ".local-demo");
  if (!isInside(reportsRoot, demoRoot)) {
    throw new LedgerGuardError(
      "LEDGER_PATH_FORBIDDEN",
      "reports path must be inside app .local-demo",
    );
  }
}

export function createRuntimeConfig({
  env = process.env,
  cwd = process.cwd(),
  appRoot = defaultAppRoot(),
  repoRoot = defaultRepoRoot(appRoot),
} = {}) {
  const mode = env.VARIABLE_OS_MODE || "demo";
  const allowCanonical = env.VARIABLE_OS_ALLOW_CANONICAL === "1";
  const ledgerRoot = env.VARIABLE_OS_LEDGER_ROOT
    ? resolveMaybe(cwd, env.VARIABLE_OS_LEDGER_ROOT)
    : path.join(appRoot, ".local-demo", "ledger");
  const projectionRoot = env.VARIABLE_OS_PROJECTION_ROOT
    ? resolveMaybe(cwd, env.VARIABLE_OS_PROJECTION_ROOT)
    : path.join(appRoot, ".local-demo", "projections");

  assertPathAllowed(ledgerRoot, { repoRoot, mode, allowCanonical });
  assertPathAllowed(projectionRoot, { repoRoot, mode, allowCanonical });

  const reportsRoot = env.VARIABLE_OS_REPORTS_ROOT
    ? resolveMaybe(cwd, env.VARIABLE_OS_REPORTS_ROOT)
    : path.join(appRoot, ".local-demo", "reports");
  assertReportsRoot(reportsRoot, { appRoot, repoRoot, mode, allowCanonical });

  const researchRoot = env.VARIABLE_OS_RESEARCH_ROOT
    ? resolveMaybe(cwd, env.VARIABLE_OS_RESEARCH_ROOT)
    : path.join(appRoot, ".local-demo", "research");
  assertPathAllowed(researchRoot, { repoRoot, mode, allowCanonical });
  const demoRoot = path.join(appRoot, ".local-demo");
  if (!isInside(researchRoot, demoRoot)) {
    throw new LedgerGuardError(
      "LEDGER_PATH_FORBIDDEN",
      "research path must be inside app .local-demo",
    );
  }

  return {
    mode,
    host: "127.0.0.1",
    port: 8787,
    ledgerRoot,
    projectionRoot,
    reportsRoot,
    researchRoot,
  };
}
