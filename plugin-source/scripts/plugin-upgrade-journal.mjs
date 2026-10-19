// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import fsSync,{constants,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {readPluginInput} from './install-public-plugin.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const active=signal=>{if(signal?.aborted)fail('PLUGIN_INSTALL_CANCELLED');};
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const managed = new Set(['node_modules','package.json','pnpm-lock.yaml','pnpm-workspace.yaml',
  'cordis.yml','.plugin-manager']);
function copied(name) {
  // pnpm regenerates its update-check timestamp during a fresh installation.
  // Keep the new tool metadata; adjacent user files remain durable state.
  if(name==='home/.local/state/pnpm/pnpm-state.json') return false;
  const prefix = 'home/.dsh/profiles/web/';
  return !name.startsWith(prefix) || !managed.has(name.slice(prefix.length).split('/')[0]);
}
export async function privateRoot(root) {
  if(typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) fail('PLUGIN_DESTINATION_INVALID');
  const stat = await fs.lstat(root);
  if(!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()
    || await fs.realpath(root) !== root) fail('PUBLIC_STATE_UNSAFE');
}
export async function stateSnapshot(root, signal) {
  const rows=[];
  async function walk(name) {
    active(signal);
    if(!copied(name)) return;
    const file=path.join(root,name), stat=await fs.lstat(file);
    const row={path:name,mode:stat.mode & 0o777};
    if(stat.isSymbolicLink()) rows.push({...row,link:await fs.readlink(file)});
    else if(stat.isDirectory()) {
      rows.push({...row,directory:true});
      for(const entry of (await fs.readdir(file)).sort()) await walk(name+'/'+entry);
    } else if(stat.isFile()) {
      const hash=createHash('sha256');
      for await(const bytes of createReadStream(file,{flags:constants.O_RDONLY|constants.O_NOFOLLOW})) {active(signal);hash.update(bytes);}
      rows.push({...row,bytes:stat.size,sha256:hash.digest('hex')});
    } else fail('PLUGIN_UPGRADE_STATE_UNSUPPORTED');
  }
  for(const name of ['home','config','workspace']) {
    try {await fs.lstat(path.join(root,name));} catch(error) {if(error.code==='ENOENT')continue;throw error;}
    await walk(name);
  }
  return rows;
}
export async function syncDirectory(directory){const h=await fs.open(directory,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
export async function writePrivateJson(file,value){
 const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
}
export async function writeReceipt(directory,receipt){
 const pending=path.join(directory,'.upgrade-receipt-'+randomBytes(16).toString('hex')+'.pending');
 await writePrivateJson(pending,receipt);await fs.rename(pending,path.join(directory,'upgrade-receipt.json'));await syncDirectory(directory);
}
export async function privateJson(file,limit=65536){
 const stat=await fs.lstat(file);if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.mode&0o077)fail('PLUGIN_RECOVERY_UNSAFE');
 return JSON.parse(await readPluginInput(file,limit));
}
export async function createUpgradeTransaction(destination,previousDescriptor,descriptor){
 const parent=path.dirname(destination),transaction=await fs.mkdtemp(path.join(parent,'upgrade-'));
 const owner={schema:3,id:randomBytes(16).toString('hex'),transaction:path.basename(transaction),destination,
   workerPid:process.pid,previousDescriptor,descriptor};
 await writePrivateJson(path.join(transaction,'transaction.json'),owner);
 await writePrivateJson(path.join(transaction,'launch-owner.json'),{version:1,instance:owner.id});
 const receipt={schema:3,transactionId:owner.id,workerPid:process.pid,commandGroups:[],stateSha256:null,
   status:'ADMITTED',previousArchiveSha256:previousDescriptor.sha256,archiveSha256:descriptor.sha256,
   backup:path.join(transaction,'previous'),hostStarted:false,fullDelivery:false,stateEntries:0};
 await writeReceipt(transaction,receipt);
 const guard=path.join(parent,'install-entry.guard');
 try{await fs.link(path.join(transaction,'transaction.json'),guard);await syncDirectory(parent);}
 catch(e){fail(e.code==='EEXIST'?'PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED':'PLUGIN_INSTALL_GUARD_FAILED');}
 return {transaction,owner,receipt,guard};
}
export async function readUpgradeTransaction(destination){
 try{await privateRoot(path.dirname(destination));}catch(e){if(e.code==='ENOENT')fail('PLUGIN_RECOVERY_NOT_REQUIRED');throw e;}
 const guard=path.join(path.dirname(destination),'install-entry.guard');let owner;
 try{owner=await privateJson(guard);}catch(e){if(e.code==='ENOENT')fail('PLUGIN_RECOVERY_NOT_REQUIRED');fail('PLUGIN_RECOVERY_UNBOUND');}
 if(owner?.schema!==3||owner.destination!==destination||!/^upgrade-[A-Za-z0-9]+$/.test(owner.transaction??'')
   ||!/^[a-f0-9]{32}$/.test(owner.id??''))fail('PLUGIN_RECOVERY_UNBOUND');
 const transaction=path.join(path.dirname(destination),owner.transaction);await privateRoot(transaction);
 const linked=await fs.lstat(guard),original=await fs.lstat(path.join(transaction,'transaction.json'));
 if(!sameFile(linked,original)||linked.nlink!==2||original.nlink!==2)fail('PLUGIN_RECOVERY_UNBOUND');
 const receipt=await privateJson(path.join(transaction,'upgrade-receipt.json'));
 if(receipt.schema!==3||receipt.transactionId!==owner.id||receipt.workerPid!==owner.workerPid
   ||receipt.backup!==path.join(transaction,'previous')||receipt.previousArchiveSha256!==owner.previousDescriptor?.sha256
   ||receipt.archiveSha256!==owner.descriptor?.sha256||!Array.isArray(receipt.commandGroups)||receipt.commandGroups.length>6
   ||!['ADMITTED','PREPARED','INSTALLING','UPGRADED_NOT_STARTED','ROLLED_BACK','RECOVERY_REQUIRED','RECOVERED_NOT_STARTED'].includes(receipt.status)
   ||(receipt.stateSha256!==null&&!/^[a-f0-9]{64}$/.test(receipt.stateSha256)))fail('PLUGIN_RECOVERY_UNSAFE');
 return {transaction,owner,receipt,guard};
}
function linuxNonLeaderThread(pid){
 if(process.platform!=='linux')return false;
 const identity=file=>{
  const text=fsSync.readFileSync(file,'utf8');
  if(text.length>65536)return null;
  const fields={};
  for(const key of ['Pid','Tgid']){
   const rows=text.split('\n').filter(row=>row.startsWith(key+':'));
   if(rows.length!==1)return null;
   const match=new RegExp('^'+key+':[\\t ]+([1-9][0-9]*)$').exec(rows[0]);
   const value=match?Number(match[1]):NaN;
   if(!Number.isSafeInteger(value))return null;
   fields[key]=value;
  }
  return fields;
 };
 try{
  // A proc mount in a different PID namespace cannot establish this identity.
  const self=identity('/proc/self/status');
  if(self?.Pid!==process.pid||self.Tgid!==process.pid)return false;
  const current=identity(`/proc/${pid}/status`);
  return current?.Pid===pid&&current.Tgid!==pid;
 }catch{return false;}
}
export function requireDead(pid,group=false){
 if(!Number.isSafeInteger(pid)||pid<=1)fail('PLUGIN_RECOVERY_UNSAFE');
 try{process.kill(group?-pid:pid,0);}catch(e){if(e.code==='ESRCH')return;fail('PLUGIN_RECOVERY_PROCESS_ACTIVE');}
 // Workers are process leaders. Linux kill(pid, 0) also accepts a nonleader TID
 // reusing an exited worker's number; /proc Pid/Tgid distinguishes that case.
 // Live leaders (including PID reuse), groups and unknown identities stay closed.
 if(!group&&linuxNonLeaderThread(pid))return;
 fail('PLUGIN_RECOVERY_PROCESS_ACTIVE');
}
export async function holdUpgradeLaunch(tx,destination,onStop){
 const root=path.join(destination,'launch');try{await fs.mkdir(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await privateRoot(root);
 try{await fs.link(path.join(tx.transaction,'launch-owner.json'),path.join(root,'public-launch.lock'));await syncDirectory(root);}
 catch(e){fail(e.code==='EEXIST'?'PUBLIC_DESK_BUSY':'PUBLIC_STATE_UNSAFE');}
 const request=path.join(root,'public-stop-'+tx.owner.id+'.request');
 const timer=setInterval(async()=>{try{const s=await fs.lstat(request);if(s.isFile()&&s.nlink===1&&s.size===0&&s.uid===process.getuid?.()&&!(s.mode&0o077))onStop();}catch{}},50);
 return ()=>clearInterval(timer);
}
export async function releaseUpgrade(tx,lockRoot){
 if(lockRoot){
 const owned=await fs.lstat(path.join(tx.transaction,'launch-owner.json'));
 const lock=path.join(lockRoot,'public-launch.lock');
 try{const current=await fs.lstat(lock);if(!sameFile(current,owned))fail('PLUGIN_RECOVERY_FOREIGN_LAUNCH');await fs.unlink(lock);await syncDirectory(lockRoot);}
 catch(e){if(e.code!=='ENOENT')throw e;}
 }
 const guard=await fs.lstat(tx.guard),owner=await fs.lstat(path.join(tx.transaction,'transaction.json'));
 if(!sameFile(guard,owner))fail('PLUGIN_RECOVERY_UNBOUND');
 await fs.unlink(tx.guard);await syncDirectory(path.dirname(tx.guard));
}
// Recovery attempts form an append-only ownership chain. An atomic hard link
// admits one successor of a dead owner; no check-then-delete stale-lock race.
export async function claimRecovery(tx){
 let link=path.join(tx.transaction,'recovery-owner');
 for(let depth=0;depth<128;depth++){
  let prior;
  try{prior=await privateJson(link);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(prior){
   if(!/^[a-f0-9]{32}$/.test(prior.id??''))fail('PLUGIN_RECOVERY_UNSAFE');
   const original=path.join(tx.transaction,'recover-'+prior.id+'.json');
   if(!sameFile(await fs.lstat(link),await fs.lstat(original)))fail('PLUGIN_RECOVERY_UNSAFE');
   requireDead(prior.pid);link=path.join(tx.transaction,'recover-'+prior.id+'.next');continue;
  }
  const claim={id:randomBytes(16).toString('hex'),pid:process.pid};
  const file=path.join(tx.transaction,'recover-'+claim.id+'.json');await writePrivateJson(file,claim);
  try{await fs.link(file,link);await syncDirectory(tx.transaction);return claim;}
  catch(e){if(e.code!=='EEXIST')throw e;}
 }
 fail('PLUGIN_RECOVERY_UNSAFE');
}
