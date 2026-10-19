// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installPublicPlugin, readApprovedPluginArchive, readPluginInput, checkPluginComposition} from './install-public-plugin.mjs';
import {readApprovedInstalledPlugin} from './start-installed-plugin.mjs';
import {privateRoot,stateSnapshot,writeReceipt,createUpgradeTransaction,holdUpgradeLaunch,releaseUpgrade,syncDirectory} from './plugin-upgrade-journal.mjs';
import {runPluginCommand} from './plugin-command.mjs';
import {findExecutable} from './dsh-contract.mjs';

const fail = code => {throw Object.assign(Error(code),{code});};
const active = signal => {if(signal?.aborted) fail('PLUGIN_INSTALL_CANCELLED');};
const profilePatch='home/.dsh/profiles/web/cordis.patch.yml';
async function copyState(backup,destination,expected,signal) {
  // Generated profile configuration is not a credential store. A modified or
  // incompatible configuration needs an explicit migration, never silent loss.
  for(const name of ['cordis.yml','pnpm-workspace.yaml']) {
    const relative='home/.dsh/profiles/web/'+name;
    const read=async root=>{try{return await readPluginInput(path.join(root,relative),1024*1024);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
    const [before,after]=await Promise.all([read(backup),read(destination)]);
    if(Boolean(before)!==Boolean(after) || before && !before.equals(after)) fail('PLUGIN_UPGRADE_PROFILE_MIGRATION_REQUIRED');
  }
  for(const row of expected) {
    active(signal);
    const target=path.join(destination,row.path);
    if(row.directory) {
      try {await fs.mkdir(target,{mode:row.mode});}
      catch(error) {if(error.code!=='EEXIST')throw error;}
      const stat=await fs.lstat(target);
      if(!stat.isDirectory() || stat.uid!==process.getuid?.() || await fs.realpath(target)!==target)fail('PLUGIN_UPGRADE_STATE_CHANGED');
      await fs.chmod(target,row.mode);
    } else if(row.path===profilePatch) {
      // The official Host persists user choices (including welcome acknowledgement)
      // here. Preserve it exactly, then validate its composition before committing.
      const bytes=await readPluginInput(path.join(backup,row.path),1024*1024);
      await readPluginInput(target,1024*1024);
      const pending=target+'.upgrade-pending';
      await fs.writeFile(pending,bytes,{mode:row.mode,flag:'wx'});
      await fs.rename(pending,target);
    } else {
      await fs.cp(path.join(backup,row.path),target,{
        dereference:false,verbatimSymlinks:true,force:false,errorOnExist:true,preserveTimestamps:true,
      });
    }
  }
  const actual=await stateSnapshot(destination,signal);
  if(JSON.stringify(actual)!==JSON.stringify(expected)
    || JSON.stringify(await stateSnapshot(backup,signal))!==JSON.stringify(expected)) fail('PLUGIN_UPGRADE_STATE_CHANGED');
}
async function composePreservedProfile(destination,env,signal,beforeCommand) {
  const childEnv={HOME:path.join(destination,'home'),DSH_HOME:path.join(destination,'home/.dsh'),
    PATH:String(env?.PATH??process.env.PATH??'').split(path.delimiter).filter(path.isAbsolute).join(path.delimiter),
    XDG_CONFIG_HOME:path.join(destination,'config'),XDG_CACHE_HOME:path.join(destination,'cache'),
    TMPDIR:path.join(destination,'tmp'),SHELL:'/bin/sh',DSH_TELEMETRY_DISABLED:'1',COREPACK_ENABLE_NETWORK:'0',
    COREPACK_DEFAULT_TO_LATEST:'0',COREPACK_ENV_FILE:'0',pnpm_config_offline:'true',pnpm_config_ignore_scripts:'true'};
  const dsh=findExecutable('dsh',childEnv);
  if(!dsh)fail('PLUGIN_TOOLCHAIN_INCOMPATIBLE');
  const file=path.join(destination,'upgrade-compose.log'),log=await fs.open(file,'wx',0o600);
  let result;
  try {
    result=await runPluginCommand({command:dsh,args:['--profile','web','--dump-config'],cwd:destination,
      env:childEnv,signal,logFd:log.fd,timeoutMs:20000,beforeStart:pid=>beforeCommand({phase:'upgrade-compose',pid})});
  } finally {await log.close();}
  if(result.exitCode!==0||result.timedOut)fail('PLUGIN_COMPOSITION_INVALID');
  checkPluginComposition(await readPluginInput(file,1024*1024));
}

export async function upgradePublicPlugin({archive,descriptor,previousDescriptor,destination,confirm,signal,env}={}) {
  if(confirm!==true) fail('PLUGIN_UPGRADE_CONFIRMATION_REQUIRED');
  active(signal);
  await privateRoot(destination);await privateRoot(path.dirname(destination));
  try {
    await fs.lstat(path.join(path.dirname(destination),'preflight-recovery.json'));
    fail('PLUGIN_PREFLIGHT_CHILDREN_REMAIN');
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  await readApprovedPluginArchive(archive,descriptor);
  await readApprovedPluginArchive(path.join(destination,'plugin.tgz'),previousDescriptor);
  await readApprovedInstalledPlugin(destination,previousDescriptor);
  if(descriptor.sha256===previousDescriptor.sha256)fail('PLUGIN_UPGRADE_ALREADY_INSTALLED');
  active(signal);
  const tx=await createUpgradeTransaction(destination,previousDescriptor,descriptor);
  const stopped=new AbortController(),cancel=()=>stopped.abort(signal?.reason);
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  let release,lockRoot,moved=false,retainGuard=false;
  const {transaction,receipt}=tx;
  try {
    active(stopped.signal);
    lockRoot=path.join(destination,'launch');
    release=await holdUpgradeLaunch(tx,destination,()=>stopped.abort('PUBLIC_STOP'));
    await readApprovedPluginArchive(path.join(destination,'plugin.tgz'),previousDescriptor);
    await readApprovedInstalledPlugin(destination,previousDescriptor);
    const state=await stateSnapshot(destination,stopped.signal);
    const backup=receipt.backup;
    Object.assign(receipt,{stateSha256:createHash('sha256').update(JSON.stringify(state)).digest('hex'),status:'PREPARED',stateEntries:state.length});
    await writeReceipt(transaction,receipt);active(stopped.signal);
    await fs.rename(destination,backup);moved=true;lockRoot=path.join(backup,'launch');
    await syncDirectory(path.dirname(destination));await syncDirectory(transaction);
    receipt.status='INSTALLING';await writeReceipt(transaction,receipt);
    const beforeCommand=async command=>{receipt.commandGroups.push(command);await writeReceipt(transaction,receipt);};
    await installPublicPlugin({archive,descriptor,destination,confirm:true,signal:stopped.signal,env,beforeCommand});
    await copyState(backup,destination,state,stopped.signal);
    await composePreservedProfile(destination,env,stopped.signal,beforeCommand);
    if(JSON.stringify(await stateSnapshot(destination,stopped.signal))!==JSON.stringify(state))fail('PLUGIN_UPGRADE_STATE_CHANGED');
    await readApprovedInstalledPlugin(destination,descriptor);active(stopped.signal);
    receipt.status='UPGRADED_NOT_STARTED';await writeReceipt(transaction,receipt);
    return receipt;
  } catch(error) {
    if(error.retainLock===true) {
      retainGuard=true;
      if(receipt){receipt.status='RECOVERY_REQUIRED';try{await writeReceipt(transaction,receipt);}catch{}}
      fail('PLUGIN_UPGRADE_RECOVERY_REQUIRED');
    }
    if(moved) {
      try {
        try {
          await privateRoot(destination);
          await fs.rename(destination,path.join(transaction,'failed'));
        } catch(e) {if(e.code!=='ENOENT')throw e;}
        await fs.rename(receipt.backup,destination);lockRoot=path.join(destination,'launch');
        receipt.status='ROLLED_BACK';receipt.failure=/^(PLUGIN_|PUBLIC_)[A-Z0-9_]+$/.test(error.code??'')?error.code:'PLUGIN_UPGRADE_FAILED';
        await writeReceipt(transaction,receipt);
      } catch {
        retainGuard=true;
        receipt.status='RECOVERY_REQUIRED';
        try {await writeReceipt(transaction,receipt);} catch { /* Prior journal and guard remain authoritative. */ }
        fail('PLUGIN_UPGRADE_RECOVERY_REQUIRED');
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort',cancel);
    release?.();
    if(!retainGuard) {try{await releaseUpgrade(tx,release?lockRoot:null);}catch{fail('PLUGIN_UPGRADE_RECOVERY_REQUIRED');}}
  }
}
