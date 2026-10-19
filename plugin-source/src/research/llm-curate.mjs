// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Derived LLM curation for UI copy only.
 * Never writes ledger truth, never reveals outcomes before exposure.
 */
import { fail } from "./errors.mjs";

const DEFAULT_ENDPOINT =
  process.env.VARIABLE_OS_LLM_ENDPOINT || "https://api.openai.com/v1/chat/completions";

export function buildCurationPrompt({ caseTitle, processSummaries, knownThenNote }) {
  return {
    system:
      "你是 Variable OS 的卷宗编辑。只根据给定的事前过程摘要整理中文重点句。禁止编造行情、发酵结果、纠正结论或未给出的事实。缺信息写「未知」。输出 JSON：{headline, bullets[], caution}。",
    user: JSON.stringify(
      {
        caseTitle: caseTitle || "未知",
        knownThenNote: knownThenNote || "未知",
        processSummaries: Array.isArray(processSummaries)
          ? processSummaries.slice(0, 12)
          : [],
      },
      null,
      2,
    ),
  };
}

export function sanitizeCuration(raw) {
  const empty = Object.freeze({
    headline: "未知 / 未提供",
    bullets: Object.freeze([]),
    caution: "仅整理事前材料，不构成交易建议。",
  });
  if (!raw || typeof raw !== "object") {
    return empty;
  }
  const bullets = Array.isArray(raw.bullets)
    ? raw.bullets
        .filter((row) => typeof row === "string" && row.trim())
        .slice(0, 5)
        .map((row) => row.trim().slice(0, 120))
    : [];
  return Object.freeze({
    headline:
      typeof raw.headline === "string" && raw.headline.trim()
        ? raw.headline.trim().slice(0, 80)
        : empty.headline,
    bullets: Object.freeze(bullets),
    caution:
      typeof raw.caution === "string" && raw.caution.trim()
        ? raw.caution.trim().slice(0, 120)
        : empty.caution,
  });
}

/**
 * Optional live sampler. Without API key, returns deterministic local digest (no network).
 */
export async function curateCaseHighlights({
  caseTitle,
  processSummaries,
  knownThenNote,
  apiKey = process.env.VARIABLE_OS_LLM_API_KEY || process.env.OPENAI_API_KEY || "",
  fetchImpl = globalThis.fetch,
  model = process.env.VARIABLE_OS_LLM_MODEL || "gpt-4.1-mini",
} = {}) {
  const prompt = buildCurationPrompt({
    caseTitle,
    processSummaries,
    knownThenNote,
  });
  if (!String(apiKey || "").trim()) {
    const joined = (processSummaries || []).filter(Boolean).slice(0, 3);
    return sanitizeCuration({
      headline: caseTitle ? `${caseTitle} · 事前要点` : "事前要点",
      bullets: joined.map((row) => String(row).slice(0, 80)),
      caution: "本地摘要（未配置 LLM）。仅事前材料。",
    });
  }
  if (typeof fetchImpl !== "function") {
    fail("INVALID_FETCH", "fetchImpl required");
  }
  const response = await fetchImpl(DEFAULT_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
  });
  if (!response.ok) {
    const err = new Error(`LLM_HTTP_${response.status}`);
    err.code = "LLM_HTTP";
    throw err;
  }
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return sanitizeCuration(parsed);
}
