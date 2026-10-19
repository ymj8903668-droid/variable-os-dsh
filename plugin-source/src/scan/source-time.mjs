// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  return [0, 31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month
  ];
}

export function parseSourceInstant(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = RFC3339.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const sign = match[8][0] === "-" ? -1 : 1;
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const fraction = match[7]
    ? Number(match[7].padEnd(3, "0").slice(0, 3))
    : 0;
  const utcWall = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  const check = new Date(utcWall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return utcWall - offsetMinutes * 60_000;
}

export function resolveSourceAvailability({
  declaredPublishedAt,
  retrievedAt,
}) {
  const retrievedMs = parseSourceInstant(retrievedAt);
  if (retrievedMs === null) {
    throw new Error("retrievedAt must be RFC3339 with timezone");
  }
  const publishedMs = parseSourceInstant(declaredPublishedAt);
  if (publishedMs === null) {
    return {
      availableAt: retrievedAt,
      declaredPublishedAt: null,
      sourceTimeConfidence: "UNKNOWN",
    };
  }
  if (publishedMs > retrievedMs) {
    return {
      availableAt: retrievedAt,
      declaredPublishedAt,
      sourceTimeConfidence: "UNKNOWN",
    };
  }
  return {
    availableAt: retrievedAt,
    declaredPublishedAt,
    sourceTimeConfidence: "DECLARED",
  };
}
