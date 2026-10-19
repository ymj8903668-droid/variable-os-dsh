// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const labels = {
  MODEL_CONFIGURED: "模型已配置 · 连接未验证",
  MODEL_SELECTION_REQUIRED: "尚未选择可用模型",
  MODEL_CREDENTIAL_REQUIRED: "模型 API Key 未配置",
  MODEL_PROVIDER_UNAVAILABLE: "模型提供方未加载",
  MODEL_SETTINGS_UNAVAILABLE: "模型配置状态不可用",
  MODEL_SETTINGS_INVALID: "模型配置无效",
  MODEL_SETTINGS_CHANGED: "模型配置已变化 · 待重新读取",
  CLIENT_BUSY: "模型配置更新中",
};

export function isModelReadiness(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3 && typeof value.ready === "boolean"
    && value.connection === "NOT_CHECKED" && Object.hasOwn(labels, value.code)
    && value.ready === (value.code === "MODEL_CONFIGURED");
}

export function modelReadinessLabel(value) {
  return isModelReadiness(value) ? labels[value.code] : labels.MODEL_SETTINGS_UNAVAILABLE;
}
