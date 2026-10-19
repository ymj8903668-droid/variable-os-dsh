// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { canonicalHash } from "../schema/canonical-json.mjs";

export async function hashFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  let byteLength = 0;
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return {
    sha256: hash.digest("hex"),
    byteLength,
  };
}

export function buildSourceDescriptor({ path, sha256, byteLength, kind }) {
  const descriptor = {
    path,
    sha256,
    byteLength,
    kind,
    descriptorHash: canonicalHash({ path, sha256, byteLength, kind }),
  };
  return Object.freeze(descriptor);
}

export async function describeSourceFile({ absolutePath, path, kind }) {
  const hashed = await hashFileSha256(absolutePath);
  return buildSourceDescriptor({
    path,
    sha256: hashed.sha256,
    byteLength: hashed.byteLength,
    kind,
  });
}
