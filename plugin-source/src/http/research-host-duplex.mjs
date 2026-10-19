// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto';
import { createDuplexResearchBridge } from '../runtime/harness-research-host-duplex-research.mjs';
import { createDuplexPlayback } from '../runtime/harness-research-host-duplex-playback.mjs';

export const DUPLEX_INSTRUCTIONS = '你是小美，用户的中文研究助手，正在通话。用短句、自然语气交流，不念报告，不重复寒暄。需要查公司、新闻、微信线索或全局变量时调用 research_company，把明确问题完整交给原生DSH；缺公司时先问清。开始研究可简短说“好，我帮你查一下”。工具返回前不能编造查到的事实；只根据返回的status和spokenText回应，完整证据在页面。partial/failed/busy/awaiting-confirmation要诚实说明，不能说已完成。正式研判、映射、入库、交易必须人工确认，不承诺自动操作或关页后的监控。用户插话先听清；停声不等于取消研究。不要声称有真实情绪或已执行没有回执的任务。';
export const DUPLEX_TOOLS = Object.freeze([{type:'function',name:'research_company',
  description:'交给当前原生DSH研究会话核查公司催化、信源或全局雷达，返回有来源约束的简短口语结果，文字详情留在页面。',
  parameters:{type:'object',properties:{question:{type:'string',description:'用户当前明确的研究问题，包含公司或全局范围'}},required:['question']}}]);
const fail = code => { throw Error(code); };
const idPattern = /^xiaomei-agent-[a-z0-9-]{16,96}$/;
const providerCodes = new Set(['DUPLEX_CLOSED','DUPLEX_CONNECTION_CLOSED','DUPLEX_CONNECTION_FAILED',
  'DUPLEX_BACKPRESSURE','DUPLEX_PROTOCOL_INVALID','DUPLEX_PROVIDER_REJECTED','DUPLEX_CHILD_FAILED',
  'DUPLEX_START_TIMEOUT','DUPLEX_CLOSE_TIMEOUT','DUPLEX_ASR_HISTORY_LIMIT','DUPLEX_TOOL_CALL_LIMIT',
  'DUPLEX_EVENT_HANDLER_FAILED']);

