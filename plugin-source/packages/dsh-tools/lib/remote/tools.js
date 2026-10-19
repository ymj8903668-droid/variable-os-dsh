// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createRemoteProvider } from "./provider.js";
import { safeError } from "./config.js";

export function registerRemoteTools(ctx, defineTool, { env = process.env } = {}) {
  const provider = createRemoteProvider({ env });
  const datasetId = { type: "string", required: true, description: "Authorized dataset ID." };
  for (const [name, method, parameters] of [
    ["vos_ask", "search", {
      query: { type: "string", required: true, description: "Read-only evidence query." },
      datasetIds: { type: "array", items: { type: "string" }, description: "Authorized datasets; omit for all granted datasets." },
      asOf: { type: "string" }, limit: { type: "number" },
    }],
    ["vos_query_casefile", "casefile", { card: { type: "string", required: true }, datasetId }],
    ["vos_query_inbox", "inbox", { datasetId: { type: "string" }, cursor: { type: "string" }, asOf: { type: "string" } }],
    ["vos_query_evidence", "evidence", { id: { type: "string", required: true }, datasetId }],
    ["vos_read_wiki", "wiki", {
      path: { type: "string", required: true, description: "Exact stored relative Wiki path; no percent-encoding." },
      datasetId, asOf: { type: "string" }, knownAt: { type: "string" },
    }],
  ]) {
    ctx.tools.register(defineTool({
      name, description: `Read-only remote ${method}; cite returned evidence IDs and receipt boundaries. ${
        method === "wiki" ? "Approved published Wiki text; legacy pages may be excerpt-only." : "Excerpts only."}`,
      parameters,
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }] },
      async execute(args) {
        try { return { ok: true, ...await provider.call(method, args) }; }
        catch (error) { return { ok: false, provider: "remote", error: safeError(error) }; }
      },
    }));
  }
}
