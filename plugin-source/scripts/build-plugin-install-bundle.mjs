// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { EXPECTED_DSH_VERSION } from "./dsh-contract.mjs";
import { isCliEntrypoint } from "./cli-entrypoint.mjs";
import { readApprovedPluginArchive, readPluginInput } from "./install-public-plugin.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(Error(code), { code }); };
const sources = [
  "scripts/plugin-install-entry.mjs", "scripts/install-public-plugin.mjs",
  "scripts/upgrade-public-plugin.mjs", "scripts/plugin-command.mjs",
  "scripts/plugin-upgrade-journal.mjs", "scripts/recover-public-plugin.mjs", "scripts/plugin-recover-entry.mjs",
  "scripts/cleanup-plugin-backups.mjs", "scripts/plugin-cleanup-entry.mjs",
  "scripts/uninstall-public-plugin.mjs", "scripts/plugin-uninstall-entry.mjs",
  "scripts/plugin-backup-inventory.mjs", "scripts/retire-plugin-backup-publications.mjs",
  "scripts/plugin-dependency-lock.mjs",
  "scripts/inspect-plugin-host.mjs",
  "scripts/cli-entrypoint.mjs", "scripts/dsh-contract.mjs",
  "scripts/start-installed-plugin.mjs", "scripts/plugin-start-entry.mjs", "scripts/public-desk-lifecycle.mjs",
  "scripts/public-tools.mjs", "profiles/public-tools/package.json",
  "profiles/public-tools/pnpm-lock.yaml", "profiles/public-tools/pnpm-workspace.yaml",
  "packages/dsh-desk-ui/lib/public-plugin-runtime.js",
];
async function readSourceCompanion(source, plugin) {
  try {
    const descriptor = source?.descriptor;
    if (descriptor?.schema !== 1 || descriptor.version !== plugin.version
      || descriptor.publicReleaseQualified !== false
      || ![descriptor.sha256, descriptor.manifestSha256, descriptor.pluginManifestSha256]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
      || descriptor.pluginManifestSha256 !== plugin.manifestSha256
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 10 || descriptor.bytes > 16 * 1024 * 1024) {
      throw Error("DESCRIPTOR");
    }
    const bytes = await readPluginInput(source.archive, descriptor.bytes);
    if (bytes.length !== descriptor.bytes || digest(bytes) !== descriptor.sha256) throw Error("ARCHIVE");
    const tar = args => {
      const result = spawnSync("/usr/bin/tar", args, {
        input: bytes, timeout: 10000, maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1", LC_ALL: "C", TZ: "UTC" },
      });
      if (result.error || result.status !== 0) throw Error("ARCHIVE_ENTRIES");
      return result.stdout;
    };
    // tar parses the archive; strict names make its bounded listings unambiguous.
    const entries = tar(["-tzf", "-"]).toString().trimEnd().split("\n");
    const detailed = tar(["-tvzf", "-"]).toString().trimEnd().split("\n");
    if (entries.length > 2048 || entries.length !== detailed.length) throw Error("ARCHIVE_ENTRIES");
    const names = new Set();
    for (const [index, name] of entries.entries()) {
      const directory = name.endsWith("/"), canonical = directory ? name.slice(0, -1) : name;
      if (!/^package(?:\/[A-Za-z0-9_.-]+)*$/.test(canonical)
        || canonical.split("/").some(part => [".", ".."].includes(part))
        || names.has(canonical.toLowerCase()) || (!directory && canonical === "package")
        || !detailed[index].startsWith(directory ? "d" : "-")
        || !detailed[index].endsWith(" " + name)) throw Error("ARCHIVE_ENTRIES");
      names.add(canonical.toLowerCase());
    }
    if (!entries.includes("package/source-manifest.json")) throw Error("MANIFEST");
    // Read from the already-hashed bytes; never extract archive paths to disk.
    const manifestBytes = tar(["-xzOf", "-", "package/source-manifest.json"]);
    if (digest(manifestBytes) !== descriptor.manifestSha256) throw Error("MANIFEST");
    const manifest = JSON.parse(manifestBytes);
    if (manifest.schema !== 1 || manifest.profile !== "standalone-plugin-source"
      || manifest.publicReleaseQualified !== false
      || manifest.pluginManifestSha256 !== plugin.manifestSha256) throw Error("BINDING");
    return bytes;
  } catch { fail("PLUGIN_SOURCE_ARTIFACT_INVALID"); }
}
const command = (entry, action = "") => `#!/bin/bash -p
# SPDX-FileCopyrightText: Yangmingjie
# SPDX-License-Identifier: GPL-3.0-only
set -eu
DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
NODE="$(command -v node)" || { printf '%s\\n' 'PLUGIN_TOOLCHAIN_INCOMPATIBLE' >&2; exit 1; }
case "$NODE" in /*) ;; *) printf '%s\\n' 'PLUGIN_TOOLCHAIN_INCOMPATIBLE' >&2; exit 1;; esac
exec /usr/bin/env -i HOME="\${HOME-}" PATH="\${PATH-}" COREPACK_HOME="\${COREPACK_HOME-}" HTTPS_PROXY="\${HTTPS_PROXY-}" \\
  "$NODE" "$DIR/app/scripts/${entry}" ${action} "$@"
`;
const guide = (platform, extension) => `# 变量发现台 ${platform === "linux" ? "Linux" : "macOS"} 私有安装候选

${platform === "linux" ? "这是未公开发布的候选，不是桌面双击、默认浏览器或完整一键启用的验收声明。" : "这是未公开发布的候选，不是签名、公证或完整一键启用的验收声明。"}
需要已安装并可在终端使用的 Node 24。
确认安装后，将下载独立的官方 DSH ${EXPECTED_DSH_VERSION} 与 pnpm 11.25.0，按随包冻结锁安装。
该工具链使用已登记的依赖修复并禁用安装脚本，不修改全局工具，不复制原有配置或 API 密钥。

1. 从可信账户页下载并解压，保留解压后的文件夹。
2. ${platform === "linux" ? "在解压目录运行 ./Install.sh；桌面文件管理器是否允许直接运行须按本机安全策略确认，不要关闭安全检查。" : "打开 Install.command，按系统正常的安全确认流程操作；不要移除隔离标记或关闭安全检查。"}
3. 阅读终端确认信息。输入 y 才执行一次安装；其他输入取消。
4. 安装成功后，再次输入 y 可启动并打开原中文配置页；拒绝或关闭输入只保留安装。

升级中断后可运行 Recover${extension}，明确确认后仅检查当前保护目录绑定的升级事务。
它要求原工作进程及所有已登记命令组消失，并核验备份、插件与用户状态；不能确认时保留保护。
未完成升级会恢复原版本，使用保留的原版本文件夹内 Start${extension} 启动；已经提交的新版本则保留。
恢复不启动、不联网、不重放安装或模型调用；启动后仍须验证当前信源授权。
不支持按旧空保护目录或旧schema日志推测恢复，也不会把已正常完成的历史备份重新上线。

确认当前版本可用后，可运行 Cleanup${extension} 查看并清理已完成升级的备份及已回滚的失败候选。
备份副本可能含旧凭证、私有卡片和研究历史；输入 DELETE 才永久删除列出的副本。
清理保留当前安装、工具链和诊断记录，不等于卸载，不删除系统或外部备份。
清理要求Host与旧工作进程已退出；中断时保留绑定保护，再运行同一入口确认续接，不能手动删锁。
旧schema或来源不明的事务不会被猜测删除，需另行核验。

不再使用时，先运行 Stop${extension}，再运行 Uninstall${extension} 查看卸载范围。
输入 DELETE 才永久删除当前安装中的凭证、私有卡片、研究历史与同步进度，以及列出的托管工具和升级副本。
仅保留不含正文或密钥的卸载回执；系统 Node、外部 DSH、安装包、导出文件及系统或外部备份保留。
卸载中断后运行同一入口，确认续接原来绑定的删除范围；运行中、未知或未完成事务会阻止卸载，不要手动删锁。
当前入口要求可核验的完整安装及现有事务格式；旧schema、损坏安装或预检未终结状态需另行处理，不能猜测删除。

安装使用独立的 ~/.variable-os-plugin/installation，不覆盖已有或失败的安装。
确认后先在独立的 ~/.variable-os-plugin/tools 准备并检查工具；失败不会占用插件安装位置。
同一安装位置只允许一个确认后的安装进程；重复打开不会并行执行工具。
未创建插件安装目录时，修正下载或工具问题后可再次确认安装；不会自动重试。
版本检查失败的私有诊断保留；真正开始安装后的失败目录和回执仍保留且不覆盖。
若提示预检子进程清理未确认，后续安装会被阻止；保留现场，先人工检查，不要直接重试。
校验失败或被系统拒绝时停止，不覆盖已有工具或插件目录。
以后打开 Start${extension} 启动同一个原中文插件，按原设置页配置服务。
启动使用原安装的独立状态及系统分配的本地端口；关闭启动终端或打开 Stop${extension} 停止。
重新打开 Start${extension} 沿用自己的配置，不重新安装、复制凭证或自动选择模型。
升级时先打开 Stop${extension}，再打开新包中的 Upgrade${extension} 并输入 y。
升级会保留配置、卡片、研究历史与同步进度，并在私有目录中保存原版本及数据备份。
新包安装或数据校验失败会恢复原安装；若提示恢复未确认，保留现场，不要删除保护目录重试。
当前升级要求相同的官方工具链；工具或原 profile 配置不兼容时停止，不自动改写。
升级成功后使用新包的 Start${extension}。启动会先移除托管历史备份中的发布卡研究正文与旧同步进度，避免它们在撤权后继续留存。
当前安装的研究历史不受这一步影响；备份中的纯个人研究及凭证仍保留，可用 Cleanup${extension} 完整删除副本。
该处理不联网，也不调用模型；未知或未完成的备份事务会阻止启动，需先按错误恢复或处理。
这些入口仍需当前平台的实际安装、启动、浏览器和系统安全验收，不代表完整公开发行。
API、IMA、模型和语音仍在原中文插件中配置；保存不等于付费调用或麦克风授权。
`;

