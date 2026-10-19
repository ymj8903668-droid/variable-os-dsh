// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
// Shared presentation projection. No IO, model calls or new publication identity.
export const publicationOf = row => ({
  cardId: row.cardId, datasetId: row.datasetId, datasetVersion: row.datasetVersion,
  revision: row.revision, contentHash: row.contentHash, evidenceId: row.evidenceId,
  availableAt: row.availableAt, recordedAt: row.recordedAt, knownAt: row.knownAt,
});
export const toPublishedDeskCard = row => ({
  ...(row.publishedCard ? { ...row.publishedCard,
    upstreamCardRevisionId: row.publishedCard.cardRevisionId,
    ...(['published-card-v2','published-card-v4'].includes(row.publishedCard.schema) ? {tier: row.publishedCard.presentation.tier, presentationDecisionId: row.publishedCard.presentation.id} : {}),
    suggestionEvidence: row.publishedCard.evidence,
    securities: row.publishedCard.mappings,
  } : {}),
  cardRevisionId: row.cardId, revision: row.revision, eventSummary: row.excerpt,
  ...(row.publishedCard ? { eventSummary: row.publishedCard.eventSummary } : {}),
  eventAt: row.eventAt, availableAt: row.availableAt, publication: publicationOf(row),
});
export function toPublishedDeskCasefile(item, receipt) {
  const card = item.publishedCard;
  return { publication: publicationOf(item), ...(receipt ? { receipt } : {}),
    ...(card ? { publishedCard: card } : {}),
    case: { id: item.cardId, title: item.title,
      mappings: card?.mappings ?? [], themes: card?.themes ?? [],
      nodes: card ? card.evidence.map(row => ({ id: row.id, nodeType: 'SOURCE',
        resultVisibility: 'PROCESS', isCurrent: true, state: 'COMPLETE',
        title: card.variableTitle, summary: row.quote, availableAt: row.availableAt,
        recordedAt: row.recordedAt, evidenceIds: [row.id], sourceType: 'published-card' })) : item.nodes },
    evidence: card ? card.evidence.map(row => ({ ...row, sourceType: 'published-card',
      summary: row.quote, sha256: row.contentHash, accessLevel: 'EXCERPT_ONLY',
      datasetId: item.datasetId, revision: item.revision })) : [{ id: item.evidenceId, sourceType: 'published-card',
      summary: item.excerpt, sha256: item.contentHash, accessLevel: 'EXCERPT_ONLY',
      datasetId: item.datasetId, revision: item.revision }],
  };
}
