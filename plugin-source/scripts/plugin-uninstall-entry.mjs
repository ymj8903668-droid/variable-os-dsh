// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {isCliEntrypoint} from './cli-entrypoint.mjs';
import {inspectPluginUninstall,uninstallPublicPlugin} from './uninstall-public-plugin.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function uninstallInstalledBundle(args=[]){
 if(args.length)fail('PLUGIN_UNINSTALL_ARGUMENTS_INVALID');
 if(!['darwin','linux'].includes(process.platform)||process.versions.node.split('.')[0]!=='24')fail('PLUGIN_TOOLCHAIN_INCOMPATIBLE');
 if(!process.env.HOME||!path.isAbsolute(process.env.HOME))fail('PLUGIN_BUNDLE_STATE_INVALID');
 const home=await fs.realpath(process.env.HOME),stat=await fs.lstat(home);
 if(!stat.isDirectory()||stat.uid!==process.getuid?.()||stat.mode&0o022)fail('PLUGIN_BUNDLE_STATE_INVALID');
 const root=path.join(home,'.variable-os-plugin'),destination=path.join(root,'installation');
 try{await fs.lstat(root);}catch(e){if(e.code!=='ENOENT')throw e;console.log('没有变量发现台安装状态，无需卸载。');return;}
 const options={destination,sourceRoot:fileURLToPath(new URL('../',import.meta.url))},plan=await inspectPluginUninstall(options);
 if(!plan.targets.length){console.log('变量发现台已卸载，仅保留卸载回执，无需卸载。');return;}
 console.log(plan.resuming?'上次卸载中断，将续接同一批已确认目标（可能已部分删除）：':'将永久删除以下变量发现台托管内容：');
 for(const name of plan.targets)console.log('- '+name);
 console.log('范围包括当前安装中的凭证、私有卡片、研究历史、同步进度，以及列出的托管工具和升级副本。删除后无法从这些位置恢复。');
 console.log('仅保留不含正文或密钥的卸载回执；系统 Node、外部 DSH、安装包、已导出文件及系统或外部备份保留。');
 const prompt=createInterface({input:process.stdin,output:process.stdout});let answer='';
 try{answer=await Promise.race([prompt.question('请先停止变量发现台。输入 DELETE 确认卸载；其他输入取消： '),new Promise(resolve=>prompt.once('close',()=>resolve('')))]);}
 finally{prompt.close();}
 if(answer.trim()!=='DELETE'){console.log('已取消，未删除安装或个人状态。');return;}
 const result=await uninstallPublicPlugin({...options,confirm:true,approval:plan.approval});
 console.log('变量发现台托管安装已卸载。外部备份仍需由你自行管理。');console.log(JSON.stringify(result));return result;
}
if(isCliEntrypoint(import.meta.url)){
 try{await uninstallInstalledBundle(process.argv.slice(2));}
 catch(error){console.error('卸载未完成。运行中或无法确认归属的状态会阻止删除；若卸载已中断，保留现场，待原进程退出后再运行 Uninstall 确认续接，不要手动删锁。');
  console.error(/^(PLUGIN_|PUBLIC_)[A-Z0-9_]+$/.test(error.code??'')?error.code:'PLUGIN_UNINSTALL_FAILED');process.exitCode=1;}
}
