// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { windowsPrivateDirectory, createWindowsPrivateFile, validateWindowsPrivatePath,
  WINDOWS_PRIVATE_ACL_POLICY } from "../../packages/dsh-desk-ui/lib/windows-private-state.js";
import { assertWindowsPrivateEntries } from "../../packages/dsh-desk-ui/lib/windows-private-inspection.js";
import { invalidWindowsPrivateState as invalid } from "../runtime/windows-private-files.mjs";

const existsError = () => Object.assign(Error("EEXIST"), { code: "EEXIST" });
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;

const PREPARE_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Import-Module ([System.IO.Path]::Combine($PSHOME,
    'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $systemFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  ${WINDOWS_PRIVATE_ACL_POLICY}
  function Exists($name) {
    try { $null = [System.IO.File]::GetAttributes($name); return $true }
    catch [System.IO.FileNotFoundException] { return $false }
    catch [System.IO.DirectoryNotFoundException] { return $false }
  }
  function Inspect($name, $private) {
    $attributes = [System.IO.File]::GetAttributes($name)
    if (($attributes -band 1024) -ne 0 -or ($attributes -band 16) -eq 0) { throw 'TYPE' }
    $acl = [System.IO.Directory]::GetAccessControl($name)
    InspectAcl $name $private $true $acl $systemFolder
  }
  $parents = [System.Collections.Generic.List[string]]::new()
  $parent = [System.IO.Path]::GetDirectoryName($request.path)
  while ($parent) { $parents.Add($parent); $parent = [System.IO.Path]::GetDirectoryName($parent) }
  for ($i = $parents.Count - 1; $i -gt 0; $i--) { Inspect $parents[$i] $false }
  Inspect $parents[0] $true
  if (Exists $request.path) {
    Inspect $request.path $true
    @{ error = 'EEXIST' } | ConvertTo-Json -Compress
    exit 0
  }
  if (Exists $request.staging) { throw 'STAGING_EXISTS' }
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($identity in $trusted) {
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new($identity), 'FullControl',
      'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VariableOsPrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct Attributes {
    public int Length;
    public IntPtr Descriptor;
    public int InheritHandle;
  }
  [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode,
    ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool Create(string name, ref Attributes attributes);
  public static int CreateExclusive(string name, byte[] descriptor) {
    GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      Attributes attributes = new Attributes {
        Length = Marshal.SizeOf(typeof(Attributes)),
        Descriptor = pinned.AddrOfPinnedObject(), InheritHandle = 0
      };
      if (Create(name, ref attributes)) return 0;
      return Marshal.GetLastWin32Error();
    } finally { pinned.Free(); }
  }
}
'@
  $code = [VariableOsPrivateDirectory]::CreateExclusive(
    ('\\?\' + $request.staging), $security.GetSecurityDescriptorBinaryForm())
  if ($code -ne 0) { throw 'STAGING_CREATE_FAILED' }
  Inspect $request.staging $true
  @{ created = $true } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('WINDOWS_PRIVATE_STATE_INVALID'); exit 1 }
`;

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function preparePrivateDirectory(lock, staging) {
  if (process.platform !== "win32") invalid();
  lock = validateWindowsPrivatePath(lock);
  staging = validateWindowsPrivatePath(staging);
  if (path.dirname(lock) !== path.dirname(staging) ||
    !/^\.write-lock-\d+-[a-f0-9]{24}$/.test(path.basename(staging)) || lock === staging) invalid();
  const systemRoot = validateWindowsPrivatePath(process.env.SystemRoot);
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(PREPARE_DIRECTORY_SCRIPT, "utf16le").toString("base64")], {
    input: JSON.stringify({ path: lock, staging, operation: "prepare-directory" }),
    encoding: "utf8", timeout: 15000, maxBuffer: 8192, windowsHide: true,
  });
  if (result.error || result.status !== 0) invalid();
  let value;
  try { value = JSON.parse(result.stdout.replace(/^\uFEFF/, "")); } catch { invalid(); }
  if (!value || Object.keys(value).length !== 1) invalid();
  if (value.error === "EEXIST") throw existsError();
  if (value.created !== true) invalid();
}

export function inspectPrivateLedger(root) {
  if (!stat(root)?.isDirectory()) invalid();
  const entries = [{ file: root, directory: true }];
  for (const name of ["events.jsonl", "source_items.jsonl"]) {
    const file = path.join(root, name), value = stat(file);
    if (value) entries.push({ file, directory: false });
  }
  assertWindowsPrivateEntries(entries);
}

export async function openPrivateLedgerFile(file, {
  append = false, lock = null, lockIdentity = null, inspectionSession = null,
} = {}) {
  if (lock && !lockIdentity) invalid();
  if (inspectionSession && (!lock || !lockIdentity)) invalid();
  if (inspectionSession) inspectionSession.assertUsable();
  const entries = [{ file: path.dirname(file), directory: true }];
  if (lock) entries.push({ file: lock, directory: true });
  const before = stat(file);
  if (!before) {
    if (!append) {
      if (inspectionSession) await inspectionSession.inspect(entries);
      else assertWindowsPrivateEntries(entries);
      return null;
    }
    if (lock) assertPrivateLock(lock, lockIdentity);
    createWindowsPrivateFile(file);
  } else if (!before.isFile() || before.nlink !== 1) invalid();
  const flags = (append ? fs.constants.O_WRONLY | fs.constants.O_APPEND : fs.constants.O_RDONLY)
    | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let handle;
  try { handle = await fsp.open(file, flags); }
  catch (error) {
    if (!append && error.code === "ENOENT") {
      if (inspectionSession) await inspectionSession.inspect(entries);
      else assertWindowsPrivateEntries(entries);
      return null;
    }
    throw error;
  }
  try {
    const all = [...entries, { file, directory: false }];
    const inspected = inspectionSession ? await inspectionSession.inspect(all) : assertWindowsPrivateEntries(all);
    if (lock && !same(inspected[1], lockIdentity) ||
      !same(inspected.at(-1), await handle.stat({ bigint: true }))) invalid();
    return handle;
  } catch (error) {
    try { await handle.close(); } catch { /* Preserve the primary inspection failure. */ }
    throw error;
  }
}

export async function readPrivateLedgerStreams(root, { lock, lockIdentity, inspectionSession = null } = {}) {
  if (!lock || !lockIdentity) invalid();
  if (inspectionSession) inspectionSession.assertUsable();
  const entries = [{ file: root, directory: true }, { file: lock, directory: true }];
  const opened = [], streams = { events: Buffer.alloc(0), sourceItems: Buffer.alloc(0) };
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let failed = false;
  try {
    for (const [key, name] of [["events", "events.jsonl"], ["sourceItems", "source_items.jsonl"]]) {
      const file = path.join(root, name), before = stat(file);
      if (!before) continue;
      if (!before.isFile() || before.nlink !== 1) invalid();
      let handle;
      try { handle = await fsp.open(file, flags); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      opened.push({ key, handle, index: entries.length });
      entries.push({ file, directory: false });
    }
    // Validate both handles and the owned lock before reading either stream.
    // Missing files still require a fresh parent/lock check.
    const inspected = inspectionSession ? await inspectionSession.inspect(entries) : assertWindowsPrivateEntries(entries);
    if (!same(inspected[1], lockIdentity)) invalid();
    for (const { handle, index } of opened) {
      if (!same(inspected[index], await handle.stat({ bigint: true }))) invalid();
    }
    for (const { key, handle } of opened) streams[key] = await handle.readFile();
    return streams;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const closed = await Promise.allSettled(opened.map(async ({ handle }) => handle.close()));
    const closeFailure = closed.find(result => result.status === "rejected");
    if (!failed && closeFailure) throw closeFailure.reason;
  }
}

export function assertPrivateLock(lock, identity) {
  if (!identity || !windowsPrivateDirectory(lock)) invalid();
  const current = fs.lstatSync(lock, { bigint: true });
  if (!current.isDirectory() || !same(current, identity)) invalid();
}

export function createPrivateDirectoryExclusive(lock) {
  const parent = path.dirname(lock);
  const staging = path.join(parent, `.write-lock-${process.pid}-${randomBytes(12).toString("hex")}`);
  // Failed or ambiguous preparation leaves any staging state untouched.
  preparePrivateDirectory(lock, staging);
  const identity = fs.lstatSync(staging, { bigint: true });
  try {
    // Native Windows rename refuses an existing directory, even an empty one.
    // Preparation alone does not acquire the lock.
    try { fs.renameSync(staging, lock); }
    catch (error) {
      if (windowsPrivateDirectory(lock)) throw existsError();
      throw error;
    }
    assertPrivateLock(lock, identity);
    return identity;
  } finally {
    if (stat(staging)) {
      if (!same(fs.lstatSync(staging, { bigint: true }), identity)) invalid();
      fs.rmdirSync(staging);
    }
  }
}

export function releasePrivateLock(lock, identity) {
  assertPrivateLock(lock, identity);
  // Unknown contents, including a newly placed authority marker, are retained.
  fs.rmdirSync(lock);
}
