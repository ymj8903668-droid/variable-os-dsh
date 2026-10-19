// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { CommandRuntime } from "../ledger/command-runtime.mjs";
import { computeLedgerWatermark } from "../http/query.mjs";
import { QueryError } from "../http/errors.mjs";
import { findSnapshot } from "./build.mjs";
import { projectReport } from "./render.mjs";

function fail(code, message, details) {
  throw new QueryError(code, message, details);
}

export async function queryReport({
  store,
  asOfWatermark,
  date,
  snapshotId,
  now,
}) {
  if (asOfWatermark === undefined || asOfWatermark === null || asOfWatermark === "") {
    fail("WATERMARK_REQUIRED", "asOfWatermark is required");
  }
  const runtime = new CommandRuntime({ store, now: () => now });
  const projected = await runtime.project();
  const watermark = computeLedgerWatermark(projected);
  if (asOfWatermark !== "latest" && asOfWatermark !== watermark) {
    fail("WATERMARK_MISMATCH", "asOfWatermark does not match frozen ledger");
  }
  const snapshot = findSnapshot(projected.events, snapshotId);
  if (!snapshot) {
    fail("NOT_FOUND", "committed cohort snapshot required");
  }
  const view = projectReport({
    snapshot,
    events: projected.events,
    sourceItems: projected.sourceItems,
  });
  if (date && view.date !== date) {
    fail("NOT_FOUND", "report date does not match snapshot window");
  }
  return {
    asOfWatermark: watermark,
    ...view,
  };
}
