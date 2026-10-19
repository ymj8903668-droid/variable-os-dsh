// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { defaultAppRoot } from "../ledger-guard.mjs";
import { syncResearchCases } from "./case-sync.mjs";
import {
  createUnavailableDailyBarAdapter,
} from "./daily-bar.mjs";
import { fail } from "./errors.mjs";
import { resolveDeskPaths } from "./desk-paths.mjs";
import { buildResearchSnapshotV1 } from "./snapshot.mjs";
import { buildAndActivate } from "./snapshot-store.mjs";

export function defaultResearchRoot(appRoot = defaultAppRoot()) {
  return path.join(appRoot, ".local-demo", "research");
}

export function shanghaiNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get(
    "minute",
  )}:${get("second")}+08:00`;
}

export async function refreshResearch({
  sourceRoot = process.env.VARIABLE_OS_SOURCE_ROOT,
  derivedRoot,
  now,
  store,
  forceOffline = false,
  dailyBarAdapter = createUnavailableDailyBarAdapter(),
} = {}) {
  sourceRoot = resolveDeskPaths({ VARIABLE_OS_SOURCE_ROOT: sourceRoot }).sourceRoot;
  if (!derivedRoot) {
    fail("DERIVED_ROOT_MISSING", "derivedRoot required");
  }
  const stamped = now || shanghaiNow();
  const adapter = forceOffline
    ? createUnavailableDailyBarAdapter()
    : dailyBarAdapter || createUnavailableDailyBarAdapter();
  const activated = await buildAndActivate({
    derivedRoot,
    now: stamped,
    build: () =>
      buildResearchSnapshotV1({
        sourceRoot,
        now: stamped,
        dailyBarAdapter: adapter,
      }),
  });
  if (!activated.ok) {
    return activated;
  }
  let sync = null;
  if (store) {
    sync = await syncResearchCases({
      store,
      snapshot: activated.snapshot,
      now: stamped,
    });
  }
  return {
    ...activated,
    sync,
  };
}
