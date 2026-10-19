// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHarnessDeepResearch } from "../../../src/runtime/harness-deep-research.mjs";
import { runBoundedResearchWorkflow } from "../../../src/research/workflow.mjs";
import { wikiResearchReference } from "../../../src/runtime/wiki-research-source.mjs";
import { imaDisclosureKey } from "./personal-disclosure-store.js";
import { commitImaResearchReport, imaResearchReportLimit } from "./ima-research-output.js";
import { researchError, INDEPENDENT_RESEARCH_CODES } from "./independent-research-controller.js";


/** IMA keeps its original authority, read receipts and cumulative disclosure
 * rules. Both this plugin and the website use the same research phases. */
export async function runIndependentResearch({ plan, binding, harness, disclosures, signal }) {
  const limits = plan.limits;
  const assertCurrent = () => {
    if (signal?.aborted) throw researchError("CANCELLED");
    binding.assertCurrent();
  };
  assertCurrent();
  const session = await binding.openWiki(signal);
  let callbackFailure;
  try {
    const research = createHarnessDeepResearch({ ...harness, env: {}, modelRouting: "selected",
      currentSelection: () => plan.model, maxTokens: limits.maxTokensPerCall,
      runDeepResearch: async ({ requestText }) => {
        const verified = await session.withWikiResearchRun({ maxQueries: limits.maxQueries,
          maxDocuments: limits.maxDocuments, signal }, async run => {
          try {
            const result = await runBoundedResearchWorkflow({
              plan: { ...plan, inputMode: plan.schema === "independent-research-plan-v2" ? plan.inputMode : undefined },
              run, requestText, assertCurrent, originalKind: "ima-original-segment-v1",
              reportLimit: records => imaResearchReportLimit(records, disclosures),
              reserveRecord: record => { if (!disclosures.reserve(imaDisclosureKey(record))) throw researchError("AUTO_JUDGMENT_CAPACITY"); },
              commitReport: (text, records) => commitImaResearchReport(text, records, disclosures),
              reference: (record, index) => wikiResearchReference({ ref: `W${index + 1}`, ...record,
                path: record.evidenceId, title: record.wikiOrigin.title, versionId: null, observedAt: record.wikiOrigin.observedAt }),
              searchWeb: typeof binding.ownWeb === "function" ? (...args) => binding.ownWeb(...args) : undefined,
            });
            return { ...result, schema: "deep-research-proposal-v1", kind: "independent-ima-v1",
              writePolicy: { readOnly: true, wroteArtifacts: false, exportAllowed: false }, cacheable: false };
          } catch (error) {
            if (INDEPENDENT_RESEARCH_CODES.has(error?.code)
              || ["DEEP_RESEARCH_OUTPUT_INVALID", "AUTO_JUDGMENT_CAPACITY", "RESEARCH_DISCLOSURE_UNAVAILABLE"].includes(error?.code)) {
              callbackFailure = researchError(error.code);
            }
            throw error;
          }
        });
        assertCurrent();
        return { ...verified.value, readScope: verified.receipt };
      },
    });
    return await research({ topic: plan.topic, signal });
  } catch (error) {
    if (signal?.aborted) throw researchError("CANCELLED");
    throw callbackFailure ?? error;
  } finally { session.close(); }
}