/** One owned live call; no audio/history is persisted and no reconnect is automatic. */
export function createDuplexCallService({loadKey,hasKey,createProvider,runResearch,beforeStart=async()=>{},
  now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,onDiagnostic=()=>{}}) {
  let active=null;
  async function start({sessionId,context},{emit,signal}={}) {
    if (!idPattern.test(sessionId || '') || !context || Array.isArray(context) || typeof context!=='object') fail('DUPLEX_CONTEXT_INVALID');
    if(active) fail('DUPLEX_BUSY');
    const call={id:randomUUID(),provider:null,bridge:null,closing:false,queue:[],sequence:0,timer:null,muted:false,outputStarted:false};
    const startedAt=now();let maxPumpLagMs=0;
    let finishStartup;
    const startupDone=new Promise(resolve=>{finishStartup=resolve;});
    const earlyCalls=[];
    active=call;
    const output = value => {
      if(call.closing) return;
      call.outputStarted=true;
      try { return Promise.resolve(emit(value)).catch(()=>{void close('DUPLEX_OUTPUT_FAILED','output');}); }
      catch { void close('DUPLEX_OUTPUT_FAILED','output'); }
    };
    let closingPromise;
    function close(code='DUPLEX_CLOSED',origin=code==='DUPLEX_CLOSED'?'control':'host',reason=code==='DUPLEX_CLOSED'?'DUPLEX_CLOSE_REQUESTED':code) {
      if(closingPromise) return closingPromise;
      // First cause wins before cleanup clears queues or cancels the research.
      // No request body, text, PCM, credentials or provider exception is copied.
      const diagnostic=Object.freeze({event:'xiaomei-duplex-close',callId:call.id,sessionId,
        code,reason,origin,elapsedMs:Math.max(0,Math.round(now()-startedAt)),
        queuedInputFrames:call.queue.length,maxPumpLagMs:Math.max(0,Math.round(maxPumpLagMs)),
        researchState:call.bridge?.status().state || 'idle'});
      call.closing=true;call.queue=[];clearTimer(call.timer);
      call.playback?.close();
      signal?.removeEventListener('abort',onAbort);
      closingPromise=(async()=>{
        await startupDone;
        await Promise.allSettled([call.provider?.close(),call.bridge?.close(diagnostic)]);
        if(active===call) active=null;
        if(call.outputStarted) try {await emit({type:'closed',code});}catch{ /* disconnected browser */ }
      })();
      try { Promise.resolve(onDiagnostic(diagnostic)).catch(()=>{}); } catch { /* Logging cannot retain a call. */ }
      return closingPromise;
    }
    const onAbort=()=>{
      const outputBlocked=signal?.reason instanceof Error && signal.reason.message==='DUPLEX_OUTPUT_BACKPRESSURE';
      void close('DUPLEX_CANCELLED',outputBlocked?'output':'transport',outputBlocked?'DUPLEX_OUTPUT_BACKPRESSURE':'DUPLEX_STREAM_DISCONNECTED');
    };
    call.playback=createDuplexPlayback({emit:event=>output({type:'provider',event}),
      onError:()=>{void close('DUPLEX_PLAYBACK_FAILED');}});
    call.close=close;signal?.addEventListener('abort',onAbort,{once:true});
    try {
      await beforeStart();
      const apiKey=await loadKey();
      if(signal?.aborted || call.closing) fail('DUPLEX_CANCELLED');
      if(!apiKey) fail('DUPLEX_KEY_UNAVAILABLE');
      call.bridge=createDuplexResearchBridge({sessionId,context,runResearch,
        onNativeEvent:event=>output({type:'native',event}),
        onStatus:status=>output({type:'status',...status}),
        submitToolResults:items=>call.provider.submitToolResults(items)});
      const handleCalls=event=>{
        void call.bridge.handleCalls(event).then(receipt=>{
          if(!receipt.ok) void close(receipt.code);
        }).catch(()=>{void close('DUPLEX_RESEARCH_FAILED');});
      };
      call.provider=await createProvider({apiKey,instructions:DUPLEX_INSTRUCTIONS,tools:DUPLEX_TOOLS,
        onEvent:async event=>{
          if(call.closing) return;
          if(event.type==='response.function_call_arguments.done') {
            // Do not block the provider's audio/ASR event ACK on a long tool.
            if(!call.provider) {
              if(earlyCalls.length>=8) {void close('DUPLEX_EARLY_CALL_LIMIT');return;}
              earlyCalls.push(event);
            } else handleCalls(event);
          } else await call.playback.handle(event);
        }});
      finishStartup();
      if(signal?.aborted || call.closing) fail('DUPLEX_CANCELLED');
      void call.provider.closed.then(receipt=>close(receipt?.ok?'DUPLEX_CLOSED':'DUPLEX_PROVIDER_CLOSED','provider',
        providerCodes.has(receipt?.code)?receipt.code:'DUPLEX_PROVIDER_CLOSED'),()=>close('DUPLEX_PROVIDER_CLOSED','provider'));
      await output({type:'call',callId:call.id});await output({type:'ready'});
      for(const event of earlyCalls) handleCalls(event);
      earlyCalls.length=0;
      let nextFrameAt=now()+20;
      const pump=()=>{
        if(call.closing) return;
        maxPumpLagMs=Math.max(maxPumpLagMs,now()-nextFrameAt);
        try {if(!call.muted && call.queue.length) call.provider.sendAudio(call.queue.shift());}
        catch(error) {
          // A closed transport can throw before its terminal receipt arrives;
          // this observation does not establish a microphone queue overflow.
          void close('DUPLEX_AUDIO_BACKPRESSURE','provider',
            providerCodes.has(error?.message)?error.message:'DUPLEX_PROVIDER_SEND_FAILED');
          return;
        }
        // Preserve the media clock through small jitter; full-frame stalls rebase
        // instead of bursting stale input. One frame per callback remains strict.
        const completedAt=now();
        nextFrameAt=completedAt-nextFrameAt>=20 ? completedAt+20 : nextFrameAt+20;
        call.timer=setTimer(pump,Math.max(0,nextFrameAt-now()));
      };
      call.timer=setTimer(pump,20);
      return {id:call.id,close};
    } catch(error) {
      finishStartup();
      const allowed=['DUPLEX_CANCELLED','DUPLEX_KEY_UNAVAILABLE'];
      const reason=allowed.includes(error?.message)?error.message:'DUPLEX_START_FAILED';
      await close('DUPLEX_START_FAILED','host',reason);
      fail(reason);
    }
  }
  async function control(input) {
    const call=active;
    if(!call || call.id!==input.callId || call.closing) fail('DUPLEX_CALL_NOT_FOUND');
    if(!call.provider) fail('DUPLEX_NOT_READY');
    switch(input.action) {
      case 'audio': {
        if(!Number.isSafeInteger(input.sequence) || input.sequence!==call.sequence) fail('DUPLEX_AUDIO_SEQUENCE');
        if(typeof input.audio!=='string' || input.audio.length!==4268 || !/^[A-Za-z0-9+/]+=$/.test(input.audio)) fail('DUPLEX_AUDIO_INVALID');
        const bytes=Buffer.from(input.audio,'base64');
        if(bytes.length!==3200 || bytes.toString('base64')!==input.audio) fail('DUPLEX_AUDIO_INVALID');
        if(call.queue.length+5>50) {void call.close('DUPLEX_AUDIO_BACKPRESSURE','input');fail('DUPLEX_AUDIO_BACKPRESSURE');}
        call.sequence++;
        if(!call.muted) for(let i=0;i<3200;i+=640) call.queue.push(bytes.subarray(i,i+640));
        break;
      }
      case 'mute':
        if(typeof input.muted!=='boolean') fail('DUPLEX_CONTROL_INVALID');
        call.muted=input.muted;call.queue=[];call.provider.setMuted(input.muted);break;
      case 'stop-speaking': call.playback.cancel();call.provider.cancelResponse();break;
      case 'cancel-research': await call.bridge.cancelResearch();break;
      case 'hangup': await call.close();break;
      default: fail('DUPLEX_CONTROL_INVALID');
    }
    return {ok:true};
  }
  return Object.freeze({start,control,
    isActive:()=>active!==null,
    availability:async()=>({configured:Boolean(await hasKey()),active:active!==null}),
    close:()=>active?.close('DUPLEX_CLOSED','host','DUPLEX_HOST_DISPOSED') || Promise.resolve()});
}

