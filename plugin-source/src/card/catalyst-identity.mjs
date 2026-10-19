// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const MIN_TITLE_LENGTH = 12;
const MIN_EXACT_TITLE_LENGTH = 8;
const MIN_SHARED_BIGRAMS = 6;
const MIN_BIGRAM_JACCARD = 0.3;

export function normalizeCatalystTheme(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

function normalizedCatalystTitle(value) {
  return normalizeCatalystTheme(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value) {
  const result = new Set();
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

export function catalystTitleSimilarity(left, right) {
  const leftTitle = normalizedCatalystTitle(left);
  const rightTitle = normalizedCatalystTitle(right);
  const leftBigrams = bigrams(leftTitle);
  const rightBigrams = bigrams(rightTitle);
  let shared = 0;
  for (const token of leftBigrams) {
    if (rightBigrams.has(token)) shared += 1;
  }
  const union = leftBigrams.size + rightBigrams.size - shared;
  return Object.freeze({
    leftLength: leftTitle.length,
    rightLength: rightTitle.length,
    sharedBigrams: shared,
    jaccard: union > 0 ? shared / union : 0,
  });
}

function titleOf(value) {
  return value?.variableIdentityKey || value?.variableTitle || "";
}

export function sameCatalystMainline(left, right) {
  const leftLineage = String(left?.sourceLineageKey || "").trim();
  const rightLineage = String(right?.sourceLineageKey || "").trim();
  if (leftLineage && leftLineage === rightLineage) return true;

  const leftTheme = normalizeCatalystTheme(left?.catalystIdentityKey);
  const rightTheme = normalizeCatalystTheme(right?.catalystIdentityKey);
  if (!leftTheme || leftTheme !== rightTheme) return false;

  const leftTitle = normalizedCatalystTitle(titleOf(left));
  const rightTitle = normalizedCatalystTitle(titleOf(right));
  if (
    leftTitle === rightTitle &&
    leftTitle.length >= MIN_EXACT_TITLE_LENGTH
  ) {
    return true;
  }
  if (
    leftTitle.length < MIN_TITLE_LENGTH ||
    rightTitle.length < MIN_TITLE_LENGTH
  ) {
    return false;
  }

  const similarity = catalystTitleSimilarity(leftTitle, rightTitle);
  return (
    similarity.sharedBigrams >= MIN_SHARED_BIGRAMS &&
    similarity.jaccard >= MIN_BIGRAM_JACCARD
  );
}
