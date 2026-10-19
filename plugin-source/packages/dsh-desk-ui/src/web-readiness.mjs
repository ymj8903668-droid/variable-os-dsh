// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const reasons = {
  UNKNOWN: ["NOT_CHECKED"],
  NOT_CONFIGURED: ["SOURCE_UNAVAILABLE", "CLIENT_NOT_CONFIGURED"],
  CHECKING: ["CHECKING"],
  READY: ["CLIENT_CONFIGURED"],
  PAUSED: ["TOKEN_WINDOW_BREAKER", "TOKEN_DAY_BREAKER"],
  FAILED: ["CHECK_FAILED"],
};
export function isWebServiceSettings(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "configured,connection,mode,persistence,revision"
    && ["off", "edge", "own"].includes(value.mode)
    && typeof value.configured === "boolean"
    && ["HOST_FILE", "SESSION_ONLY"].includes(value.persistence)
    && value.connection === "NOT_CHECKED" && typeof value.revision === "string"
    && /^[a-f0-9]{64}$/.test(value.revision));
}
export function isWebReadiness(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "connection,provider,ready,reason,sourceRevision,status"
    && value.provider === "tavily" && value.connection === "NOT_CHECKED"
    && reasons[value.status]?.includes(value.reason)
    && value.ready === (value.status === "READY")
    && typeof value.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(value.sourceRevision));
}
export function webReadinessLabel(value) {
  if (!isWebReadiness(value)) return "网页服务状态未确认";
  if (value.reason === "SOURCE_UNAVAILABLE") return "尚未配置 API 信源";
  return {
    UNKNOWN: "网页服务未检查",
    CHECKING: "正在检查网页服务配置",
    NOT_CONFIGURED: "网页服务未配置",
    READY: "网页服务已配置 · 上游连接未验证",
    PAUSED: "网页服务已熔断 · 授权资料仍可查询",
    FAILED: "网页服务检查失败",
  }[value.status];
}
