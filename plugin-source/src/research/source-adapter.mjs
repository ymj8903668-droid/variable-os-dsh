// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { RESEARCH_CASES } from "./cases.mjs";
import { fail } from "./errors.mjs";
import { describeSourceFile } from "./source-hash.mjs";
import { resolveNamedSources } from "./source-discover.mjs";
import { normalizeTemporal } from "./time.mjs";

const MAX_FOLLOWED_MEETINGS = 8;
const MAX_MEETING_LINES = 8;
const SENSITIVE = /总资产|总仓|持仓|账户/;

export function accessLevelFor(relPath) {
  return relPath.startsWith("raw/") ? "RESTRICTED" : "TEAM";
}

export function suggestNodeTypeForRecord(record, named) {
  if (record && record.sourceKind === "expert_meeting") {
    // Keep the canonical timeline vocabulary. Source provenance identifies Liudu.
    return "EXPERT_MEETING";
  }
  if (named && named.role === "morningReview") {
    return "MORNING_HYPOTHESIS";
  }
  if (named && named.role === "eveningReview") {
    return "EVENING_VALIDATION";
  }
  if (named && named.role === "wechatSentiment") {
    return "WECHAT_DIGEST";
  }
  if (
    named &&
    (named.role === "gangtiseClues" || named.role === "gangtiseCluesIngest")
  ) {
    return "GANGTISE_CLUE";
  }
  const blob = `${(record && record.claim) || ""} ${(record && record.object) || ""}`;
  if (/更正|纠正/.test(blob)) {
    return "CORRECTION";
  }
  return "SOURCE_EVENT";
}

function provenanceFields(record, named) {
  return {
    evidenceLevel: record && record.evidenceLevel ? record.evidenceLevel : null,
    sourceKind: record && record.sourceKind ? record.sourceKind : null,
    sourceType:
      (record && record.sourceKind) ||
      (named && named.role) ||
      (named && named.kind) ||
      null,
    suggestedNodeType: suggestNodeTypeForRecord(record, named),
    sourceChannel:
      record && record.sourceKind === "expert_meeting"
        ? "LIUDU"
        : named &&
            (named.role === "gangtiseClues" ||
              named.role === "gangtiseCluesIngest")
          ? "GANGTISE"
          : null,
  };
}

export function resolveUnderRoot(sourceRoot, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    fail("SOURCE_PATH_INVALID", "relative source path required");
  }
  if (path.isAbsolute(relPath) || relPath.includes("\0") || relPath.includes("..")) {
    fail("SOURCE_PATH_INVALID", "source path must stay relative");
  }
  const root = path.resolve(sourceRoot);
  const full = path.resolve(root, ...relPath.split("/"));
  const relative = path.relative(root, full);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    fail("SOURCE_PATH_INVALID", "source path escaped source root");
  }
  return full;
}

async function streamJsonl(absolutePath, onRecord) {
  const stream = createReadStream(absolutePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line === "") {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail("JSONL_CORRUPT", `invalid json at ${absolutePath}:${lineNumber}`);
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("JSONL_CORRUPT", `non-object json at ${absolutePath}:${lineNumber}`);
    }
    await onRecord({ lineNumber, record });
  }
  return lineNumber;
}