const schemas={availability:['action'],start:['action','sessionId','context'],audio:['action','callId','sequence','audio'],
  mute:['action','callId','muted'],'stop-speaking':['action','callId'],'cancel-research':['action','callId'],hangup:['action','callId']};
async function readBody(req) {
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>65536) fail('BODY_TOO_LARGE');chunks.push(chunk);}
  try {const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const keys=schemas[body?.action];
    if(!keys || Object.keys(body).some(key=>!keys.includes(key)) || keys.some(key=>!(key in body))) fail('DUPLEX_REQUEST_INVALID');
    return body;
  }catch{fail('DUPLEX_REQUEST_INVALID');}
}
function sameOrigin(req) {
  try {const origin=new URL(req.headers.origin);return ['http:','https:'].includes(origin.protocol) && origin.host===req.headers.host;}
  catch{return false;}
}
function json(res,status,value) {if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
/** Same-origin, CSRF-protected HTTP ingress. No browser ever receives the key. */
export function createDuplexHttpHandler({service,csrfToken}) {
  return async(req,res)=>{
    if(req.method!=='POST') return json(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      || !sameOrigin(req) || !csrfToken || req.headers['x-variable-os-csrf']!==csrfToken)
      return json(res,403,{ok:false,code:'DUPLEX_FORBIDDEN'});
    if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) return json(res,415,{ok:false,code:'CONTENT_TYPE_REQUIRED'});
    const bodyTimer=setTimeout(()=>req.destroy(),10000);
    let input;
    try {input=await readBody(req);}catch(error){return json(res,error.message==='BODY_TOO_LARGE'?413:400,{ok:false,code:error.message==='BODY_TOO_LARGE'?'BODY_TOO_LARGE':'DUPLEX_REQUEST_INVALID'});}
    finally{clearTimeout(bodyTimer);}
    if(input.action!=='start') {
      try {return json(res,200,input.action==='availability'?await service.availability():await service.control(input));}
      catch(error){const code=/^DUPLEX_[A-Z_]+$/.test(error?.message||'')?error.message:'DUPLEX_CONTROL_FAILED';return json(res,400,{ok:false,code});}
    }
    const controller=new AbortController();
    res.on('close',()=>controller.abort());
    let queued=0,tail=Promise.resolve();
    const emit=value=>{
      const line=JSON.stringify(value)+'\n';const size=Buffer.byteLength(line);
      if(size+queued>262144 || res.destroyed || controller.signal.aborted) {
        if(size+queued>262144) controller.abort(Error('DUPLEX_OUTPUT_BACKPRESSURE'));else controller.abort();
        return Promise.reject(Error('DUPLEX_OUTPUT_BACKPRESSURE'));
      }
      queued+=size;
      const pending=tail.then(async()=>{
        if(res.destroyed || controller.signal.aborted) throw Error('DUPLEX_CANCELLED');
        if(!res.headersSent) res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'SAMEORIGIN'});
        if(!res.write(line)) await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{done();controller.abort(Error('DUPLEX_OUTPUT_BACKPRESSURE'));reject(Error('DUPLEX_OUTPUT_BACKPRESSURE'));},2000);
          const drain=()=>{done();resolve();};const closed=()=>{done();reject(Error('DUPLEX_CANCELLED'));};
          const done=()=>{clearTimeout(timer);res.off('drain',drain);res.off('close',closed);};
          res.once('drain',drain);res.once('close',closed);
        });
        if(value.type==='closed') res.end();
      }).finally(()=>{queued-=size;});
      tail=pending.catch(()=>{});return pending;
    };
    try {await service.start(input,{emit,signal:controller.signal});}
    catch(error){if(!res.headersSent) json(res,error.message==='DUPLEX_BUSY'?409:503,{ok:false,code:/^DUPLEX_[A-Z_]+$/.test(error?.message||'')?error.message:'DUPLEX_START_FAILED'});else res.end();}
  };
}
