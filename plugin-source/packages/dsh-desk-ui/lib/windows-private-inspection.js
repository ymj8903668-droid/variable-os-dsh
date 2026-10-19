// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { runWindowsPrivateCommand } from "./windows-private-command.js";
import { validateWindowsPrivatePath, WINDOWS_PRIVATE_ACL_POLICY } from "./windows-private-state.js";

const invalid = () => { throw Object.assign(Error("WINDOWS_PRIVATE_STATE_INVALID"), { code: "WINDOWS_PRIVATE_STATE_INVALID" }); };
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const valid = (stat, directory) => !stat.isSymbolicLink() &&
  (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n);
export const WINDOWS_PRIVATE_INSPECTION_FUNCTIONS = String.raw`
  ${WINDOWS_PRIVATE_ACL_POLICY}
  function Inspect($name, $private, $directory) {
    $attributes = [System.IO.File]::GetAttributes($name)
    if (($attributes -band 1024) -ne 0 -or (($attributes -band 16) -ne 0) -ne $directory) { throw 'TYPE' }
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($name) } else {
      [System.IO.File]::GetAccessControl($name)
    }
    InspectAcl $name $private $directory $acl $systemFolder
  }
`;
const SCRIPT = String.raw`
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $systemFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
  ${WINDOWS_PRIVATE_INSPECTION_FUNCTIONS}
  foreach ($entry in $request.entries) {
    $parents = [System.Collections.Generic.List[string]]::new()
    $parent = [System.IO.Path]::GetDirectoryName($entry.file)
    while ($parent) { $parents.Add($parent); $parent = [System.IO.Path]::GetDirectoryName($parent) }
    for ($i = $parents.Count - 1; $i -ge 0; $i--) { Inspect $parents[$i] $false $true }
    Inspect $entry.file $true $entry.directory
  }
  return 'OK'
`;

// Read-only batching, not an authorization cache. Every entry and ancestor is
// inspected anew; before/after identities also bind any caller's open handle.
export function assertWindowsPrivateEntries(entries) {
  if (process.platform !== "win32" || !Array.isArray(entries)) invalid();
  const systemRoot = validateWindowsPrivatePath(process.env.SystemRoot);
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const results = [];
  try {
    for (let offset = 0; offset < entries.length; offset += 128) {
      const batch = entries.slice(offset, offset + 128).map(entry => {
        if (!entry || typeof entry.directory !== "boolean") invalid();
        const file = validateWindowsPrivatePath(entry.file), stat = fs.lstatSync(file, { bigint: true });
        if (!valid(stat, entry.directory)) invalid();
        return { file, directory: entry.directory, stat };
      });
      const result = runWindowsPrivateCommand(executable, SCRIPT, {
        entries: batch.map(({ file, directory }) => ({ file, directory })),
      });
      if (result !== "OK") invalid();
      for (const entry of batch) {
        const after = fs.lstatSync(entry.file, { bigint: true });
        if (!valid(after, entry.directory) || !same(entry.stat, after)) invalid();
        results.push(after);
      }
    }
    return results;
  } catch { invalid(); }
}
