// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {isCliEntrypoint} from './cli-entrypoint.mjs';
import {inspectPluginBackups,cleanupPluginBackups} from './cleanup-plugin-backups.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function cleanupInstalledBundle(args=[]){
 if(args.length)fail('PLUGIN_CLEANUP_ARGUMENTS_INVALID');
 if(process.versions.node.split('.')[0]!=='24')fail('PLUGIN_TOOLCHAIN_INCOMPATIBLE');
 if(!process.env.HOME||!path.isAbsolute(process.env.HOME))fail('PLUGIN_BUNDLE_STATE_INVALID');
 const home=await fs.realpath(process.env.HOME),stat=await fs.lstat(home);
 if(!stat.isDirectory()||stat.uid!==process.getuid?.()||stat.mode&0o022)fail('PLUGIN_BUNDLE_STATE_INVALID');
 const root=path.join(home,'.variable-os-plugin'),destination=path.join(root,'installation');
 try{await fs.lstat(root);}catch(e){if(e.code!=='ENOENT')throw e;console.log('没有变量发现台安装状态，无需清理。');return;}
 const plan=await inspectPluginBackups({destination});
 if(!plan.targets.length){console.log('没有已完成事务的备份或失败候选，无需清理。');return;}
 console.log(plan.resuming?'上次清理中断，将续接同一批目标（可能已部分删除）：':'将删除以下已完成升级事务的备份或失败候选：');
 for(const row of plan.targets)console.log(`- ${row.transaction}/${row.payload}`);
 console.log('这些副本可能包含旧凭证、私有卡片和研究历史。删除后不能从中恢复；保留当前安装及其数据、工具链和诊断记录。');
 const prompt=createInterface({input:process.stdin,output:process.stdout});let answer='';
 try{answer=await Promise.race([prompt.question('请先停止变量发现台。输入 DELETE 确认永久删除上述副本；其他输入取消： '),new Promise(resolve=>prompt.once('close',()=>resolve('')))]);}
 finally{prompt.close();}
 if(answer.trim()!=='DELETE'){console.log('已取消，未删除备份或个人状态。');return;}
 const result=await cleanupPluginBackups({destination,confirm:true,approval:plan.approval});
 console.log('备份副本清理完成，当前安装保持保留。本操作不等于卸载，也不删除系统或外部备份。');
 console.log(JSON.stringify(result));return result;
}
if(isCliEntrypoint(import.meta.url)){
 try{await cleanupInstalledBundle(process.argv.slice(2));}
 catch(error){
  const code=/^(PLUGIN_|PUBLIC_)[A-Z0-9_]+$/.test(error.code??'')?error.code:'PLUGIN_CLEANUP_FAILED';
  console.error('清理未完成。若已有清理保护，保留现场并在相关进程退出后再次运行 Cleanup 确认续接；不要手动删锁。');
  console.error(code);process.exitCode=1;
 }
}
