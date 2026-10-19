// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const assets = [
  "src/runtime/harness-research-host-duplex-provider.mjs",
  "src/runtime/harness-research-host-duplex-provider-child.mjs",
  "packages/dsh-desk-ui/lib/duplex-audio-worklet.js",
];
const providerOptions = new Set([
  "apiKey", "instructions", "tools", "onEvent", "startupTimeoutMs", "closeTimeoutMs",
]);
const fail = code => Object.assign(Error(code), { code });

async function installedFiles(appRoot) {
  const rootStat = await lstat(appRoot);
  if (!rootStat.isDirectory() || rootStat.mode & 0o022) throw fail("DUPLEX_RUNTIME_UNAVAILABLE");
  const root = await realpath(appRoot), files = [];
  for (const asset of assets) {
    const parts = asset.split("/");
    let file = root;
    for (const [index, part] of parts.entries()) {
      file = path.join(file, part);
      const stat = await lstat(file);
      if (stat.mode & 0o022 || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw fail("DUPLEX_RUNTIME_UNAVAILABLE");
      }
    }
    if (await realpath(file) !== file) throw fail("DUPLEX_RUNTIME_UNAVAILABLE");
    files.push(file);
  }
  return files;
}

/** Host-only installed assets; loading neither resolves a key nor starts voice. */
export async function loadPersonalVoiceRuntime({ appRoot } = {}) {
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) return null;
  appRoot = path.resolve(appRoot);
  try {
    const files = await installedFiles(appRoot);
    const worklet = await readFile(files[2]);
    // Import the original module so its native fork retains the sibling URL.
    const { createSeeduplexProvider } = await import(pathToFileURL(files[0]).href);
    if (typeof createSeeduplexProvider !== "function") return null;
    return Object.freeze({
      worklet,
      async createProvider(options = {}) {
        if (!options || typeof options !== "object"
          || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw fail("DUPLEX_CONFIG_INVALID");
        const descriptors = Object.getOwnPropertyDescriptors(options), clean = Object.create(null);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (!providerOptions.has(key) || !Object.hasOwn(descriptors[key], "value")) throw fail("DUPLEX_CONFIG_INVALID");
          clean[key] = descriptors[key].value;
        }
        try {
          const current = await installedFiles(appRoot);
          if (current.some((file, index) => file !== files[index])) throw fail("DUPLEX_RUNTIME_UNAVAILABLE");
        } catch { throw fail("DUPLEX_RUNTIME_UNAVAILABLE"); }
        return createSeeduplexProvider(clean);
      },
    });
  } catch { return null; }
}
