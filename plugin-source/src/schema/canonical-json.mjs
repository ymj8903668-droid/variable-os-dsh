// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import { SchemaError } from "./errors.mjs";

export { SchemaError };
export const CANONICALIZATION_VERSION = "canonical-json-v1";
export const HASH_ALGORITHM = "SHA-256";

function fail(message) {
  throw new SchemaError("CANONICAL_INVALID", message);
}

function nfc(value) {
  return value.normalize("NFC");
}

function serialize(value, stack) {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "string") {
    return JSON.stringify(nfc(value));
  }
  if (type === "boolean") {
    return value ? "true" : "false";
  }
  if (type === "number") {
    if (!Number.isFinite(value)) {
      fail("non-finite number");
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (type !== "object") {
    fail(`unsupported type: ${type}`);
  }
  if (stack.has(value)) {
    fail("circular reference");
  }
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) {
      fail("non-plain array");
    }
    stack.add(value);
    const items = value.map((item) => {
      if (item === undefined) {
        fail("undefined array item");
      }
      return serialize(item, stack);
    });
    stack.delete(value);
    return `[${items.join(",")}]`;
  }
  if (proto !== Object.prototype && proto !== null) {
    fail("non-plain object");
  }
  stack.add(value);
  const entries = Object.keys(value).map((key) => [nfc(key), value[key]]);
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const seen = new Set();
  const parts = [];
  for (const [key, raw] of entries) {
    if (seen.has(key)) {
      fail("duplicate key after NFC");
    }
    seen.add(key);
    if (raw === undefined) {
      fail("undefined object value");
    }
    parts.push(`${JSON.stringify(key)}:${serialize(raw, stack)}`);
  }
  stack.delete(value);
  return `{${parts.join(",")}}`;
}

export function canonicalize(value) {
  return serialize(value, new WeakSet());
}

export function canonicalHash(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}

export function brandedId(prefix, payload) {
  if (typeof prefix !== "string" || !prefix.endsWith("_") || prefix.length < 2) {
    fail("id prefix must end with underscore");
  }
  return `${prefix}${canonicalHash(payload)}`;
}
