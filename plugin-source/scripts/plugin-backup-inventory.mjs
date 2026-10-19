// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {privateRoot,privateJson,digest,requireDead} from './plugin-upgrade-journal.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exists=async p=>{try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const phases=['pnpm-version','dsh-version','install','compose','import','upgrade-compose'];
const terminal=new Set(['UPGRADED_NOT_STARTED','ROLLED_BACK','RECOVERED_NOT_STARTED']);
export async function listCompletedPluginBackupPayloads(destination){
 const root=path.dirname(destination),selected=[];
 for(const name of (await fs.readdir(root)).sort()){
  if(!/^upgrade-[A-Za-z0-9]+$/.test(name))continue;
  const directory=path.join(root,name);await privateRoot(directory);
  const payloads=[];
  for(const payload of ['previous','failed'])if(await exists(path.join(directory,payload)))payloads.push(payload);
  if(!payloads.length)continue;
  const owner=await privateJson(path.join(directory,'transaction.json')),
    receipt=await privateJson(path.join(directory,'upgrade-receipt.json'));
  if(owner.schema!==3||owner.transaction!==name||owner.destination!==destination||!/^[a-f0-9]{32}$/.test(owner.id??'')
    ||receipt.schema!==3||receipt.transactionId!==owner.id||receipt.workerPid!==owner.workerPid
    ||receipt.backup!==path.join(directory,'previous')||receipt.previousArchiveSha256!==owner.previousDescriptor?.sha256
    ||receipt.archiveSha256!==owner.descriptor?.sha256||!terminal.has(receipt.status)
    ||!Array.isArray(receipt.commandGroups)||receipt.commandGroups.length>6)fail('PLUGIN_CLEANUP_UNFINISHED_TRANSACTION');
  if((await fs.lstat(path.join(directory,'transaction.json'))).nlink!==1)fail('PLUGIN_CLEANUP_UNSAFE');
  requireDead(owner.workerPid);
  for(const [i,row]of receipt.commandGroups.entries()){
   if(row.phase!==phases[i])fail('PLUGIN_CLEANUP_UNSAFE');requireDead(row.pid,true);
  }
  if(receipt.recovery)requireDead(receipt.recovery.workerPid);
  for(const file of await fs.readdir(directory))if(/^recover-[a-f0-9]{32}\.json$/.test(file))requireDead((await privateJson(path.join(directory,file))).pid);
  for(const payload of payloads){
   const file=path.join(directory,payload);await privateRoot(file);const stat=await fs.lstat(file);
   selected.push({transaction:name,payload,dev:stat.dev,ino:stat.ino,
     ownerDigest:digest(JSON.stringify(owner)),receiptDigest:digest(JSON.stringify(receipt))});
  }
 }
 if(selected.length>512)fail('PLUGIN_CLEANUP_UNSAFE');return selected;
}
