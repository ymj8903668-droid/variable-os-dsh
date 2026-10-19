// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalHash } from "../schema/canonical-json.mjs";
import { resolveDeskPaths } from "../research/desk-paths.mjs";
import { LIUDU_READ_LIMITS, liuduReadBudget, liuduReadError, readStableLiuduJsonl } from "./liudu-jsonl-reader.mjs";

export function sourceConnectorPolicy(connector, defaultSensitivity = "INTERNAL") {
  return {
    sensitivity: connector.sensitivity || defaultSensitivity,
    modelUseAllowed: connector.modelUseAllowed === true,
    exportAllowed: connector.exportAllowed === true,
    accessScope: Array.isArray(connector.accessScope) ? connector.accessScope : ["local"],
  };
}

function connectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function asBoundedText(value, maxChars = 2_000) {
  if (typeof value === "string") return value.slice(0, maxChars);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value).slice(0, maxChars);
}

function listText(value, maxItems = 8) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((row) => asBoundedText(row, 1_200));
}

function publishedAtFrom(text, relativePath) {
  const timestamp = /(?:^|\n)#{1,3}\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    text,
  );
  if (timestamp) {
    return `${timestamp[1]}T${timestamp[2]}:${timestamp[3]}:${timestamp[4] || "00"}+08:00`;
  }
  const date = /(\d{4})[-.](\d{2})[-.](\d{2})/.exec(relativePath);
  return date ? `${date[1]}-${date[2]}-${date[3]}T00:00:00+08:00` : null;
}

function makeRanges(lines) {
  const numbered = [];
  lines.forEach((line, index) => {
    if (/^\s*\d+\.\s+\*\*/.test(line) || /^###\s+\d+\.\s+/.test(line)) {
      numbered.push(index);
    }
  });
  if (numbered.length) return numbered;
  const headings = [];
  lines.forEach((line, index) => {
    if (/^##\s+\S/.test(line) && !/^##\s+(今日概览|主题索引|逐条明细)\s*$/.test(line)) {
      headings.push(index);
    }
  });
  return headings.length ? headings : lines.some((line) => line.trim()) ? [0] : [];
}

function boundedSections(lines, starts, maxItemChars) {
  const sections = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const nextStart = index + 1 < starts.length ? starts[index + 1] : lines.length;
    const nextHeading = lines.findIndex(
      (line, lineIndex) => lineIndex > start && /^##\s+\S/.test(line),
    );
    const boundary = nextHeading > start
      ? Math.min(nextStart, nextHeading)
      : nextStart;
    let end = boundary - 1;
    while (end > start && lines[end].trim() === "") end -= 1;
    let text = lines.slice(start, end + 1).join("\n");
    if (text.length > maxItemChars) {
      text = text.slice(0, maxItemChars).trimEnd();
      const keptLines = text.split("\n").length;
      end = start + keptLines - 1;
    }
    if (text.trim()) sections.push({ start, end, text });
  }
  return sections;
}

function markdownItem(section, relativePath) {
  const lineStart = section.start + 1;
  const lineEnd = section.end + 1;
  return {
    sourceDocumentKey: `${relativePath}#L${lineStart}-L${lineEnd}:${sha256(section.text).slice(0, 12)}`,
    text: section.text, lineStart, lineEnd,
    declaredPublishedAt: publishedAtFrom(section.text, relativePath),
  };
}

// Original appendices belong to messages, not to the last numbered summary.
// Use a unique, exact provenance match; the selected source remains one literal
// contiguous span. Never concatenate a summary and distant raw text into a fake span.
function duplicateOriginalBody(text) {
  const lines = String(text).split(/\r?\n/);
  const body = lines.slice(2, -1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      // Reposts often differ only in a short title/emoji or trailing ticker tag.
      // Keep the substantive paragraph, but never use metadata-only lines to
      // decide that two otherwise different originals are duplicates.
      if (line.length > 160) return true;
      if (line.includes("【") && line.includes("】")) return false;
      return !/^\s*(?:\[[^\]\n]{1,20}\]\s*)?(?:#[\p{L}\p{N}_-]+\s*){1,12}$/u.test(line);
    });
  const normalized = body.join("\n").replace(/\s+/g, "");
  return normalized.length >= 32 ? normalized : null;
}

function summaryEvidenceKeywords(text) {
  const keywords = new Set();
  const runs = String(text).match(/[\p{Script=Han}]{3,}|[A-Za-z0-9]{3,}/gu) || [];
  for (const run of runs) {
    if (/^[\p{Script=Han}]+$/u.test(run)) {
      for (let index = 0; index + 3 <= run.length; index += 1) {
        keywords.add(run.slice(index, index + 3));
      }
    } else {
      keywords.add(run);
    }
  }
  return [...keywords];
}