async function readLines(absolutePath) {
  const stream = createReadStream(absolutePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines;
}

async function readLineRange(absolutePath, start, end) {
  const last = Math.min(end, start + MAX_MEETING_LINES - 1);
  const stream = createReadStream(absolutePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let lineNumber = 0;
  for await (const text of rl) {
    lineNumber += 1;
    if (lineNumber < start) {
      continue;
    }
    if (lineNumber > last) {
      break;
    }
    lines.push({ lineNumber, text });
  }
  return lines;
}

function needlesFor(caseDef) {
  return [caseDef.title, ...caseDef.names];
}

export function recordMatchesCase(record, caseDef) {
  if (record.wikiPath === caseDef.wikiPath) {
    return true;
  }
  const fields = [
    record.canonicalSubject,
    record.subject,
    ...(Array.isArray(record.aliases) ? record.aliases : []),
  ];
  return caseDef.names.some((name) =>
    fields.some((field) => typeof field === "string" && field.includes(name)),
  );
}

function inferMarkdownEventAt(lines, relPath) {
  let frontEnd = 40;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      frontEnd = close;
    }
  }
  const head = lines.slice(0, Math.max(frontEnd, 40)).join("\n");
  const dateField = /(?:^|\n)date:\s*(\d{4}-\d{2}-\d{2})/.exec(head);
  if (dateField) {
    return dateField[1];
  }
  const created =
    /(?:^|\n)created:\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
      head,
    );
  if (created) {
    if (
      !created[2] ||
      (created[2] === "00" &&
        created[3] === "00" &&
        (!created[4] || created[4] === "00"))
    ) {
      return created[1];
    }
    return `${created[1]} ${created[2]}:${created[3]}:${created[4] || "00"}`;
  }
  const fromPath = /(\d{4}-\d{2}-\d{2})/.exec(relPath);
  if (fromPath) {
    return fromPath[1];
  }
  const fromTitle = /(\d{4}-\d{2}-\d{2})/.exec(lines[0] || "");
  if (fromTitle) {
    return fromTitle[1];
  }
  return null;
}

function findMarkdownHit(lines, caseDef) {
  const needles = needlesFor(caseDef);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (SENSITIVE.test(text)) {
      continue;
    }
    if (needles.some((needle) => text.includes(needle))) {
      return { lineNumber: index + 1, text };
    }
  }
  return null;
}

function pushUnique(list, item, seen) {
  if (seen.has(item.path)) {
    return;
  }
  seen.add(item.path);
  list.push(item);
}

