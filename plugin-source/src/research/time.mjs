// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseClock(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    return {
      date: trimmed,
      hour: null,
      minute: null,
      second: null,
      tz: "+08:00",
      midnight: true,
      hasClock: false,
      hasSeconds: false,
    };
  }
  const wall = WALL.exec(trimmed);
  if (!wall || wall[4] == null) {
    return null;
  }
  const hour = Number(wall[4]);
  const minute = Number(wall[5]);
  const second = wall[6] != null ? Number(wall[6]) : 0;
  return {
    date: `${wall[1]}-${wall[2]}-${wall[3]}`,
    hour,
    minute,
    second,
    tz: wall[8] || "+08:00",
    midnight: hour === 0 && minute === 0 && second === 0,
    hasClock: true,
    hasSeconds: wall[6] != null,
  };
}

function toRfc3339(parsed) {
  const tz = parsed.tz === "Z" ? "Z" : parsed.tz;
  return `${parsed.date}T${pad2(parsed.hour)}:${pad2(parsed.minute)}:${pad2(
    parsed.second,
  )}${tz}`;
}

function instantFrom(value, now) {
  const parsed = parseClock(value);
  if (!parsed || !parsed.hasClock || parsed.midnight) {
    return now;
  }
  return toRfc3339(parsed);
}

export function normalizeTemporal({
  eventAt,
  availableAt = null,
  recordedAt = null,
  now,
} = {}) {
  const eventParsed = parseClock(eventAt);
  let timePrecision = "DAY";
  let normalizedEvent = typeof eventAt === "string" ? eventAt.trim() : null;
  if (!eventParsed || !eventParsed.hasClock || eventParsed.midnight) {
    normalizedEvent = eventParsed ? eventParsed.date : normalizedEvent;
    timePrecision = "DAY";
  } else {
    normalizedEvent = toRfc3339(eventParsed);
    timePrecision =
      eventParsed.hasSeconds && eventParsed.second !== 0 ? "SECOND" : "MINUTE";
  }

  const recorded = instantFrom(recordedAt, now);
  const available = instantFrom(availableAt, recorded || now);
  return Object.freeze({
    eventAt: normalizedEvent,
    availableAt: available,
    recordedAt: recorded,
    timePrecision,
  });
}
