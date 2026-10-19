// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { fork } from 'node:child_process';

const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const fail = code => Object.assign(new Error(code), {code});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && Buffer.byteLength(value) <= max;

// The Host never imports the child module (or its process-global diagnostics
// hook). Commands are synchronous bounded admission, not delivery promises.
// onEvent may return a promise; its completion releases downstream credit.
// Caller supplies one PCM16/16 kHz mono frame every 20 ms. We never replay or
// accelerate a backlog. close()/closed resolve only after the owned child exits.
export async function createSeeduplexProvider({
  apiKey, instructions = '', tools = [], onEvent = () => {},
  startupTimeoutMs = 8_000, closeTimeoutMs = 1_500,
  testEndpoint,
} = {}) {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(apiKey)) throw fail('DUPLEX_KEY_INVALID');
  let endpoint = ENDPOINT;
  if (testEndpoint !== undefined) {
    let url;
    try { url = new URL(testEndpoint); } catch { throw fail('DUPLEX_CONFIG_INVALID'); }
    // A test-only upstream boundary, never arbitrary remote URL/header routing.
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash) throw fail('DUPLEX_CONFIG_INVALID');
    endpoint = url.href;
  }
  let toolBytes;
  try { toolBytes = JSON.stringify(tools); } catch { throw fail('DUPLEX_CONFIG_INVALID'); }
  if (!bounded(instructions, 16_384) || typeof onEvent !== 'function'
    || !Array.isArray(tools) || tools.length > 8 || !bounded(toolBytes, 16_384)
    || tools.some(t => !object(t) || t.type !== 'function' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(t.name) || !object(t.parameters))
    || new Set(tools.map(t => t.name)).size !== tools.length
    || ![startupTimeoutMs, closeTimeoutMs].every(n => Number.isInteger(n) && n >= 20 && n <= 10_000)) throw fail('DUPLEX_CONFIG_INVALID');

  const child = fork(new URL('./harness-research-host-duplex-provider-child.mjs', import.meta.url), [], {
    execPath:process.execPath, execArgv:[], env:{},
    stdio:['ignore','ignore','ignore','ipc'],
  });
  let ready = false, closing = false, exited = false, muted = false, cancelFence = false;
  let terminal, commandId = 0, pendingBytes = 0, closeTimer, killTimer;
  const pending = new Map(), batches = new Set(), callHistory = new Map(), asrHistory = new Set();
  const batchKey = items => JSON.stringify(items.map(item => item.call_id).sort());
  const callFingerprint = item => JSON.stringify([item.name,item.arguments]);
  let resolveClosed, resolveReady, rejectReady;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finish = () => {
    if (exited) return;
    exited = true; closing = true;
    clearTimeout(startTimer); clearTimeout(closeTimer); clearTimeout(killTimer);
    pending.clear(); batches.clear(); callHistory.clear(); asrHistory.clear();
    terminal ??= {ok:false,code:'DUPLEX_CONNECTION_CLOSED'};
    if (!ready) rejectReady(fail(terminal.code));
    resolveClosed(terminal);
  };
  const stop = code => {
    if (exited) return;
    closing = true; terminal ??= {ok:false,code};
    clearTimeout(startTimer); clearTimeout(closeTimer);
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 100);
  };
  const startTimer = setTimeout(() => stop('DUPLEX_START_TIMEOUT'), startupTimeoutMs);
  const send = (op, data = {}) => {
    if (closing || exited || !ready) throw fail('DUPLEX_CLOSED');
    const message = {kind:'command',id:++commandId,op,...data};
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (pending.size >= 32 || pendingBytes + bytes > 65_536) {
      stop('DUPLEX_BACKPRESSURE'); throw fail('DUPLEX_BACKPRESSURE');
    }
    pending.set(message.id, bytes); pendingBytes += bytes;
    try {
      child.send(message, error => { if (error && !closing) stop('DUPLEX_CONNECTION_CLOSED'); });
    } catch { stop('DUPLEX_CONNECTION_CLOSED'); throw fail('DUPLEX_CLOSED'); }
    return true;
  };
  const api = Object.freeze({
    pid:child.pid, closed,
    sendAudio(pcm) {
      if (closing || exited) throw fail('DUPLEX_CLOSED');
      if (!(pcm instanceof Uint8Array) || pcm.byteLength !== 640) throw fail('DUPLEX_AUDIO_INVALID');
      if (muted) throw fail('DUPLEX_MUTED');
      return send('audio', {audio:Buffer.from(pcm).toString('base64')});
    },
    setMuted(value) {
      if (typeof value !== 'boolean') throw fail('DUPLEX_CONFIG_INVALID');
      const accepted = send('mute', {muted:value}); muted = value; return accepted;
    },
    cancelResponse() {
      // Stop speech, not the DSH task: accepted call IDs keep one result slot.
      const accepted = send('cancel'); cancelFence = true; return accepted;
    },
    submitToolResults(items) {
      if (!Array.isArray(items) || !items.length || items.length > 8
        || new Set(items.map(item => item?.call_id)).size !== items.length
        || items.some(item => !object(item) || typeof item.call_id !== 'string' || item.role !== 'tool'
          || !Array.isArray(item.content) || item.content.length !== 1 || item.content[0]?.type !== 'input_text'
          || !bounded(item.content[0].text, 16_384) || Object.keys(item).some(k => !['call_id','role','content'].includes(k)))) throw fail('DUPLEX_TOOL_RESULT_INVALID');
      const batch = batchKey(items);
      if (!batches.has(batch)) throw fail('DUPLEX_TOOL_RESULT_INVALID');
      const clean = items.map(item => ({call_id:item.call_id,role:'tool',content:[{type:'input_text',text:item.content[0].text}]}));
      if (Buffer.byteLength(JSON.stringify(clean)) > 32_768) throw fail('DUPLEX_TOOL_RESULT_INVALID');
      const accepted = send('tool-results', {items:clean}); batches.delete(batch); return accepted;
    },
    close() {
      if (closing || exited) return closed;
      closing = true; batches.clear(); callHistory.clear(); asrHistory.clear();
      closeTimer = setTimeout(() => stop('DUPLEX_CLOSE_TIMEOUT'), closeTimeoutMs);
      try { child.send({kind:'command',op:'close'}, error => { if (error) stop('DUPLEX_CONNECTION_CLOSED'); }); }
      catch { stop('DUPLEX_CONNECTION_CLOSED'); }
      return closed;
    },
  });
  const acknowledge = id => {
    if (!closing && child.connected) {
      try { child.send({kind:'event-ack',id}, error => { if (error && !closing) stop('DUPLEX_CONNECTION_CLOSED'); }); }
      catch { stop('DUPLEX_CONNECTION_CLOSED'); }
    }
  };
  child.on('message', message => {
    if (exited || !object(message)) return;
    if (message.kind === 'terminal') {
      if (!/^DUPLEX_[A-Z_]+$/.test(message.code)) return stop('DUPLEX_PROTOCOL_INVALID');
      terminal ??= {ok:message.code === 'DUPLEX_CLOSED',code:message.code};
      closing = true;
      killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 100);
    } else if (message.kind === 'ready' && !closing && !ready) {
      ready = true; clearTimeout(startTimer); resolveReady(api);
    } else if (message.kind === 'command-ack') {
      pendingBytes -= pending.get(message.id) ?? 0; pending.delete(message.id);
    } else if (message.kind === 'event' && !closing) {
      const event = message.event;
      if (!object(event) || typeof event.type !== 'string') return stop('DUPLEX_PROTOCOL_INVALID');
      if (event.type.startsWith('conversation.item.input_audio_transcription.')
        && typeof event.item_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(event.item_id)
        && !asrHistory.has(event.item_id)) {
        // Never evict history: an evicted ASR ID could masquerade as a new turn
        // and authorize work that was not accepted before speech cancellation.
        if (asrHistory.size >= 256) return stop('DUPLEX_ASR_HISTORY_LIMIT');
        asrHistory.add(event.item_id);
        if (event.type === 'conversation.item.input_audio_transcription.started') cancelFence = false;
      }
      if (cancelFence && event.type.startsWith('response.') && event.type !== 'response.canceled') return acknowledge(message.id);
      if (event.type === 'response.function_call_arguments.done') {
        const batch = batchKey(event.items);
        const known = event.items.filter(item => callHistory.has(item.call_id));
        if (known.length) {
          // Only an exact replay of one prior batch is inert. Mixed old/new
          // ownership or a changed call cannot silently start another task.
          if (known.length !== event.items.length || known.some(item => {
            const previous = callHistory.get(item.call_id);
            return previous.batch !== batch || previous.fingerprint !== callFingerprint(item);
          })) return stop('DUPLEX_PROTOCOL_INVALID');
          return acknowledge(message.id);
        }
        // Up to 16 batches / 128 unfinished calls; retain at most 256 call IDs
        // for exact-once semantics, including after result submission.
        if (batches.size >= 16 || callHistory.size + event.items.length > 256) return stop('DUPLEX_TOOL_CALL_LIMIT');
        batches.add(batch);
        for (const item of event.items) callHistory.set(item.call_id,{batch,fingerprint:callFingerprint(item)});
      }
      try {
        Promise.resolve(onEvent(event)).then(() => acknowledge(message.id), () => stop('DUPLEX_EVENT_HANDLER_FAILED'));
      } catch { stop('DUPLEX_EVENT_HANDLER_FAILED'); }
    }
  });
  child.on('error', () => { terminal ??= {ok:false,code:'DUPLEX_CHILD_FAILED'}; if (!child.pid) finish(); else stop('DUPLEX_CHILD_FAILED'); });
  child.on('exit', finish);
  try {
    // Empty env and no execArgv: no inherited keys, proxies, NODE_OPTIONS or
    // preload hooks. Only this IPC message carries the selected API key.
    child.send({kind:'start',apiKey,endpoint,instructions,tools:JSON.parse(toolBytes)}, error => { if (error) stop('DUPLEX_CHILD_FAILED'); });
    apiKey = undefined;
  } catch { stop('DUPLEX_CHILD_FAILED'); }
  return started;
}
