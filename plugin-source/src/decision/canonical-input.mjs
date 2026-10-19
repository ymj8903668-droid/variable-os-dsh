// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { DecisionError } from "./errors.mjs";

export { DecisionError };

const DECISION_TYPES = new Set([
  "SCREENING",
  "CARD_SYNTHESIS",
  "PRESENTATION_RANKING",
]);
const SUBJECT_TYPES = new Set(["SCAN_EXPOSURE", "VARIABLE", "CARD_REVISION"]);
const STREAMS = new Set(["FOCAL", "CONCURRENT", "PRIOR", "THEME"]);
const REF_TYPES = new Set([
  "SOURCE_ITEM",
  "EVENT_INSTANCE",
  "FACT",
  "JUDGMENT",
  "THEME_MEMORY_SNAPSHOT",
]);
const CREDENTIAL_KEYS = new Set([
  "password",
  "apikey",
  "token",
  "secret",
  "authorization",
  "credential",
  "accesstoken",
  "privatekey",
]);

function fail(code, message, details) {
  throw new DecisionError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoCredentials(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentials(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const normalized = String(key).toLowerCase().replace(/[-_]/g, "");
    if (CREDENTIAL_KEYS.has(normalized)) {
      fail("CREDENTIALS_FORBIDDEN", `credential field ${key}`, { path, key });
    }
    assertNoCredentials(value[key], `${path}.${key}`);
  }
}

function freezeItem(item, index) {
  if (!isPlainObject(item)) {
    fail("INVALID_CONTEXT", "context item must be a plain object", { index });
  }
  if (item.stream === "SKILL" || item.stream === "EPISODE") {
    fail("SKILL_EPISODE_FORBIDDEN", "P0 rejects Skill/Episode context items", {
      stream: item.stream,
    });
  }
  if (
    item.refType === "SKILL" ||
    item.refType === "EPISODE" ||
    item.refType === "SKILL_REVISION" ||
    item.refType === "EPISODE_SNAPSHOT"
  ) {
    fail("SKILL_EPISODE_FORBIDDEN", "P0 rejects Skill/Episode ref types", {
      refType: item.refType,
    });
  }
  if (!STREAMS.has(item.stream) || !REF_TYPES.has(item.refType)) {
    fail("INVALID_CONTEXT", "unknown context stream or refType", { index });
  }
  if (typeof item.id !== "string" || !item.id) {
    fail("INVALID_CONTEXT", "context item id required", { index });
  }
  if (typeof item.refId !== "string" || !item.refId) {
    fail("INVALID_CONTEXT", "context item refId required", { index });
  }
  if (typeof item.contentHash !== "string" || !item.contentHash) {
    fail("INVALID_CONTEXT", "contentHash required", { index });
  }
  if (typeof item.availableAt !== "string" || !item.availableAt) {
    fail("INVALID_CONTEXT", "availableAt required", { index });
  }
  if (!isPlainObject(item.payload)) {
    fail("INVALID_CONTEXT", "payload required", { index });
  }
  if (
    item.payload.renderedText === undefined &&
    item.payload.structuredInput === undefined &&
    item.payload.ruleInput === undefined
  ) {
    fail("INVALID_CONTEXT", "payload must contain rendered or structured input", {
      index,
    });
  }
  assertNoCredentials(item, `contextItems[${index}]`);
  return {
    id: item.id,
    stream: item.stream,
    refType: item.refType,
    refId: item.refId,
    availabilityReceiptId: item.availabilityReceiptId ?? null,
    resolutionReceiptId: item.resolutionReceiptId ?? null,
    availableAt: item.availableAt,
    resolvedAt: item.resolvedAt ?? null,
    contentHash: item.contentHash,
    memberRefs: Array.isArray(item.memberRefs) ? item.memberRefs : [],
    payload: item.payload,
    recordKind: item.recordKind ?? null,
    caseResolutionReceipt: item.caseResolutionReceipt ?? null,
    themeMemorySnapshot: item.themeMemorySnapshot ?? null,
  };
}

function freezeEngine(engine) {
  if (!isPlainObject(engine)) {
    fail("INVALID_CONTEXT", "engine required");
  }
  assertNoCredentials(engine, "engine");
  if (engine.engineType === "RULE") {
    if (typeof engine.ruleVersion !== "string" || !engine.ruleVersion) {
      fail("INVALID_CONTEXT", "ruleVersion required");
    }
    const decisionInput = engine.canonicalDecisionInput;
    if (
      !isPlainObject(decisionInput) ||
      !Object.prototype.hasOwnProperty.call(decisionInput, "ruleInput") ||
      decisionInput.ruleInput === undefined ||
      decisionInput.ruleInput === null
    ) {
      fail("INVALID_CONTEXT", "RULE requires canonicalDecisionInput.ruleInput");
    }
    return {
      engineType: "RULE",
      ruleVersion: engine.ruleVersion,
      canonicalDecisionInput: {
        ruleInput: decisionInput.ruleInput,
      },
    };
  }
  if (engine.engineType === "MODEL") {
    if (typeof engine.modelVersion !== "string" || !engine.modelVersion) {
      fail("INVALID_CONTEXT", "modelVersion required");
    }
    if (typeof engine.promptVersion !== "string" || !engine.promptVersion) {
      fail("INVALID_CONTEXT", "promptVersion required");
    }
    const decisionInput = engine.canonicalDecisionInput;
    if (
      !isPlainObject(decisionInput) ||
      !isPlainObject(decisionInput.modelRequest)
    ) {
      fail("INVALID_CONTEXT", "MODEL requires canonicalDecisionInput.modelRequest");
    }
    return {
      engineType: "MODEL",
      modelVersion: engine.modelVersion,
      promptVersion: engine.promptVersion,
      canonicalDecisionInput: {
        modelRequest: decisionInput.modelRequest,
      },
    };
  }
  fail("INVALID_CONTEXT", "engineType must be RULE or MODEL");
}

export function buildCanonicalDecisionInput(input) {
  if (!isPlainObject(input)) {
    fail("INVALID_CONTEXT", "canonical decision input must be a plain object");
  }
  assertNoCredentials(input, "input");
  if (!DECISION_TYPES.has(input.decisionType)) {
    fail("INVALID_CONTEXT", "decisionType invalid");
  }
  if (
    !isPlainObject(input.subjectRef) ||
    !SUBJECT_TYPES.has(input.subjectRef.type) ||
    typeof input.subjectRef.id !== "string"
  ) {
    fail("INVALID_CONTEXT", "subjectRef invalid");
  }
  if (typeof input.contextCutoffAt !== "string" || !input.contextCutoffAt) {
    fail("INVALID_CONTEXT", "contextCutoffAt required");
  }
  if (typeof input.policyVersion !== "string" || !input.policyVersion) {
    fail("INVALID_CONTEXT", "policyVersion required");
  }
  if (!Array.isArray(input.contextItems)) {
    fail("INVALID_CONTEXT", "contextItems must be an array");
  }
  const contextItems = input.contextItems.map((item, index) =>
    freezeItem(item, index),
  );
  const canonical = {
    serializationVersion: "canonical-json-v1",
    decisionType: input.decisionType,
    subjectRef: {
      type: input.subjectRef.type,
      id: input.subjectRef.id,
    },
    focalEventInstanceId: input.focalEventInstanceId ?? null,
    contextCutoffAt: input.contextCutoffAt,
    contextItems,
    engine: freezeEngine(input.engine),
    policyVersion: input.policyVersion,
  };
  return {
    ...canonical,
    contextHash: canonicalHash(canonical),
  };
}
