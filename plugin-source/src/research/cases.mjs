// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const BUILDER_VERSION = "research-snapshot-v1", RESEARCH_CASES = Object.freeze(
  []
), NAMED_SOURCES = Object.freeze(
  []
), RESEARCH_BASKETS = Object.freeze(
  []
);
function researchObservationQueries(baskets = RESEARCH_BASKETS) {
  const queries = [];
  for (const basket of baskets)
    for (const security of basket.securities)
      for (const sessionDate of basket.sessions)
        queries.push(
          Object.freeze({
            securityCode: security.code,
            sessionDate,
            securityName: security.name,
            caseId: basket.caseId
          })
        );
  return Object.freeze(queries);
}
function basketForCase(caseId) {
  return RESEARCH_BASKETS.find((row) => row.caseId === caseId) || null;
}
export {
  BUILDER_VERSION,
  NAMED_SOURCES,
  RESEARCH_BASKETS,
  RESEARCH_CASES,
  basketForCase,
  researchObservationQueries
};
