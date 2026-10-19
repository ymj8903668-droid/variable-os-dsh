// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { brandedId, canonicalHash } from "../schema/canonical-json.mjs";
import { validateEventEnvelope } from "../schema/envelope.mjs";
import { SCHEMA_PREFIXES } from "../schema/registry.mjs";
import { JsonlStore, LedgerError } from "./jsonl-store.mjs";
import { setImmediate as yieldToIo } from "node:timers/promises";

export { JsonlStore, LedgerError };

function sameArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function invalidReceipt(message, details) {
  throw new LedgerError("INVALID_COMMIT_GROUP_RECEIPT", message, details);
}

function indexRecords(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== "string") {
      continue;
    }
    const list = byId.get(row.id);
    if (list) {
      list.push(row);
    } else {
      byId.set(row.id, [row]);
    }
  }
  return byId;
}

function verifyOneReceipt(receipt, catalog) {
  try {
    validateEventEnvelope(receipt);
  } catch (err) {
    invalidReceipt("receipt envelope invalid", { cause: err && err.code });
  }
  if (
    !Array.isArray(receipt.recordIds) ||
    !Array.isArray(receipt.memberRecordHashes) ||
    typeof receipt.recordCount !== "number" ||
    typeof receipt.groupHash !== "string" ||
    receipt.hashAlgorithm !== "SHA-256" ||
    receipt.canonicalizationVersion !== "canonical-json-v1" ||
    typeof receipt.commitGroupId !== "string"
  ) {
    invalidReceipt("receipt structure invalid", { id: receipt.id });
  }
  const ids = receipt.recordIds;
  const hashes = receipt.memberRecordHashes;
  if (
    ids.length === 0 ||
    ids.length !== hashes.length ||
    ids.length !== receipt.recordCount
  ) {
    invalidReceipt("recordIds/hashes/count mismatch", { id: receipt.id });
  }
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (typeof id !== "string" || typeof hashes[index] !== "string") {
      invalidReceipt("record id/hash type invalid", { id: receipt.id });
    }
    if (index > 0 && !(ids[index - 1] < id)) {
      invalidReceipt("recordIds must be unique and sorted", { id: receipt.id });
    }
  }
  if (ids.includes(receipt.id)) {
    invalidReceipt("receipt must not be a member", { id: receipt.id });
  }
  const pairs = [];
  for (let index = 0; index < ids.length; index += 1) {
    const memberId = ids[index];
    const matches = catalog.get(memberId) ?? [];
    const members = matches.filter((row) => row !== receipt);
    if (members.length !== 1) {
      invalidReceipt("member missing or ambiguous", { memberId });
    }
    const member = members[0];
    if (member.schema === "commit-group-receipt-v1") {
      invalidReceipt("receipt listed as member", { memberId });
    }
    if (member.commitGroupId !== receipt.commitGroupId) {
      invalidReceipt("member commitGroupId mismatch", { memberId });
    }
    const hash = canonicalHash(member);
    if (hash !== hashes[index]) {
      invalidReceipt("member hash mismatch", { memberId });
    }
    pairs.push([memberId, hash]);
  }
  if (canonicalHash(pairs) !== receipt.groupHash) {
    invalidReceipt("groupHash mismatch", { id: receipt.id });
  }
}

function* verifiedCommitGroupReceipts(events, sourceItems) {
  const catalog = indexRecords([...events, ...sourceItems]);
  const receipts = events.filter(
    (row) => row.schema === "commit-group-receipt-v1",
  );
  const byGroup = new Map();
  for (const receipt of receipts) {
    verifyOneReceipt(receipt, catalog);
    const list = byGroup.get(receipt.commitGroupId) ?? [];
    list.push(receipt);
    byGroup.set(receipt.commitGroupId, list);
    yield receipt;
  }
  for (const [commitGroupId, list] of byGroup) {
    if (list.length !== 1) {
      invalidReceipt("ambiguous receipts for commit group", { commitGroupId });
    }
  }
}

function verifyCommitGroupReceipts(events, sourceItems) {
  return Array.from(verifiedCommitGroupReceipts(events, sourceItems));
}

