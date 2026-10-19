// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { registerRemoteTools } from "../../dsh-tools/lib/remote.bundle.mjs";
import { applyRemoteHost, loadPersonalVoiceRuntime, createLocalNarrationController } from "./remote.bundle.mjs";
import { createPublicPluginEnvironment } from "./public-plugin-layout.js";
import { assertPublicPluginRuntime } from "./public-plugin-runtime.js";
import { createPersonalModelServices } from "./personal-model-settings.js";

export const name = "variable-os-desk-ui";
export const inject = ["webServer", "llm", "agentDefaultModel", "tools", "pluginPackages"];
const appRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export async function apply(ctx, config = {}) {
  if (!config || ![Object.prototype, null].includes(Object.getPrototypeOf(config))
    || Reflect.ownKeys(config).length) {
    throw Object.assign(Error("PUBLIC_PLUGIN_CONFIG_INVALID"), { code: "PUBLIC_PLUGIN_CONFIG_INVALID" });
  }
  assertPublicPluginRuntime(import.meta.url, ctx.get("pluginPackages"));
  const env = createPublicPluginEnvironment({ dshHome: resolveDshHome(), appRoot });
  const voice = await loadPersonalVoiceRuntime({ appRoot });
  const model = createPersonalModelServices(ctx, { file: env.VARIABLE_OS_MODEL_SETTINGS_FILE });
  applyRemoteHost(ctx, {
    env, appRoot, createUserMessage, createBlockAssembler: () => new BlockAssembler(),
    ...model,
    createVoiceProvider: voice?.createProvider, voiceWorklet: voice?.worklet,
    localNarration: createLocalNarrationController(),
  });
  registerRemoteTools(ctx, defineTool, { env });
}
