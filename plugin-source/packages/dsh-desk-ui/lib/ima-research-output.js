// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { remoteError } from "../../dsh-tools/lib/remote/config.js";
import { imaDisclosureKey } from "./personal-disclosure-store.js";
import { disclosureFragment, disclosureSize } from "../../../src/research/disclosure-fragments.mjs";

const normalized = value => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A bounded synthesis may leave the Host, never a literal whole document.
 * Formatting normalization is not a semantic DLP or encoding classifier. */
export function assertImaResearchOutput(text, records) {
  assertOutput(text, records, 1200);
}
function assertOutput(text, records, maxCharacters) {
  if (typeof text !== "string" || !text.trim() || [...text].length > maxCharacters) throw remoteError("DEEP_RESEARCH_OUTPUT_INVALID");
  const output = normalized(text);
  for (const record of records) {
    const body = normalized(record.content);
    const literal = record.content.normalize("NFKC").replace(/\s/gu, "");
    if (body ? output.includes(body) : literal && text.normalize("NFKC").replace(/\s/gu, "").includes(literal)) {
      throw remoteError("DEEP_RESEARCH_OUTPUT_INVALID");
    }
  }
}

function historyFragments(history) {
  const fragments = [];
  const fields = new Set(["text", "finalText", "spokenText", "summary", "fullQuote", "synthesisMarkdown", "note"]);
  const inspect = (value, depth = 0, key = "") => {
    if (depth > 20) throw remoteError("DEEP_RESEARCH_OUTPUT_INVALID");
    if (typeof value === "string") {
      if (fields.has(key)) fragments.push(value);
      if (key === "dataJson" && value !== "") inspect(JSON.parse(value), depth + 1);
    } else if (value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) inspect(child, depth + 1, name);
    }
  };
  try { inspect(history); }
  catch { throw remoteError("DEEP_RESEARCH_OUTPUT_INVALID"); }
  return fragments;
}

/** Read-only preflight; final disclosure checks still own the atomic commit. */
export function imaResearchReportLimit(records, disclosures) {
  let limit = 6000;
  for (const record of records) disclosures.inspect(imaDisclosureKey(record), history => {
    const used = disclosureSize(historyFragments(history), history);
    const remaining = record.content.normalize("NFC").replace(/\s+/gu, "").length - used - 1;
    limit = Math.min(limit, Math.max(0, remaining));
  });
  return limit;
}

function assertHistory(text, record, history, maxCharacters = 1200) {
  const fragments = [text, ...historyFragments(history)];
  // Match the native turn's conservative cumulative text budget. Keep the
  // stronger per-response formatting-normalized whole-body check as well.
  const compact = value => value.normalize("NFC").replace(/\s+/gu, "");
  let size;
  try { size = disclosureSize(fragments, history); }
  catch { throw remoteError("DEEP_RESEARCH_OUTPUT_INVALID"); }
  if (size >= compact(record.content).length) throw remoteError("DEEP_RESEARCH_OUTPUT_INVALID");
  assertOutput(text, [record], maxCharacters);
}

/** The longer independent report keeps the same whole-source and cumulative
 * disclosure refusal; short sources can still refuse delivery conservatively. */
export function commitImaResearchReport(text, records, disclosures) {
  assertOutput(text, records, 6000);
  for (const record of records) disclosures.check(imaDisclosureKey(record), history => {
    assertHistory(text, record, history, 6000);
    return { disclosureFragments: [disclosureFragment(text)] };
  });
}

export function guardImaResearchDisclosures(withImaResearch, disclosures) {
  return (params, operation, options) => withImaResearch(params, async input => {
    const records = input.records ?? [input.record];
    const active = () => { if (input.signal?.aborted) throw remoteError("CANCELLED"); };
    for (const record of records) {
      active();
      if (!disclosures.reserve(imaDisclosureKey(record))) throw remoteError("AUTO_JUDGMENT_CAPACITY");
    }
    // Source admission precedes this callback. Reserve before any optional
    // API/web/model work; final live source proof still belongs to its caller.
    const result = await operation(input);
    for (const record of records) {
      active();
      disclosures.check(imaDisclosureKey(record), history => {
        assertHistory(result.synthesisMarkdown, record, history);
        return { synthesisMarkdown: result.synthesisMarkdown };
      });
    }
    // If a later record/proof refuses, earlier reservations stay conservative.
    // No proposal is delivered until every record has been checked/committed.
    active();
    return result;
  }, options);
}