async function verifyCooperativeReceipts(events, sourceItems) {
  const receipts = [];
  let batchSize = 0, batchStarted = performance.now();
  // A full live ledger can hash hundreds of thousands of records. Keep the
  // exact same verification and snapshot, but let audio and cancellation I/O
  // run between batches. Opted-in writers retain their store lock/transaction
  // across every yield; validation must finish before a COMMITTED resolution.
  for (const receipt of verifiedCommitGroupReceipts(events, sourceItems)) {
    receipts.push(receipt);
    if (++batchSize >= 32 || performance.now() - batchStarted >= 8) {
      await yieldToIo();
      batchSize = 0;
      batchStarted = performance.now();
    }
  }
  return receipts;
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidMemberPlan(message, details) {
  throw new LedgerError("MEMBER_PLAN_INVALID", message, details);
}

function invalidIntent(message, details) {
  throw new LedgerError("INVALID_COMMAND_INTENT", message, details);
}

function invalidResolution(message, details) {
  throw new LedgerError("INVALID_COMMAND_RESOLUTION", message, details);
}

function assertMemberPlan(members, targetCommitGroupId) {
  if (!Array.isArray(members) || members.length === 0) {
    invalidMemberPlan("builder returned no members");
  }
  const seenIds = new Set();
  for (const member of members) {
    if (!isPlainObject(member)) {
      invalidMemberPlan("member must be a plain object");
    }
    if (member.file !== "events" && member.file !== "source_items") {
      invalidMemberPlan("member.file must be events or source_items");
    }
    if (!isPlainObject(member.record)) {
      invalidMemberPlan("member.record must be a plain object");
    }
    if (member.record.commitGroupId !== targetCommitGroupId) {
      invalidMemberPlan("record.commitGroupId must equal targetCommitGroupId");
    }
    const prefix = SCHEMA_PREFIXES[member.record.schema];
    if (!prefix) {
      invalidMemberPlan("record.schema is not a known P0 schema");
    }
    try {
      validateEventEnvelope(member.record);
    } catch (err) {
      invalidMemberPlan("member envelope invalid", {
        cause: err && err.code,
      });
    }
    const id = member.record.id;
    if (seenIds.has(id)) {
      invalidMemberPlan("member ids must be unique");
    }
    seenIds.add(id);
  }
}

function verifyCommandIntent(intent, command) {
  try {
    validateEventEnvelope(intent);
  } catch (err) {
    invalidIntent("intent envelope invalid", { cause: err && err.code });
  }
  if (intent.schema !== "command-intent-v1") {
    invalidIntent("schema");
  }
  if (intent.commitGroupId !== null) {
    invalidIntent("intent commitGroupId must be null");
  }
  if (
    intent.commandType !== command.commandType ||
    intent.idempotencyKey !== command.idempotencyKey
  ) {
    invalidIntent("intent does not match command identity");
  }
  const expectedId = brandedId("cmd_", {
    commandType: intent.commandType,
    idempotencyKey: intent.idempotencyKey,
  });
  if (intent.id !== expectedId) {
    invalidIntent("intent.id is not recomputable");
  }
  if (canonicalHash(intent.canonicalCommandInput) !== intent.commandInputHash) {
    invalidIntent("canonicalCommandInput hash mismatch");
  }
  if (
    typeof intent.startedAt !== "string" ||
    !RFC3339.test(intent.startedAt)
  ) {
    invalidIntent("startedAt must be RFC3339 with timezone");
  }
  if (typeof intent.builderVersion !== "string" || !intent.builderVersion) {
    invalidIntent("builderVersion");
  }
  if (
    !Array.isArray(intent.expectedHeads) ||
    !Array.isArray(intent.immutableInputRefs)
  ) {
    invalidIntent("frozen arrays invalid");
  }
  if (
    !Array.isArray(intent.memberRecordIds) ||
    intent.memberRecordIds.length === 0 ||
    intent.memberRecordIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(intent.memberRecordIds).size !== intent.memberRecordIds.length
  ) {
    invalidIntent("memberRecordIds invalid");
  }
  const expectedGroup = brandedId("cgr_", {
    intentId: intent.id,
    role: "group",
  });
  if (intent.targetCommitGroupId !== expectedGroup) {
    invalidIntent("targetCommitGroupId is not recomputable");
  }
}

function verifyCommandResolution(resolution, intent, receipt) {
  try {
    validateEventEnvelope(resolution);
  } catch (err) {
    invalidResolution("resolution envelope invalid", { cause: err && err.code });
  }
  if (resolution.schema !== "command-intent-resolution-v1") {
    invalidResolution("schema");
  }
  if (resolution.status !== "COMMITTED") {
    invalidResolution("status");
  }
  if (resolution.commandIntentId !== intent.id) {
    invalidResolution("commandIntentId mismatch");
  }
  if (!receipt || resolution.commitGroupReceiptId !== receipt.id) {
    invalidResolution("commitGroupReceiptId mismatch");
  }
}

export class CommandRuntime {
  constructor({ store, now = () => new Date().toISOString(), cooperativeWrites = false }) {
    this.store = store;
    this.now = now;
    // Explicitly opt in background publication; legacy/manual writers keep
    // their synchronous scheduling contract and all ledger semantics.
    this.cooperativeWrites = cooperativeWrites === true;
  }

  async execute(command) {
    return this.store.withLock(() => this._executeLocked(command));
  }

  // Resolve mutable ledger heads and execute from the same locked snapshot.
  // The resolver must stay deterministic and side-effect free.
  async executeResolved(resolveCommand) {
    if (typeof resolveCommand !== "function") {
      throw new LedgerError(
        "INVALID_COMMAND_RESOLVER",
        "resolveCommand must be a function",
      );
    }
    return this.store.withLock(async () => {
      const snapshot = await this._readLockedProjection();
      const { committedProjection, events } = snapshot;
      const existingIntent = (idempotencyKey) => {
        const matches = events.filter(
          (row) =>
            row.schema === "command-intent-v1" &&
            row.idempotencyKey === idempotencyKey,
        );
        if (matches.length > 1) {
          throw new LedgerError(
            "IDEMPOTENCY_CONFLICT",
            "duplicate intents for key",
          );
        }
        return matches[0] || null;
      };
      const command = await resolveCommand(
        Object.freeze({ committedProjection, existingIntent }),
      );
      if (!isPlainObject(command)) {
        throw new LedgerError(
          "INVALID_COMMAND_RESOLVER",
          "resolveCommand must return a command object",
        );
      }
      return this._executeLocked(command, snapshot);
    });
  }

  async project() {
    if (typeof this.store.readSnapshot === "function") {
      return this._projectUnlocked(await this.store.readSnapshot(), { cooperative: true });
    }
    return this.store.withLock(() => this._projectUnlocked(null, { cooperative: true }));
  }

  async _executeLocked(command, snapshot = null) {
    const now = this.now();
    const { committedProjection, events, sourceItems } =
      snapshot || (await this._readLockedProjection());
    const commandInputHash = canonicalHash(command.canonicalCommandInput);
    const expectedHeads = command.expectedHeads ?? [];
    const immutableInputRefs = command.immutableInputRefs ?? [];
    const engineResultId = command.engineResultId ?? null;
    const intentId = brandedId("cmd_", {
      commandType: command.commandType,
      idempotencyKey: command.idempotencyKey,
    });

    const existingIntents = events.filter(
      (row) =>
        row.schema === "command-intent-v1" &&
        row.idempotencyKey === command.idempotencyKey,
    );
    if (existingIntents.length > 1) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "duplicate intents for key");
    }
    if (existingIntents.length === 1) {
      const intent = existingIntents[0];
      verifyCommandIntent(intent, command);
      this._assertFrozenMatch(intent, {
        commandInputHash,
        builderVersion: command.builderVersion,
        expectedHeads,
        immutableInputRefs,
        engineResultId,
      });
      return this._completeExisting({
        intent,
        command,
        events,
        sourceItems,
        recoveryNow: now,
        committedProjection,
      });
    }

    const targetCommitGroupId = brandedId("cgr_", {
      intentId,
      role: "group",
    });
    const members = this._planMembers({
      command,
      intentId,
      targetCommitGroupId,
      now,
      committedProjection,
    });
    const memberRecordIds = members.map((member) => member.record.id);
    const intent = {
      schema: "command-intent-v1",
      id: intentId,
      createdAt: now,
      recordedAt: now,
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      commitGroupId: null,
      supersedesId: null,
      policyVersion: command.policyVersion,
      commandType: command.commandType,
      idempotencyKey: command.idempotencyKey,
      canonicalCommandInput: command.canonicalCommandInput,
      commandInputHash,
      immutableInputRefs,
      authorityClaim: null,
      builderVersion: command.builderVersion,
      engineResultId,
      expectedHeads,
      targetCommitGroupId,
      memberRecordIds,
      startedAt: now,
    };
    validateEventEnvelope(intent);
    await this.store.append("events", intent);
    await this._appendMissingMembers(members, new Set());
    if (command.crashAfter === "members") {
      throw new LedgerError("SIMULATED_CRASH", "simulated crash after members");
    }
    const receipt = await this._appendReceipt({
      command,
      intent,
      memberRecords: members.map((member) => member.record),
      now,
    });
    await this._assertReceiptsOnDisk();
    const resolution = await this._appendResolution({
      intent,
      receipt,
      now,
      command,
    });
    verifyCommandResolution(resolution, intent, receipt);
    return {
      commitGroupId: intent.targetCommitGroupId,
      commitGroupReceipt: receipt,
      memberRecordIds,
      commandIntentId: intent.id,
      reused: false,
    };
  }

  _assertFrozenMatch(intent, next) {
    const same =
      intent.commandInputHash === next.commandInputHash &&
      intent.builderVersion === next.builderVersion &&
      intent.engineResultId === next.engineResultId &&
      canonicalHash(intent.expectedHeads) === canonicalHash(next.expectedHeads) &&
      canonicalHash(intent.immutableInputRefs) ===
        canonicalHash(next.immutableInputRefs);
    if (!same) {
      throw new LedgerError(
        "IDEMPOTENCY_CONFLICT",
        "idempotency key reused with different frozen input",
      );
    }
  }

  _planMembers({ command, intentId, targetCommitGroupId, now, committedProjection }) {
    const assignId = (schema, key) => {
      const prefix = SCHEMA_PREFIXES[schema];
      if (!prefix) {
        throw new LedgerError("UNKNOWN_SCHEMA", `no prefix for ${schema}`);
      }
      return brandedId(prefix, { intentId, schema, key });
    };
    const members = command.buildMembers({
      assignId,
      targetCommitGroupId,
      canonicalCommandInput: command.canonicalCommandInput,
      now,
      intentId,
      committedProjection,
    });
    assertMemberPlan(members, targetCommitGroupId);
    return members;
  }

  async _completeExisting({
    intent,
    command,
    events,
    sourceItems,
    recoveryNow,
    committedProjection,
  }) {
    const frozenCommand = {
      ...command,
      canonicalCommandInput: intent.canonicalCommandInput,
    };
    const members = this._planMembers({
      command: frozenCommand,
      intentId: intent.id,
      targetCommitGroupId: intent.targetCommitGroupId,
      now: intent.startedAt,
      committedProjection,
    });
    const plannedIds = members.map((member) => member.record.id);
    if (!sameArray(plannedIds, intent.memberRecordIds)) {
      throw new LedgerError(
        "RECOVERY_MISMATCH",
        "builder produced different memberRecordIds than frozen intent",
      );
    }
    const byId = indexRecords([...events, ...sourceItems]);
    const resolvedRecords = [];
    const knownIds = new Set(byId.keys());
    for (const member of members) {
      const matches = byId.get(member.record.id) ?? [];
      if (matches.length > 1) {
        throw new LedgerError(
          "RECOVERY_MISMATCH",
          "existing member id is ambiguous",
        );
      }
      const existing = matches[0];
      if (existing) {
        if (canonicalHash(existing) !== canonicalHash(member.record)) {
          throw new LedgerError(
            "RECOVERY_MISMATCH",
            "existing member content differs from frozen plan",
          );
        }
        resolvedRecords.push(existing);
        continue;
      }
      resolvedRecords.push(member.record);
    }
    const groupReceipts = events.filter(
      (row) =>
        row.schema === "commit-group-receipt-v1" &&
        row.commitGroupId === intent.targetCommitGroupId,
    );
    if (groupReceipts.length > 0) {
      await this._verifyWriteReceipts(events, sourceItems);
    }
    await this._appendMissingMembers(members, knownIds);
    if (command.crashAfter === "members" && groupReceipts.length === 0) {
      throw new LedgerError("SIMULATED_CRASH", "simulated crash after members");
    }
    let receipt = groupReceipts[0] ?? null;
    if (!receipt) {
      receipt = await this._appendReceipt({
        command,
        intent,
        memberRecords: resolvedRecords,
        now: recoveryNow,
      });
      await this._assertReceiptsOnDisk();
    }
    const resolutions = events.filter(
      (row) =>
        row.schema === "command-intent-resolution-v1" &&
        row.commandIntentId === intent.id,
    );
    const committed = resolutions.filter((row) => row.status === "COMMITTED");
    if (committed.length > 1) {
      invalidResolution("multiple COMMITTED resolutions");
    }
    if (committed.length === 1) {
      verifyCommandResolution(committed[0], intent, receipt);
      return {
        commitGroupId: intent.targetCommitGroupId,
        commitGroupReceipt: receipt,
        memberRecordIds: intent.memberRecordIds,
        commandIntentId: intent.id,
        reused: true,
      };
    }
    if (resolutions.length > 0) {
      invalidResolution("uncommitted or invalid resolution present");
    }
    const resolution = await this._appendResolution({
      intent,
      receipt,
      now: recoveryNow,
      command,
    });
    verifyCommandResolution(resolution, intent, receipt);
    return {
      commitGroupId: intent.targetCommitGroupId,
      commitGroupReceipt: receipt,
      memberRecordIds: intent.memberRecordIds,
      commandIntentId: intent.id,
      reused: true,
    };
  }

  async _readLockedStreams() {
    if (typeof this.store.readLockedStreams === "function") return this.store.readLockedStreams();
    return { events: await this.store.readAll("events"), sourceItems: await this.store.readAll("source_items") };
  }

  async _assertReceiptsOnDisk() {
    const { events, sourceItems } = await this._readLockedStreams();
    return this._verifyWriteReceipts(events, sourceItems);
  }

  async _readLockedProjection() {
    // One decoded generation for pre-write validation, resolution and recovery.
    // This is local to the held writer lock, never a cross-command cache.
    const { events, sourceItems } = await this._readLockedStreams();
    const committedProjection = await this._projectUnlocked({ events, sourceItems });
    return { events, sourceItems, committedProjection };
  }

  _verifyWriteReceipts(events, sourceItems) {
    return this.cooperativeWrites
      ? verifyCooperativeReceipts(events, sourceItems)
      : verifyCommitGroupReceipts(events, sourceItems);
  }

  async _appendMissingMembers(members, knownIds) {
    for (const member of members) {
      if (knownIds.has(member.record.id)) {
        continue;
      }
      const file = member.file === "source_items" ? "source_items" : "events";
      await this.store.append(file, member.record);
      knownIds.add(member.record.id);
    }
  }

  async _appendReceipt({ command, intent, memberRecords, now }) {
    const pairs = memberRecords.map((record) => [
      record.id,
      canonicalHash(record),
    ]);
    pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    const recordIds = pairs.map((pair) => pair[0]);
    const memberRecordHashes = pairs.map((pair) => pair[1]);
    const receipt = {
      schema: "commit-group-receipt-v1",
      id: brandedId("cgr_", { intentId: intent.id, role: "receipt" }),
      createdAt: now,
      recordedAt: now,
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      commitGroupId: intent.targetCommitGroupId,
      supersedesId: null,
      policyVersion: command.policyVersion,
      commandType: command.commandType,
      idempotencyKey: command.idempotencyKey,
      recordIds,
      recordCount: recordIds.length,
      memberRecordHashes,
      hashAlgorithm: "SHA-256",
      canonicalizationVersion: "canonical-json-v1",
      groupHash: canonicalHash(pairs),
      committedAt: now,
    };
    validateEventEnvelope(receipt);
    await this.store.append("events", receipt);
    return receipt;
  }

  async _appendResolution({ intent, receipt, now, command }) {
    const resolution = {
      schema: "command-intent-resolution-v1",
      id: brandedId("cmdres_", { intentId: intent.id, status: "COMMITTED" }),
      createdAt: now,
      recordedAt: now,
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
      commitGroupId: null,
      supersedesId: null,
      policyVersion: command.policyVersion,
      commandIntentId: intent.id,
      status: "COMMITTED",
      commitGroupReceiptId: receipt.id,
      sanitizedFailureCode: null,
      resolvedAt: now,
    };
    validateEventEnvelope(resolution);
    await this.store.append("events", resolution);
    return resolution;
  }

  async _projectUnlocked(snapshot = null, { cooperative = this.cooperativeWrites } = {}) {
    const { events, sourceItems } = snapshot || await this._readLockedStreams();
    const receipts = cooperative
      ? await verifyCooperativeReceipts(events, sourceItems)
      : verifyCommitGroupReceipts(events, sourceItems);
    const committedMemberIds = new Set();
    const committedReceiptIds = new Set();
    for (const receipt of receipts) {
      committedReceiptIds.add(receipt.id);
      for (const id of receipt.recordIds) {
        committedMemberIds.add(id);
      }
    }
    const committedIntentIds = new Set();
    for (const row of events) {
      if (
        row.schema === "command-intent-resolution-v1" &&
        row.status === "COMMITTED" &&
        committedReceiptIds.has(row.commitGroupReceiptId)
      ) {
        committedIntentIds.add(row.commandIntentId);
      }
    }
    const projectedEvents = events.filter((row) => {
      if (row.schema === "commit-group-receipt-v1") {
        return true;
      }
      if (row.schema === "command-intent-resolution-v1") {
        return (
          row.status === "COMMITTED" &&
          committedReceiptIds.has(row.commitGroupReceiptId)
        );
      }
      if (row.schema === "command-intent-v1") {
        return committedIntentIds.has(row.id);
      }
      return committedMemberIds.has(row.id);
    });
    return {
      events: projectedEvents,
      sourceItems: sourceItems.filter((row) => committedMemberIds.has(row.id)),
    };
  }
}
