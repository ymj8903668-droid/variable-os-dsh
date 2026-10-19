// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { validateWindowsPrivatePath } from "./windows-private-state.js";
import { WINDOWS_PRIVATE_INSPECTION_FUNCTIONS } from "./windows-private-inspection.js";

const error = () => Object.assign(Error("WINDOWS_PRIVATE_STATE_INVALID"), { code: "WINDOWS_PRIVATE_STATE_INVALID" });
const invalid = () => { throw error(); };
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const valid = (stat, directory) => !stat.isSymbolicLink() &&
  (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n);
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Import-Module ([System.IO.Path]::Combine($PSHOME,
    'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  ${WINDOWS_PRIVATE_INSPECTION_FUNCTIONS}
  $expected = 1
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Length -gt 65536 -or $expected -gt 4096) { throw 'LIMIT' }
    $request = $line | ConvertFrom-Json
    if (@($request.PSObject.Properties).Count -ne 2 -or
      ($request.seq -isnot [int] -and $request.seq -isnot [long]) -or $request.seq -ne $expected -or
      $request.entries -isnot [array] -or $request.entries.Count -lt 2 -or
      $request.entries.Count -gt 4) { throw 'REQUEST' }
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $systemFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
    foreach ($entry in $request.entries) {
      if (@($entry.PSObject.Properties).Count -ne 2 -or $entry.file -isnot [string] -or
        $entry.directory -isnot [bool]) { throw 'ENTRY' }
      $parents = [System.Collections.Generic.List[string]]::new()
      $parent = [System.IO.Path]::GetDirectoryName($entry.file)
      while ($parent) { $parents.Add($parent); $parent = [System.IO.Path]::GetDirectoryName($parent) }
      for ($i = $parents.Count - 1; $i -ge 0; $i--) { Inspect $parents[$i] $false $true }
      Inspect $entry.file $true $entry.directory
    }
    [Console]::Out.WriteLine(('{"seq":' + $expected + ',"ok":true}'))
    [Console]::Out.Flush()
    $expected++
  }
} catch { [Console]::Error.WriteLine('WINDOWS_PRIVATE_STATE_INVALID'); exit 1 }
`;

/** A single writer lock owns this process. Only executable code is reused. */
export function createWindowsPrivateInspectionSession({ root, lock, lockIdentity }) {
  if (process.platform !== "win32") invalid();
  root = validateWindowsPrivatePath(root);
  lock = validateWindowsPrivatePath(lock);
  if (lock !== path.join(root, ".write-lock") || typeof lockIdentity?.dev !== "bigint" ||
    typeof lockIdentity?.ino !== "bigint") invalid();
  const executable = path.join(validateWindowsPrivatePath(process.env.SystemRoot),
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const allowed = new Map([[root, true], [lock, true],
    [path.join(root, "events.jsonl"), false], [path.join(root, "source_items.jsonl"), false]]);
  let child = null, closed = false, failed = false, closing = false, pending = null, sequence = 0;
  let output = Buffer.alloc(0), outputBytes = 0, closePromise, shutdownPromise;

  function assertUsable() {
    if (failed || closing || closed) invalid();
  }

  function poison() {
    failed = true;
    if (pending) {
      clearTimeout(pending.timer);
      const rejected = pending; pending = null;
      rejected.reject(error());
    }
    if (child && !closed) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }

  function start() {
    child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    closePromise = new Promise(resolve => child.once("close", (code, signal) => {
      closed = true;
      if (!closing || code !== 0 || signal || output.length || pending) poison();
      resolve();
    }));
    child.on("exit", (code, signal) => {
      // A later close() call cannot turn an already-unexpected exit into success.
      if (!closing || code !== 0 || signal || pending || output.length) poison();
    });
    child.on("error", poison);
    child.stdin.on("error", poison);
    child.stdout.on("error", poison);
    child.stderr.on("error", poison);
    child.stderr.on("data", poison);
    child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (failed || !pending || outputBytes > 1048576 || output.length + chunk.length > 8192) {
        poison(); return;
      }
      output = Buffer.concat([output, chunk]);
      const newline = output.indexOf(10);
      if (newline < 0) return;
      if (newline !== output.length - 1) { poison(); return; }
      let value;
      try { value = JSON.parse(output.toString("utf8")); } catch { poison(); return; }
      if (!value || Object.keys(value).length !== 2 || value.seq !== pending.seq || value.ok !== true) {
        poison(); return;
      }
      output = Buffer.alloc(0);
      const accepted = pending; pending = null;
      clearTimeout(accepted.timer);
      accepted.resolve();
    });
  }

  async function close() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      closing = true;
      if (pending) poison();
      if (child && !closed) {
        if (failed) poison();
        else child.stdin.end();
        let timer;
        try {
          await Promise.race([closePromise, new Promise((_, reject) => {
            timer = setTimeout(() => {
              poison();
              reject(Object.assign(Error("WINDOWS_PRIVATE_INSPECTION_CLOSE_UNCONFIRMED"),
                { code: "WINDOWS_PRIVATE_INSPECTION_CLOSE_UNCONFIRMED" }));
            }, 5000);
          })]);
        } finally { clearTimeout(timer); }
      }
      if (failed) invalid();
    })();
    return shutdownPromise;
  }

  async function inspect(entries) {
    try {
      assertUsable();
      if (pending || sequence >= 4096 ||
        !Array.isArray(entries) || entries.length < 2 || entries.length > 4) invalid();
      const seen = new Set();
      const before = entries.map(entry => {
        const file = validateWindowsPrivatePath(entry?.file);
        if (typeof entry.directory !== "boolean" || allowed.get(file) !== entry.directory || seen.has(file)) invalid();
        seen.add(file);
        const stat = fs.lstatSync(file, { bigint: true });
        if (!valid(stat, entry.directory) || file === lock && !same(stat, lockIdentity)) invalid();
        return { file, directory: entry.directory, stat };
      });
      if (before[0].file !== root || before[1].file !== lock) invalid();
      const seq = ++sequence;
      const request = JSON.stringify({ seq, entries: before.map(({ file, directory }) => ({ file, directory })) }) + "\n";
      if (Buffer.byteLength(request) > 65536) invalid();
      if (!child) start();
      await new Promise((resolve, reject) => {
        pending = { seq, resolve, reject, timer: setTimeout(poison, 15000) };
        child.stdin.write(request, writeError => { if (writeError) poison(); });
      });
      assertUsable();
      return before.map(entry => {
        const after = fs.lstatSync(entry.file, { bigint: true });
        if (!valid(after, entry.directory) || !same(entry.stat, after) ||
          entry.file === lock && !same(after, lockIdentity)) invalid();
        return after;
      });
    } catch {
      const firstFailure = error();
      poison();
      try { await close(); }
      catch (closeError) {
        if (closeError?.code === "WINDOWS_PRIVATE_INSPECTION_CLOSE_UNCONFIRMED") {
          firstFailure.closeFailureCode = closeError.code;
        }
      }
      throw firstFailure;
    }
  }
  return Object.freeze({ assertUsable, inspect, close, get closed() { return !child || closed; } });
}
