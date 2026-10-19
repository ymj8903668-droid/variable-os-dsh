// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { brandedId } from "../schema/canonical-json.mjs";
import { fail } from "./errors.mjs";

export const MAX_SUMMARY_CHARS = 240;
const EVIDENCE_ID = /^evid_[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACCESS_LEVELS = new Set(["TEAM", "RESTRICTED"]);
const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

function boundSummary(value) {
  const text = String(value || "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_SUMMARY_CHARS) {
    return text;
  }
  return text.slice(0, MAX_SUMMARY_CHARS);
}

export function isRelativeSourcePath(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return false;
  }
  if (sourcePath.includes("\0") || sourcePath.includes("..")) {
    return false;
  }
  if (path.isAbsolute(sourcePath)) {
    return false;
  }
  if (sourcePath.startsWith("/") || sourcePath.startsWith("\\")) {
    return false;
  }
  if (WINDOWS_ABS.test(sourcePath)) {
    return false;
  }
  if (sourcePath.includes("://")) {
    return false;
  }
  return true;
}

export function createEvidenceRegistry() {
  const records = new Map();

  function register({
    sourcePath,
    sha256,
    lineNumber,
    accessLevel,
    summary,
  }) {
    if (!isRelativeSourcePath(sourcePath)) {
      fail("EVIDENCE_PATH_INVALID", "sourcePath must be a relative file path");
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
      fail("EVIDENCE_HASH_INVALID", "sha256 must be 64 hex chars");
    }
    if (!Number.isInteger(lineNumber) || lineNumber < 1) {
      fail("EVIDENCE_LINE_INVALID", "lineNumber must be a positive integer");
    }
    if (!ACCESS_LEVELS.has(accessLevel)) {
      fail("EVIDENCE_ACCESS_INVALID", "accessLevel must be TEAM or RESTRICTED");
    }
    const bounded = boundSummary(summary);
    const payload = {
      sourcePath,
      sha256,
      lineNumber,
      accessLevel,
      summary: bounded,
    };
    const id = brandedId("evid_", payload);
    const existing = records.get(id);
    if (existing) {
      return existing;
    }
    const record = Object.freeze({ id, ...payload });
    records.set(id, record);
    return record;
  }

  function get(id) {
    if (typeof id !== "string" || !EVIDENCE_ID.test(id)) {
      fail("EVIDENCE_ID_INVALID", "evidence id is not a registered evid_ hash");
    }
    const record = records.get(id);
    if (!record) {
      fail("EVIDENCE_NOT_REGISTERED", "evidence id is not registered");
    }
    return record;
  }

  function list() {
    return [...records.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  }

  return { register, get, list };
}
