// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";
import { PUBLIC_PLUGIN_HOST_PEERS } from "../packages/dsh-desk-ui/lib/public-plugin-runtime.js";
import { writeSourceCompanion } from "./plugin-source-companion.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
import { build } from "./plugin-build-tools.mjs";
const header = "// SPDX-FileCopyrightText: Yangmingjie\n// SPDX-License-Identifier: GPL-3.0-only\n";
const copies = [
  "LICENSE", "NOTICE",
  "docs/DEPENDENCIES.md", "docs/BUILD_AND_TEST.md", "docs/PLUGIN_SOURCE_BUILD.md",
  // Native card materialization and ranking read these versioned policies.
  "fixtures/policies/budget-v1.json",
  "fixtures/policies/fermentation-rule-v1.json",
  "fixtures/policies/mapping-rule-v1.json",
  "fixtures/policies/reaction-search-v1.json",
  "packages/dsh-desk-ui/lib/public-plugin.js",
  "packages/dsh-desk-ui/lib/public-plugin-layout.js",
  "packages/dsh-desk-ui/lib/public-plugin-runtime.js",
  "packages/dsh-desk-ui/lib/windows-private-state.js",
  "packages/dsh-desk-ui/lib/windows-private-command.js",
  "packages/dsh-desk-ui/lib/client.js",
  "packages/dsh-desk-ui/lib/remote.bundle.mjs",
  "packages/dsh-desk-ui/lib/duplex-audio-worklet.js",
  "packages/dsh-tools/lib/remote.bundle.mjs",
  "src/runtime/harness-research-host-duplex-provider.mjs",
  "src/runtime/harness-research-host-duplex-provider-child.mjs",
];
const bundles = [
  "src/research/personal-desk.mjs",
  "src/runtime/ima-card-input.mjs",
  "packages/dsh-desk-ui/lib/personal-agent-session.js",
  "packages/dsh-desk-ui/lib/personal-model-adapter.js",
  "packages/dsh-desk-ui/lib/personal-model-profile.js",
  "packages/dsh-desk-ui/lib/personal-model-settings.js",
  "packages/edge-mcp-bridge/src/stdio.mjs",
];
const modelProtocolImports = ["openai-completions", "openai-responses", "anthropic-messages"]
  .map(name => `@earendil-works/pi-ai/api/${name}.lazy`);
const fail = code => { throw Object.assign(Error(code), { code }); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function sourceFile(sourceRoot, relative) {
  let target = sourceRoot;
  for (const [index, part] of relative.split("/").entries()) {
    target = path.join(target, part);
    const stat = await fs.lstat(target);
    const last = index === relative.split("/").length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) fail("PUBLIC_PLUGIN_INPUT_INVALID");
  }
  return fs.readFile(target);
}

