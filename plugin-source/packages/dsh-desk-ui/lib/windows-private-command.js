// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { Worker } from "node:worker_threads";

const invalid = () => { throw Object.assign(Error("WINDOWS_PRIVATE_STATE_INVALID"), { code: "WINDOWS_PRIVATE_STATE_INVALID" }); };
const sessions = new Map();

// The worker owns asynchronous pipes while the caller keeps the existing
// synchronous private-file API. Only fixed executable code is reused: every
// request executes the native ACL policy again, including identity and parents.
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
let child, pending, output = Buffer.alloc(0), seq = 0, closed = false, idle, stderrBytes = 0;
function finish(ok, value) {
  if (!pending) return;
  const { shared, timer } = pending; pending = null; clearTimeout(timer);
  const header = new Int32Array(shared, 0, 2);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > shared.byteLength - 8) ok = false;
  if (ok) new Uint8Array(shared, 8).set(bytes);
  Atomics.store(header, 1, ok ? bytes.length : 0);
  Atomics.store(header, 0, ok ? 1 : 2);
  Atomics.notify(header, 0);
}
function stop() {
  if (closed) return;
  closed = true; Atomics.store(new Int32Array(workerData.life), 0, 1);
  clearTimeout(idle); finish(false, null);
  if (child) { try { child.kill(); } catch {} }
  parentPort.close();
}
function start() {
  child = spawn(workerData.executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(workerData.script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  child.on('error', stop); child.on('exit', stop);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', stop);
  // Windows PowerShell can emit a default-drive initialization warning before
  // our fixed script runs under a restricted token. It carries no authority:
  // accept only the matching explicit reply after all native checks succeed.
  // Never forward diagnostics or allow an unbounded stderr stream.
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) stop(); });
  child.stdout.on('data', chunk => {
    if (!pending || output.length + chunk.length > 8192) return stop();
    output = Buffer.concat([output, chunk]);
    const newline = output.indexOf(10);
    if (newline < 0) return;
    if (newline !== output.length - 1) return stop();
    let value;
    try { value = JSON.parse(output.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return stop(); }
    if (!value || Object.keys(value).length !== 2 || value.seq !== seq ||
      !Object.hasOwn(value, 'value')) return stop();
    output = Buffer.alloc(0); finish(true, value.value);
    idle = setTimeout(stop, 60000);
  });
}
parentPort.on('message', message => {
  if (message.close) return stop();
  if (closed || pending) return stop();
  clearTimeout(idle);
  pending = { shared: message.shared, timer: setTimeout(stop, 14000) };
  if (!child) start();
  if (closed) return;
  const line = JSON.stringify({ seq: ++seq, value: message.value }) + '\n';
  if (Buffer.byteLength(line) > 1048576) return stop();
  child.stdin.write(line, error => { if (error) stop(); });
});
parentPort.on('close', stop);
`;

export function runWindowsPrivateCommand(executable, body, value) {
  if (process.platform !== "win32") invalid();
  const key = `${executable}\n${body}`;
  let session = sessions.get(key);
  if (!session || !session.alive || Atomics.load(new Int32Array(session.life), 0) !== 0) {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Import-Module ([System.IO.Path]::Combine($PSHOME,
    'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  function InvokePrivateRequest($request) {
    ${body}
  }
  $expected = 1
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Length -gt 1048576) { throw 'LIMIT' }
    $request = $line | ConvertFrom-Json
    if (@($request.PSObject.Properties).Count -ne 2 -or $request.seq -ne $expected) { throw 'SEQUENCE' }
    $value = InvokePrivateRequest $request.value
    [Console]::Out.WriteLine((@{ seq = $expected; value = $value } | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
    $expected++
  }
} catch { [Console]::Error.WriteLine('WINDOWS_PRIVATE_STATE_INVALID'); exit 1 }
`;
    const life = new SharedArrayBuffer(4);
    const worker = new Worker(WORKER, { eval: true, execArgv: [], workerData: { executable, script, life } });
    session = { worker, alive: true, life };
    const current = session;
    const ended = () => { current.alive = false; if (sessions.get(key) === current) sessions.delete(key); };
    worker.on("error", ended); worker.on("exit", ended); worker.unref();
    sessions.set(key, session);
  }
  const shared = new SharedArrayBuffer(8192), header = new Int32Array(shared, 0, 2);
  try {
    session.worker.postMessage({ shared, value });
    Atomics.wait(header, 0, 0, 15000);
    if (Atomics.load(header, 0) !== 1) invalid();
    const size = Atomics.load(header, 1);
    if (size < 1 || size > shared.byteLength - 8) invalid();
    return JSON.parse(Buffer.from(shared, 8, size).toString("utf8"));
  } catch {
    session.alive = false; sessions.delete(key);
    session.worker.postMessage({ close: true });
    invalid();
  }
}
