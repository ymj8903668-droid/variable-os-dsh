// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";

export const EXPECTED_DSH_VERSION = "0.2.1-alpha.2";
export const EXPECTED_PNPM_VERSION = "11.25.0";
export const DEFAULT_DSH_PORT = 3080;

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function findExecutable(name, env = process.env) {
  for (const folder of String(env.PATH || "").split(path.delimiter)) {
    if (!folder) continue;
    const candidate = path.join(folder, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

export function validateToolchain({
  nodeVersion = process.versions.node,
  env = process.env,
} = {}) {
  if (!nodeVersion) {
    throw contractError("NODE_MISSING", "Node.js 24 is required");
  }
  const major = Number(String(nodeVersion).split(".")[0]);
  if (major !== 24) {
    throw contractError(
      "NODE_VERSION_UNSUPPORTED",
      `Node.js 24 is required; found ${nodeVersion}`,
    );
  }
  const corepack = findExecutable("corepack", env);
  const pnpm = findExecutable("pnpm", env);
  const dsh = findExecutable("dsh", env);
  if (!pnpm) {
    throw contractError(
      "PNPM_MISSING",
      `pnpm ${EXPECTED_PNPM_VERSION} is required in PATH`,
    );
  }
  if (!dsh) {
    throw contractError(
      "DSH_MISSING",
      `dsh ${EXPECTED_DSH_VERSION} is required in PATH`,
    );
  }
  // The frozen workspace and script-disabled profile policy use this pnpm.
  const packageManagerVersion = spawnSync(pnpm, ["--version"], {
    encoding: "utf8", env, timeout: 10_000, maxBuffer: 16_384,
  });
  if (packageManagerVersion.error || packageManagerVersion.status !== 0) {
    throw contractError("PNPM_VERSION_FAILED", "could not read pnpm version");
  }
  const pnpmVersion = String(packageManagerVersion.stdout || "").trim();
  if (pnpmVersion !== EXPECTED_PNPM_VERSION) {
    throw contractError(
      "PNPM_VERSION_MISMATCH",
      `pnpm ${EXPECTED_PNPM_VERSION} is required for the reviewed build policy`,
    );
  }
  const version = spawnSync(dsh, ["--version"], { encoding: "utf8", env });
  if (version.status !== 0) {
    throw contractError("DSH_VERSION_FAILED", "could not read dsh version");
  }
  const actual = String(version.stdout || version.stderr || "").trim();
  if (actual !== EXPECTED_DSH_VERSION) {
    throw contractError(
      "DSH_VERSION_MISMATCH",
      `dsh ${EXPECTED_DSH_VERSION} is pinned; found ${actual || "unknown"}`,
    );
  }
  return { corepack, pnpm, dsh, nodeVersion, pnpmVersion, dshVersion: actual };
}

export function validateSourceRoot(sourceRoot) {
  const resolved = path.resolve(sourceRoot || "");
  const required = [
    "packages/dsh-tools/package.json",
    "packages/dsh-desk-ui/package.json",
    "scripts/install-dsh-desk.sh",
    "scripts/boot-variable-desk.sh",
    "scripts/dsh-profile-sync.mjs",
  ];
  const missing = required.filter((entry) => !fs.existsSync(path.join(resolved, entry)));
  if (missing.length) {
    throw contractError(
      "SOURCE_ROOT_INVALID",
      `Variable OS source root is invalid; missing ${missing.join(", ")}`,
    );
  }
  return resolved;
}

function countId(config, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...String(config).matchAll(new RegExp(`^\\s*- id:\\s*['\"]?${escaped}['\"]?\\s*$`, "gm"))].length;
}

export function validateDumpConfig(config) {
  const required = ["webserver", "modules", "tool-variable-os", "variable-os-desk-ui"];
  for (const id of required) {
    const count = countId(config, id);
    if (count !== 1) {
      throw contractError(
        "DUMP_CONFIG_CONTRACT_FAILED",
        `dump-config requires exactly one ${id} entry; found ${count}`,
      );
    }
  }
  return true;
}

export function dumpAndValidate({ dsh, env = process.env, profile = "variable-desk" }) {
  const result = spawnSync(dsh, ["--profile", profile, "--dump-config"], {
    encoding: "utf8",
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw contractError(
      "DUMP_CONFIG_FAILED",
      String(result.stderr || result.stdout || "dsh --dump-config failed").trim(),
    );
  }
  validateDumpConfig(result.stdout);
  return result.stdout;
}

export async function assertPortAvailable(port = DEFAULT_DSH_PORT, host = "127.0.0.1") {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw contractError(
      "PORT_INVALID",
      `port must be an integer between 1 and 65535; found ${String(port)}`,
    );
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      reject(
        contractError(
          "PORT_IN_USE",
          `${host}:${port} is unavailable (${error.code || error.message})`,
        ),
      );
    });
    server.listen(port, host, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

function parseArgs(argv) {
  const options = { mode: "boot", sourceRoot: null, port: DEFAULT_DSH_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "install" || arg === "boot" || arg === "dump" || arg === "port-check") options.mode = arg;
    else if (arg === "--source-root") options.sourceRoot = argv[++index];
    else if (arg === "--port") options.port = Number(argv[++index]);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Safe before profile repair: do not inspect or execute the installed DSH.
  if (options.mode === "port-check") {
    await assertPortAvailable(options.port);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: options.mode, port: options.port })}\n`);
    return;
  }
  const sourceRoot = validateSourceRoot(
    options.sourceRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  );
  const tools = validateToolchain();
  if (options.mode === "boot") await assertPortAvailable(options.port);
  if (options.mode === "boot" || options.mode === "dump") {
    dumpAndValidate({ dsh: tools.dsh });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, mode: options.mode, sourceRoot, port: options.port, node: tools.nodeVersion, pnpm: tools.pnpmVersion, dsh: tools.dshVersion })}\n`,
  );
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "") ? error.code : "PREFLIGHT_FAILED";
    process.stderr.write(process.env.VARIABLE_OS_DESK_REQUIRE_POSTGRES === "1"
      ? `${code}\n` : `${code}: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
