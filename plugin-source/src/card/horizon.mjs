// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import { CardError } from "./errors.mjs";

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const MONTH_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const Q3_START = "2026-07-01";
const Q3_END = "2026-09-30";

function fail(code, message, details) {
  throw new CardError(code, message, details);
}

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseInstant(value) {
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
  const maxDay = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month];
  if (day < 1 || day > maxDay) {
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
  const fraction = match[7] ? Number(match[7].padEnd(3, "0").slice(0, 3)) : 0;
  const utcWall = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
  const check = new Date(utcWall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  return utcWall - offsetMinutes * 60_000;
}

function shanghaiWall(value) {
  const ms = parseInstant(value);
  if (ms === null) {
    fail("INVALID_TIME", "evaluationAnchorAt must be RFC3339", { value });
  }
  const iso = new Date(ms + 8 * 3600 * 1000).toISOString();
  return {
    date: iso.slice(0, 10),
    hour: Number(iso.slice(11, 13)),
    minute: Number(iso.slice(14, 16)),
    second: Number(iso.slice(17, 19)),
  };
}

function inCalendarRange(date, calendar) {
  return date >= calendar.rangeStart && date <= calendar.rangeEnd;
}

function nextTradingDay(calendar, date, inclusive) {
  for (const day of calendar.tradingDays) {
    if (inclusive ? day >= date : day > date) {
      return day;
    }
  }
  fail("HORIZON_OUT_OF_RANGE", "no later trading day in calendar", { date });
}

function previousTradingDay(calendar, date) {
  for (let index = calendar.tradingDays.length - 1; index >= 0; index -= 1) {
    if (calendar.tradingDays[index] < date) {
      return calendar.tradingDays[index];
    }
  }
  fail("HORIZON_OUT_OF_RANGE", "no earlier trading day in calendar", { date });
}

function nthSession(calendar, first, n) {
  const from = calendar.tradingDays.filter((day) => day >= first);
  if (from.length < n) {
    fail("HORIZON_OUT_OF_RANGE", "horizon exceeds calendar coverage", {
      first,
      n,
    });
  }
  return from[n - 1];
}

function sessionOpenAt(date) {
  return `${date}T09:30:00+08:00`;
}

function sessionCloseAt(date) {
  return `${date}T15:00:00+08:00`;
}

function minutesOf(wall) {
  return wall.hour * 60 + wall.minute;
}

export async function loadHorizonCalendar(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || parsed.synthetic !== true) {
    fail("INVALID_CALENDAR", "calendar must be synthetic");
  }
  if (parsed.version !== "a-share-horizon-v1") {
    fail("INVALID_CALENDAR", "calendar version must be a-share-horizon-v1");
  }
  if (parsed.rangeStart !== Q3_START || parsed.rangeEnd !== Q3_END) {
    fail("INVALID_CALENDAR", "calendar must be synthetic 2026Q3");
  }
  if (!Array.isArray(parsed.tradingDays) || parsed.tradingDays.length === 0) {
    fail("INVALID_CALENDAR", "tradingDays required");
  }
  let previous = null;
  for (const day of parsed.tradingDays) {
    if (typeof day !== "string" || day < Q3_START || day > Q3_END) {
      fail("INVALID_CALENDAR", "trading day outside synthetic 2026Q3", { day });
    }
    if (previous !== null && !(previous < day)) {
      fail("INVALID_CALENDAR", "tradingDays must be unique and sorted");
    }
    previous = day;
  }
  return parsed;
}

export function resolveAShareHorizons({ evaluationAnchorAt, calendar }) {
  const wall = shanghaiWall(evaluationAnchorAt);
  if (!inCalendarRange(wall.date, calendar)) {
    fail("HORIZON_OUT_OF_RANGE", "anchor outside calendar coverage", {
      date: wall.date,
    });
  }
  const isTrading = calendar.tradingDays.includes(wall.date);
  const beforeCutoff = minutesOf(wall) < 9 * 60 + 25;
  const anchorSession =
    isTrading && beforeCutoff
      ? wall.date
      : nextTradingDay(calendar, wall.date, false);
  const t1 = nthSession(calendar, anchorSession, 1);
  const t3 = nthSession(calendar, anchorSession, 3);
  const t5 = nthSession(calendar, anchorSession, 5);
  return {
    calendarRuleVersion: "a-share-horizon-v1",
    anchorSession,
    horizons: {
      T1: { scheduledSession: t1, scheduledAt: sessionCloseAt(t1) },
      T3: { scheduledSession: t3, scheduledAt: sessionCloseAt(t3) },
      T5: { scheduledSession: t5, scheduledAt: sessionCloseAt(t5) },
    },
  };
}

export function resolveReactionSearchWindow({
  opportunityEligibleAt,
  t5CloseAt,
  calendar,
}) {
  const startMs = parseInstant(opportunityEligibleAt);
  if (startMs === null) {
    fail("INVALID_TIME", "opportunityEligibleAt must be RFC3339");
  }
  const wall = shanghaiWall(opportunityEligibleAt);
  if (!inCalendarRange(wall.date, calendar)) {
    fail("HORIZON_OUT_OF_RANGE", "eligibleAt outside calendar coverage", {
      date: wall.date,
    });
  }
  const endMs = parseInstant(t5CloseAt);
  if (endMs === null) {
    fail("INVALID_TIME", "t5CloseAt must be RFC3339");
  }
  if (endMs < startMs) {
    fail("HORIZON_OUT_OF_RANGE", "reaction search end is before eligibleAt");
  }
  return {
    reactionSearchStartAt: opportunityEligibleAt,
    reactionSearchEndAt: t5CloseAt,
  };
}
