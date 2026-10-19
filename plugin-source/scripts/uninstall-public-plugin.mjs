// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readPluginInput,readApprovedPluginArchive} from './install-public-plugin.mjs';
import {readApprovedInstalledPlugin} from './start-installed-plugin.mjs';
import {EXPECTED_DSH_VERSION} from './dsh-contract.mjs';
import {selectPublicTools} from './public-tools.mjs';
import {privateRoot,privateJson,digest,sameFile,writePrivateJson,syncDirectory,requireDead,
 claimRecovery,holdUpgradeLaunch,releaseUpgrade} from './plugin-upgrade-journal.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exists=async p=>{try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const targetName=n=>['installation','tools'].includes(n)||/^(upgrade|cleanup)-[A-Za-z0-9]+$/.test(n);
const approvalFor=owner=>digest(JSON.stringify({root:owner.rootIdentity,targets:owner.targets,retained:owner.retained}));
async function location(destination){
 if(typeof destination!=='string'||!path.isAbsolute(destination)||path.resolve(destination)!==destination
  ||path.basename(destination)!=='installation'||path.basename(path.dirname(destination))!=='.variable-os-plugin')fail('PLUGIN_DESTINATION_INVALID');
 const root=path.dirname(destination);await privateRoot(root);return root;
}
async function installed(destination){
 await privateRoot(destination);const r=JSON.parse(await readPluginInput(path.join(destination,'install-receipt.json'),16384));
 const descriptor={schema:1,version:r.version,dshVersion:EXPECTED_DSH_VERSION,publicReleaseQualified:false,
  bytes:(await fs.lstat(path.join(destination,'plugin.tgz'))).size,sha256:r.archiveSha256,manifestSha256:r.manifestSha256};
 await readApprovedPluginArchive(path.join(destination,'plugin.tgz'),descriptor);await readApprovedInstalledPlugin(destination,descriptor);return descriptor;
}
async function journal(directory,name,destination){
 const owner=await privateJson(path.join(directory,'transaction.json'));
 if((await fs.lstat(path.join(directory,'transaction.json'))).nlink!==1||owner.destination!==destination
  ||owner.transaction!==name||!/^[a-f0-9]{32}$/.test(owner.id??''))fail('PLUGIN_UNINSTALL_UNSAFE');
 const type=name.split('-')[0],receipt=await privateJson(path.join(directory,type+'-receipt.json'));
 if(type==='upgrade'){
  if(owner.schema!==3||receipt.schema!==3||receipt.transactionId!==owner.id||receipt.workerPid!==owner.workerPid
   ||receipt.backup!==path.join(directory,'previous')||receipt.archiveSha256!==owner.descriptor?.sha256
   ||receipt.previousArchiveSha256!==owner.previousDescriptor?.sha256
   ||!['UPGRADED_NOT_STARTED','ROLLED_BACK','RECOVERED_NOT_STARTED'].includes(receipt.status)
   ||!Array.isArray(receipt.commandGroups)||receipt.commandGroups.length>6)fail('PLUGIN_UNINSTALL_UNFINISHED_TRANSACTION');
  requireDead(owner.workerPid);
  const phases=['pnpm-version','dsh-version','install','compose','import','upgrade-compose'];
  for(const [i,row]of receipt.commandGroups.entries()){if(row.phase!==phases[i])fail('PLUGIN_UNINSTALL_UNSAFE');requireDead(row.pid,true);}
  if(receipt.recovery)requireDead(receipt.recovery.workerPid);
 }else{
  if(owner.schema!==1||owner.kind!==(type==='cleanup'?'PLUGIN_BACKUP_CLEANUP':'PLUGIN_UNINSTALL')
   ||receipt.schema!==1||receipt.id!==owner.id||!['COMPLETE','REJECTED'].includes(receipt.status))fail('PLUGIN_UNINSTALL_UNFINISHED_TRANSACTION');
  if((await fs.readdir(directory)).some(n=>n.startsWith('trash-')))fail('PLUGIN_UNINSTALL_UNFINISHED_TRANSACTION');
 }
 for(const n of await fs.readdir(directory))if(/^recover-[a-f0-9]{32}\.json$/.test(n))requireDead((await privateJson(path.join(directory,n))).pid);
 return digest(JSON.stringify({owner,receipt}));
}
async function inventory(destination,sourceRoot,{ignore}={}){
 const root=path.dirname(destination),rootStat=await fs.lstat(root),targets=[],retained=[];
 const names=(await fs.readdir(root)).filter(n=>n!==ignore&&!(ignore&&n==='install-entry.guard')).sort();
 for(const name of names){
  if(!targetName(name)&&!/^uninstall-[A-Za-z0-9]+$/.test(name))fail('PLUGIN_UNINSTALL_UNKNOWN_STATE');
  const directory=path.join(root,name);await privateRoot(directory);const stat=await fs.lstat(directory);let binding;
  if(name==='installation')binding=await installed(destination);
  else if(name==='tools'){
   if(!selectPublicTools({root,sourceRoot,env:{PATH:''}}))fail('PLUGIN_UNINSTALL_UNSAFE');
   binding=digest(JSON.stringify(await privateJson(path.join(directory,'.variable-os-tools.json'))));
  }else binding=await journal(directory,name,destination);
  const row={name,dev:stat.dev,ino:stat.ino,binding};
  (name.startsWith('uninstall-')?retained:targets).push(row);
 }
 if(targets.length>512||retained.length>512)fail('PLUGIN_UNINSTALL_UNSAFE');
 if(targets.length&&!targets.some(r=>r.name==='installation'))fail('PLUGIN_UNINSTALL_INSTALLATION_REQUIRED');
 targets.sort((a,b)=>a.name==='installation'?-1:b.name==='installation'?1:a.name.localeCompare(b.name));
 return {rootIdentity:{dev:rootStat.dev,ino:rootStat.ino},targets,retained};
}
async function save(tx,status){
 const file=path.join(tx.transaction,'.uninstall-'+randomBytes(16).toString('hex')+'.pending');
 await writePrivateJson(file,{schema:1,id:tx.owner.id,status});await fs.rename(file,path.join(tx.transaction,'uninstall-receipt.json'));await syncDirectory(tx.transaction);
}
async function bound(tx){
 await privateRoot(path.dirname(tx.guard));await privateRoot(tx.transaction);
 const a=await fs.lstat(tx.guard),b=await fs.lstat(path.join(tx.transaction,'transaction.json'));
 if(!sameFile(await fs.lstat(path.dirname(tx.guard)),tx.owner.rootIdentity)||!sameFile(a,b)||a.nlink!==2||b.nlink!==2
  ||digest(JSON.stringify(await privateJson(tx.guard)))!==digest(JSON.stringify(tx.owner)))fail('PLUGIN_UNINSTALL_UNBOUND');
}
async function readUninstall(destination){
 const root=path.dirname(destination),guard=path.join(root,'install-entry.guard');let owner;
 try{owner=await privateJson(guard);}catch{fail('PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED');}
 if(owner.schema!==1||owner.kind!=='PLUGIN_UNINSTALL'||owner.destination!==destination
  ||!/^uninstall-[A-Za-z0-9]+$/.test(owner.transaction??'')||!/^[a-f0-9]{32}$/.test(owner.id??'')
  ||!Array.isArray(owner.targets)||owner.targets.length<1||owner.targets.length>512
  ||!Array.isArray(owner.retained)||owner.retained.length>512)fail('PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED');
 const rows=[owner.rootIdentity,...owner.targets,...owner.retained];
 if(rows.some(r=>!r||!Number.isSafeInteger(r.dev)||!Number.isSafeInteger(r.ino)||r.ino<1)
  ||owner.targets.some(r=>!targetName(r.name))||owner.retained.some(r=>!/^uninstall-[A-Za-z0-9]+$/.test(r.name??''))
  ||owner.targets[0].name!=='installation'||new Set([...owner.targets,...owner.retained].map(r=>r.name)).size!==owner.targets.length+owner.retained.length)fail('PLUGIN_UNINSTALL_UNSAFE');
 const tx={owner,guard,transaction:path.join(root,owner.transaction)};await bound(tx);requireDead(owner.workerPid);
 const receipt=await privateJson(path.join(tx.transaction,'uninstall-receipt.json'));
 if(receipt.schema!==1||receipt.id!==owner.id||!['ADMITTED','REMOVING','COMPLETE','REJECTED'].includes(receipt.status))fail('PLUGIN_UNINSTALL_UNSAFE');
 tx.status=receipt.status;return tx;
}
export async function inspectPluginUninstall({destination,sourceRoot}={}){
 await location(destination);const guard=path.join(path.dirname(destination),'install-entry.guard');
 const tx=await exists(guard)?await readUninstall(destination):null;
 const owner=tx?.owner??await inventory(destination,sourceRoot);
 return {resuming:!!tx,approval:approvalFor(owner),targets:owner.targets.map(r=>r.name),diagnosticsRetained:true,fullDelivery:false};
}
export async function uninstallPublicPlugin({destination,sourceRoot,confirm,approval}={}){
 if(confirm!==true)fail('PLUGIN_UNINSTALL_CONFIRMATION_REQUIRED');
 if(!/^[a-f0-9]{64}$/.test(approval??''))fail('PLUGIN_UNINSTALL_APPROVAL_REQUIRED');
 const root=await location(destination),guard=path.join(root,'install-entry.guard');let tx,resuming=false;
 if(await exists(guard)){
  tx=await readUninstall(destination);if(approval!==approvalFor(tx.owner))fail('PLUGIN_UNINSTALL_APPROVAL_CHANGED');
  await claimRecovery(tx);await bound(tx);resuming=true;
 }else{
  const plan=await inventory(destination,sourceRoot);if(approval!==approvalFor(plan))fail('PLUGIN_UNINSTALL_APPROVAL_CHANGED');
  if(!plan.targets.length)return {status:'UNINSTALLED',deletedTargets:0,diagnosticsRetained:true,fullDelivery:false};
  const transaction=await fs.mkdtemp(path.join(root,'uninstall-'));
  const owner={schema:1,kind:'PLUGIN_UNINSTALL',id:randomBytes(16).toString('hex'),transaction:path.basename(transaction),destination,workerPid:process.pid,...plan};
  tx={owner,transaction,guard};await writePrivateJson(path.join(transaction,'transaction.json'),owner);
  await writePrivateJson(path.join(transaction,'launch-owner.json'),{version:1,instance:owner.id});await save(tx,'ADMITTED');
  try{await fs.link(path.join(transaction,'transaction.json'),guard);await syncDirectory(root);}catch(e){if(e.code==='EEXIST')fail('PLUGIN_INSTALL_BUSY_OR_RECOVERY_REQUIRED');throw e;}
 }
 let release,locked=false,destructive=resuming&&['REMOVING','COMPLETE'].includes(tx.status);
 try{
  await bound(tx);
  const current=await exists(destination),staged=await exists(path.join(tx.transaction,'trash-0'));
  if(current&&staged)fail('PLUGIN_UNINSTALL_AMBIGUOUS');
  if(current){
   if(!current.isDirectory()||!sameFile(current,tx.owner.targets[0]))fail('PLUGIN_UNINSTALL_STATE_CHANGED');
   const lock=await exists(path.join(destination,'launch/public-launch.lock'));
   if(lock){if(!sameFile(lock,await fs.lstat(path.join(tx.transaction,'launch-owner.json'))))fail('PUBLIC_DESK_BUSY');}
   else release=await holdUpgradeLaunch(tx,destination,()=>{});
   locked=true;
  }else if(!destructive)fail('PLUGIN_UNINSTALL_STATE_CHANGED');
  if(!destructive&&approvalFor(await inventory(destination,sourceRoot,{ignore:tx.owner.transaction}))!==approvalFor(tx.owner))fail('PLUGIN_UNINSTALL_STATE_CHANGED');
  const expected=new Set(['install-entry.guard',tx.owner.transaction,...tx.owner.targets.map(r=>r.name),...tx.owner.retained.map(r=>r.name)]);
  if((await fs.readdir(root)).some(n=>!expected.has(n)))fail('PLUGIN_UNINSTALL_UNKNOWN_STATE');
  await save(tx,'REMOVING');destructive=true;
  for(const [i,row]of tx.owner.targets.entries()){
   await bound(tx);const from=path.join(root,row.name),trash=path.join(tx.transaction,'trash-'+i);
   const a=await exists(from),b=await exists(trash);if(a&&b)fail('PLUGIN_UNINSTALL_AMBIGUOUS');const selected=a??b;if(!selected)continue;
   if(!selected.isDirectory()||!sameFile(selected,row))fail('PLUGIN_UNINSTALL_STATE_CHANGED');
   if(a){await fs.rename(from,trash);await syncDirectory(root);await syncDirectory(tx.transaction);}
   await privateRoot(trash);if(!sameFile(await fs.lstat(trash),row))fail('PLUGIN_UNINSTALL_STATE_CHANGED');
   await bound(tx);await fs.rm(trash,{recursive:true});await syncDirectory(tx.transaction);
  }
  await save(tx,'COMPLETE');await releaseUpgrade(tx,null);
  return {status:'UNINSTALLED',deletedTargets:tx.owner.targets.length,diagnosticsRetained:true,fullDelivery:false};
 }catch(e){if(!destructive){await save(tx,'REJECTED');await releaseUpgrade(tx,locked?path.join(destination,'launch'):null);}throw e;}
 finally{release?.();}
}
