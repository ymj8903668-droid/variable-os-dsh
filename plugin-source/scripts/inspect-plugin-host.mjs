// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXPECTED_DSH_VERSION} from './dsh-contract.mjs';
import {readPluginInput} from './install-public-plugin.mjs';
import {PUBLIC_PLUGIN_HOST_PEERS,assertPublicPluginRuntime} from '../packages/dsh-desk-ui/lib/public-plugin-runtime.js';
import {isCliEntrypoint} from './cli-entrypoint.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};

// Accept the declared CLI bin, including npm links and pnpm's explicit target
// metadata. Never guess a neighbouring global install or execute a shell probe.
export async function officialDshAnchor(executable){
 try{
  if(!path.isAbsolute(executable))throw Error('PATH');
  const canonical=await fs.realpath(executable),targets=[executable,canonical];
  const bytes=await readPluginInput(canonical,128*1024);
  const matches=[...bytes.toString().matchAll(/^# cmd-shim-target=(\/[^\r\n]+)$/gm)];
  if(matches.length>1)throw Error('SHIM');
  if(matches.length===1)targets.push(await fs.realpath(matches[0][1]));
  for(const target of targets){
   for(let directory=path.dirname(target);;directory=path.dirname(directory)){
    try{
     const anchor=await fs.realpath(path.join(directory,'package.json'));
     const metadata=JSON.parse(await readPluginInput(anchor,128*1024));
     if(metadata.name==='@deepseek-ai/dsh'){
      const bin=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.dsh;
      if(metadata.version!==EXPECTED_DSH_VERSION||typeof bin!=='string'||path.isAbsolute(bin))throw Error('VERSION');
      const declared=await fs.realpath(path.resolve(directory,bin));
      if(declared!==await fs.realpath(target))throw Error('BIN');
      return anchor;
     }
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(directory===path.dirname(directory))break;
   }
  }
 }catch{fail('PUBLIC_PLUGIN_HOST_ROOT_INVALID');}
 fail('PUBLIC_PLUGIN_HOST_ROOT_INVALID');
}

// Use the same public resolver service installed by official runProfile, without
// mounting the profile, activating the plugin or opening a web server.
export async function inspectPluginHost({dsh,profileRoot,entry}){
 const anchor=await officialDshAnchor(dsh),require=createRequire(anchor);
 async function sdk(name,version){
  const manifest=await fs.realpath(require.resolve(name+'/package.json'));
  const metadata=JSON.parse(await readPluginInput(manifest,128*1024));
  if(metadata.name!==name||metadata.version!==version)fail('PUBLIC_PLUGIN_RUNTIME_INCOMPATIBLE');
  return import(pathToFileURL(require.resolve(name)));
 }
 const {Context}=await sdk('@deepseek-ai/cordis',PUBLIC_PLUGIN_HOST_PEERS['@deepseek-ai/cordis']);
 const {PluginPackages,loadProfileDirectory,createRuntimeResolution}=await sdk('@deepseek-ai/dsh-app-boot',EXPECTED_DSH_VERSION);
 const ctx=new Context();
 try{
  const profile=loadProfileDirectory('dsh',profileRoot,anchor),resolution=await createRuntimeResolution({installAnchor:anchor,profile,home:path.resolve(profileRoot,'../..')});
  await ctx.plugin(PluginPackages,{resolution}).await();
  assertPublicPluginRuntime(entry,ctx.get('pluginPackages'));
  const plugin=await import(entry);
  assert.equal(plugin.name,'variable-os-desk-ui');assert.equal(typeof plugin.apply,'function');
  return {verifiedHostPeers:Object.keys(PUBLIC_PLUGIN_HOST_PEERS).length,imported:true,activated:false};
 }finally{await ctx.fiber.dispose();}
}
if(isCliEntrypoint(import.meta.url)){
 try{
  const {values}=parseArgs({options:{dsh:{type:'string'},'profile-root':{type:'string'},entry:{type:'string'}},strict:true});
  console.log(JSON.stringify(await inspectPluginHost({dsh:values.dsh,profileRoot:values['profile-root'],entry:values.entry})));
 }catch(error){console.error(/^PUBLIC_PLUGIN_[A-Z_]+$/.test(error.code??'')?error.code:'PUBLIC_PLUGIN_HOST_INSPECTION_FAILED');process.exitCode=1;}
}