export async function buildPluginInstallBundle({ archive, descriptor, destRoot, platform = "darwin", sourceCompanion } = {}) {
  if (!["darwin", "linux"].includes(platform)) fail("PLUGIN_BUNDLE_PLATFORM_INVALID");
  const slug = platform === "linux" ? "linux" : "macos";
  const extension = platform === "linux" ? ".sh" : ".command";
  try {
    const stat = await fs.lstat(destRoot);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077
      || await fs.realpath(destRoot) !== destRoot || (await fs.readdir(destRoot)).length) throw Error("DEST");
  } catch { fail("PLUGIN_BUNDLE_DEST_INVALID"); }
  const approved = await readApprovedPluginArchive(archive, descriptor);
  const sourceBytes = sourceCompanion === undefined ? null : await readSourceCompanion(sourceCompanion, descriptor);
  const contents = new Map([
    ["plugin.tgz", approved],
    ["descriptor.json", Buffer.from(JSON.stringify(descriptor, null, 2) + "\n")],
    ["app/package.json", Buffer.from('{"private":true,"type":"module"}\n')],
    ["Install" + extension, Buffer.from(command("plugin-install-entry.mjs"))],
    ["Upgrade" + extension, Buffer.from(command("plugin-install-entry.mjs", "--upgrade"))],
    ["Recover" + extension, Buffer.from(command("plugin-recover-entry.mjs"))],
    ["Cleanup" + extension, Buffer.from(command("plugin-cleanup-entry.mjs"))],
    ["Uninstall" + extension, Buffer.from(command("plugin-uninstall-entry.mjs"))],
    ["Start" + extension, Buffer.from(command("plugin-start-entry.mjs", "start"))],
    ["Stop" + extension, Buffer.from(command("plugin-start-entry.mjs", "stop"))],
    ["README.zh.md", Buffer.from(guide(platform, extension))],
  ]);
  if (sourceBytes) {
    contents.set("source.tgz", sourceBytes);
    contents.set("source-descriptor.json", Buffer.from(JSON.stringify(sourceCompanion.descriptor, null, 2) + "\n"));
  }
  for (const file of [...sources, "LICENSE", "NOTICE",
    "docs/DEPENDENCIES.md", "docs/BUILD_AND_TEST.md", "docs/PLUGIN_SOURCE_BUILD.md"]) {
    contents.set(sources.includes(file) ? "app/" + file : file,
      await readPluginInput(path.join(sourceRoot, file), 1024 * 1024));
  }
  const manifest = { schema: 1, platform, publicReleaseQualified: false, runtimeIncluded: false,
    sourceIncluded: sourceBytes !== null,
    files: [...contents].sort(([a], [b]) => a.localeCompare(b))
      .map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: digest(bytes) })) };
  contents.set("installer-manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  const stage = path.join(destRoot, "Variable-Desk"), entries = [];
  const epoch = new Date("1980-01-01T00:00:00Z");
  for (const [file, bytes] of contents) {
    const target = path.join(stage, file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: file.endsWith(extension) ? 0o700 : 0o600 });
    await fs.utimes(target, epoch, epoch);
    entries.push("Variable-Desk/" + file);
  }
  const file = path.join(destRoot, `variable-os-dsh-${descriptor.version}-${slug}.zip`);
  const zip = spawnSync("/usr/bin/zip", ["-X", "-q", "-0", file, ...entries.sort()], {
    cwd: destRoot, env: { PATH: "/usr/bin:/bin", TZ: "UTC", COPYFILE_DISABLE: "1" },
    encoding: "utf8", timeout: 10000, maxBuffer: 16384,
  });
  if (zip.error || zip.status !== 0) fail("PLUGIN_BUNDLE_ARCHIVE_FAILED");
  await fs.chmod(file, 0o600);
  const bytes = await readPluginInput(file, 16 * 1024 * 1024);
  return { file, version: descriptor.version, dshVersion: descriptor.dshVersion, bytes: bytes.length,
    sha256: digest(bytes), format: `${slug}-installer-zip` };
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      archive: { type: "string" }, descriptor: { type: "string" }, output: { type: "string" },
      platform: { type: "string" },
      "source-archive": { type: "string" }, "source-descriptor": { type: "string" },
    } });
    const descriptor = JSON.parse(await readPluginInput(values.descriptor, 16384));
    if (Boolean(values["source-archive"]) !== Boolean(values["source-descriptor"])) fail("PLUGIN_BUNDLE_ARGUMENTS_INVALID");
    const sourceCompanion = values["source-archive"] ? {
      archive: values["source-archive"],
      descriptor: JSON.parse(await readPluginInput(values["source-descriptor"], 16384)),
    } : undefined;
    console.log(JSON.stringify(await buildPluginInstallBundle({
      archive: values.archive, descriptor, destRoot: values.output, platform: values.platform,
      sourceCompanion,
    })));
  } catch (error) {
    console.error(/^(?:PLUGIN_|PUBLIC_PLUGIN_)[A-Z0-9_]+$/.test(error.code ?? "")
      ? error.code : "PLUGIN_BUNDLE_ARGUMENTS_INVALID");
    process.exitCode = 1;
  }
}
