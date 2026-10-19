// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const categories = new Map([
  ["analysis object and source text required", ["root_invalid"]],
  ["analysis decision or reason invalid", ["decision_invalid"]],
  ["horizon or relation invalid", ["timeline_invalid"]],
  ["string field required", ["field_missing"]],
  ["non-empty string field required", ["field_empty"]],
  ["string array required", ["list_invalid"]],
  ["model text exceeded field limit", ["field_too_large"]],
  ["generated recommendation is forbidden", ["generated_recommendation"]],
  ["scoreComponents required", ["score_components_missing", "scoreComponents"]],
  ["theme required", ["theme_missing", "theme"]],
  ["one to eight evidence quotes required", ["evidence_count_invalid", "evidence"]],
  ["evidence role invalid", ["evidence_role_invalid", "evidence"]],
  ["every evidence quote must occur exactly in the frozen source", ["evidence_quote_mismatch", "evidence"]],
  ["every evidence quote must occur exactly in its cited ask source", ["evidence_quote_mismatch", "evidence"]],
  ["evidence sourceRef not found", ["evidence_source_invalid", "evidence"]],
  ["evidence quoteRef not found", ["evidence_reference_invalid", "evidence"]],
  ["multi-source cards require the triggering seed quote", ["seed_evidence_missing", "evidence"]],
  ["multi-source cards require at least one cited ask result", ["ask_evidence_missing", "evidence"]],
  ["mappings must be a bounded array", ["mapping_list_invalid", "mappings"]],
  ["mapping securityCode invalid", ["mapping_code_invalid", "mappings"]],
  ["duplicate security mapping", ["mapping_duplicate", "mappings"]],
  ["systemSuggestion label invalid", ["suggestion_invalid", "systemSuggestion.label"]],
  ["rejection suggestion must be NOT_TRADABLE", ["rejection_suggestion_invalid", "systemSuggestion.label"]],
  ["rejectDisposition invalid", ["rejection_disposition_invalid", "rejectDisposition"]],
  ["WATCH_CATALYST output is disabled for this analysis contract", ["watch_disabled", "rejectDisposition"]],
  ["DISCARD cannot include watch", ["unexpected_watch", "watch"]],
  ["CREATE_CARD cannot include reject disposition or watch", ["unexpected_rejection_fields"]],
]);
const fields = new Set(["variableTitle", "eventSummary", "variableThesis", "whyPotentiallyFerments",
  "counterEvidence", "uncertainties", "invalidationConditions", "systemSuggestion.label",
  "systemSuggestion.rationale", "theme.themeRef", "theme.narrative", "rejectDisposition", "watch", "evidence"]);
const scores = new Set(["evidenceStrength", "novelty", "timeSensitivity", "tradabilityConfidence", "mappingConfidence"]);

export function personalCardSchemaDiagnostic(error) {
  const score = typeof error?.message === "string"
    ? /^scoreComponents\.([a-zA-Z]+) invalid$/.exec(error.message)?.[1] : undefined;
  if (scores.has(score)) return { reason: "score_component_invalid", field: `scoreComponents.${score}` };
  const [reason, defaultField] = categories.get(error?.message) ?? ["schema_invalid"];
  const value = error?.fieldPath;
  let field = fields.has(value) ? value : defaultField;
  if (typeof value === "string") {
    const evidence = /^evidence\[[0-7]\]\.(quote|sourceRef|quoteRef|sourceType|sourcePath)$/.exec(value);
    const mapping = /^mappings\[(?:[0-9]|1[01])\]\.(securityName|thesis)$/.exec(value);
    const list = /^(counterEvidence|uncertainties|invalidationConditions)\[[0-7]\]$/.exec(value);
    if (evidence) field = `evidence.${evidence[1]}`;
    else if (mapping) field = `mappings.${mapping[1]}`;
    else if (list) field = list[1];
  }
  return { reason, ...(field ? { field } : {}) };
}
