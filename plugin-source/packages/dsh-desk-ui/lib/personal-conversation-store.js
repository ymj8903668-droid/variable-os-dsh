// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createPrivateJsonProfile, listPrivateJsonFiles } from "./private-json-profile.js";
import { remoteError } from "../../dsh-tools/lib/remote/config.js";

const revision = () => randomBytes(32).toString("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validId = value => typeof value === "string" && /^xiaomei-agent-[a-z0-9-]{16,96}$/.test(value);
const filename = id => `${createHash("sha256").update(id).digest("hex")}.json`;
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const payload = value => plain(value) && Object.keys(value).sort().join(",") === "published,session"
  && plain(value.session) && (value.published === null || plain(value.published));
const bounded = value => {
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw remoteError("RESEARCH_CHECKPOINT_INVALID");
};

// The running marker is durable before any source/model admission. A crash
// does not turn the previous successful turn into authority for a new one.
export function createPersonalConversationStore({ root }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw remoteError("RESEARCH_CHECKPOINT_INVALID");
  const reader = (name, id, binding) => createPrivateJsonProfile({
      file: path.join(root, name),
      initial: () => id ? ({ schema: "personal-conversation-store-v1", id, binding, revision: revision(),
        status: "empty", checkpoint: null }) : ({ revision: revision(), status: "empty" }),
      validate: value => plain(value) && Object.keys(value).sort().join(",") === "binding,checkpoint,id,revision,schema,status"
        && value.schema === "personal-conversation-store-v1" && validId(value.id)
        && (!id || value.id === id) && filename(value.id) === name
        && hash(value.binding) && hash(value.revision) && ["empty", "running", "ready", "retired"].includes(value.status)
        && (value.status === "ready" ? payload(value.checkpoint) : value.checkpoint === null),
      maxBytes: 512 * 1024, temporaryPrefix: ".conversation-",
      errors: { invalid: "RESEARCH_CHECKPOINT_INVALID", unavailable: "RESEARCH_CHECKPOINT_UNAVAILABLE",
        changed: "XIAOMEI_SESSION_SCOPE_CHANGED", busy: "RESEARCH_CHECKPOINT_BUSY", write: "RESEARCH_CHECKPOINT_WRITE_FAILED" },
    });
  const profile = (id, binding) => {
    if (!validId(id) || !hash(binding)) throw remoteError("RESEARCH_CHECKPOINT_INVALID");
    return reader(filename(id), id, binding);
  };
  const assertBinding = (record, binding) => {
    if (record.binding !== binding) throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
  };
  function* readyRecords() {
    for (const name of listPrivateJsonFiles(root, {
      invalid: "RESEARCH_CHECKPOINT_INVALID", unavailable: "RESEARCH_CHECKPOINT_UNAVAILABLE",
    }).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const store = reader(name), selected = store.current();
      if (selected.record?.status === "ready") yield { store, selected };
    }
  }
  return Object.freeze({
    hasCheckpoint(select) {
      for (const { selected } of readyRecords()) if (select(structuredClone(selected.record.checkpoint))) return true;
      return false;
    },
    async reconcileCheckpoints(retain) {
      const retired = [];
      for (const { store, selected } of readyRecords()) {
        if (await retain(structuredClone(selected.record.checkpoint))) continue;
        const current = store.current();
        // A source read must never overwrite a newer turn or another Host's
        // lease. That turn performs its own final source proof.
        if (current.record.revision !== selected.record.revision) continue;
        store.write({ ...current.record, revision: revision(), status: "retired", checkpoint: null }, current);
        retired.push(current.record.id);
      }
      return retired;
    },
    list(binding, { cursor = null } = {}) {
      if (!hash(binding) || cursor !== null && !hash(cursor)) throw remoteError("INVALID_REQUEST");
      const names = listPrivateJsonFiles(root, {
        invalid: "RESEARCH_CHECKPOINT_INVALID", unavailable: "RESEARCH_CHECKPOINT_UNAVAILABLE",
      }).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && (cursor === null || name > `${cursor}.json`)).sort();
      const page = names.slice(0, 32), entries = [];
      for (const name of page) {
        const record = reader(name).current().record;
        if (!record || record.status !== "ready" || record.binding !== binding) continue;
        const time = record.checkpoint.session.native?.events?.at(-1)?.time;
        entries.push({ sessionId: record.id, updatedAt: Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15 ? time : null });
      }
      return { entries, nextCursor: names.length > page.length ? page.at(-1).slice(0, -5) : null };
    },
    begin(id, binding, { resume = false, revision: expected } = {}) {
      const store = profile(id, binding), selected = store.current(), prior = selected.record;
      assertBinding(prior, binding);
      if (prior.status === "retired" || expected !== undefined && expected !== prior.revision) {
        throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
      }
      if (prior.status === "running") throw remoteError("RESEARCH_CHECKPOINT_INCOMPLETE");
      if (resume && prior.status !== "ready") throw remoteError("XIAOMEI_SESSION_NOT_FOUND");
      const claim = { ...prior, revision: revision(), status: "running", checkpoint: null };
      store.write(claim, selected);
      const commit = (status, checkpoint) => {
        const current = store.current();
        if (current.record.revision !== claim.revision || current.record.status !== "running") {
          throw remoteError("XIAOMEI_SESSION_SCOPE_CHANGED");
        }
        const next = { ...claim, revision: revision(), status, checkpoint: structuredClone(checkpoint) };
        bounded(next);
        return store.write(next, current).revision;
      };
      return Object.freeze({
        checkpoint: structuredClone(prior.checkpoint),
        finish(value) {
          if (!payload(value)) throw remoteError("RESEARCH_CHECKPOINT_INVALID");
          return commit("ready", value);
        },
        release: () => commit(prior.status, prior.checkpoint),
      });
    },
    retire(id, binding) {
      const store = profile(id, binding), current = store.current();
      assertBinding(current.record, binding);
      if (current.record.status !== "retired") store.write({ ...current.record,
        revision: revision(), status: "retired", checkpoint: null }, current);
    },
  });
}
