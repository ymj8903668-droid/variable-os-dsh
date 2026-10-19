// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_FULL_QUOTE_CHARS = 4_000;

function expansionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sourceFilePart(sourcePath) {
  const value = String(sourcePath || "").trim();
  if (!value || value.includes("\0") || /^[a-z]+:/i.test(value)) {
    throw expansionError("EVIDENCE_SOURCE_FORBIDDEN", "evidence source path is not allowed");
  }
  return value.replace(/#L\d+(?:-L?\d+)?(?::[0-9a-f]+)?$/i, "");
}

function normalizedQuote(value) {
  return String(value || "")
    .replace(/^\s*[\-*>]+\s*/, "")
    .replace(/^\s*[“\"]|[”\"]\s*$/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function frozenPrefix(value) {
  return normalizedQuote(value).replace(/(?:\.{3}|…+)\s*$/u, "").trim();
}

async function resolveSourceFile(sourceRoots, sourcePath) {
  const roots = Array.isArray(sourceRoots) ? sourceRoots.filter(Boolean) : [];
  if (!roots.length) {
    throw expansionError("EVIDENCE_SOURCE_UNAVAILABLE", "no evidence source root is configured");
  }
  const filePart = sourceFilePart(sourcePath);
  for (const configuredRoot of roots) {
    const root = await fs.realpath(path.resolve(String(configuredRoot))).catch(() => null);
    if (!root) continue;
    const candidate = path.isAbsolute(filePart)
      ? path.resolve(filePart)
      : path.resolve(root, filePart);
    if (!insideRoot(root, candidate)) continue;
    const real = await fs.realpath(candidate).catch(() => null);
    if (real && insideRoot(root, real)) return real;
  }
  throw expansionError("EVIDENCE_SOURCE_FORBIDDEN", "evidence source is outside configured roots");
}

/**
 * Recover one complete source line from an immutable evidence prefix.
 * This never returns a whole source file and never crosses configured roots.
 */
export async function expandEvidenceQuote({ sourceRoots, sourcePath, frozenQuote } = {}) {
  const frozen = normalizedQuote(frozenQuote);
  const truncated = /(?:\.{3}|…+)\s*$/u.test(frozen);
  if (!truncated) {
    return Object.freeze({
      fullQuote: frozen,
      matchKind: "FROZEN_QUOTE",
      sourceFileHash: null,
    });
  }
  const prefix = frozenPrefix(frozen);
  if (prefix.length < 12) {
    throw expansionError("EVIDENCE_SOURCE_MISMATCH", "frozen evidence prefix is too short");
  }

  const sourceFile = await resolveSourceFile(sourceRoots, sourcePath);
  const stat = await fs.stat(sourceFile);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
    throw expansionError("EVIDENCE_SOURCE_TOO_LARGE", "evidence source is not a bounded file");
  }
  const buffer = await fs.readFile(sourceFile);
  const sourceFileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const matches = [
    ...new Set(
      buffer
        .toString("utf8")
        .split(/\r?\n/u)
        .map(normalizedQuote)
        .filter((line) => line.startsWith(prefix)),
    ),
  ];
  if (matches.length !== 1) {
    throw expansionError(
      matches.length > 1 ? "EVIDENCE_SOURCE_AMBIGUOUS" : "EVIDENCE_SOURCE_MISMATCH",
      matches.length > 1
        ? "frozen evidence prefix matched multiple source lines"
        : "frozen evidence prefix no longer matches its source",
    );
  }
  if (Array.from(matches[0]).length > MAX_FULL_QUOTE_CHARS) {
    throw expansionError("EVIDENCE_SOURCE_TOO_LARGE", "complete evidence quote exceeds the display limit");
  }
  return Object.freeze({
    fullQuote: matches[0],
    matchKind: "FROZEN_PREFIX",
    sourceFileHash,
  });
}
