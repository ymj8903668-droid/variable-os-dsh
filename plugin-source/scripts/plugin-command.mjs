// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import {fork,spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isCliEntrypoint} from './cli-entrypoint.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// The IPC peer waits for admission before starting the external program. Its
// group can therefore be journalled before any installer command can write data.
export async function runPluginCommand({command,args,cwd,env,logFd,signal,timeoutMs=20000,beforeStart}={}) {
  if(signal?.aborted)fail('PLUGIN_INSTALL_CANCELLED');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isInteger(logFd)
    ||beforeStart!==undefined&&typeof beforeStart!=='function')fail('PLUGIN_COMMAND_ARGUMENTS_INVALID');
  const child=fork(fileURLToPath(import.meta.url),['--worker'],{
    execPath:process.execPath,execArgv:[],cwd,env,detached:true,stdio:['ignore',logFd,logFd,'ipc'],
  });
  let closed=false,terminal,result,gateError,stoppingAt,escalated=false,timedOut=false;
  const alive=()=>{
    if(!child.pid)return false;
    try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}
  };
  // Concurrent owner/peer cleanup can race with group exit. The authoritative
  // condition is confirmed group absence; a still-live group retains admission.
  const kill=value=>{
    // The unreaped direct child reserves its PID and group identity. Node sets
    // exitCode/signalCode before emitting exit, which can precede close. Once
    // reaped, a live numeric group may belong to another process: observe it
    // conservatively and retain admission, but never signal that number again.
    if(child.exitCode!==null||child.signalCode!==null)return;
    try{if(child.pid)process.kill(value==='SIGTERM'?child.pid:-child.pid,value);}catch{}
  };
  const stop=()=>{if(stoppingAt===undefined){stoppingAt=performance.now();kill('SIGTERM');}};
  child.once('error',error=>{gateError??=error;});
  child.once('close',(exitCode,signal)=>{terminal={exitCode,signal};closed=true;});
  child.on('message',message=>{
    if(message?.type==='plugin-command-result'&&message.result
      &&(message.result.exitCode===null||Number.isInteger(message.result.exitCode))
      &&(message.result.signal===null||typeof message.result.signal==='string')) result=message.result;
  });
  signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  try {
    try {
      if(child.pid)await beforeStart?.(child.pid);
      if(signal?.aborted)stop();
      if(!closed&&stoppingAt===undefined&&child.connected) {
        await new Promise((resolve,reject)=>child.send({type:'plugin-command-start',command,args},error=>error?reject(error):resolve()));
      }
    } catch(error) {gateError=error;stop();}
    for(;;) {
      const groupAlive=alive();
      if(closed&&!groupAlive)break;
      if(closed&&groupAlive)stop();
      if(stoppingAt!==undefined) {
        if(!escalated&&performance.now()-stoppingAt>=3000){escalated=true;kill('SIGKILL');}
        if(performance.now()-stoppingAt>=5000) {
          child.unref();if(child.connected)child.disconnect();
          throw Object.assign(Error('PLUGIN_INSTALL_CHILDREN_REMAIN'),{code:'PLUGIN_INSTALL_CHILDREN_REMAIN',retainLock:true});
        }
      }
      await delay(20);
    }
    if(gateError)throw gateError;
    if(!result&&!signal?.aborted&&!timedOut)fail('PLUGIN_COMMAND_WORKER_FAILED');
    return {...(result??terminal),timedOut};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',stop);}
}

export function inspectCommandGroup(text,{ownerPid,observerPid}) {
  if(typeof text!=='string'||text.length>1024*1024||ownerPid===observerPid
    ||![ownerPid,observerPid].every(pid=>Number.isSafeInteger(pid)&&pid>1))return 'unknown';
  const rows=new Map();
  for(const line of text.trim().split('\n')) {
    const match=/^\s*([1-9][0-9]*)\s+(0|[1-9][0-9]*)\s+(\S+)\s*$/.exec(line);
    if(!match)return 'unknown';
    const pid=Number(match[1]),group=Number(match[2]);
    if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(group)||rows.has(pid))return 'unknown';
    rows.set(pid,{group,state:match[3]});
  }
  if(rows.get(ownerPid)?.group!==ownerPid||rows.get(observerPid)?.group!==ownerPid)return 'unknown';
  return [...rows].some(([pid,row])=>pid!==ownerPid&&pid!==observerPid
    &&row.group===ownerPid&&!row.state.startsWith('Z'))?'active':'empty';
}

function commandWorker() {
  let command,started=false,finished=false,finishing=false,stopping=false,orphaned=false,escalation,graceful=false;
  const kill=value=>{try{process.kill(-process.pid,value);}catch{process.exit(1);}};
  const stop=()=>{
    if(stopping||finished)return;
    stopping=true;escalation=setTimeout(()=>kill('SIGKILL'),graceful&&!orphaned?8000:3000);kill('SIGTERM');
  };
  const groupState=()=>{
    try {
      const observed=spawnSync('/bin/ps',['-axo','pid=,pgid=,stat='],{
        cwd:'/',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},encoding:'utf8',timeout:1000,maxBuffer:1024*1024,
      });
      return observed.status===0?inspectCommandGroup(observed.stdout,
        {ownerPid:process.pid,observerPid:observed.pid}):'unknown';
    }catch{return 'unknown';}
  };
  const finish=async result=>{
    if(finished||finishing)return;
    finishing=true;
    // If our owner was killed, remain until the group-wide escalation. An exited
    // command leader does not prove that grandchildren have stopped writing.
    if(orphaned){stop();return;}
    if(graceful) {
      // The peer still owns this group. Allow the Host's descendants their
      // graceful shutdown window; unknown observations never certify a drain.
      while(groupState()!=='empty') {
        stop();await delay(20);
        if(orphaned)return;
      }
    }
    finished=true;clearTimeout(escalation);
    // Do not leave descendant cleanup to the owner: it may be suspended or die
    // immediately after receiving this result. The command leader is terminal,
    // so finish the entire recorded group, including this IPC peer.
    try {
      if(process.connected)process.send({type:'plugin-command-result',result},()=>kill('SIGKILL'));
      else kill('SIGKILL');
    } catch {kill('SIGKILL');}
  };
  for(const name of ['SIGINT','SIGTERM','SIGHUP'])process.on(name,stop);
  process.on('disconnect',()=>{if(finished)return;orphaned=true;if(started)stop();else process.exit(1);});
  process.on('message',message=>{
    if(started||stopping||finished||message?.type!=='plugin-command-start')return;
    if(typeof message.command!=='string'||!Array.isArray(message.args)||!message.args.every(x=>typeof x==='string'))return finish({exitCode:null,signal:null,spawnError:true});
    graceful=message.graceful===true;
    started=true;
    try {
      // Inherit this recorded process group; no shell, preload, or detached child.
      command=spawn(message.command,message.args,{env:process.env,detached:false,stdio:'inherit'});
      command.once('error',()=>finish({exitCode:null,signal:null,spawnError:true}));
      command.once('close',(exitCode,signal)=>finish({exitCode,signal}));
    } catch {finish({exitCode:null,signal:null,spawnError:true});}
  });
  if(!process.connected)process.exit(1);
}

if(isCliEntrypoint(import.meta.url)) {
  if(process.argv.length!==3||process.argv[2]!=='--worker'||typeof process.send!=='function')process.exitCode=1;
  else commandWorker();
}
