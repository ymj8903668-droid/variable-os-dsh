// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readPluginInput,readApprovedPluginArchive} from './install-public-plugin.mjs';
import {readApprovedInstalledPlugin} from './start-installed-plugin.mjs';
import {EXPECTED_DSH_VERSION} from './dsh-contract.mjs';
import {privateRoot,privateJson,digest,sameFile,writePrivateJson,syncDirectory,requireDead,
  claimRecovery,holdUpgradeLaunch,releaseUpgrade} from './plugin-upgrade-journal.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exists=async p=>{try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
import {listCompletedPluginBackupPayloads as targets} from './plugin-backup-inventory.mjs';
const approvalFor=owner=>digest(JSON.stringify({descriptor:owner.descriptor,targets:owner.targets}));
const checkApproval=(owner,approval)=>{if(approval!==undefined&&approval!==approvalFor(owner))fail('PLUGIN_CLEANUP_APPROVAL_CHANGED');};
async function location(destination){
 if(typeof destination!=='string'||!path.isAbsolute(destination)||path.resolve(destination)!==destination
   ||path.basename(destination)!=='installation')fail('PLUGIN_DESTINATION_INVALID');
 await privateRoot(path.dirname(destination));
 if(await exists(path.join(path.dirname(destination),'preflight-recovery.json')))fail('PLUGIN_PREFLIGHT_CHILDREN_REMAIN');
}
async function installed(destination){
 await privateRoot(destination);
 const r=JSON.parse(await readPluginInput(path.join(destination,'install-receipt.json'),16384));
 const descriptor={schema:1,version:r.version,dshVersion:EXPECTED_DSH_VERSION,publicReleaseQualified:false,
   bytes:(await fs.lstat(path.join(destination,'plugin.tgz'))).size,sha256:r.archiveSha256,manifestSha256:r.manifestSha256};
 await readApprovedPluginArchive(path.join(destination,'plugin.tgz'),descriptor);
 await readApprovedInstalledPlugin(destination,descriptor);return descriptor;
}
export async function inspectPluginBackups({destination}={}){
 await location(destination);
 if(await exists(path.join(path.dirname(destination),'install-entry.guard'))){
  const tx=await readCleanup(destination,{claim:false});
  return {resuming:true,approval:approvalFor(tx.owner),targets:tx.owner.targets.map(({transaction,payload})=>({transaction,payload})),fullDelivery:false};
 }
 const owner={descriptor:await installed(destination),targets:await targets(destination)};
 return {approval:approvalFor(owner),targets:owner.targets.map(({transaction,payload})=>({transaction,payload})),fullDelivery:false};
}
async function save(tx,status){
 const file=path.join(tx.transaction,'.cleanup-'+randomBytes(16).toString('hex')+'.pending');
 await writePrivateJson(file,{schema:1,id:tx.owner.id,status});
 await fs.rename(file,path.join(tx.transaction,'cleanup-receipt.json'));await syncDirectory(tx.transaction);
}
async function bound(tx){
 const a=await fs.lstat(tx.guard),b=await fs.lstat(path.join(tx.transaction,'transaction.json'));
 if(!sameFile(a,b)||a.nlink!==2||b.nlink!==2
   ||digest(JSON.stringify(await privateJson(tx.guard)))!==digest(JSON.stringify(tx.owner)))fail('PLUGIN_CLEANUP_UNBOUND');
}
async function readCleanup(destination,{claim=true}={}){
 const guard=path.join(path.dirname(destination),'install-entry.guard');
 let owner;try{owner=await privateJson(guard);}catch{fail('PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED');}
 if(owner.schema!==1||owner.kind!=='PLUGIN_BACKUP_CLEANUP'||owner.destination!==destination
  ||!/^cleanup-[A-Za-z0-9]+$/.test(owner.transaction??'')||!/^[a-f0-9]{32}$/.test(owner.id??'')
  ||!Array.isArray(owner.targets)||owner.targets.length>512)fail('PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED');
 for(const row of owner.targets)if(!/^upgrade-[A-Za-z0-9]+$/.test(row.transaction??'')||!['previous','failed'].includes(row.payload)
  ||!Number.isSafeInteger(row.dev)||!Number.isSafeInteger(row.ino)||row.ino<1
  ||![row.ownerDigest,row.receiptDigest].every(v=>/^[a-f0-9]{64}$/.test(v??'')))fail('PLUGIN_CLEANUP_UNSAFE');
 if(new Set(owner.targets.map(r=>r.transaction+'/'+r.payload)).size!==owner.targets.length)fail('PLUGIN_CLEANUP_UNSAFE');
 const transaction=path.join(path.dirname(destination),owner.transaction);await privateRoot(transaction);
 const tx={owner,transaction,guard};await bound(tx);requireDead(owner.workerPid);
 if(claim)await claimRecovery(tx);await bound(tx);return tx;
}
export async function cleanupPluginBackups({destination,confirm,approval}={}){
 if(confirm!==true)fail('PLUGIN_CLEANUP_CONFIRMATION_REQUIRED');
 await location(destination);
 const guard=path.join(path.dirname(destination),'install-entry.guard');let tx,resuming=false;
 if(await exists(guard)){
  tx=await readCleanup(destination,{claim:false});checkApproval(tx.owner,approval);
  await claimRecovery(tx);await bound(tx);resuming=true;
 }
 else{
  const descriptor=await installed(destination),plan=await targets(destination);
  checkApproval({descriptor,targets:plan},approval);
  if(!plan.length)return {status:'BACKUPS_CLEANED',deletedPayloads:0,diagnosticsRetained:true,fullDelivery:false};
  const transaction=await fs.mkdtemp(path.join(path.dirname(destination),'cleanup-'));
  const owner={schema:1,kind:'PLUGIN_BACKUP_CLEANUP',id:randomBytes(16).toString('hex'),transaction:path.basename(transaction),
    destination,workerPid:process.pid,descriptor,targets:plan};
  tx={owner,transaction,guard};await writePrivateJson(path.join(transaction,'transaction.json'),owner);
  await writePrivateJson(path.join(transaction,'launch-owner.json'),{version:1,instance:owner.id});await save(tx,'ADMITTED');
  try{await fs.link(path.join(transaction,'transaction.json'),guard);await syncDirectory(path.dirname(guard));}
  catch(e){if(e.code==='EEXIST')fail('PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED');throw e;}
 }
 const launch=path.join(destination,'launch');let release,locked=false,destructive=resuming;
 try{
  await bound(tx);
  const lock=await exists(path.join(launch,'public-launch.lock'));
  if(lock){if(!sameFile(lock,await fs.lstat(path.join(tx.transaction,'launch-owner.json'))))fail('PUBLIC_DESK_BUSY');}
  else release=await holdUpgradeLaunch(tx,destination,()=>{});
  locked=true;
  if(JSON.stringify(await installed(destination))!==JSON.stringify(tx.owner.descriptor))fail('PLUGIN_CLEANUP_INSTALLATION_CHANGED');
  // Recheck live workers and the full target inventory under both guards before
  // starting. On resumption, immutable inode bindings replace partially removed
  // payload contents; a different directory can never be substituted for trash.
  if(!resuming&&JSON.stringify(await targets(destination))!==JSON.stringify(tx.owner.targets))fail('PLUGIN_CLEANUP_STATE_CHANGED');
  await save(tx,'REMOVING');
  for(const [index,row]of tx.owner.targets.entries()){
   await bound(tx);
   const directory=path.join(path.dirname(destination),row.transaction);await privateRoot(directory);
   if(digest(JSON.stringify(await privateJson(path.join(directory,'transaction.json'))))!==row.ownerDigest
     ||digest(JSON.stringify(await privateJson(path.join(directory,'upgrade-receipt.json'))))!==row.receiptDigest)fail('PLUGIN_CLEANUP_STATE_CHANGED');
   const from=path.join(directory,row.payload),trash=path.join(tx.transaction,'trash-'+index);
   const [source,staged]=await Promise.all([exists(from),exists(trash)]);
   if(source&&staged)fail('PLUGIN_CLEANUP_AMBIGUOUS');
   const selected=source??staged;
   if(!selected)continue;
   if(!selected.isDirectory()||!sameFile(selected,row))fail('PLUGIN_CLEANUP_STATE_CHANGED');
   destructive=true;
   if(source){await fs.rename(from,trash);await syncDirectory(directory);await syncDirectory(tx.transaction);}
   await privateRoot(trash);
   if(!sameFile(await fs.lstat(trash),row))fail('PLUGIN_CLEANUP_STATE_CHANGED');
   await bound(tx);await fs.rm(trash,{recursive:true});await syncDirectory(tx.transaction);
  }
  await save(tx,'COMPLETE');await releaseUpgrade(tx,launch);locked=false;
  return {status:'BACKUPS_CLEANED',deletedPayloads:tx.owner.targets.length,diagnosticsRetained:true,fullDelivery:false};
 }catch(e){
  if(!destructive){await save(tx,'REJECTED');await releaseUpgrade(tx,locked?launch:null);}
  throw e;
 }finally{release?.();}
}
