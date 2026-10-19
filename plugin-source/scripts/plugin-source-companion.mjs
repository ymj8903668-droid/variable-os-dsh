// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildClientBundles } from "../packages/dsh-desk-ui/scripts/build-client.mjs";

import { transform } from "./plugin-build-tools.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(Error(code), { code }); };
const generated = new Set([
  "packages/dsh-desk-ui/lib/client.js",
  "packages/dsh-desk-ui/lib/remote.bundle.mjs",
  "packages/dsh-tools/lib/remote.bundle.mjs",
]);
const buildFiles = [
  "scripts/build-dsh-plugin.mjs", "scripts/cli-entrypoint.mjs",
  "scripts/plugin-source-companion.mjs", "scripts/rebuild-plugin-source.mjs",
  "scripts/plugin-build-tools.mjs",
  "scripts/build-plugin-install-bundle.mjs", "scripts/plugin-install-entry.mjs",
  "scripts/upgrade-public-plugin.mjs", "scripts/plugin-command.mjs",
  "scripts/plugin-upgrade-journal.mjs", "scripts/recover-public-plugin.mjs", "scripts/plugin-recover-entry.mjs",
  "scripts/cleanup-plugin-backups.mjs", "scripts/plugin-cleanup-entry.mjs",
  "scripts/uninstall-public-plugin.mjs", "scripts/plugin-uninstall-entry.mjs",
  "scripts/plugin-backup-inventory.mjs", "scripts/retire-plugin-backup-publications.mjs",
  "scripts/public-tools.mjs", "profiles/public-tools/package.json",
  "profiles/public-tools/pnpm-lock.yaml", "profiles/public-tools/pnpm-workspace.yaml",
  "scripts/install-public-plugin.mjs", "scripts/dsh-contract.mjs",
  "scripts/plugin-dependency-lock.mjs",
  "scripts/inspect-plugin-host.mjs",
  "scripts/start-installed-plugin.mjs", "scripts/plugin-start-entry.mjs", "scripts/public-desk-lifecycle.mjs",
  "packages/dsh-desk-ui/scripts/build-client.mjs",
  "packages/dsh-desk-ui/scripts/build-remote.mjs",
  "packages/dsh-desk-ui/package.json", "packages/dsh-tools/package.json",
  "packages/evidence-provider/package.json",
  "scripts/plugin-source-build-deps/package.json",
  "scripts/plugin-source-build-deps/pnpm-lock.yaml",
  "scripts/plugin-source-build-deps/pnpm-workspace.yaml",
  "packages/storage-contracts/package.json",
  "patches/dsh-settings-0.1.1-rc.2.patch", "patches/dsh-settings-file-0.1.1-rc.2.patch",
  "LICENSE", "NOTICE", "docs/DEPENDENCIES.md", "docs/BUILD_AND_TEST.md", "docs/PLUGIN_SOURCE_BUILD.md",
];

export async function writeSourceCompanion({
  sourceRoot, destRoot, pluginRoot, sourceFiles, pluginManifest, readSource,
}) {
  try {
    if (!path.isAbsolute(destRoot) || path.resolve(destRoot) !== destRoot
      || await fs.realpath(destRoot) !== destRoot) throw Error("PATH");
    const stat = await fs.lstat(destRoot);
    if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()
      || (await fs.readdir(destRoot)).length) throw Error("DEST");
    for (const other of [sourceRoot, pluginRoot]) {
      if (other === destRoot || other.startsWith(destRoot + path.sep)) throw Error("OVERLAP");
    }
    if (destRoot.startsWith(pluginRoot + path.sep)) throw Error("OVERLAP");
  } catch { fail("PUBLIC_PLUGIN_SOURCE_DEST_INVALID"); }

  const rebuilt = await buildClientBundles({ root: sourceRoot, write: false });
  const inputs = new Set([...sourceFiles, ...buildFiles]);
  for (const artifact of rebuilt) {
    if (hash(await readSource(artifact.relativePath)) !== artifact.sha256) {
      fail("PUBLIC_PLUGIN_SOURCE_GENERATED_STALE");
    }
    for (const file of artifact.inputs) if (file !== "reviewed-ima:ipaddr.js") inputs.add(file);
  }
  const contents = new Map(), transformations = [];
  for (const file of [...inputs].sort()) {
    if (generated.has(file)) continue;
    if (!/^[a-zA-Z0-9_./-]+$/.test(file)
      || file.split("/").some(part => !part || [".", "..", "node_modules", "raw", "wiki", ".git", ".env"].includes(part))
      || /\.test\.|\/voice\/|grok-cli-analyzer/.test(file)) fail("PUBLIC_PLUGIN_SOURCE_INPUT_INVALID");
    let bytes = await readSource(file);
    if (file === "src/research/cases.mjs") {
      const originalSha256 = hash(bytes);
      const { code } = await transform(bytes.toString("utf8"), {
        define: { __VARIABLE_OS_REFERENCE_CATALOGUE__: "false" },
        minifySyntax: true, minifyIdentifiers: false, minifyWhitespace: false,
        charset: "utf8", format: "esm", target: "node24", legalComments: "none",
      });
      bytes = Buffer.from("// SPDX-FileCopyrightText: Yangmingjie\n// SPDX-License-Identifier: GPL-3.0-only\n" + code);
      transformations.push({ path: file, profile: "public-reference-catalogue-empty", originalSha256 });
    }
    contents.set(file, bytes);
  }
  contents.set("README.md", await readSource("docs/PLUGIN_SOURCE_BUILD.md"));
  contents.set("expected-plugin-manifest.json", pluginManifest);
  const metadata = { name: "@variable-os/dsh-desk-ui-source", version: "0.1.1",
    private: true, type: "module", license: "GPL-3.0-only",
    engines: { node: "24.19.0", pnpm: "11.25.0" },
    files: [...contents.keys(), "package.json", "source-manifest.json"].sort() };
  contents.set("package.json", Buffer.from(JSON.stringify(metadata, null, 2)));
  const manifest = { schema: 1, profile: "standalone-plugin-source", publicReleaseQualified: false,
    nodeVersion: "24.19.0", pnpmVersion: "11.25.0", pluginManifestSha256: hash(pluginManifest),
    transformations, files: [...contents].sort(([a], [b]) => a.localeCompare(b))
      .map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: hash(bytes) })) };
  contents.set("source-manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  for (const [file, bytes] of contents) {
    const target = path.join(destRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  }
  return manifest;
}
