// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
export function independentResearchLimits(webSearchAllowed, segmented = false) {
  return Object.freeze({ maxQueries: 4, maxDocuments: 4, apiRequests: 80, downloads: 8,
    maxModelCalls: segmented ? 27 : 3, maxWebSearches: webSearchAllowed ? 2 : 0,
    maxTokensPerCall: 4096, maxInputCharacters: 60000, totalTimeoutMs: segmented ? 1800000 : 300000,
    ...(segmented ? { maxSegments: 24, segmentCharacters: 24000 } : {}) });
}
