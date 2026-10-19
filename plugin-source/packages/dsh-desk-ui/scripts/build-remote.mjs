// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolvePluginBuildTool } from "../../../scripts/plugin-build-tools.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const license = "// SPDX-FileCopyrightText: Yangmingjie\n// SPDX-License-Identifier: GPL-3.0-only\n";
const entries = [
  ["packages/dsh-tools/lib/remote/tools.js", "packages/dsh-tools/lib/remote.bundle.mjs"],
  ["packages/dsh-desk-ui/lib/remote-host.js", "packages/dsh-desk-ui/lib/remote.bundle.mjs"],
];

export async function buildRemoteBundles({ root = defaultRoot, write = true } = {}) {
  const classifier = resolvePluginBuildTool("ipaddr.js", path.resolve(root));
  const classifierRoot = path.dirname(path.dirname(classifier));
  const metadata = JSON.parse(await readFile(path.join(classifierRoot, "package.json"), "utf8"));
  if (metadata.name !== "ipaddr.js" || metadata.version !== "2.5.0" || metadata.license !== "MIT") {
    throw new Error("REMOTE_BUNDLE_DEPENDENCY_REJECTED");
  }
  const classifierLicense = await readFile(path.join(classifierRoot, "LICENSE"), "utf8");
  const artifacts = [];
  for (const [entry, relativePath] of entries) {
    const result = await build({
      entryPoints: [entry], absWorkingDir: path.resolve(root), outfile: relativePath,
      bundle: true, platform: "node", target: "node24", format: "esm",
      minify: false, sourcemap: false, write: false, metafile: true, legalComments: "none",
      plugins: [{
        name: "reviewed-ima-classifier",
        setup(builder) {
          builder.onResolve({ filter: /^ipaddr\.js$/ }, () => ({ path: "ipaddr.js", namespace: "reviewed-ima" }));
          builder.onLoad({ filter: /^ipaddr\.js$/, namespace: "reviewed-ima" }, async () => ({
            contents: await readFile(classifier, "utf8"), loader: "js",
          }));
        },
      }],
    });
    const inputs = Object.keys(result.metafile.inputs);
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
    const reviewedClassifier = name => name === "reviewed-ima:ipaddr.js";
    // The optional IMA transport adds one pinned classifier. No other vendor
    // module or checkout-relative runtime dependency is allowed.
    if (inputs.filter(name => !reviewedClassifier(name)).some(name => path.isAbsolute(name) || name.startsWith("../")
      || /(?:^|\/)node_modules\/|\/voice\/|grok-cli-analyzer/.test(name))
      || imports.some(row => !row.external || !row.path.startsWith("node:"))) {
      throw new Error("REMOTE_BUNDLE_DEPENDENCY_REJECTED");
    }
    const includesClassifier = inputs.some(reviewedClassifier);
    const text = license + (includesClassifier
      ? `// Generated from remote modules and reviewed ipaddr.js 2.5.0; run pnpm build.\n/*\n${classifierLicense}*/\n`
      : "// Generated from first-party remote modules; run pnpm build.\n")
      + result.outputFiles[0].text;
    artifacts.push({ relativePath, text, inputs, imports });
  }
  // Validate both graphs before replacing either artifact.
  for (const artifact of write ? artifacts : []) {
    const target = path.join(root, artifact.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.text);
  }
  return artifacts.map(({ text, ...artifact }) => ({
    ...artifact, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"),
  }));
}
