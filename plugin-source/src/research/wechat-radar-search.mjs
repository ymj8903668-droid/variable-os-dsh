// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const MAX_QUERY_CHARS = 120;
const MAX_SCOPE_ENTRIES = 500;
const MAX_CONFIG_BYTES = 1 * 1024 * 1024;
const MAX_SNIPPET_CHARS = 480;

function radarSearchError(code, message) {
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
    throw radarSearchError("WECHAT_RADAR_DATE_INVALID", `${field} must be YYYY-MM-DD`);
  }
  return date;
}

export function normalizeWechatRadarSearchInput(value = {}) {
  const rawQuery = String(value.query ?? "");
  if ([...rawQuery].length > MAX_QUERY_CHARS) {
    throw radarSearchError("WECHAT_RADAR_QUERY_TOO_LONG", "微信雷达检索词过长");
  }
  const query = cleanText(rawQuery, MAX_QUERY_CHARS);
  if (!query) throw radarSearchError("WECHAT_RADAR_QUERY_REQUIRED", "微信雷达检索词不能为空");
  const dateFrom = normalizeDate(value.dateFrom, "dateFrom");
  const dateTo = normalizeDate(value.dateTo, "dateTo");
  const exposureCutoffDate = normalizeDate(value.exposureCutoffDate, "exposureCutoffDate");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw radarSearchError("WECHAT_RADAR_DATE_RANGE_INVALID", "微信雷达日期范围无效");
  }
  const parsedLimit = Number(value.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(MAX_LIMIT, parsedLimit)
    : DEFAULT_LIMIT;
  return Object.freeze({ query, limit, dateFrom, dateTo, exposureCutoffDate });
}

function absoluteRegularFile(filePath, code, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath.trim())) {
    throw radarSearchError(code, `${label}路径未配置`);
  }
  return path.resolve(filePath);
}

async function readScope(groupsConfigPath) {
  const configuredPath = absoluteRegularFile(
    groupsConfigPath,
    "WECHAT_RADAR_SCOPE_UNAVAILABLE",
    "微信雷达群组配置",
  );
  const stat = await fs.lstat(configuredPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    throw radarSearchError("WECHAT_RADAR_SCOPE_UNAVAILABLE", "微信雷达群组配置不可读");
  }
  const realPath = await fs.realpath(configuredPath).catch(() => null);
  if (!realPath) {
    throw radarSearchError("WECHAT_RADAR_SCOPE_UNAVAILABLE", "微信雷达群组配置路径无效");
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(realPath, "utf8"));
  } catch {
    throw radarSearchError("WECHAT_RADAR_SCOPE_UNAVAILABLE", "微信雷达群组配置不可解析");
  }
  const entries = [
    ...(Array.isArray(parsed?.groups) ? parsed.groups : []),
    ...(Array.isArray(parsed?.contacts) ? parsed.contacts : []),
  ];
  const scope = new Map();
  for (const entry of entries.slice(0, MAX_SCOPE_ENTRIES)) {
    const id = cleanText(entry?.chatroom_id || entry?.username, 160);
    if (!id) continue;
    const label = cleanText(entry?.name, 160) || id;
    scope.set(id, label);
  }
  if (!scope.size) {
    throw radarSearchError("WECHAT_RADAR_SCOPE_UNAVAILABLE", "微信雷达群组配置没有可读范围");
  }
  return scope;
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/gu, "\\$&")}%`;
}

function contentHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeSourcePart(value) {
  return cleanText(value, 120).replace(/[^A-Za-z0-9._:@-]/gu, "_") || "unknown";
}

function eventAt(date, time, timestamp) {
  const value = cleanText(time, 40);
  if (value.includes("T")) return value;
  if (DATE_PATTERN.test(date) && value) return `${date}T${value}+08:00`;
  if (Number.isFinite(Number(timestamp)) && Number(timestamp) > 0) {
    return new Date(Number(timestamp) * 1000).toISOString();
  }
  return DATE_PATTERN.test(date) ? `${date}T00:00:00+08:00` : null;
}

function snippetFor(value, query) {
  const compact = cleanText(value, 12_000);
  if (compact.length <= MAX_SNIPPET_CHARS) return compact;
  const lower = compact.toLocaleLowerCase("zh-CN");
  const needle = String(query).toLocaleLowerCase("zh-CN");
  const matchAt = lower.indexOf(needle);
  if (matchAt < 0) return compact.slice(0, MAX_SNIPPET_CHARS);
  const start = Math.max(0, matchAt - 160);
  const end = Math.min(compact.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`.slice(0, MAX_SNIPPET_CHARS);
}

