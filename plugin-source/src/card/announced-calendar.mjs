// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { canonicalHash } from "../schema/canonical-json.mjs";
import { CardError } from "./errors.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const closedRanges = [
  { holiday: "NEW_YEAR", start: "2026-01-01", end: "2026-01-03" },
  { holiday: "SPRING_FESTIVAL", start: "2026-02-15", end: "2026-02-23" },
  { holiday: "QINGMING", start: "2026-04-04", end: "2026-04-06" },
  { holiday: "LABOUR_DAY", start: "2026-05-01", end: "2026-05-05" },
  { holiday: "DRAGON_BOAT", start: "2026-06-19", end: "2026-06-21" },
  { holiday: "MID_AUTUMN", start: "2026-09-25", end: "2026-09-27" },
  { holiday: "NATIONAL_DAY", start: "2026-10-01", end: "2026-10-07" },
];

const definition = {
  calendarId: "sse-szse-2026-v1",
  version: "a-share-horizon-v1",
  synthetic: false,
  basis: "ANNOUNCED_SESSIONS",
  markets: ["SSE", "SZSE"],
  timezone: "Asia/Shanghai",
  sessionOpen: "09:30",
  sessionClose: "15:00",
  // The cutoff is the existing application policy, not an exchange rule.
  decisionCutoff: "09:25",
  rangeStart: "2026-01-01",
  rangeEnd: "2026-12-31",
  sources: [
    { publisher: "SSE", publishedOn: "2025-12-22", notice: "2025-45",
      url: "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml" },
    { publisher: "SZSE", publishedOn: "2025-12-22", notice: "2025-481",
      url: "https://www.szse.cn/disclosure/notice/t20251222_618087.html" },
  ],
  closedRanges,
  tradingDays: [],
};

// A bounded announced schedule, not observed market data or a rolling forecast.
for (let instant = Date.parse(`${definition.rangeStart}T00:00:00Z`);
  instant <= Date.parse(`${definition.rangeEnd}T00:00:00Z`); instant += 86_400_000) {
  const date = new Date(instant);
  const day = date.toISOString().slice(0, 10);
  if (![0, 6].includes(date.getUTCDay()) &&
    !closedRanges.some(range => day >= range.start && day <= range.end)) {
    definition.tradingDays.push(day);
  }
}
const calendar = freeze({ ...definition, contentHash: canonicalHash(definition) });

export function getAnnouncedCalendar(calendarId) {
  if (calendarId !== calendar.calendarId) {
    throw new CardError("HORIZON_CALENDAR_UNAVAILABLE", "explicit horizon calendar is not available");
  }
  return calendar;
}