function duplicateOriginalFallback(originals, declaredCount, summaryText) {
  if (originals.length < 2 || (declaredCount !== null && declaredCount < 2)) return null;
  const keywords = summaryEvidenceKeywords(summaryText);
  if (keywords.length < 2) return null;
  const groups = new Map();
  for (const row of originals) {
    const key = duplicateOriginalBody(row.text);
    if (!key) return null;
    const rows = groups.get(key) || [];
    rows.push(row);
    groups.set(key, rows);
  }
  if (groups.size !== 1) return null;
  const [rows] = groups.values();
  if (rows.length !== originals.length) return null;
  const body = duplicateOriginalBody(rows[0].text);
  const matched = new Set(keywords.filter((keyword) => body.includes(keyword)));
  return matched.size >= 2 ? rows[0] : null;
}

function wechatEvidenceItems(lines, relativePath, maxItemChars, legacySections) {
  let fence = null;
  const outside = lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return false;
    }
    if (marker) { fence = marker[1]; return false; }
    return true;
  });
  const headings = lines.flatMap((line, i) => outside[i] && /^##\s+/.test(line) ? [i] : []);
  const digestPattern = /^##\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+微信(?:股票群)?增量摘要\s*$/;
  if (!headings.some((i) => digestPattern.test(lines[i]))) return null;
  const legacy = new Map(legacySections.map((section) => [section.start, markdownItem(section, relativePath)]));
  const result = [];
  const sectionAt = (start, boundary) => {
    let end = boundary - 1;
    while (end > start && !lines[end].trim()) end--;
    let text = lines.slice(start, end + 1).join("\n");
    while (end > start && text.length > maxItemChars) text = lines.slice(start, --end + 1).join("\n");
    if (text.length > maxItemChars) throw connectorError("SOURCE_CONTENT_TOO_LARGE", "source heading exceeds evidence bound");
    while (end > start && !lines[end].trim()) end--;
    return { start, end, text: lines.slice(start, end + 1).join("\n") };
  };
  for (let b = 0; b < headings.length; b++) {
    const start = headings[b], end = headings[b + 1] ?? lines.length;
    const digest = digestPattern.exec(lines[start]);
    if (!digest) {
      result.push(...legacySections.filter((section) => section.start >= start && section.start < end)
        .map((section) => Object.freeze(markdownItem(section, relativePath))));
      continue;
    }
    const appendix = lines.findIndex((line, i) => i > start && i < end && outside[i] && /^###\s+【完整调研原文】\s*$/.test(line));
    const summaryEnd = appendix < 0 ? end : appendix;
    const summaries = lines.flatMap((line, i) => i > start && i < summaryEnd && outside[i]
      && (/^\s*\d+\.\s+\*\*/.test(line) || /^###\s+\d+\.\s+/.test(line)) ? [i] : []);
    const originals = [];
    if (appendix >= 0) for (let i = appendix + 1; i < end; i++) {
      if (!outside[i]) continue;
      const header = /^####\s+(.+?)｜消息时间：(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*$/.exec(lines[i]);
      if (!header) continue;
      let open = i + 1;
      while (open < end && !lines[open].trim()) open++;
      const marker = /^\s{0,3}(`{3,}|~{3,})\w*\s*$/.exec(lines[open] || "");
      if (!marker) continue;
      let close = open + 1;
      for (; close < end; close++) {
        const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[close]);
        if (closing && closing[1][0] === marker[1][0] && closing[1].length >= marker[1].length) break;
      }
      if (close === end) continue;
      originals.push({ group: header[1], date: header[2], time: header[3], start: i,
        end: close, text: lines.slice(i, close + 1).join("\n") });
    }
    for (let j = 0; j < summaries.length; j++) {
      const summary = sectionAt(summaries[j], summaries[j + 1] ?? summaryEnd);
      const summaryItem = markdownItem(summary, relativePath);
      const provenance = summary.text.split("\n").filter((line, offset) => outside[summary.start + offset]
        && /^\s*-\s*\*\*代表来源\*\*[：:]/.test(line));
      const ref = provenance.length === 1 ? /^\s*-\s*\*\*代表来源\*\*[：:]\s*(.+?)\s+(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{2}:\d{2}:\d{2})(?:｜|$)/.exec(provenance[0]) : null;
      const count = /原文数[：:]\s*(\d+)/.exec(lines[summary.start]);
      const declaredCount = count ? Number(count[1]) : null;
      const matches = ref && (!count || declaredCount === 1)
        && (provenance[0].match(/\d{2}:\d{2}(?::\d{2})?/g) || []).length === 1
        ? originals.filter((row) => row.group === ref[1] && row.date === (ref[2] || digest[1]) && row.time === ref[3]
          && `${row.date}T${row.time}` <= `${digest[1]}T${digest[2]}`) : [];
      const duplicate = duplicateOriginalFallback(originals, declaredCount, summary.text);
      const selected = matches.length === 1 && matches[0].text.length <= maxItemChars
        ? matches[0]
        : duplicate && duplicate.text.length <= maxItemChars
          ? duplicate
          : summary;
      const item = markdownItem(selected, relativePath);
      if (selected !== summary) item.declaredPublishedAt = `${selected.date}T${selected.time}+08:00`;
      const previousIdentities = [legacy.get(summary.start), summaryItem].filter((old, index, all) => old
        && old.sourceDocumentKey !== item.sourceDocumentKey
        && all.findIndex((other) => other?.sourceDocumentKey === old.sourceDocumentKey) === index)
        .map(({ sourceDocumentKey, text }) => ({ sourceDocumentKey, text }));
      result.push(Object.freeze({ ...item, ...(previousIdentities.length ? { previousIdentities } : {}) }));
    }
  }
  return result;
}

export function splitMarkdownEvidenceItems(
  text,
  { relativePath, maxItemChars = 12_000 } = {},
) {
  if (typeof text !== "string") {
    throw connectorError("SOURCE_CONTENT_INVALID", "markdown text required");
  }
  const lines = text.split(/\r?\n/);
  const starts = makeRanges(lines);
  const legacySections = boundedSections(lines, starts, maxItemChars);
  return wechatEvidenceItems(lines, relativePath, maxItemChars, legacySections)
    ?? legacySections.map((section) => Object.freeze(markdownItem(section, relativePath)));
}

async function listSafeFiles(connector) {
  const root = path.resolve(connector.root);
  const rootReal = await fs.realpath(root).catch(() => root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!connector.filePattern.test(entry.name)) continue;
    const absolutePath = path.join(root, entry.name);
    const lstat = await fs.lstat(absolutePath);
    if (lstat.isSymbolicLink()) {
      throw connectorError(
        "SOURCE_SYMLINK_FORBIDDEN",
        "source connector refuses symbolic links",
      );
    }
    const real = await fs.realpath(absolutePath);
    const relative = path.relative(rootReal, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw connectorError("SOURCE_PATH_INVALID", "source file escaped connector root");
    }
    const stat = await fs.stat(real);
    files.push({ absolutePath: real, relativePath: entry.name, mtimeMs: stat.mtimeMs });
  }
  return files.sort((left, right) =>
    left.mtimeMs !== right.mtimeMs
      ? left.mtimeMs - right.mtimeMs
      : left.relativePath.localeCompare(right.relativePath),
  );
}

export async function discoverConnectorItems({ connector, cursor } = {}) {
  if (!connector || typeof connector.root !== "string") {
    throw connectorError("CONNECTOR_INVALID", "connector root required");
  }
  const allFiles = await listSafeFiles(connector);
  const priorMtime = Number(cursor?.lastMtimeMs);
  let files;
  if (Number.isFinite(priorMtime)) {
    const latest = allFiles.at(-1);
    files = allFiles.filter(
      (row) => row.mtimeMs > priorMtime || row.absolutePath === latest?.absolutePath,
    );
  } else {
    const limit = Math.max(1, Number(connector.bootstrapFileLimit) || 1);
    files = allFiles.slice(-limit);
  }
  const items = [];
  for (const file of files) {
    const raw = await fs.readFile(file.absolutePath, "utf8");
    const split = splitMarkdownEvidenceItems(raw, {
      relativePath: file.relativePath,
      maxItemChars: connector.maxItemChars || 12_000,
    });
    for (const item of split) {
      items.push(
        Object.freeze({
          connectorId: connector.id,
          sourceNamespace: connector.sourceNamespace,
          sourceDocumentKey: item.sourceDocumentKey,
          ...(item.previousIdentities ? { previousIdentities: item.previousIdentities.map((previous) => ({
            sourceDocumentKey: previous.sourceDocumentKey,
            contentHash: canonicalHash({ sourceNamespace: connector.sourceNamespace, text: previous.text }),
          })) } : {}),
          sourceKind: connector.sourceKind,
          rawUri: file.absolutePath,
          contentHash: canonicalHash({
            sourceNamespace: connector.sourceNamespace,
            text: item.text,
          }),
          excerpt: item.text,
          lineStart: item.lineStart,
          lineEnd: item.lineEnd,
          declaredPublishedAt: item.declaredPublishedAt,
          ...sourceConnectorPolicy(connector),
        }),
      );
    }
  }
  return Object.freeze({
    files: Object.freeze(files),
    items: Object.freeze(items),
    cursor: Object.freeze({
      lastMtimeMs: allFiles.length ? allFiles.at(-1).mtimeMs : priorMtime || 0,
      lastFile: allFiles.length ? allFiles.at(-1).relativePath : cursor?.lastFile || null,
      sourceWatermarkAt: allFiles.length
        ? new Date(allFiles.at(-1).mtimeMs).toISOString()
        : cursor?.sourceWatermarkAt || null,
    }),
  });
}

async function newestLiuduSnapshot(root) {
  const resolved = path.resolve(root);
  const rootReal = await fs.realpath(resolved);
  const entries = await fs.readdir(rootReal, { withFileTypes: true });
  const dated = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}\.\d{2}\.\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of dated) {
    const target = path.join(rootReal, name, "all_records.jsonl");
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        throw connectorError(
          "SOURCE_SYMLINK_FORBIDDEN",
          "Liudu connector refuses symbolic links",
        );
      }
      if (stat.isFile()) return { absolutePath: target, relativePath: `${name}/all_records.jsonl` };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const fallback = path.join(rootReal, "all_records.jsonl");
  const stat = await fs.lstat(fallback);
  if (stat.isSymbolicLink()) {
    throw connectorError(
      "SOURCE_SYMLINK_FORBIDDEN",
      "Liudu connector refuses symbolic links",
    );
  }
  if (!stat.isFile()) {
    throw connectorError("SOURCE_NOT_FOUND", "Liudu cumulative JSONL missing");
  }
  return { absolutePath: fallback, relativePath: "all_records.jsonl" };
}

export function liuduRecordKey(record) {
  return `${Number(record?.date) || 0}:${asBoundedText(record?.title, 300)}`;
}

export function liuduExcerpt(record) {
  const questions = listText(record.questions, 4);
  const answers = listText(record.answers, 4);
  const pairs = questions.map((question, index) =>
    `问：${question}\n答：${answers[index] || ""}`.trim(),
  );
  return [
    `会议：${asBoundedText(record.title, 500)}`,
    listText(record.industry_list, 12).length
      ? `行业：${listText(record.industry_list, 12).join("、")}`
      : "",
    listText(record.ticker_list, 20).length
      ? `公司代码：${listText(record.ticker_list, 20).join("、")}`
      : "",
    ...pairs,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);
}

function liuduItem(record, key, connector, file) {
    const excerpt = liuduExcerpt(record);
    const published = Number(record.date);
    return Object.freeze({
      connectorId: connector.id,
      sourceNamespace: connector.sourceNamespace,
      sourceDocumentKey: `${file.relativePath}#${canonicalHash(key).slice(0, 20)}`,
      sourceKind: connector.sourceKind,
      rawUri: file.absolutePath,
      contentHash: canonicalHash({
        sourceNamespace: connector.sourceNamespace,
        record,
      }),
      excerpt,
      lineStart: null,
      lineEnd: null,
      declaredPublishedAt:
        Number.isFinite(published) && published > 0
          ? new Date(published * 1_000).toISOString()
          : null,
      ...sourceConnectorPolicy(connector, "RESTRICTED"),
    });
}

export async function discoverLiuduItems({ connector, cursor } = {}) {
  if (!connector || typeof connector.root !== "string") {
    throw connectorError("CONNECTOR_INVALID", "Liudu connector root required");
  }
  const checkBudget = liuduReadBudget();
  const file = await newestLiuduSnapshot(connector.root);
  const priorKey = typeof cursor?.lastRecordKey === "string" ? cursor.lastRecordKey : null;
  const limit = Math.trunc(Math.max(1, Math.min(100, Number(connector.bootstrapRecordLimit) || 20)));
  const tail = [], selected = [];
  let tailBytes = 0, itemBytes = 0, lastKey = null;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parse = raw => {
    try { return JSON.parse(decoder.decode(raw)); }
    catch { throw liuduReadError("SOURCE_CONTENT_INVALID"); }
  };
  const addItem = (record, key) => {
    checkBudget();
    if (selected.length >= LIUDU_READ_LIMITS.items) throw liuduReadError("SOURCE_SELECTION_TOO_LARGE");
    let item;
    try { item = liuduItem(record, key, connector, file); }
    catch { throw liuduReadError("SOURCE_CONTENT_INVALID"); }
    itemBytes += Buffer.byteLength(JSON.stringify(item));
    if (itemBytes > LIUDU_READ_LIMITS.itemBytes) throw liuduReadError("SOURCE_SELECTION_TOO_LARGE");
    selected.push({ key, item });
    checkBudget();
  };
  const stat = await readStableLiuduJsonl(file.absolutePath, (raw, terminated) => {
    // Preserve the old CRLF split and blank-line behavior. Whitespace-only
    // lines and a BOM are not silently turned into absent evidence.
    const line = terminated && raw.at(-1) === 13 ? raw.subarray(0, -1) : raw;
    if (!line.length) return;
    const record = parse(line);
    checkBudget();
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const key = liuduRecordKey(record);
    if (lastKey === null || lastKey.localeCompare(key) <= 0) lastKey = key;
    if (priorKey) {
      if (key > priorKey) addItem(record, key);
    } else if (tail.length < limit || tail[0].key.localeCompare(key) <= 0) {
      // Keep bytes, not a retained graph of parsed source objects. Materialize
      // only the final tail: discarded rows may have unusable declared dates.
      tail.push({ key, raw: Buffer.from(line) }); tailBytes += line.length;
      tail.sort((a, b) => a.key.localeCompare(b.key));
      if (tail.length > limit) tailBytes -= tail.shift().raw.length;
      if (tailBytes > LIUDU_READ_LIMITS.bootstrapBytes) throw liuduReadError("SOURCE_SELECTION_TOO_LARGE");
    }
  }, checkBudget, () => {
    for (const row of tail) addItem(parse(row.raw), row.key);
    selected.sort((a, b) => a.key.localeCompare(b.key));
    checkBudget();
  });
  checkBudget();
  const items = selected.map(row => row.item);
  return Object.freeze({
    files: Object.freeze([file]),
    items: Object.freeze(items),
    cursor: Object.freeze({
      snapshot: file.relativePath,
      lastRecordKey: lastKey || priorKey,
      sourceWatermarkAt: stat.mtime.toISOString(),
    }),
  });
}

export function defaultSourceConnectors(env = process.env) {
  const { sourceRoot, liuduRoot } = resolveDeskPaths(env);
  const allowRemote = env.VARIABLE_OS_ALLOW_REMOTE_SOURCE_LLM === "1";
  const shared = {
    bootstrapFileLimit: 1,
    maxItemChars: 12_000,
    sensitivity: "RESTRICTED",
    modelUseAllowed: allowRemote,
    exportAllowed: false,
    accessScope: ["local"],
  };
  return Object.freeze([
    Object.freeze({
      ...shared,
      id: "wechat",
      sourceNamespace: "local.wechat",
      sourceKind: "markdown",
      root: path.join(sourceRoot, "raw", "微信聊天"),
      filePattern: /^\d{4}-\d{2}-\d{2}\.md$/,
      adapterVersion: "markdown-evidence-v1",
      pollIntervalSeconds: 60,
    }),
    Object.freeze({
      ...shared,
      id: "gangtise",
      sourceNamespace: "local.gangtise",
      sourceKind: "markdown",
      root: path.join(sourceRoot, "raw", "研报新闻", "投研线索"),
      filePattern: /gangtise-meeting-clues\.md$/,
      adapterVersion: "markdown-evidence-v1",
      pollIntervalSeconds: 180,
    }),
    Object.freeze({
      ...shared,
      id: "morning-review",
      sourceNamespace: "local.morning-review",
      sourceKind: "markdown",
      root: path.join(sourceRoot, ".llm-wiki", "morning-review"),
      filePattern: /\.md$/,
      adapterVersion: "markdown-evidence-v1",
      pollIntervalSeconds: 300,
    }),
    Object.freeze({
      ...shared,
      id: "evening-review",
      sourceNamespace: "local.evening-review",
      sourceKind: "markdown",
      root: path.join(sourceRoot, "raw", "日复盘"),
      filePattern: /^\d{4}-\d{2}-\d{2}-复盘\.md$/,
      adapterVersion: "markdown-evidence-v1",
      pollIntervalSeconds: 300,
    }),
    ...(liuduRoot ? [Object.freeze({
      ...shared,
      id: "liudu",
      sourceNamespace: "local.liudu",
      sourceKind: "meeting-jsonl",
      root: path.join(liuduRoot, "polarisix_xuanji_export"),
      adapterVersion: "liudu-jsonl-v1",
      pollIntervalSeconds: 300,
      bootstrapRecordLimit: 20,
    })] : []),
  ]);
}
