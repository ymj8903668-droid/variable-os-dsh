// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const ALLOWED_RATES = new Map([
  [0.8, "150"],
  [1, "180"],
  [1.2, "210"],
]);
const ALLOWED_ACTIONS = new Set(["status", "start", "pause", "resume", "stop"]);

function envelope(result) {
  return { ok: true, result, projectionStatus: "UNCHANGED" };
}

function failure(code, message) {
  return {
    ok: false,
    error: { code, message },
    projectionStatus: "UNCHANGED",
  };
}

function boundedText(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text && text.length <= 900 ? text : null;
}

export function createLocalNarrationController({
  platform = process.platform,
  executable = "/usr/bin/say",
  voice = "Tingting",
  spawnImpl = spawn,
  existsImpl = existsSync,
  killGraceMs = 250,
  stopTimeoutMs = 1500,
} = {}) {
  if (![killGraceMs, stopTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError("Narration time limits must be positive integers");
  }
  const available = platform === "darwin" && executable === "/usr/bin/say" && existsImpl(executable);
  let child = null;
  let state = "idle";
  let stopping = null, starting = false, disposed = false, sequence = 0;

  const snapshot = () => ({
    available,
    state,
    backend: "macos-say",
  });

  const waitClosed = async (active, timeoutMs) => {
    if (active.closed) return true;
    let timer;
    try {
      return await Promise.race([active.done.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const stopActive = async () => {
    if (stopping) return stopping;
    const active = child, paused = state === "paused";
    if (!active) { state = "idle"; return true; }
    active.stopping = true;
    state = "stopping";
    stopping = (async () => {
      try {
        // A paused process cannot handle TERM; do not resume audible playback.
        if (!active.exited && !active.process.kill(paused ? "SIGKILL" : "SIGTERM")) return false;
        if (await waitClosed(active, killGraceMs)) return true;
        if (!active.exited && !active.process.kill("SIGKILL")) return false;
        return await waitClosed(active, stopTimeoutMs);
      } catch { return false; }
    })();
    try {
      const confirmed = await stopping;
      state = confirmed ? "idle" : "error";
      return confirmed;
    } finally { stopping = null; }
  };

  return {
    status() {
      return envelope(snapshot());
    },
    async call(params = {}) {
      const action = typeof params.action === "string" ? params.action : "";
      if (!ALLOWED_ACTIONS.has(action)) {
        return failure("NARRATION_INVALID_INPUT", "unsupported narration action");
      }
      if (action === "status") return envelope(snapshot());
      if (action === "stop") {
        sequence++;
        if (!available) return failure("NARRATION_UNAVAILABLE", "local narration is unavailable");
        if (!await stopActive()) {
          return failure("NARRATION_CONTROL_FAILED", "local narration could not stop");
        }
        return envelope(snapshot());
      }
      if (!available || disposed) {
        return failure("NARRATION_UNAVAILABLE", "local narration is unavailable");
      }
      if (stopping || starting) return failure("NARRATION_BUSY", "local narration is stopping");
      if (action === "pause") {
        if (child && state === "speaking") {
          try {
            if (child.process.kill("SIGSTOP") === false) throw new Error("pause failed");
            state = "paused";
          } catch {
            return failure("NARRATION_CONTROL_FAILED", "local narration could not pause");
          }
        }
        return envelope(snapshot());
      }
      if (action === "resume") {
        if (child && state === "paused") {
          try {
            if (child.process.kill("SIGCONT") === false) throw new Error("resume failed");
            state = "speaking";
          } catch {
            return failure("NARRATION_CONTROL_FAILED", "local narration could not resume");
          }
        }
        return envelope(snapshot());
      }

      const text = boundedText(params.text);
      const wordsPerMinute = ALLOWED_RATES.get(Number(params.rate));
      if (!text || !wordsPerMinute) {
        return failure("NARRATION_INVALID_INPUT", "narration text or rate is invalid");
      }
      if (child && state === "error") {
        return failure("NARRATION_CONTROL_FAILED", "previous narration could not stop");
      }
      const request = ++sequence;
      starting = true;
      let next, active;
      try {
        if (!await stopActive()) {
          return failure("NARRATION_CONTROL_FAILED", "previous narration could not stop");
        }
        if (disposed) return failure("NARRATION_UNAVAILABLE", "local narration is unavailable");
        if (request !== sequence) return failure("NARRATION_CANCELLED", "local narration was cancelled");
        next = spawnImpl(executable, ["-v", voice, "-r", wordsPerMinute], {
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        });
        let resolve;
        active = { process: next, exited: false, closed: false,
          done: new Promise(done => { resolve = done; }) };
        child = active;
        state = "speaking";
        next.once("exit", () => {
          active.exited = true;
          if (child === active && state !== "error") state = "stopping";
        });
        next.once("close", (code, signal) => {
          active.closed = true;
          resolve();
          if (child !== active) return;
          child = null;
          if (!active.stopping) state = code === 0 || signal === "SIGTERM" ? "idle" : "error";
        });
        next.on("error", () => {
          if (child !== active || state === "stopping") return;
          state = "error";
        });
        next.stdin?.once?.("error", () => {
          if (child !== active) return;
          void stopActive().then(() => {
            if (!child || child === active) state = "error";
          });
          state = "error";
        });
        next.stdin.end(text);
      } catch {
        if (active && child === active) await stopActive();
        state = "error";
        return failure("NARRATION_START_FAILED", "local narration could not start");
      } finally { starting = false; }
      return envelope(snapshot());
    },
    async dispose() {
      disposed = true; sequence++;
      if (!await stopActive()) {
        throw Object.assign(Error("NARRATION_CONTROL_FAILED"), { code: "NARRATION_CONTROL_FAILED" });
      }
    },
  };
}
