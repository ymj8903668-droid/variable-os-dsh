// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

// A standalone companion installs its own frozen toolchain. In a development
// checkout, keep the existing per-package tool installation usable as well.
export function resolvePluginBuildTool(name, sourceRoot = new URL("../", import.meta.url)) {
  const root = typeof sourceRoot === "string" ? pathToFileURL(path.resolve(sourceRoot) + path.sep) : sourceRoot;
  const isolated = new URL("scripts/plugin-source-build-deps/", root);
  const manifest = existsSync(new URL("node_modules", isolated))
    ? new URL("package.json", isolated)
    : new URL(name === "esbuild" ? "packages/dsh-desk-ui/package.json"
      : "packages/evidence-provider/package.json", root);
  return createRequire(manifest).resolve(name);
}
const { build, transform } = createRequire(import.meta.url)(resolvePluginBuildTool("esbuild"));
export { build, transform };
