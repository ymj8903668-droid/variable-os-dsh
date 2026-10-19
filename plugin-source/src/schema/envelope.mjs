// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { SchemaError } from "./errors.mjs";
import {
  ACTOR_TYPES,
  ENVELOPE_FIELDS,
  NULLABLE_ENVELOPE_FIELDS,
  SCHEMA_PREFIXES,
} from "./registry.mjs";

export { SchemaError };

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const MONTH_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fail(code, message, details) {
  throw new SchemaError(code, message, details);
}

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_TYPE", "envelope must be a plain object");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail("INVALID_TYPE", "envelope must be a plain object");
  }
}

function assertRfc3339(field, value) {
  if (typeof value !== "string") {
    fail("INVALID_TIME", `${field} must be RFC3339 with timezone`, { field });
  }
  const match = RFC3339.exec(value);
  if (!match) {
    fail("INVALID_TIME", `${field} must be RFC3339 with timezone`, { field });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    fail("INVALID_TIME", `${field} is not a valid timestamp`, { field });
  }
  const maxDay = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month];
  if (day < 1 || day > maxDay) {
    fail("INVALID_TIME", `${field} is not a valid timestamp`, { field });
  }
  if (match[8] !== "Z") {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      fail("INVALID_TIME", `${field} has an invalid offset`, { field });
    }
  }
}

function assertIdPrefix(schema, id) {
  const prefix = SCHEMA_PREFIXES[schema];
  if (typeof id !== "string" || !id.startsWith(prefix) || id.length <= prefix.length) {
    fail("ID_PREFIX_MISMATCH", "id prefix does not match schema kind", {
      schema,
      prefix,
    });
  }
}

export function validateEventEnvelope(input) {
  assertPlainObject(input);
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      fail("MISSING_FIELD", `missing ${field}`, { field });
    }
  }

  const schema = input.schema;
  if (typeof schema !== "string" || schema.length === 0) {
    fail("INVALID_TYPE", "schema must be a non-empty string", { field: "schema" });
  }
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_PREFIXES, schema)) {
    fail("UNKNOWN_SCHEMA", `unknown schema: ${schema}`, { schema });
  }

  const actorType = input.actorType;
  if (!ACTOR_TYPES.includes(actorType)) {
    fail("INVALID_ENUM", "actorType is not a known kind", { field: "actorType" });
  }

  assertIdPrefix(schema, input.id);
  assertRfc3339("createdAt", input.createdAt);
  assertRfc3339("recordedAt", input.recordedAt);

  for (const field of ["correlationId", "policyVersion"]) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      fail("INVALID_TYPE", `${field} must be a non-empty string`, { field });
    }
  }

  const nullable = new Set(NULLABLE_ENVELOPE_FIELDS);
  for (const field of nullable) {
    const value = input[field];
    if (value !== null && (typeof value !== "string" || value.length === 0)) {
      fail("INVALID_TYPE", `${field} must be string or null`, { field });
    }
  }

  const out = {};
  for (const field of ENVELOPE_FIELDS) {
    out[field] = input[field];
  }
  return Object.freeze(out);
}
