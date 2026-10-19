// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";

/**
 * Resolve the read-only source roots used by both Harness tools and the desk.
 * Keeping this in core prevents Host tools from drifting from the UI service.
 */
export function resolveDeskPaths(env = process.env) {
  const sourceRoot = env.VARIABLE_OS_SOURCE_ROOT;
  if (typeof sourceRoot !== "string" || !sourceRoot.trim()) {
    const error = new Error("VARIABLE_OS_SOURCE_ROOT must be configured");
    error.code = "SOURCE_ROOT_UNCONFIGURED";
    throw error;
  }
  const liuduRoot =
    typeof env.VARIABLE_OS_LIUDU_ROOT === "string" && env.VARIABLE_OS_LIUDU_ROOT.trim()
      ? env.VARIABLE_OS_LIUDU_ROOT
      : null;
  return Object.freeze({
    sourceRoot,
    liuduRoot,
    wechatMdDir: path.join(sourceRoot, "raw", "微信聊天"),
    gangtiseCluesDir: path.join(sourceRoot, "raw", "研报新闻", "投研线索"),
    radarDb:
      env.VARIABLE_OS_WECHAT_RADAR_DB ||
      path.join(env.HOME || "", ".wechat-radar", "radar.db"),
    radarGroupsConfig:
      env.VARIABLE_OS_WECHAT_RADAR_GROUPS_CONFIG ||
      path.join(env.HOME || "", ".config", "wechat-radar", "core-groups.json"),
    radarSyncUrl:
      env.VARIABLE_OS_WECHAT_RADAR_SYNC_URL ||
      "http://127.0.0.1:3001/api/core-sync-lite",
    llmEndpoint: env.VARIABLE_OS_LLM_ENDPOINT || null,
    llmModel: env.VARIABLE_OS_LLM_MODEL || null,
  });
}

export function assertLoopbackUrl(urlString) {
  const url = new URL(urlString);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "[::1]")
  ) {
    const error = new Error("Radar sync URL must use loopback HTTP");
    error.code = "RADAR_NOT_LOOPBACK";
    throw error;
  }
  return url;
}