export async function loadBoundedResearchCorpus({
  sourceRoot,
  now,
  registry,
}) {
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
    fail("SOURCE_ROOT_MISSING", "sourceRoot required");
  }
  const sources = [];
  const seenSources = new Set();
  const watermarks = {};
  const caseNodes = new Map(
    RESEARCH_CASES.map((caseDef) => [caseDef.caseId, []]),
  );
  const followedMeetings = [];
  const { sources: namedList, discovered } = await resolveNamedSources({
    sourceRoot,
  });

  async function addSource(relPath, kind) {
    const absolutePath = resolveUnderRoot(sourceRoot, relPath);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        fail("NAMED_SOURCE_MISSING", `missing source ${relPath}`, { relPath });
      }
      throw err;
    }
    if (!stat.isFile()) {
      fail("NAMED_SOURCE_MISSING", `source is not a file ${relPath}`, {
        relPath,
      });
    }
    const descriptor = await describeSourceFile({
      absolutePath,
      path: relPath,
      kind,
    });
    pushUnique(sources, descriptor, seenSources);
    return { absolutePath, descriptor };
  }

  function addNode(caseId, node) {
    if (!node.eventAt) {
      return;
    }
    caseNodes.get(caseId).push(node);
  }

  for (const named of namedList) {
    const loaded = await addSource(named.path, named.kind);
    if (named.kind === "jsonl") {
      let lastId = null;
      const lineCount = await streamJsonl(
        loaded.absolutePath,
        async ({ lineNumber, record }) => {
          lastId = record.id || lastId;
          const matched = RESEARCH_CASES.filter((caseDef) =>
            recordMatchesCase(record, caseDef),
          );
          if (matched.length === 0) {
            return;
          }
          const temporal = normalizeTemporal({
            eventAt: record.validAt || record.sourceDate || record.createdAt,
            availableAt: record.createdAt,
            recordedAt: record.createdAt,
            now,
          });
          const evidence = registry.register({
            sourcePath: named.path,
            sha256: loaded.descriptor.sha256,
            lineNumber,
            accessLevel: accessLevelFor(named.path),
            summary: record.claim || record.object || record.subject || "",
          });
          for (const caseDef of matched) {
            addNode(caseDef.caseId, {
              eventAt: temporal.eventAt,
              availableAt: temporal.availableAt,
              recordedAt: temporal.recordedAt,
              timePrecision: temporal.timePrecision,
              evidenceId: evidence.id,
              summary: evidence.summary,
              ...provenanceFields(record, named),
            });
          }
          if (
            record.sourceKind === "expert_meeting" &&
            typeof record.sourcePath === "string" &&
            followedMeetings.length < MAX_FOLLOWED_MEETINGS
          ) {
            followedMeetings.push({
              relPath: record.sourcePath,
              caseIds: matched.map((row) => row.caseId),
              temporal,
              sourceRefs: Array.isArray(record.sourceRefs)
                ? record.sourceRefs
                : [],
              evidenceLevel: record.evidenceLevel || null,
              sourceKind: record.sourceKind,
            });
          }
        },
      );
      watermarks[named.role] = Object.freeze({
        path: named.path,
        sha256: loaded.descriptor.sha256,
        lineCount,
        lastId,
      });
    } else {
      const lines = await readLines(loaded.absolutePath);
      const eventAt = inferMarkdownEventAt(lines, named.path);
      const temporal = normalizeTemporal({
        eventAt,
        availableAt: null,
        recordedAt: eventAt,
        now,
      });
      for (const caseDef of RESEARCH_CASES) {
        const hit = findMarkdownHit(lines, caseDef);
        if (!hit) {
          continue;
        }
        const evidence = registry.register({
          sourcePath: named.path,
          sha256: loaded.descriptor.sha256,
          lineNumber: hit.lineNumber,
          accessLevel: accessLevelFor(named.path),
          summary: hit.text,
        });
        addNode(caseDef.caseId, {
          eventAt: temporal.eventAt,
          availableAt: temporal.availableAt,
          recordedAt: temporal.recordedAt,
          timePrecision: temporal.timePrecision,
          evidenceId: evidence.id,
          summary: evidence.summary,
          ...provenanceFields(null, named),
        });
      }
    }
  }

  for (const meeting of followedMeetings) {
    let loaded;
    try {
      loaded = await addSource(meeting.relPath, "markdown");
    } catch (err) {
      if (err && err.code === "NAMED_SOURCE_MISSING") {
        continue;
      }
      throw err;
    }
    const ref = meeting.sourceRefs[0];
    const start = Number.isInteger(ref?.lineStart) ? ref.lineStart : 1;
    const end = Number.isInteger(ref?.lineEnd) ? ref.lineEnd : start;
    const range = await readLineRange(loaded.absolutePath, start, end);
    const hit =
      range.find((row) => row.text.trim() && !SENSITIVE.test(row.text)) ||
      range[0];
    if (!hit) {
      continue;
    }
    const evidence = registry.register({
      sourcePath: meeting.relPath,
      sha256: loaded.descriptor.sha256,
      lineNumber: hit.lineNumber,
      accessLevel: accessLevelFor(meeting.relPath),
      summary: hit.text,
    });
    for (const caseId of meeting.caseIds) {
      addNode(caseId, {
        eventAt: meeting.temporal.eventAt,
        availableAt: meeting.temporal.availableAt,
        recordedAt: meeting.temporal.recordedAt,
        timePrecision: meeting.temporal.timePrecision,
        evidenceId: evidence.id,
        summary: evidence.summary,
        evidenceLevel: meeting.evidenceLevel || null,
        sourceKind: meeting.sourceKind || "expert_meeting",
        sourceType: meeting.sourceKind || "expert_meeting",
        suggestedNodeType: "EXPERT_MEETING",
      });
    }
  }

  sources.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    sources,
    watermarks: Object.freeze(watermarks),
    discovered: Object.freeze(discovered),
    caseNodes,
  };
}
