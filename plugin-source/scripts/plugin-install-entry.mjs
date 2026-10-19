// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";
import { installPublicPlugin, readPluginInput, readApprovedPluginArchive } from "./install-public-plugin.mjs";
import { launchInstalledBundle } from "./plugin-start-entry.mjs";
import { findExecutable, EXPECTED_DSH_VERSION, EXPECTED_PNPM_VERSION } from "./dsh-contract.mjs";
import { runChild } from "./public-desk-lifecycle.mjs";
import { preparePublicTools, selectPublicTools } from "./public-tools.mjs";
import { upgradePublicPlugin } from "./upgrade-public-plugin.mjs";

const fail = code => { throw Object.assign(Error(code), { code }); };
const bundleRoot = fileURLToPath(new URL("../../", import.meta.url));
const cancellation = new AbortController();
const signalCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export function pluginInstallFailureCode(error, signal, fallback = "PLUGIN_BUNDLE_FAILED") {
  if (["PLUGIN_UPGRADE_RECOVERY_REQUIRED", "PLUGIN_INSTALL_CHILDREN_REMAIN"].includes(error?.code)) return error.code;
  if (error?.code === "PUBLIC_DESK_BUSY") return "PLUGIN_UPGRADE_HOST_RUNNING";
  if (["PUBLIC_CHILDREN_REMAIN", "PLUGIN_PREFLIGHT_CHILDREN_REMAIN"].includes(error?.code)) {
    return "PLUGIN_PREFLIGHT_CHILDREN_REMAIN";
  }
  if (signal.aborted) return "PLUGIN_INSTALL_CANCELLED";
  if (/^PUBLIC_TOOLS_[A-Z_]+$/.test(error?.code ?? "")) return error.code.replace(/^PUBLIC_/, "PLUGIN_");
  return /^(?:PLUGIN_|PUBLIC_PLUGIN_)[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : fallback;
}

async function inputs() {
  const root = await fs.realpath(bundleRoot);
  const descriptor = JSON.parse(await readPluginInput(path.join(root, "descriptor.json"), 16 * 1024));
  const archive = path.join(root, "plugin.tgz");
  await readApprovedPluginArchive(archive, descriptor);
  return { descriptor, archive };
}

async function privateState(home) {
  const root = path.join(home, ".variable-os-plugin");
  try { await fs.mkdir(root, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077
    || await fs.realpath(root) !== root) fail("PLUGIN_BUNDLE_STATE_INVALID");
  return path.join(root, "installation");
}

async function homeDirectory() {
  if (!process.env.HOME || !path.isAbsolute(process.env.HOME)) fail("PLUGIN_BUNDLE_STATE_INVALID");
  const home = await fs.realpath(process.env.HOME), stat = await fs.lstat(home);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) fail("PLUGIN_BUNDLE_STATE_INVALID");
  return home;
}

async function reserveInstallEntry(destination) {
  const recovery = path.join(path.dirname(destination), "preflight-recovery.json");
  try {
    await fs.lstat(recovery);
    fail("PLUGIN_PREFLIGHT_CHILDREN_REMAIN");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const guard = path.join(path.dirname(destination), "install-entry.guard");
  try { await fs.mkdir(guard, { mode: 0o700 }); }
  catch (error) {
    fail(error.code === "EEXIST" ? "PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED" : "PLUGIN_INSTALL_GUARD_FAILED");
  }
  return guard;
}

async function preflight(destination) {
  const recovery = path.join(path.dirname(destination), "preflight-recovery.json");
  try {
    await fs.lstat(destination);
    fail("PLUGIN_DESTINATION_EXISTS");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const env = {
    PATH: String(process.env.PATH ?? "").split(path.delimiter).filter(folder => path.isAbsolute(folder)).join(path.delimiter),
    SHELL: "/bin/sh", DSH_TELEMETRY_DISABLED: "1", COREPACK_ENABLE_NETWORK: "0",
    COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENV_FILE: "0",
    pnpm_config_offline: "true", pnpm_config_ignore_scripts: "true",
    pnpm_config_manage_package_manager_versions: "false",
  };
  if (process.env.COREPACK_HOME && path.isAbsolute(process.env.COREPACK_HOME)) {
    env.COREPACK_HOME = process.env.COREPACK_HOME;
  }
  const node = findExecutable("node", env);
  if (process.versions.node.split(".")[0] !== "24" || !node
    || await fs.realpath(node) !== await fs.realpath(process.execPath)) fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
  if (cancellation.signal.aborted) fail("PLUGIN_INSTALL_CANCELLED");
  const root = await fs.mkdtemp(path.join(path.dirname(destination), "preflight-"));
  let passed = false;
  try {
    for (const name of ["home", "config", "cache", "tmp"]) {
      await fs.mkdir(path.join(root, name), { mode: 0o700 });
    }
    Object.assign(env, {
      HOME: path.join(root, "home"), DSH_HOME: path.join(root, "home/.dsh"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
      TMPDIR: path.join(root, "tmp"),
    });
    const plan = { root: path.dirname(destination), sourceRoot: path.join(bundleRoot, "app"), cwd: root, env };
    if (!selectPublicTools(plan)) {
      await preparePublicTools(plan, (command, argv) => runChild(command, argv, plan, cancellation.signal,
        { capture: true, timeoutMs: 1_200_000 }));
    }
    const pnpm = findExecutable("pnpm", env), dsh = findExecutable("dsh", env);
    for (const [tool, expected] of [[pnpm, EXPECTED_PNPM_VERSION], [dsh, EXPECTED_DSH_VERSION]]) {
      const result = await runChild(tool, ["--version"], { cwd: root, env }, cancellation.signal,
        { capture: true, timeoutMs: 10000 });
      if (result.status !== 0 || result.stdout.trim() !== expected) fail("PLUGIN_TOOLCHAIN_INCOMPATIBLE");
    }
    if (cancellation.signal.aborted) fail("PLUGIN_INSTALL_CANCELLED");
    passed = true;
    return { ...process.env, PATH: env.PATH };
  } catch (error) {
    const code = pluginInstallFailureCode(error, cancellation.signal, "PLUGIN_TOOLCHAIN_PREFLIGHT_FAILED");
    try {
      if (code === "PLUGIN_PREFLIGHT_CHILDREN_REMAIN") {
        try {
          await fs.writeFile(recovery, JSON.stringify({
            schema: 1, status: "MANUAL_RECOVERY_REQUIRED", code, preflight: path.basename(root),
          }) + "\n", { mode: 0o600, flag: "wx" });
        } catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
      }
      await fs.writeFile(path.join(root, "preflight.json"),
        JSON.stringify({ schema: 1, status: "REJECTED", code }) + "\n", { mode: 0o600, flag: "wx" });
    } finally { fail(code); }
  } finally {
    // Only a successful disposable preflight is removed. Rejected checks stay private.
    if (passed) await fs.rm(root, { recursive: true });
  }
}

async function worker(upgrade = false) {
  const lost = () => cancellation.abort("PARENT_LOST");
  const stop = message => {
    if (message?.type === "cancel" && Object.hasOwn(signalCodes, message.signal)) cancellation.abort(message.signal);
  };
  process.on("disconnect", lost); process.on("message", stop);
  if (!process.connected) lost();
  try {
    const input = await inputs(), home = await homeDirectory();
    if (cancellation.signal.aborted) fail("PLUGIN_INSTALL_CANCELLED");
    const destination = await privateState(home);
    const guard = upgrade ? null : await reserveInstallEntry(destination);
    let receipt, retainGuard = false;
    try {
      if (upgrade) {
        const env = { ...process.env };
        if (!selectPublicTools({ root: path.dirname(destination), sourceRoot: path.join(bundleRoot, "app"), env })) {
          fail("PLUGIN_TOOLS_INSTALL_REQUIRED");
        }
        const previous = JSON.parse(await readPluginInput(path.join(destination, "install-receipt.json"), 16384));
        const archiveStat = await fs.lstat(path.join(destination, "plugin.tgz"));
        const previousDescriptor = { schema: 1, version: previous.version, dshVersion: EXPECTED_DSH_VERSION,
          sha256: previous.archiveSha256, manifestSha256: previous.manifestSha256,
          bytes: archiveStat.size, publicReleaseQualified: false };
        receipt = await upgradePublicPlugin({ ...input, previousDescriptor, destination,
          confirm: true, signal: cancellation.signal, env });
      } else {
        const env = await preflight(destination);
        if (cancellation.signal.aborted) fail("PLUGIN_INSTALL_CANCELLED");
        receipt = await installPublicPlugin({ ...input, destination, confirm: true, signal: cancellation.signal, env });
      }
    } catch (error) {
      retainGuard = ["PLUGIN_PREFLIGHT_CHILDREN_REMAIN", "PLUGIN_INSTALL_CHILDREN_REMAIN"].includes(pluginInstallFailureCode(error, cancellation.signal));
      throw error;
    } finally {
      // Admission exists before any tool runs, including when later diagnostic
      // writes fail. Never release it without confirmed child cleanup.
      if (guard && !retainGuard) await fs.rmdir(guard);
    }
    if (process.connected) await new Promise(resolve => process.send({ type: "installed", receipt }, resolve));
  } finally {
    process.off("disconnect", lost); process.off("message", stop);
    if (process.connected) process.disconnect();
  }
}

async function confirm(message) {
  if (process.stdin.readableEnded || process.stdin.destroyed) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    const closed = new Promise(resolve => prompt.once("close", () => resolve("")));
    answer = await Promise.race([prompt.question(message, { signal: cancellation.signal }), closed]);
  } finally { prompt.close(); }
  if (cancellation.signal.aborted) fail("PLUGIN_INSTALL_CANCELLED");
  return answer.trim().toLowerCase() === "y";
}

async function foreground(upgrade = false) {
  if (process.argv.length !== (upgrade ? 3 : 2)) fail("PLUGIN_BUNDLE_ARGUMENTS_INVALID");
  await inputs();
  const home = await homeDirectory();
  const question = upgrade
    ? "请先停止变量发现台。升级当前安装并备份原版本？保留配置、卡片和研究历史。[y/N] "
    : "安装变量发现台私有候选及独立官方工具链？不启用模型或语音。[y/N] ";
  if (!await confirm(question)) {
    console.log("已取消，未创建安装或个人状态。");
    return;
  }
  const env = { HOME: home, PATH: process.env.PATH ?? "",
    COREPACK_HOME: process.env.COREPACK_HOME ?? "", HTTPS_PROXY: process.env.HTTPS_PROXY ?? "" };
  // The IPC peer owns the actual install. Losing a terminal, including SIGKILL
  // of this foreground process, cancels work rather than orphaning it.
  const child = fork(fileURLToPath(import.meta.url), [upgrade ? "--upgrade-worker" : "--worker"], {
    execPath: process.execPath, execArgv: [], env, cwd: bundleRoot, detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let receipt, errorCode, childError;
  child.stdout.resume();
  child.stderr.on("data", bytes => {
    const text = bytes.toString();
    const code = /^(?:PLUGIN_|PUBLIC_PLUGIN_)[A-Z0-9_]+$/m.exec(text)?.[0];
    if (code) errorCode = code;
  });
  child.on("message", value => {
    if (value?.type === "installed" && value.receipt?.status === (upgrade ? "UPGRADED_NOT_STARTED" : "INSTALLED_NOT_STARTED")) receipt = value.receipt;
  });
  const stop = () => {
    if (child.connected) child.send({ type: "cancel", signal: cancellation.signal.reason }, error => {
      if (error && child.connected) child.disconnect();
    });
  };
  cancellation.signal.addEventListener("abort", stop, { once: true });
  if (cancellation.signal.aborted) stop();
  try {
    const exit = await new Promise(resolve => {
      child.once("error", error => { childError = error; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (["PLUGIN_PREFLIGHT_CHILDREN_REMAIN", "PLUGIN_UPGRADE_RECOVERY_REQUIRED", "PLUGIN_INSTALL_CHILDREN_REMAIN"].includes(errorCode)) fail(errorCode);
    if (cancellation.signal.aborted) fail("PLUGIN_INSTALL_CANCELLED");
    if (childError || exit.code !== 0 || exit.signal || !receipt) fail(errorCode ?? "PLUGIN_INSTALL_WORKER_FAILED");
    console.log(upgrade ? "升级与数据校验完成。尚未启动变量发现台，原版本备份已保留。"
      : "插件安装与校验完成。尚未启动 Host、信源、模型或语音。");
    console.log(JSON.stringify(receipt));
  } finally { cancellation.signal.removeEventListener("abort", stop); }
  if (await confirm("现在启动变量发现台并打开配置页？不会自动启用信源、模型或语音。[y/N] ")) {
    process.exitCode = await launchInstalledBundle(["start"], { signal: cancellation.signal });
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const handlers = Object.keys(signalCodes).map(name => [name, () => cancellation.abort(name)]);
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    if (process.argv.length === 3 && ["--worker", "--upgrade-worker"].includes(process.argv[2]) && typeof process.send === "function") {
      await worker(process.argv[2] === "--upgrade-worker");
    } else await foreground(process.argv[2] === "--upgrade");
  } catch (error) {
    const code = pluginInstallFailureCode(error, cancellation.signal);
    if (["PLUGIN_TOOLCHAIN_INCOMPATIBLE", "PLUGIN_TOOLCHAIN_PREFLIGHT_FAILED"].includes(code)) {
      console.error("工具链检查未通过。需要已可用的 Node 24；确认安装后会准备独立官方工具链，不修改全局工具或覆盖失败现场。");
    }
    if (code.startsWith("PLUGIN_TOOLS_")) console.error("独立工具链准备或校验未通过，未开始插件安装。已有目录和失败现场不覆盖；本次不会自动重试。");
    if (code === "PLUGIN_INSTALL_REGISTRY_FETCH_FAILED") {
      console.error("依赖源读取失败，请检查 registry.npmjs.org 的连接。失败现场已保留，未启动 Host；可查看安装目录内的 install-receipt.json 和 install.log，不要覆盖原目录重试。");
    }
    if (code === "PLUGIN_PREFLIGHT_CHILDREN_REMAIN") {
      console.error("无法确认预检子进程已全部退出，已阻止后续安装。保留现场，人工确认清理前不要重试。");
    }
    if (code === "PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED") {
      console.error("已有安装进程或未确认清理的安装现场。本次未开始安装，请先确认原进程状态，不要删除保护目录后重试。");
    }
    if (code === "PLUGIN_INSTALL_CHILDREN_REMAIN") console.error("无法确认安装子进程已全部退出，保护目录和现场已保留，请先检查原进程状态。");
    if (code === "PLUGIN_UPGRADE_HOST_RUNNING") console.error("变量发现台仍在运行。请先正常停止；本次未升级。");
    if (code === "PLUGIN_UPGRADE_ALREADY_INSTALLED") console.error("当前安装已是这一份插件，无需重复升级。");
    if (code === "PLUGIN_UPGRADE_PROFILE_MIGRATION_REQUIRED") console.error("已有配置需要专门迁移，已恢复原安装，未覆盖原配置。");
    if (code === "PLUGIN_UPGRADE_RECOVERY_REQUIRED") console.error("无法确认升级回滚已完成，已阻止后续安装与启动。原备份和失败现场已保留，请先检查升级回执。");
    console.error(code);
    process.exitCode = signalCodes[cancellation.signal.reason] ?? 1;
  } finally { for (const [name, handler] of handlers) process.off(name, handler); }
}