function openReadOnlyDatabase(dbPath) {
  const configuredPath = absoluteRegularFile(
    dbPath,
    "WECHAT_RADAR_DB_UNAVAILABLE",
    "微信雷达数据库",
  );
  return fs.lstat(configuredPath)
    .then(async (stat) => {
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw radarSearchError("WECHAT_RADAR_DB_UNAVAILABLE", "微信雷达数据库不可读");
      }
      const realPath = await fs.realpath(configuredPath).catch(() => null);
      if (!realPath) {
        throw radarSearchError("WECHAT_RADAR_DB_UNAVAILABLE", "微信雷达数据库路径无效");
      }
      try {
        return new DatabaseSync(realPath, { readOnly: true });
      } catch {
        throw radarSearchError("WECHAT_RADAR_DB_UNAVAILABLE", "微信雷达数据库不可读");
      }
    })
    .catch((error) => {
      if (error?.code?.startsWith("WECHAT_RADAR_")) throw error;
      throw radarSearchError("WECHAT_RADAR_DB_UNAVAILABLE", "微信雷达数据库不可读");
    });
}

export async function searchWechatRadarMessages({ dbPath, groupsConfigPath, ...rawInput } = {}) {
  const input = normalizeWechatRadarSearchInput(rawInput);
  const scope = await readScope(groupsConfigPath);
  const database = await openReadOnlyDatabase(dbPath);
  try {
    const ids = [...scope.keys()];
    const placeholders = ids.map(() => "?").join(",");
    const clauses = [
      `chatroom_id IN (${placeholders})`,
      "(content LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')",
    ];
    const params = [...ids, likePattern(input.query), likePattern(input.query)];
    if (input.dateFrom) {
      clauses.push("date >= ?");
      params.push(input.dateFrom);
    }
    if (input.dateTo) {
      clauses.push("date <= ?");
      params.push(input.dateTo);
    }
    if (input.exposureCutoffDate) {
      clauses.push("date <= ?");
      params.push(input.exposureCutoffDate);
    }
    const where = clauses.join(" AND ");
    let rows;
    let totalMatches;
    try {
      totalMatches = Number(database.prepare(`SELECT COUNT(*) AS total FROM messages WHERE ${where}`).get(...params)?.total) || 0;
      rows = database.prepare(`
        SELECT chatroom_id, local_id, sender, content, time, timestamp, date
        FROM messages
        WHERE ${where}
        ORDER BY timestamp DESC, local_id DESC
        LIMIT ?
      `).all(...params, input.limit);
    } catch {
      throw radarSearchError("WECHAT_RADAR_DB_SCHEMA_INVALID", "微信雷达消息表不可读");
    }
    const matches = rows.map((row) => {
      const hash = contentHash(`${row.chatroom_id}\u0000${row.local_id}\u0000${row.content}`);
      const sourceGroup = scope.get(row.chatroom_id) || row.chatroom_id;
      return Object.freeze({
        sourceDate: cleanText(row.date, 20) || null,
        sourceDocumentKey: `wechat-radar/messages/${safeSourcePart(row.chatroom_id)}/${Number(row.local_id) || 0}:${hash.slice(0, 12)}`,
        heading: `${sourceGroup} · ${cleanText(row.sender, 120) || "未知发言人"}`,
        snippet: snippetFor(row.content, input.query),
        lineStart: null,
        lineEnd: null,
        contentHash: hash,
        eventAt: eventAt(row.date, row.time, row.timestamp),
        sourceGroup,
        sender: cleanText(row.sender, 120) || null,
      });
    });
    return Object.freeze({
      schema: "wechat-radar-search-v1",
      readOnly: true,
      source: "wechat-radar",
      query: input.query,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      exposureCutoffDate: input.exposureCutoffDate,
      matches: Object.freeze(matches),
      totalMatches,
      truncated: totalMatches > matches.length,
      scannedGroups: scope.size,
    });
  } finally {
    database.close();
  }
}
