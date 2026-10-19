// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const PUBLIC_PLUGIN_HOST_PEERS = Object.freeze({
  "@deepseek-ai/cordis": "4.0.5-alpha.1",
  "@deepseek-ai/dsh-agent": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-agent-loop": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-credentials": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-home-paths": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-hmr": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-llm": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-llm-deepseek": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-llm-pi-ai": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-scope": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-session": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-session-projection": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-session-persistence": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-settings": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-system-prompt": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-tools": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-tool-web": "0.2.1-alpha.2",
  "@deepseek-ai/dsh-user-approval": "0.2.1-alpha.2",
  "@earendil-works/pi-ai": "1.1.0",
  "zod": "4.6.5",
});

// DSH's native profile preparation supplies these peers from its installation.
// Inspect the first package in Node's search order, never skip an incompatible
// nearer package to find a compatible fallback.
export function assertPublicPluginRuntime(anchor = import.meta.url, packages) {
  try {
    if (packages !== undefined && typeof packages?.packageOf !== "function") throw Error("RESOLVER_MISSING");
    const require = createRequire(anchor);
    for (const [name, version] of Object.entries(PUBLIC_PLUGIN_HOST_PEERS)) {
      let installed;
      for (const base of require.resolve.paths(name) ?? []) {
        const directory = path.join(base, name);
        try { fs.statSync(directory); }
        catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        installed = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
        break;
      }
      // Preserve fail-closed handling of a nearer physical shadow even when the
      // Host's runtime resolver would select its own installation package.
      if (installed && (installed.name !== name || installed.version !== version)) throw Error("VERSION_MISMATCH");
      if (packages) {
        const selected = packages.packageOf(name, String(anchor));
        if (!selected || !path.isAbsolute(selected.dir)) throw Error("RESOLUTION_MISSING");
        // Read again rather than accepting cached display metadata after a change.
        installed = JSON.parse(fs.readFileSync(path.join(selected.dir, "package.json"), "utf8"));
      }
      if (installed?.name !== name || installed.version !== version) throw Error("VERSION_MISMATCH");
    }
  } catch {
    throw Object.assign(Error("PUBLIC_PLUGIN_RUNTIME_INCOMPATIBLE"), { code: "PUBLIC_PLUGIN_RUNTIME_INCOMPATIBLE" });
  }
}
