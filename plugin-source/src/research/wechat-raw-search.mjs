// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { splitMarkdownEvidenceItems } from "../runtime/source-connectors.mjs";

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_QUERY_CHARS = 120;
const MAX_FILES = 366;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_ITEM_CHARS = 12_000;
const MAX_SNIPPET_CHARS = 480;

function rawSearchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\p{Cf}\u0000]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = cleanText(value, 20);
  if (!DATE_PATTERN.test(date)) {
    throw rawSearchError("WECHAT_RAW_DATE_INVALID", `${field} must be YYYY-MM-DD`);
  }
  return date;
}

export function normalizeWechatRawSearchInput(value = {}) {
  const rawQuery = String(value.query ?? "");
  if ([...rawQuery].length > MAX_QUERY_CHARS) {
    throw rawSearchError("WECHAT_RAW_QUERY_TOO_LONG", "微信舆情检索词过长");
  }
  const query = cleanText(rawQuery, MAX_QUERY_CHARS);
  if (!query) throw rawSearchError("WECHAT_RAW_QUERY_REQUIRED", "微信舆情检索词不能为空");
  const dateFrom = normalizeDate(value.dateFrom, "dateFrom");
  const dateTo = normalizeDate(value.dateTo, "dateTo");
  const exposureCutoffDate = normalizeDate(
    value.exposureCutoffDate,
    "exposureCutoffDate",
  );
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw rawSearchError("WECHAT_RAW_DATE_RANGE_INVALID", "微信舆情日期范围无效");
  }
  const parsedLimit = Number(value.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(MAX_LIMIT, parsedLimit)
    : DEFAULT_LIMIT;
  return Object.freeze({ query, limit, dateFrom, dateTo, exposureCutoffDate });
}

function searchTerms(query) {
  const normalized = query.toLocaleLowerCase("zh-CN");
  const terms = normalized
    .split(/[\s,，、/|或或者]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
  const expanded = [];
  for (const term of terms) {
    expanded.push(term);
    if (/^[\p{Script=Han}]{2,}$/u.test(term) && term.length > 4) {
      for (let index = 0; index + 1 < term.length; index += 1) {
        expanded.push(term.slice(index, index + 2));
      }
    }
  }
  return Object.freeze([...new Set([normalized, ...expanded])].slice(0, 24));
}

function fileDate(name) {
  return DATE_FILE_PATTERN.exec(name)?.[1] || null;
}

async function listSourceFiles(directory, exposureCutoffDate = null) {
  if (typeof directory !== "string" || !path.isAbsolute(directory.trim())) {
    throw rawSearchError("WECHAT_RAW_DIRECTORY_INVALID", "微信原始目录未配置");
  }
  const root = path.resolve(directory);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw rawSearchError("WECHAT_RAW_DIRECTORY_UNAVAILABLE", "微信原始目录不可读");
  }
  const rootReal = await fs.realpath(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const date = fileDate(entry.name);
    if (!date) continue;
    if (exposureCutoffDate && date > exposureCutoffDate) continue;
    const absolutePath = path.join(root, entry.name);
    const lstat = await fs.lstat(absolutePath);
    if (lstat.isSymbolicLink()) {
      throw rawSearchError("WECHAT_RAW_SYMLINK_FORBIDDEN", "微信原始目录拒绝符号链接文件");
    }
    if (!lstat.isFile()) continue;
    const real = await fs.realpath(absolutePath);
    const relative = path.relative(rootReal, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw rawSearchError("WECHAT_RAW_PATH_INVALID", "微信原始文件越出受控目录");
    }
    files.push({ name: entry.name, date, absolutePath: real, size: lstat.size });
  }
  return files
    .sort((left, right) => right.date.localeCompare(left.date) || left.name.localeCompare(right.name))
    .slice(0, MAX_FILES);
}

function sectionHeading(text) {
  const line = String(text || "").split("\n").find((item) => item.trim()) || "微信舆情片段";
  return cleanText(line.replace(/^#{1,6}\s*/u, "").replace(/^\d+\.\s*/u, ""), 200);
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function scoreSection(text, terms, query) {
  const corpus = text.toLocaleLowerCase("zh-CN");
  let score = corpus.includes(query) ? 100 : 0;
  let matched = 0;
  for (const term of terms) {
    if (!term || term === query) continue;
    if (corpus.includes(term)) {
      matched += 1;
      score += term.length >= 3 ? 14 : 8;
    }
  }
  if (!score && matched < 2) return 0;
  return score + matched;
}

function snippetFor(text, query, terms) {
  const compact = cleanText(text, MAX_ITEM_CHARS);
  const lower = compact.toLocaleLowerCase("zh-CN");
  const needle = [query, ...terms]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((term) => lower.includes(term));
  if (!needle || compact.length <= MAX_SNIPPET_CHARS) return compact.slice(0, MAX_SNIPPET_CHARS);
  const matchAt = lower.indexOf(needle);
  const start = Math.max(0, matchAt - 160);
  const end = Math.min(compact.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`.slice(0, MAX_SNIPPET_CHARS);
}

export async function searchWechatRawMessages({ directory, ...rawInput } = {}) {
  const input = normalizeWechatRawSearchInput(rawInput);
  const files = await listSourceFiles(directory, input.exposureCutoffDate);
  const terms = searchTerms(input.query);
  const matches = [];
  let scannedBytes = 0;
  let truncated = files.length >= MAX_FILES;
  for (const file of files) {
    if (input.dateFrom && file.date < input.dateFrom) continue;
    if (input.dateTo && file.date > input.dateTo) continue;
    if (scannedBytes + file.size > MAX_SCAN_BYTES) {
      truncated = true;
      break;
    }
    const text = await fs.readFile(file.absolutePath, "utf8");
    scannedBytes += Buffer.byteLength(text, "utf8");
    const sections = splitMarkdownEvidenceItems(text, {
      relativePath: file.name,
      maxItemChars: MAX_ITEM_CHARS,
    });
    for (const section of sections) {
      const score = scoreSection(section.text, terms, input.query.toLocaleLowerCase("zh-CN"));
      if (!score) continue;
      const hash = contentHash(section.text);
      matches.push({
        score,
        sourceDate: file.date,
        sourceDocumentKey: `raw/微信聊天/${file.name}#L${section.lineStart}-L${section.lineEnd}:${hash.slice(0, 12)}`,
        heading: sectionHeading(section.text),
        snippet: snippetFor(section.text, input.query.toLocaleLowerCase("zh-CN"), terms),
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        contentHash: hash,
        eventAt: section.declaredPublishedAt || `${file.date}T00:00:00+08:00`,
      });
    }
  }
  matches.sort((left, right) => (
    right.score - left.score
    || right.sourceDate.localeCompare(left.sourceDate)
    || left.lineStart - right.lineStart
  ));
  const visible = matches.slice(0, input.limit).map(({ score: _score, ...match }) => Object.freeze(match));
  return Object.freeze({
    schema: "wechat-raw-search-v1",
    readOnly: true,
    source: "raw/微信聊天",
    query: input.query,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    exposureCutoffDate: input.exposureCutoffDate,
    matches: Object.freeze(visible),
    totalMatches: matches.length,
    truncated,
    scannedDocuments: files.length,
    scannedBytes,
  });
}
