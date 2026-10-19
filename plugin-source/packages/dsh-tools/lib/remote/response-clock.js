// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import timers from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { differenceRfc3339Micros } from "../../../storage-contracts/src/time.mjs";
import { remoteError } from "./config.js";

// Wait for local time, never widen the receipt's evidence or knowledge cutoff.
// The caller must still run the original strict response projection afterwards.
export async function waitForResponseClock(receipt, { signal, context = false } = {}) {
  const active = () => { if (signal?.aborted) throw remoteError("CANCELLED"); };
  const drift = () => {
    try {
      const now = new Date().toISOString();
      const available = differenceRfc3339Micros(receipt.asOf, now);
      const known = context ? available : differenceRfc3339Micros(receipt.knownAt, now);
      return available > known ? available : known;
    } catch { throw remoteError("RESPONSE_INVALID"); }
  };
  active();
  let ahead = drift();
  if (ahead > 5_000_000n) throw remoteError("RESPONSE_INVALID");
  const deadline = performance.now() + Number((ahead + 999n) / 1000n);
  while (ahead > 0n) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw remoteError("RESPONSE_INVALID");
    try { await timers.setTimeout(Math.min(Number((ahead + 999n) / 1000n), Math.ceil(remaining)), undefined, { signal }); }
    catch (error) { active(); throw error; }
    active();
    const next = drift();
    if (next > ahead) throw remoteError("RESPONSE_INVALID");
    // Timer readiness is not proof that the wall-clock evidence boundary was reached.
    // Early wakes share one monotonic budget; frozen or reversing clocks still fail.
    ahead = next;
  }
}
