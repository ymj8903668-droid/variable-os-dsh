// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {readApprovedPluginArchive} from './install-public-plugin.mjs';
import {readApprovedInstalledPlugin} from './start-installed-plugin.mjs';
import {privateRoot,stateSnapshot,readUpgradeTransaction,requireDead,claimRecovery,
  sameFile,digest,writeReceipt,releaseUpgrade,syncDirectory} from './plugin-upgrade-journal.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exists=async file=>{try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
async function verifyOld(tx,root){
 await privateRoot(root);
 await readApprovedPluginArchive(path.join(root,'plugin.tgz'),tx.owner.previousDescriptor);
 await readApprovedInstalledPlugin(root,tx.owner.previousDescriptor,{profileDestination:tx.owner.destination});
 if(tx.receipt.stateSha256!==null && digest(JSON.stringify(await stateSnapshot(root)))!==tx.receipt.stateSha256)fail('PLUGIN_RECOVERY_STATE_CHANGED');
}
async function verifyLaunch(tx,root){
 const file=path.join(root,'launch/public-launch.lock');
 if(await exists(file) && !sameFile(await fs.lstat(file),await fs.lstat(path.join(tx.transaction,'launch-owner.json'))))fail('PLUGIN_RECOVERY_FOREIGN_LAUNCH');
}
export async function recoverPublicPlugin({destination,confirm}={}){
 if(confirm!==true)fail('PLUGIN_RECOVERY_CONFIRMATION_REQUIRED');
 if(typeof destination!=='string'||!path.isAbsolute(destination)||path.resolve(destination)!==destination)fail('PLUGIN_DESTINATION_INVALID');
 const tx=await readUpgradeTransaction(destination),{owner,transaction}=tx;
 let {receipt}=tx;
 requireDead(owner.workerPid);
 const phases=['pnpm-version','dsh-version','install','compose','import','upgrade-compose'];
 for(const [index,row]of receipt.commandGroups.entries()){
  if(row.phase!==phases[index])fail('PLUGIN_RECOVERY_UNSAFE');requireDead(row.pid,true);
 }
 await claimRecovery(tx);
 // Admission is still the exact original transaction after claiming recovery.
 const current=await readUpgradeTransaction(destination);
 if(current.transaction!==transaction||JSON.stringify(current.owner)!==JSON.stringify(owner))fail('PLUGIN_RECOVERY_UNBOUND');
 receipt=tx.receipt=current.receipt;
 requireDead(owner.workerPid);
 for(const [index,row]of receipt.commandGroups.entries()){
  if(row.phase!==phases[index])fail('PLUGIN_RECOVERY_UNSAFE');requireDead(row.pid,true);
 }
 const backup=path.join(transaction,'previous'),failed=path.join(transaction,'failed');
 const action=receipt.recovery?.action ?? (receipt.status==='UPGRADED_NOT_STARTED'?'KEEP_COMMITTED':'RESTORE_PREVIOUS');
 if(!['KEEP_COMMITTED','RESTORE_PREVIOUS'].includes(action))fail('PLUGIN_RECOVERY_UNSAFE');
 if(receipt.stateSha256===null && ((receipt.recovery?.initialStatus??receipt.status)!=='ADMITTED'||await exists(backup)))fail('PLUGIN_RECOVERY_UNSAFE');
 if(action==='KEEP_COMMITTED'){
  await verifyOld(tx,backup);await verifyLaunch(tx,backup);await verifyLaunch(tx,destination);
  await readApprovedPluginArchive(path.join(destination,'plugin.tgz'),owner.descriptor);
  await readApprovedInstalledPlugin(destination,owner.descriptor);
  if(digest(JSON.stringify(await stateSnapshot(destination)))!==receipt.stateSha256)fail('PLUGIN_RECOVERY_STATE_CHANGED');
 }else if(await exists(backup)){
  await verifyOld(tx,backup);await verifyLaunch(tx,backup);
  if(await exists(destination)){
   await privateRoot(destination);await verifyLaunch(tx,destination);
   if(await exists(failed))fail('PLUGIN_RECOVERY_AMBIGUOUS_STATE');
  }
 }else{await verifyOld(tx,destination);await verifyLaunch(tx,destination);}
 receipt.recovery={action,initialStatus:receipt.recovery?.initialStatus??receipt.status,workerPid:process.pid,hostStarted:false,authorizationRevalidated:false};
 await writeReceipt(transaction,receipt);
 if(action==='RESTORE_PREVIOUS'&&await exists(backup)){
  if(await exists(destination)){await fs.rename(destination,failed);await syncDirectory(path.dirname(destination));await syncDirectory(transaction);}
  await fs.rename(backup,destination);await syncDirectory(path.dirname(destination));await syncDirectory(transaction);
  await verifyOld(tx,destination);
 }
 receipt.status='RECOVERED_NOT_STARTED';await writeReceipt(transaction,receipt);
 await releaseUpgrade(tx,path.join(action==='KEEP_COMMITTED'?backup:destination,'launch'));
 return {schema:1,status:'RECOVERED_NOT_STARTED',action,transaction:path.basename(transaction),
   hostStarted:false,authorizationRevalidated:false,fullDelivery:false};
}
