// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {readPluginInput} from './install-public-plugin.mjs';
import {listCompletedPluginBackupPayloads} from './plugin-backup-inventory.mjs';
import {privateRoot,privateJson,sameFile,digest,writePrivateJson,syncDirectory} from './plugin-upgrade-journal.mjs';

const fail=()=>{throw Object.assign(Error('PLUGIN_BACKUP_PUBLICATION_STATE_UNSAFE'),{code:'PLUGIN_BACKUP_PUBLICATION_STATE_UNSAFE'});};
const exists=async p=>{try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const identity=s=>JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.mode,s.nlink,s.uid]);
const base='home/.dsh/variable-os';

// The Start owner holds its launch lease throughout this operation. Upgrade and
// explicit Cleanup cannot mutate these copies while that lease is held. Every
// target remains bound to its terminal journal and directory identity.
export async function retirePluginBackupPublications({destination,launchIdentity}={}) {
 const parent=path.dirname(destination),lock=path.join(destination,'launch/public-launch.lock');
 async function admission(){
  await privateRoot(parent);await privateRoot(destination);await privateRoot(path.dirname(lock));
  const actual=await exists(lock);
  if(!actual?.isFile()||actual.nlink!==1||actual.mode&0o077||actual.uid!==process.getuid?.()
    ||!launchIdentity||!sameFile(actual,launchIdentity))fail();
  for(const name of ['install-entry.guard','preflight-recovery.json'])if(await exists(path.join(parent,name)))fail();
 }
 await admission();
 const targets=await listCompletedPluginBackupPayloads(destination),changes=[];
 async function bound(row){
  await admission();
  const directory=path.join(parent,row.transaction);await privateRoot(directory);
  if(digest(JSON.stringify(await privateJson(path.join(directory,'transaction.json'))))!==row.ownerDigest
    ||digest(JSON.stringify(await privateJson(path.join(directory,'upgrade-receipt.json'))))!==row.receiptDigest)fail();
  const root=path.join(directory,row.payload);await privateRoot(root);
  if(!sameFile(await fs.lstat(root),row)||await exists(path.join(root,'launch/public-launch.lock')))fail();
  return root;
 }
 async function optionalDirectory(root,relative){
  let current=root;
  for(const part of relative.split('/')){
   current=path.join(current,part);const s=await exists(current);if(!s)return null;
   // DSH creates .dsh with its normal directory mode inside our private home.
   // It may be readable, but must still be owned, canonical and not writable
   // by others. All application state directories remain private (0700).
   if(current===path.join(root,'home/.dsh')){
    if(!s.isDirectory()||s.uid!==process.getuid?.()||s.mode&0o022||await fs.realpath(current)!==current)fail();
   }else await privateRoot(current);
  }
  return current;
 }
 async function read(file,limit){
  const before=await fs.lstat(file);
  if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o7777)!==0o600)fail();
  const bytes=await readPluginInput(file,limit);
  if(identity(before)!==identity(await fs.lstat(file)))fail();
  let value;try{value=JSON.parse(bytes);}catch{fail();}
  return {value,stamp:identity(before),sha256:digest(bytes)};
 }
 // Validate the whole bounded inventory before changing any file. Unknown
 // layouts are refused instead of guessing which personal data may be erased.
 for(const row of targets){
  const root=await bound(row),history=await optionalDirectory(root,base+'/personal/conversations');
  if(history){
   const names=(await fs.readdir(history)).sort();if(names.length>1024)fail();
   for(const name of names){
    const file=path.join(history,name);
    if(/^[a-f0-9]{64}\.json\.lock$/.test(name)){
     const s=await fs.lstat(file);if(!s.isFile()||s.nlink!==1||s.size!==0||s.mode&0o077||s.uid!==process.getuid?.())fail();continue;
    }
    const normal=/^[a-f0-9]{64}\.json$/.test(name),temporary=/^\.conversation-[a-f0-9]{32}$/.test(name);
    // Our interrupted temporary contains only a redacted record, but still
    // validate it and never accept a symlink or foreign object with that name.
    const retiredTemporary=/^\.publication-retirement-[a-f0-9]{32}\.pending$/.test(name);
    if(!normal&&!temporary&&!retiredTemporary)fail();
    const selected=await read(file,512*1024),v=selected.value;
    if(!plain(v)||Object.keys(v).sort().join(',')!=='binding,checkpoint,id,revision,schema,status'
      ||v.schema!=='personal-conversation-store-v1'||!/^xiaomei-agent-[a-z0-9-]{16,96}$/.test(v.id??'')
      ||normal&&digest(v.id)+'.json'!==name||!hash(v.binding)||!hash(v.revision)
      ||!['empty','running','ready','retired'].includes(v.status)
      ||(v.status==='ready'?!plain(v.checkpoint)||Object.keys(v.checkpoint).sort().join(',')!=='published,session'
        ||!plain(v.checkpoint.session)||v.checkpoint.published!==null&&!plain(v.checkpoint.published):v.checkpoint!==null))fail();
    if(retiredTemporary&&(v.status!=='retired'||v.checkpoint!==null))fail();
    if(v.status==='ready'&&v.checkpoint.published!==null)changes.push({row,file,selected,
      relative:base+'/personal/conversations',value:{...v,revision:randomBytes(32).toString('hex'),status:'retired',checkpoint:null},kind:'history'});
   }
  }
  const connections=await optionalDirectory(root,base+'/connections');
  if(connections){
   const file=path.join(connections,'published-sync.json');
   if(await exists(file)){
    const selected=await read(file,1024),v=selected.value;
    if(!plain(v)||Object.keys(v).sort().join(',')!=='cursor,projectionDigest,revision,schema'||v.schema!==1||!hash(v.revision)
      ||v.cursor!==null&&(typeof v.cursor!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(v.cursor))
      ||v.projectionDigest!==null&&!hash(v.projectionDigest))fail();
    if(v.cursor!==null||v.projectionDigest!==null)changes.push({row,file,selected,relative:base+'/connections',
      value:{...v,cursor:null,projectionDigest:null},kind:'cursor'});
   }
  }
  if(changes.length>4096)fail();
 }
 const counts={retiredHistories:0,clearedCursors:0,backupPayloads:targets.length};
 for(const change of changes){
  const root=await bound(change.row);
  if(await optionalDirectory(root,change.relative)!==path.dirname(change.file))fail();
  const directory=await fs.lstat(path.dirname(change.file));
  const check=async()=>{
   await bound(change.row);
   if(await optionalDirectory(root,change.relative)!==path.dirname(change.file)
    ||!sameFile(directory,await fs.lstat(path.dirname(change.file))))fail();
   const current=await read(change.file,change.kind==='history'?512*1024:1024);
   if(current.stamp!==change.selected.stamp||current.sha256!==change.selected.sha256)fail();
  };
  await check();
  const temporary=path.join(path.dirname(change.file),'.publication-retirement-'+randomBytes(16).toString('hex')+'.pending');
  try{
   await writePrivateJson(temporary,change.value);await check();
   const staged=await read(temporary,change.kind==='history'?512*1024:1024);
   if(JSON.stringify(staged.value)!==JSON.stringify(change.value))fail();
   await fs.rename(temporary,change.file);await syncDirectory(path.dirname(change.file));
  }finally{
   // Only a redacted pending record can remain after a crash. Do not follow a
   // replaced parent or remove an unverified file while handling an error.
   if(await optionalDirectory(root,change.relative)===path.dirname(change.file)
     &&sameFile(directory,await fs.lstat(path.dirname(change.file)))){
    const s=await exists(temporary);
    if(s){const staged=await read(temporary,512*1024);if(JSON.stringify(staged.value)===JSON.stringify(change.value))await fs.unlink(temporary);}
   }
  }
  counts[change.kind==='history'?'retiredHistories':'clearedCursors']++;
 }
 await admission();return counts;
}
