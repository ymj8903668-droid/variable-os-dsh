// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { researchError as remoteError } from "./protocol.mjs";

const SECTIONS = [
  ["scope", "研究问题与范围", 1], ["findings", "关键发现", 3],
  ["evidence", "证据与因果推理", 4], ["counterevidence", "反证与替代解释", 2],
  ["uncertainties", "不确定性与覆盖缺口", 2], ["verification", "证伪与验证条件", 2],
];
const render = value => SECTIONS.map(([key, title]) => `## ${title}\n${value[key]}`).join("\n\n");
const overhead = render(Object.fromEntries(SECTIONS.map(([key]) => [key, ""]))).length;

export function reportSectionsBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit > 6000) throw remoteError("RESEARCH_RESULT_INVALID");
  const capacity = limit - overhead, weight = SECTIONS.reduce((n, row) => n + row[2], 0);
  if (capacity < weight) throw remoteError("RESEARCH_DISCLOSURE_EXHAUSTED");
  let remaining = capacity;
  const fields = Object.fromEntries(SECTIONS.map(([key, , share], index) => {
    const size = index === SECTIONS.length - 1 ? remaining : Math.floor(capacity * share / weight);
    remaining -= size; return [key, size];
  }));
  return { limit, fields };
}

export function reportSectionsInstruction(budget) {
  const schema = SECTIONS.map(([key, title]) => `${key}（${title}，最多${budget.fields[key]}字符）`).join("；");
  return `仅返回一个JSON对象，严格包含六个非空字符串字段：${schema}。每个字段的字符数按UTF-16计算，含引用、标点及空白；优先写到各字段上限的60%，不要写到上限附近。Host将组装中文Markdown，含标题和分隔符总上限${budget.limit}字符。不要返回Markdown代码围栏、额外字段或字段内重复标题。六类研究要素均须保留；无证据时明确写未知，不编造、不复制全文。`;
}

export function renderResearchReport(text, budget) {
  let value;
  try { value = JSON.parse(text); } catch { throw remoteError("RESEARCH_RESULT_INVALID"); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== SECTIONS.map(row => row[0]).sort().join(",")) {
    throw remoteError("RESEARCH_RESULT_INVALID");
  }
  for (const [key] of SECTIONS) {
    if (typeof value[key] !== "string" || !value[key].trim() || !value[key].isWellFormed()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value[key])) throw remoteError("RESEARCH_RESULT_INVALID");
    if (value[key].length > budget.fields[key]) throw remoteError("RESEARCH_REPORT_LENGTH_EXCEEDED");
  }
  const markdown = render(value);
  if (markdown.length > budget.limit) throw remoteError("RESEARCH_REPORT_LENGTH_EXCEEDED");
  return markdown;
}