export async function buildPublicPlugin({ sourceRoot = root, destRoot, sourceCompanionRoot } = {}) {
  try {
    const stat = await fs.lstat(destRoot);
    if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()
      || (await fs.readdir(destRoot)).length) fail("PUBLIC_PLUGIN_DEST_INVALID");
  } catch { fail("PUBLIC_PLUGIN_DEST_INVALID"); }
  sourceRoot = await fs.realpath(sourceRoot);
  destRoot = await fs.realpath(destRoot);
  if (sourceRoot === destRoot || sourceRoot.startsWith(destRoot + path.sep)) fail("PUBLIC_PLUGIN_DEST_INVALID");
  const original = JSON.parse(await sourceFile(sourceRoot, "packages/dsh-desk-ui/package.json"));
  const dependencies = { ...original.peerDependencies, ...original.dependencies };
  const reviewedDependencies = new Map(Object.entries({ ...PUBLIC_PLUGIN_HOST_PEERS,
    "@deepseek-ai/dsh-client-ui-primitives": "0.2.1-alpha.2",
  }));
  if (Object.entries(dependencies).some(([name, version]) =>
    reviewedDependencies.get(name) !== version)) fail("PUBLIC_PLUGIN_SDK_UNREVIEWED");
  if (Object.entries(PUBLIC_PLUGIN_HOST_PEERS).some(([name, version]) =>
    dependencies[name] !== version)) fail("PUBLIC_PLUGIN_SDK_UNREVIEWED");
  const external = [...Object.keys(dependencies), ...Object.keys(original.peerDependencies)];
  const allowedImports = new Set([...Object.keys(PUBLIC_PLUGIN_HOST_PEERS),
    ...modelProtocolImports]);
  const contents = new Map();
  const sourceFiles = new Set([...copies, "packages/publication-edge/src/portal/install-guide.txt"]);
  sourceFiles.add("packages/dsh-desk-ui/plugin-dependencies.json");
  contents.set("plugin-dependencies.json", await sourceFile(sourceRoot, "packages/dsh-desk-ui/plugin-dependencies.json"));
  contents.set("USER-GUIDE.zh.md", await sourceFile(sourceRoot,
    "packages/publication-edge/src/portal/install-guide.txt"));
  for (const file of copies) contents.set(file, await sourceFile(sourceRoot, file));
  for (const entry of bundles) {
    const result = await build({
      entryPoints: [entry], absWorkingDir: sourceRoot, bundle: true, platform: "node",
      target: "node24", format: "esm", external, write: false, metafile: true,
      sourcemap: false, minify: false, minifySyntax: true, legalComments: "none",
      define: { __VARIABLE_OS_REFERENCE_CATALOGUE__: "false" },
    });
    const inputs = Object.keys(result.metafile.inputs);
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
    if (inputs.some(file => path.isAbsolute(file) || file.startsWith("../") || /(^|\/)node_modules\//.test(file))
      || imports.some(item => !item.external || !isBuiltin(item.path) && !allowedImports.has(item.path))) {
      fail("PUBLIC_PLUGIN_DEPENDENCY_UNREVIEWED");
    }
    for (const file of inputs) await sourceFile(sourceRoot, file);
    for (const file of inputs) sourceFiles.add(file);
    contents.set(entry, Buffer.from(header + result.outputFiles[0].text));
  }
  const main = "./packages/dsh-desk-ui/lib/public-plugin.js";
  const metadata = {
    name: original.name, version: original.version, private: true, type: "module",
    license: "GPL-3.0-only", description: original.description,
    main, exports: { ".": main, "./client": "./packages/dsh-desk-ui/lib/client.js",
      "./package.json": "./package.json" },
    engines: { node: ">=24 <25" },
    dsh: { ...original.dsh, bundle: { patch: "./cordis.patch.yml" } },
    dependencies: {},
    // The packaged client gets UI primitives from the frontend module loader.
    peerDependencies: { ...PUBLIC_PLUGIN_HOST_PEERS },
  };
  contents.set("cordis.patch.yml", Buffer.from(
    '- insert:\n    - id: variable-os-desk-ui\n      name: "@variable-os/dsh-desk-ui"\n'));
  contents.set("README.md", Buffer.from(
    "# Variable Discovery Desk Private Candidate\n\n" +
    "For isolated testing in existing official DSH 0.2.1-alpha.2 with Node24.\n" +
    "Uses the original Chinese plugin and explicit user-owned service configuration.\n" +
    "Exact SDK/model peers come from the existing official Host; incompatible\n" +
    "versions are refused before private state or Host registration. The\n" +
    "browser UI primitives come from the Host's frontend module loader.\n" +
    "Profile reloads use the official Host's config-only HMR unchanged.\n" +
    "This payload adds no direct, optional or bundled runtime dependencies.\n" +
    "Its manifest-bound host-peers-only lock does not audit Host transitives.\n" +
    "Exact Host peer checks still fail closed before plugin activation.\n" +
    "No runtime installer, service credentials or automatic activation is included.\n" +
    "This private candidate is NOT a public release. Cross-platform installation,\n" +
    "complete workflow acceptance and corresponding-source distribution review\n" +
    "remain required before public redistribution. Do not publish this package.\n\n" +
    "Compatibility limits: private state currently requires POSIX ownership/mode\n" +
    "checks; Windows fails closed and is not qualified. A version match alone\n" +
    "does not qualify model setup. Model settings use private guarded metadata\n" +
    "and native credential-record transactions; global Settings are unchanged.\n" +
    "Complete installed workflow compatibility still requires acceptance.\n" +
    "No SDK patch or automatic model, network or microphone start.\n"));
  metadata.files = [...contents.keys(), "package.json", "build-manifest.json"].sort();
  // Preserve the metadata hash across the pinned packer's JSON serialization.
  contents.set("package.json", Buffer.from(JSON.stringify(metadata, null, 2)));
  const files = [...contents].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: digest(bytes) }));
  const receipt = { schema: 1, dshVersion: "0.2.1-alpha.2", publicReleaseQualified: false, files };
  const manifestBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  if (sourceCompanionRoot !== undefined) {
    await writeSourceCompanion({ sourceRoot, destRoot: sourceCompanionRoot, pluginRoot: destRoot,
      sourceFiles, pluginManifest: manifestBytes, readSource: file => sourceFile(sourceRoot, file) });
  }
  for (const [file, bytes] of contents) {
    const target = path.join(destRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  }
  await fs.writeFile(path.join(destRoot, "build-manifest.json"), manifestBytes, { flag: "wx", mode: 0o644 });
  return receipt;
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    let output, sourceOutput;
    try {
      ({ values: { output, "source-output": sourceOutput } } = parseArgs({ options: {
        output: { type: "string" }, "source-output": { type: "string" },
      }, strict: true }));
      if (!output || !path.isAbsolute(output)) fail("PUBLIC_PLUGIN_ARGUMENTS_INVALID");
      if (sourceOutput !== undefined && !path.isAbsolute(sourceOutput)) fail("PUBLIC_PLUGIN_ARGUMENTS_INVALID");
    } catch { fail("PUBLIC_PLUGIN_ARGUMENTS_INVALID"); }
    const receipt = await buildPublicPlugin({ destRoot: output, sourceCompanionRoot: sourceOutput });
    console.log(JSON.stringify({
      status: "PRIVATE_CANDIDATE", fileCount: receipt.files.length, publicReleaseQualified: false,
    }));
  } catch (error) {
    const code = typeof error?.code === "string" && /^PUBLIC_PLUGIN_[A-Z_]+$/.test(error.code)
      ? error.code : "PUBLIC_PLUGIN_BUILD_FAILED";
    console.error(code);
    process.exitCode = 1;
  }
}
