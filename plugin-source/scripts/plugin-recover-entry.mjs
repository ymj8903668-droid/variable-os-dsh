// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {isCliEntrypoint} from './cli-entrypoint.mjs';
import {recoverPublicPlugin} from './recover-public-plugin.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function recoverInstalledBundle(args=[]){
 if(args.length)fail('PLUGIN_RECOVERY_ARGUMENTS_INVALID');
 if(process.versions.node.split('.')[0]!=='24')fail('PLUGIN_TOOLCHAIN_INCOMPATIBLE');
 if(!process.env.HOME||!path.isAbsolute(process.env.HOME))fail('PLUGIN_BUNDLE_STATE_INVALID');
 const home=await fs.realpath(process.env.HOME),stat=await fs.lstat(home);
 if(!stat.isDirectory()||stat.uid!==process.getuid?.()||stat.mode&0o022)fail('PLUGIN_BUNDLE_STATE_INVALID');
 const prompt=createInterface({input:process.stdin,output:process.stdout});let answer='';
 try{answer=await Promise.race([prompt.question('检查并恢复本次中断的升级？保留失败现场，不启动、不联网、不重跑安装。[y/N] '),new Promise(resolve=>prompt.once('close',()=>resolve('')))]);}
 finally{prompt.close();}
 if(answer.trim().toLowerCase()!=='y'){console.log('已取消，未更改安装或个人状态。');return;}
 const receipt=await recoverPublicPlugin({destination:path.join(home,'.variable-os-plugin/installation'),confirm:true});
 console.log('中断事务已恢复，尚未启动。信源当前授权仍须在启动时重新核验。');
 console.log(receipt.action==='RESTORE_PREVIOUS'?'已恢复原版本，请使用保留的原版本文件夹中的 Start 启动。':'已保留提交完成的新版本，可使用当前文件夹中的 Start 启动。');
 console.log(JSON.stringify(receipt));return receipt;
}
if(isCliEntrypoint(import.meta.url)){
 try{await recoverInstalledBundle(process.argv.slice(2));}
 catch(error){
  const code=/^(PLUGIN_|PUBLIC_)[A-Z0-9_]+$/.test(error.code??'')?error.code:'PLUGIN_RECOVERY_FAILED';
  if(code==='PLUGIN_RECOVERY_NOT_REQUIRED')console.log('没有需要恢复的中断事务，无需恢复。');
  else {console.error('恢复未完成，保护目录、备份和失败现场保持保留。不要手动删锁或覆盖安装目录。');console.error(code);process.exitCode=1;}
 }
}
