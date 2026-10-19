// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { runWindowsPrivateCommand } from "./windows-private-command.js";

const fail = () => { throw Object.assign(Error("WINDOWS_PRIVATE_STATE_INVALID"), { code: "WINDOWS_PRIVATE_STATE_INVALID" }); };

export function validateWindowsPrivatePath(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^[a-z]:[\\/]/i.test(value)) fail();
  const parts = value.slice(3).split(/[\\/]/);
  if (!parts.length || parts.length > 64 || parts.some(part => !part || /[<>:"|?*\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail();
  return path.win32.normalize(value);
}

// Shared verbatim with native descriptor tests, not a second policy implementation.
export const WINDOWS_PRIVATE_ACL_POLICY = String.raw`
  function InspectAcl($name, $private, $directory, $acl, $systemFolder) {
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $systemOwner = $false
    if (-not $private -and $directory -and $systemFolder -match '^[a-z]:[\\/]' -and
      $owner -eq 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') {
      $systemOwner = [String]::Equals($name, [System.IO.Path]::GetPathRoot($systemFolder),
        [StringComparison]::OrdinalIgnoreCase)
    }
    if (($private -and $owner -ne $sid.Value) -or
      (-not $private -and $trusted -notcontains $owner -and -not $systemOwner)) { throw 'OWNER' }
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'NULL_DACL' }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        @('AccessAllowed', 'AccessDenied') -notcontains $ace.AceQualifier.ToString()) { throw 'ACE' }
    }
    $self = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if (-not $private -and ($rule.PropagationFlags -band 2) -ne 0) { continue }
      if ($rule.AccessControlType -eq 'Allow') {
        $identity = $rule.IdentityReference.Value
        if ($identity -eq $sid.Value) { $self = $true }
        # Ancestors may permit child creation, but not replacing/deleting
        # existing children, changing their own ACL/owner or generic writes.
        if ($trusted -notcontains $identity -and ($private -or
          ([long]$rule.FileSystemRights -band 0x500D0150) -ne 0)) { throw 'ACCESS' }
      }
    }
    if ($private -and -not $self) { throw 'NO_SELF' }
  }
`;

// Only fixed code is executed. Paths are JSON data on stdin, never shell text.
// New objects receive their DACL at creation; existing ACLs are never repaired.
const SCRIPT = String.raw`
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $systemFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  ${WINDOWS_PRIVATE_ACL_POLICY}
  function Inspect($name, $private, $directory) {
    $attributes = [System.IO.File]::GetAttributes($name)
    if (($attributes -band 1024) -ne 0 -or (($attributes -band 16) -ne 0) -ne $directory) { throw 'TYPE' }
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($name) } else {
      [System.IO.File]::GetAccessControl($name)
    }
    InspectAcl $name $private $directory $acl $systemFolder
  }
  function Security($directory) {
    $acl = if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else {
      [System.Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in $trusted) {
      $principal = [System.Security.Principal.SecurityIdentifier]::new($identity)
      $inherit = if ($directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    return $acl
  }
  $parents = [System.Collections.Generic.List[string]]::new()
  $parent = [System.IO.Path]::GetDirectoryName($request.path)
  while ($parent) { $parents.Add($parent); $parent = [System.IO.Path]::GetDirectoryName($parent) }
  for ($i = $parents.Count - 1; $i -ge 0; $i--) { Inspect $parents[$i] $false $true }
  $directory = $request.operation -eq 'directory'
  $exists = $true
  try { $null = [System.IO.File]::GetAttributes($request.path) }
  catch [System.IO.FileNotFoundException] { $exists = $false }
  catch [System.IO.DirectoryNotFoundException] { $exists = $false }
  if ($request.operation -eq 'create-file') {
    Inspect $parents[0] $true $true
    try {
      $stream = [System.IO.FileStream]::new($request.path, 'CreateNew', 'Write', 'None', 4096, 'None', (Security $false))
    } catch {
      $cause = $_.Exception
      while ($cause.InnerException) { $cause = $cause.InnerException }
      if ($cause -is [System.IO.IOException] -and @(80, 183) -contains ($cause.HResult -band 0xFFFF)) {
        return @{ error = 'EEXIST' }
      }
      throw
    }
    $stream.Dispose()
    $exists = $true
  } elseif (-not $exists -and $directory -and $request.create) {
    $null = [System.IO.Directory]::CreateDirectory($request.path, (Security $true))
    $exists = $true
  }
  if ($exists) { Inspect $request.path $true $directory }
  elseif (-not $directory) { throw 'MISSING' }
  return @{ exists = $exists }
`;

function inspect(file, operation, create = false) {
  if (process.platform !== "win32") fail();
  file = validateWindowsPrivatePath(file);
  const systemRoot = process.env.SystemRoot;
  validateWindowsPrivatePath(systemRoot);
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const value = runWindowsPrivateCommand(executable, SCRIPT, { path: file, operation, create });
  if (operation === "create-file" && value?.error === "EEXIST" && Object.keys(value).length === 1) {
    throw Object.assign(Error("EEXIST"), { code: "EEXIST" });
  }
  if (!value || typeof value.exists !== "boolean" || Object.keys(value).length !== 1) fail();
  return value.exists;
}

export function windowsPrivateDirectory(directory, { create = false } = {}) {
  if (!inspect(directory, "directory", create)) return null;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) fail();
  return stat;
}

export function assertWindowsPrivateFile(file, stat) {
  if (!stat.isFile() || stat.nlink !== 1) fail();
  inspect(file, "file");
  const after = fs.lstatSync(file);
  if (!after.isFile() || after.nlink !== 1 || stat.dev !== after.dev || stat.ino !== after.ino) fail();
}

export function createWindowsPrivateFile(file) {
  inspect(file, "create-file");
}
