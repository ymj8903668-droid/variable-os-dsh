// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isCliEntrypoint(moduleUrl, argument = process.argv[1]) {
  if (!argument) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argument); }
  catch { return false; }
}
