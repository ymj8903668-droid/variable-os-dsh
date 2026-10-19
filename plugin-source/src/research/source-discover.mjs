// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { NAMED_SOURCES } from "./cases.mjs";
import { fail } from "./errors.mjs";

const DISCOVERY = Object.freeze({
  morningReview: Object.freeze({
    dir: ".llm-wiki/morning-review",
    pattern: /^(\d{4}-\d{2}-\d{2})-morning-review.*\.md$/i,
  }),
  eveningReview: Object.freeze({
    dir: "raw/日复盘",
    pattern: /^(\d{4}-\d{2}-\d{2})-复盘\.md$/i,
  }),
  // Codex hourly digest under raw/微信聊天 — NOT wiki/总结/*-微信舆情.md
  wechatSentiment: Object.freeze({
    dir: "raw/微信聊天",
    pattern: /^(\d{4}-\d{2}-\d{2})\.md$/i,
    optional: true,
  }),
  // 冈底斯日更线索（时效线）；主路径对齐晨报 collector
  gangtiseClues: Object.freeze({
    dir: "raw/研报新闻/投研线索",
    pattern: /^(\d{4}-\d{2}-\d{2})-.*gangtise-meeting-clues.*\.md$/i,
    optional: true,
  }),
  // ingest 副本作回退（导出失败时晨报也可能写到这里）
  gangtiseCluesIngest: Object.freeze({
    dir: ".llm-wiki/codex-ingest",
    pattern: /^.*?(\d{4}-\d{2}-\d{2}).*gangtise-meeting-clues.*\.md$/i,
    optional: true,
  }),
});

function resolveDir(sourceRoot, relDir) {
  if (typeof relDir !== "string" || relDir.includes("..")) {
    fail("SOURCE_PATH_INVALID", "discovery dir must stay relative");
  }
  const root = path.resolve(sourceRoot);
  const full = path.resolve(root, ...relDir.split("/"));
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("SOURCE_PATH_INVALID", "discovery dir escaped source root");
  }
  return full;
}

export function pickLatestByDateFilename(names, pattern) {
  let best = null;
  let bestDate = "";
  for (const name of names || []) {
    const match = pattern.exec(name);
    if (!match) {
      continue;
    }
    const date = match[1];
    if (date > bestDate) {
      bestDate = date;
      best = name;
    }
  }
  return best ? { name: best, date: bestDate } : null;
}

async function listDirNames(sourceRoot, relDir) {
  try {
    const absolute = resolveDir(sourceRoot, relDir);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries.filter((row) => row.isFile()).map((row) => row.name);
  } catch {
    return [];
  }
}

/**
 * Resolve named sources: pinned jsonl/wiki stay; morning/evening/wechat/gangtise
 * pick the latest dated file under their directories so refresh tracks source churn.
 */
export async function resolveNamedSources({
  sourceRoot,
  namedSources = NAMED_SOURCES,
  discovery = DISCOVERY,
} = {}) {
  const resolved = [];
  const discovered = {};

  for (const named of namedSources) {
    const rule = discovery[named.role];
    if (!rule) {
      resolved.push(named);
      continue;
    }
    const names = await listDirNames(sourceRoot, rule.dir);
    const latest = pickLatestByDateFilename(names, rule.pattern);
    if (!latest) {
      if (rule.optional) {
        continue;
      }
      resolved.push(named);
      discovered[named.role] = Object.freeze({
        mode: "fallback",
        path: named.path,
      });
      continue;
    }
    const relPath = `${rule.dir}/${latest.name}`.replaceAll("\\", "/");
    resolved.push(
      Object.freeze({
        ...named,
        path: relPath,
      }),
    );
    discovered[named.role] = Object.freeze({
      mode: "latest",
      path: relPath,
      date: latest.date,
    });
  }

  for (const [role, rule] of Object.entries(discovery)) {
    if (!rule.optional) {
      continue;
    }
    if (resolved.some((row) => row.role === role)) {
      continue;
    }
    const names = await listDirNames(sourceRoot, rule.dir);
    const latest = pickLatestByDateFilename(names, rule.pattern);
    if (!latest) {
      continue;
    }
    const relPath = `${rule.dir}/${latest.name}`.replaceAll("\\", "/");
    resolved.push(
      Object.freeze({
        path: relPath,
        kind: "markdown",
        role,
        optional: true,
      }),
    );
    discovered[role] = Object.freeze({
      mode: "latest",
      path: relPath,
      date: latest.date,
    });
  }

  return Object.freeze({
    sources: Object.freeze(resolved),
    discovered: Object.freeze(discovered),
  });
}
