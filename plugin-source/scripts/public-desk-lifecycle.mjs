// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const fail = code => { throw Object.assign(new Error(code), { code }); };

export function privateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) { if (error.code !== "EEXIST") fail("PUBLIC_STATE_UNSAFE"); }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("PUBLIC_STATE_UNSAFE");
}

export function writePatch(plan) {
  const patch = [
    { id: "settings", config: { path: path.join(plan.env.DSH_HOME, "settings.yaml") } },
    { id: "credentials", config: { path: path.join(plan.env.DSH_HOME, "credentials.yaml") } },
    { id: "workspace-controller", config: { documentsDirectory: plan.cwd } },
    { id: "session-title-llm", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
  ];
  const file = path.join(plan.root, "public.patch.json");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("PUBLIC_STATE_UNSAFE");
    fs.ftruncateSync(fd);
    fs.writeFileSync(fd, JSON.stringify(patch) + "\n");
  } catch { fail("PUBLIC_STATE_UNSAFE"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return file;
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function privateRoot(root) {
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { if (error.code === "ENOENT") return null; fail("PUBLIC_STATE_UNSAFE"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("PUBLIC_STATE_UNSAFE");
  return stat;
}

function readControl(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      // Normal completion may unlink after open. Reopen the path instead of
      // treating the now-unlinked descriptor as either live or unsafe evidence.
      if (stat.nlink === 0) continue;
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 256
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("PUBLIC_STATE_UNSAFE");
      const buffer = Buffer.alloc(257), size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > 256) fail("PUBLIC_STATE_UNSAFE");
      return { stat, body: buffer.subarray(0, size).toString("utf8") };
    } catch (error) { if (error.code === "ENOENT") return null; fail("PUBLIC_STATE_UNSAFE"); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  fail("PUBLIC_RECOVERY_REQUIRED");
}

function removeControl(file, held) {
  const current = readControl(file);
  if (current && sameFile(current.stat, held)) {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function launchInstance(body) {
  let record;
  try { record = JSON.parse(body); } catch { fail("PUBLIC_RECOVERY_REQUIRED"); }
  if (record?.version !== 1 || typeof record.instance !== "string" || !/^[a-f0-9]{32}$/.test(record.instance)
    || Object.keys(record).length !== 2) fail("PUBLIC_RECOVERY_REQUIRED");
  return record.instance;
}

async function readPublishedLaunch(file, root, directory) {
  const deadline = Date.now() + 1000;
  for (;;) {
    const currentRoot = privateRoot(root);
    if (!currentRoot || !sameFile(directory, currentRoot)) fail("PUBLIC_STATE_UNSAFE");
    const current = readControl(file);
    if (current?.body !== "") return current;
    // Exclusive creation precedes the tiny synchronous record write.
    // Empty startup windows get a bounded wait, never a fabricated identity.
    if (Date.now() >= deadline) fail("PUBLIC_RECOVERY_REQUIRED");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export function holdLaunchLock(root, onStop) {
  const file = path.join(root, "public-launch.lock");
  const instance = randomBytes(16).toString("hex");
  const requestFile = path.join(root, `public-stop-${instance}.request`);
  const directory = privateRoot(root);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { fail(error.code === "EEXIST" ? "PUBLIC_DESK_BUSY" : "PUBLIC_STATE_UNSAFE"); }
  const held = fs.fstatSync(fd);
  try { fs.writeFileSync(fd, JSON.stringify({ version: 1, instance }) + "\n"); }
  catch {
    try { removeControl(file, held); } finally { fs.closeSync(fd); }
    fail("PUBLIC_STATE_UNSAFE");
  }
  let accepted;
  const timer = setInterval(() => {
    try {
      const current = privateRoot(root);
      if (!current || !sameFile(directory, current)) return;
      const request = readControl(requestFile);
      if (request?.body === "") {
        accepted = request.stat;
        clearInterval(timer);
        onStop();
      }
    } catch { /* Unsafe requests never authorize shutdown. */ }
  }, 50);
  return (retain = false, finalRoot = root) => {
    clearInterval(timer);
    try {
      if (!retain) {
        const current = privateRoot(finalRoot);
        if (current && sameFile(directory, current)) {
          if (accepted) removeControl(path.join(finalRoot, path.basename(requestFile)), accepted);
          removeControl(path.join(finalRoot, path.basename(file)), held);
        }
      }
    } finally { fs.closeSync(fd); }
  };
}

export async function stopPublicDesk(root) {
  const directory = privateRoot(root);
  if (!directory) return "PUBLIC_DESK_NOT_RUNNING";
  const file = path.join(root, "public-launch.lock");
  const held = await readPublishedLaunch(file, root, directory);
  if (!held) return "PUBLIC_DESK_NOT_RUNNING";
  const instance = launchInstance(held.body);
  const requestFile = path.join(root, `public-stop-${instance}.request`);
  const deadline = Date.now() + 12_000;
  let request;
  for (;;) {
    const current = await readPublishedLaunch(file, root, directory);
    if (!current || !sameFile(current.stat, held.stat)) {
      if (current && launchInstance(current.body) === instance) fail("PUBLIC_RECOVERY_REQUIRED");
      if (request) removeControl(requestFile, request);
      return "PUBLIC_DESK_STOPPED";
    }
    if (current.body !== held.body) fail("PUBLIC_RECOVERY_REQUIRED");
    if (!request) {
      let fd;
      try {
        // An empty exclusive file is the complete request; concurrent callers
        // cannot observe a partially written message. Its name binds the launch.
        fd = fs.openSync(requestFile, fs.constants.O_WRONLY | fs.constants.O_CREAT
          | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        request = fs.fstatSync(fd);
      } catch (error) {
        if (error.code !== "EEXIST") fail("PUBLIC_STATE_UNSAFE");
        const existing = readControl(requestFile);
        if (existing && existing.body !== "") fail("PUBLIC_STATE_UNSAFE");
        request = existing?.stat;
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    if (Date.now() >= deadline) fail("PUBLIC_RECOVERY_REQUIRED");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export function cancelled(signal) {
  if (signal.aborted) throw Object.assign(new Error("PUBLIC_CANCELLED"), {
    code: "PUBLIC_CANCELLED", signal: signal.reason,
  });
}

export async function runChild(command, args, plan, signal, { capture = false, timeoutMs = 0, maxCaptureBytes = 16_384 } = {}) {
  cancelled(signal);
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1 || maxCaptureBytes > 1024 * 1024) fail("PUBLIC_CAPTURE_LIMIT_INVALID");
  // Keep a group-owning IPC peer alive while the command runs. It drains its
  // descendants itself on command completion or owner disconnect, so a dead
  // Host does not force its parent to signal an unowned numeric group.
  const child = fork(fileURLToPath(new URL("./plugin-command.mjs", import.meta.url)), ["--worker"], {
    execPath: process.execPath, execArgv: [], env: plan.env, cwd: plan.cwd, detached: true,
    stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit", "ipc"],
  });
  let failure, result, status = -1, exited = false, closed = false, stoppingAt, escalated = false;
  let stdout = "", stderr = "", capturedBytes = 0;
  const startedAt = Date.now();
  const alive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  };
  const kill = value => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Let the peer broadcast TERM once. Broadcasting here as well would send
    // a second TERM to descendants whose one-shot handler is still draining.
    try { if (child.pid) process.kill(value === "SIGTERM" ? child.pid : -child.pid, value); }
    catch (error) { if (error.code !== "ESRCH") failure ||= "PUBLIC_CHILD_SIGNAL_FAILED"; }
  };
  const abort = () => {
    if (stoppingAt !== undefined) return;
    stoppingAt = Date.now();
    kill("SIGTERM");
  };
  signal.addEventListener("abort", abort, { once: true });
  child.once("error", () => { failure = "PUBLIC_CHILD_START_FAILED"; exited = true; });
  child.once("exit", () => { exited = true; });
  child.once("close", () => { closed = true; });
  child.on("message", message => {
    if (message?.type !== "plugin-command-result" || !message.result
      || !(message.result.exitCode === null || Number.isInteger(message.result.exitCode))
      || !(message.result.signal === null || typeof message.result.signal === "string")) return;
    result = message.result; status = result.exitCode;
    if (result.spawnError) failure ||= "PUBLIC_CHILD_START_FAILED";
  });
  if (capture) {
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      stream.on("data", part => {
        capturedBytes += part.length;
        if (capturedBytes > maxCaptureBytes) { failure ||= "PUBLIC_PREFLIGHT_OUTPUT_LIMIT"; abort(); }
        else if (isError) stderr += part.toString("utf8");
        else stdout += part.toString("utf8");
      });
    }
  }
  child.send({ type: "plugin-command-start", command, args, graceful: true }, error => {
    if (error) { failure ||= "PUBLIC_CHILD_START_FAILED"; abort(); }
  });
  try {
    // A leader's exit/close does not prove its descendants have stopped.
    // Retain the lock until both streams and the owned process group drain.
    for (;;) {
      if (signal.aborted) abort();
      if (timeoutMs && Date.now() - startedAt >= timeoutMs) {
        failure ||= "PUBLIC_PREFLIGHT_TIMEOUT"; abort();
      }
      const groupAlive = alive();
      if (closed && !groupAlive) break;
      if (exited && groupAlive) abort();
      if (stoppingAt !== undefined) {
        if (!escalated && Date.now() - stoppingAt >= 8000) {
          escalated = true; kill("SIGKILL");
        }
        if (Date.now() - stoppingAt >= 10_000) {
          child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          throw Object.assign(new Error("PUBLIC_CHILDREN_REMAIN"), {
            code: "PUBLIC_CHILDREN_REMAIN", retainLock: true,
          });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { signal.removeEventListener("abort", abort); }
  cancelled(signal);
  if (!result) failure ||= "PUBLIC_CHILD_START_FAILED";
  if (failure) fail(failure);
  return { status, stdout, stderr };
}

export async function supervise({ entry, args, env, cwd, signal }) {
  if (signal) cancelled(signal);
  // This process owns no lock or Host. The private IPC peer owns both and
  // drains its groups even if the foreground terminal/launcher is killed.
  const child = fork(entry, args, {
    execPath: process.execPath, execArgv: [], env, cwd,
    detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => {
    if (child.connected) child.send({ type: "public-desk-stop", signal }, error => {
      if (error && child.connected) child.disconnect();
    });
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const abort = () => (handlers.get(signal.reason) ?? handlers.get("SIGTERM"))();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code));
    });
    if (status === null) fail("PUBLIC_SUPERVISOR_FAILED");
    return status;
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
