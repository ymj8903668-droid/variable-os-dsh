// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { StorageContractError } from "./contracts.mjs";

export const TIME_PRECISIONS = Object.freeze([
  "SECOND",
  "MINUTE",
  "HOUR",
  "DAY",
  "MONTH",
  "UNKNOWN",
]);

export const TIME_SOURCES = Object.freeze([
  "SOURCE_DECLARED",
  "CONNECTOR_OBSERVED",
  "SYSTEM_ASSIGNED",
  "HUMAN_CONFIRMED",
  "UNKNOWN",
]);

export const TIMESTAMP_CONFIDENCES = Object.freeze([
  "CONFIRMED",
  "INFERRED",
  "AMBIGUOUS",
  "UNKNOWN",
]);

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const INTEGER_STRING = /^-?(?:0|[1-9]\d*)$/;
const MONTH_DAYS = Object.freeze([0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const TIME_FIELDS = Object.freeze([
  "eventAt",
  "availableAt",
  "recordedAt",
  "timePrecision",
  "timeSource",
  "sourceTimezone",
  "originalTimeText",
  "timestampConfidence",
  "clockSkewMs",
  "usableForAsOf",
]);

function fail(code, message, details = null) {
  throw new StorageContractError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseRfc3339(value, field = "timestamp") {
  if (typeof value !== "string") {
    fail("STORAGE_TIME_INVALID", `${field} must be an RFC3339 string`, { field });
  }
  const match = RFC3339.exec(value);
  if (!match) {
    fail("STORAGE_TIME_INVALID", `${field} must be RFC3339 with at most microseconds`, {
      field,
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const maxDay = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month];
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maxDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    match[8] === "-00:00" ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    fail("STORAGE_TIME_INVALID", `${field} is not a valid RFC3339 instant`, { field });
  }

  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  base.setUTCHours(hour, minute, second, 0);
  const fraction = BigInt((match[7] || "").padEnd(6, "0"));
  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMicros =
    BigInt(offsetSign * (offsetHour * 60 + offsetMinute)) * 60n * 1_000_000n;
  return BigInt(base.getTime()) * 1_000n + fraction - offsetMicros;
}

function optionalTime(value, field) {
  if (value === null) {
    return null;
  }
  parseRfc3339(value, field);
  return value;
}

function assertEnum(value, values, field) {
  if (!values.includes(value)) {
    fail("STORAGE_TIME_ENUM_INVALID", `${field} is not supported`, { field });
  }
  return value;
}

function assertTimezone(value) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    fail("STORAGE_TIMEZONE_INVALID", "sourceTimezone must be an IANA timezone or null");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    fail("STORAGE_TIMEZONE_INVALID", "sourceTimezone must be an IANA timezone or null");
  }
  return value;
}

export function validateTimeBundle(input) {
  if (!isPlainObject(input)) {
    fail("STORAGE_TIME_INVALID", "TimeBundle must be a plain object");
  }
  for (const field of TIME_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      fail("STORAGE_TIME_REQUIRED", `TimeBundle.${field} is required`, { field });
    }
  }
  const unknown = Object.keys(input).filter((field) => !TIME_FIELDS.includes(field));
  if (unknown.length > 0) {
    fail("STORAGE_TIME_FIELD_UNKNOWN", "TimeBundle has unknown fields", { fields: unknown });
  }

  if (input.recordedAt === null || input.recordedAt === undefined || input.recordedAt === "") {
    fail("STORAGE_TIME_REQUIRED", "recordedAt is required", { field: "recordedAt" });
  }
  parseRfc3339(input.recordedAt, "recordedAt");
  const eventAt = optionalTime(input.eventAt, "eventAt");
  const availableAt = optionalTime(input.availableAt, "availableAt");
  const timePrecision = assertEnum(input.timePrecision, TIME_PRECISIONS, "timePrecision");
  const timeSource = assertEnum(input.timeSource, TIME_SOURCES, "timeSource");
  const timestampConfidence = assertEnum(
    input.timestampConfidence,
    TIMESTAMP_CONFIDENCES,
    "timestampConfidence",
  );
  if (typeof input.usableForAsOf !== "boolean") {
    fail("STORAGE_TIME_INVALID", "usableForAsOf must be boolean", {
      field: "usableForAsOf",
    });
  }
  if (input.usableForAsOf && availableAt === null) {
    fail("STORAGE_ASOF_TIME_REQUIRED", "usable records require availableAt");
  }
  if (["DAY", "MONTH", "UNKNOWN"].includes(timePrecision) && eventAt !== null) {
    fail(
      "STORAGE_TIME_PRECISION_CONFLICT",
      "coarse or unknown event time must not be represented by an invented instant",
    );
  }
  if (timePrecision === "UNKNOWN" && timeSource !== "UNKNOWN") {
    fail(
      "STORAGE_TIME_PRECISION_CONFLICT",
      "unknown event precision requires an unknown event time source",
    );
  }
  if (input.originalTimeText !== null && typeof input.originalTimeText !== "string") {
    fail("STORAGE_TIME_INVALID", "originalTimeText must be string or null", {
      field: "originalTimeText",
    });
  }
  if (
    input.clockSkewMs !== null &&
    (typeof input.clockSkewMs !== "string" || !INTEGER_STRING.test(input.clockSkewMs))
  ) {
    fail("STORAGE_TIME_INVALID", "clockSkewMs must be an integer string or null", {
      field: "clockSkewMs",
    });
  }

  return Object.freeze({
    eventAt,
    availableAt,
    recordedAt: input.recordedAt,
    timePrecision,
    timeSource,
    sourceTimezone: assertTimezone(input.sourceTimezone),
    originalTimeText: input.originalTimeText,
    timestampConfidence,
    clockSkewMs: input.clockSkewMs,
    usableForAsOf: input.usableForAsOf,
  });
}

export function serializeTimeBundle(input) {
  const value = validateTimeBundle(input);
  return Object.freeze({
    event_at: value.eventAt,
    available_at: value.availableAt,
    recorded_at: value.recordedAt,
    time_precision: value.timePrecision,
    time_source: value.timeSource,
    source_timezone: value.sourceTimezone,
    original_time_text: value.originalTimeText,
    timestamp_confidence: value.timestampConfidence,
    clock_skew_ms: value.clockSkewMs,
    usable_for_asof: value.usableForAsOf,
  });
}

export function deserializeTimeBundle(row) {
  if (!isPlainObject(row)) {
    fail("STORAGE_TIME_INVALID", "database time row must be a plain object");
  }
  return validateTimeBundle({
    eventAt: row.event_at,
    availableAt: row.available_at,
    recordedAt: row.recorded_at,
    timePrecision: row.time_precision,
    timeSource: row.time_source,
    sourceTimezone: row.source_timezone,
    originalTimeText: row.original_time_text,
    timestampConfidence: row.timestamp_confidence,
    clockSkewMs: row.clock_skew_ms,
    usableForAsOf: row.usable_for_asof,
  });
}

export function compareRfc3339(left, right) {
  const leftMicros = parseRfc3339(left, "left");
  const rightMicros = parseRfc3339(right, "right");
  return leftMicros < rightMicros ? -1 : leftMicros > rightMicros ? 1 : 0;
}

export function differenceRfc3339Micros(left, right) {
  return parseRfc3339(left, "left") - parseRfc3339(right, "right");
}

export function compareStableTimeRows(left, right) {
  const leftAvailable = left?.availableAt ?? null;
  const rightAvailable = right?.availableAt ?? null;
  if (leftAvailable === null || rightAvailable === null) {
    if (leftAvailable !== rightAvailable) {
      return leftAvailable === null ? 1 : -1;
    }
  } else {
    const availableOrder = compareRfc3339(leftAvailable, rightAvailable);
    if (availableOrder !== 0) {
      return availableOrder;
    }
  }
  const recordedOrder = compareRfc3339(left?.recordedAt, right?.recordedAt);
  if (recordedOrder !== 0) {
    return recordedOrder;
  }
  if (typeof left?.stableId !== "string" || typeof right?.stableId !== "string") {
    fail("STORAGE_ID_INVALID", "stable ordering requires stableId strings");
  }
  return left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0;
}

export function asOfVisibility(bundle, asOf) {
  const value = validateTimeBundle(bundle);
  parseRfc3339(asOf, "asOf");
  if (!value.usableForAsOf || value.availableAt === null) {
    return Object.freeze({ visible: false, reason: "TIME_UNKNOWN" });
  }
  if (compareRfc3339(value.availableAt, asOf) > 0) {
    return Object.freeze({ visible: false, reason: "AVAILABLE_AFTER_ASOF" });
  }
  return Object.freeze({ visible: true, reason: null });
}

function sampleRows(value, field) {
  if (!Array.isArray(value)) {
    fail("STORAGE_SAMPLE_INVALID", `${field} must be an array`, { field });
  }
  return value;
}

function sampleAvailability(row, field) {
  if (!isPlainObject(row) || typeof row.id !== "string" || !row.id) {
    fail("STORAGE_SAMPLE_INVALID", `${field} row requires an id`, { field });
  }
  if (row.availableAt === null || row.availableAt === undefined) {
    fail("STORAGE_ASOF_TIME_REQUIRED", `${field} row requires availableAt`, {
      field,
      id: row.id,
    });
  }
  parseRfc3339(row.availableAt, `${field}.availableAt`);
  return row.availableAt;
}

export function validateTemporalSample(input) {
  if (!isPlainObject(input)) {
    fail("STORAGE_SAMPLE_INVALID", "temporal sample must be a plain object");
  }
  parseRfc3339(input.cutoffAt, "cutoffAt");
  const features = sampleRows(input.features, "features");
  const labels = sampleRows(input.labels, "labels");
  for (const row of features) {
    if (compareRfc3339(sampleAvailability(row, "features"), input.cutoffAt) > 0) {
      fail("STORAGE_ASOF_LEAKAGE", "feature became available after sample cutoff", {
        id: row.id,
      });
    }
  }
  for (const row of labels) {
    if (compareRfc3339(sampleAvailability(row, "labels"), input.cutoffAt) <= 0) {
      fail("STORAGE_LABEL_LEAKAGE", "label was available at or before sample cutoff", {
        id: row.id,
      });
    }
  }
  return Object.freeze({
    cutoffAt: input.cutoffAt,
    features: Object.freeze([...features]),
    labels: Object.freeze([...labels]),
  });
}
