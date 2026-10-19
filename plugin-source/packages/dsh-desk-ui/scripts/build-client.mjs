// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "../../../scripts/plugin-build-tools.mjs";
import { buildRemoteBundles } from "./build-remote.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function buildClientBundles({ root = defaultRoot, write = true } = {}) {
  const packageRoot = path.join(path.resolve(root), "packages/dsh-desk-ui");
  const entry = path.join(packageRoot, "src", "client.tsx");
  const output = path.join(packageRoot, "lib", "client.js");
  const external = [
    "react",
    "react/jsx-runtime",
    "@deepseek-ai/dsh-client-ui-primitives",
  ];

  const compiled = await build({
    entryPoints: [entry],
    absWorkingDir: path.dirname(path.dirname(packageRoot)),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external,
    minify: false,
    sourcemap: false,
    write: false,
    metafile: true,
    legalComments: "none",
  });

  const inputs = Object.keys(compiled.metafile.inputs);
  const imports = Object.values(compiled.metafile.outputs).flatMap(output => output.imports);
  // The first-party header is not a substitute for reviewing vendor attribution.
  if (inputs.some(name => path.isAbsolute(name) || name.startsWith("../")
    || /(?:^|\/)node_modules\/|\/voice\/|grok-cli-analyzer/.test(name))
    || imports.some(row => !row.external || !external.includes(row.path))) {
    throw new Error("CLIENT_BUNDLE_DEPENDENCY_REJECTED");
  }

  const body = compiled.outputFiles[0].text;
  const wrapped = `/* Generated from src/client.tsx — run pnpm build. */\nwindow.__ModuleLoader__.load({\n  id: "@variable-os/dsh-desk-ui",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${body
    .split("\n")
    .map((line) => (line ? `    ${line}` : ""))
    .join("\n")}\n    return module.exports;\n  },\n});\n`;

  // Reject either remote graph before replacing the validated browser artifact.
  const remote = await buildRemoteBundles({ root: path.dirname(path.dirname(packageRoot)), write });
  const license = "// SPDX-FileCopyrightText: Yangmingjie\n// SPDX-License-Identifier: GPL-3.0-only\n";
  const text = license + wrapped;
  if (write) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, text, "utf8");
  }
  return [{ relativePath: "packages/dsh-desk-ui/lib/client.js", inputs, imports,
    bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }, ...remote];
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  await buildClientBundles();
}
