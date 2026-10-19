// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const EMPTY_SUCCESS = new Set([
  "NO_NEW_INPUT",
  "NO_CANDIDATE",
  "DUPLICATES_ONLY",
]);

export function projectInboxEmptyState({ scanRun, scanReceipt }) {
  if (!scanRun) {
    return { state: "NOT_STARTED", message: "尚未扫描" };
  }
  if (!scanReceipt) {
    return { state: "RUNNING", message: "扫描进行中" };
  }
  const health = scanReceipt.runHealth;
  const outcome = scanReceipt.contentOutcome;
  if (health === "PARTIAL") {
    return { state: "PARTIAL", message: "扫描部分失败" };
  }
  if (health === "FAILED") {
    return { state: "FAILED", message: "扫描全部失败" };
  }
  if (health === "SUCCESS" && outcome === "HAS_CANDIDATE") {
    return { state: "HAS_CANDIDATE", message: "已有候选" };
  }
  if (health === "SUCCESS" && EMPTY_SUCCESS.has(outcome)) {
    const detail =
      outcome === "NO_NEW_INPUT"
        ? "无新输入"
        : outcome === "NO_CANDIDATE"
          ? "无候选"
          : "全部重复";
    return { state: outcome, message: `扫描成功，${detail}` };
  }
  return { state: "FAILED", message: "扫描状态不可用" };
}
