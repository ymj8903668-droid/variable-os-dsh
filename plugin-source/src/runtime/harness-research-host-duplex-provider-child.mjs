// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

// Executed only by the owned fork. No credential-bearing error is serialized.
// Node 24.18 native WS; protocol: https://docs.volcengine.com/docs/6561/2549778?lang=zh
// Observed v3 wire audio contains 81,920 base64 characters. The JSON-message
// bound is 128 KiB; the separate unacknowledged-event budget remains 256 KiB.
const MAX_FRAME = 131_072, MAX_EVENTS = 16, MAX_PENDING_BYTES = 262_144;
let socket, phase = 'waiting', fenced = false, muted = false, config;
let audioEpoch = null;
let audioRemainder = Buffer.alloc(0);
const resetAudio = () => { audioEpoch = null; audioRemainder = Buffer.alloc(0); };
let eventId = 0, pendingBytes = 0;
const pending = new Map(), asrHistory = new Set();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 16_384) => typeof value === 'string' && Buffer.byteLength(value) <= max;
const ipc = value => { if (process.connected) process.send(value, () => {}); };
const finish = code => {
  if (phase === 'ended') return;
  phase = 'ended'; resetAudio(); asrHistory.clear(); headersChannel.unsubscribe(headers);
  // Terminating this process makes failed handshakes hard terminal: Undici
  // cannot retry a 401 or retain an uncooperative transport in the Host.
  try { socket?.close(1000); } catch { /* process exit is final teardown */ }
  if (process.connected) process.send({kind:'terminal',code}, () => process.exit(code === 'DUPLEX_CLOSED' ? 0 : 1));
  setTimeout(() => process.exit(1), 50);
};
const emit = event => {
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (pending.size >= MAX_EVENTS || pendingBytes + bytes > MAX_PENDING_BYTES) { finish('DUPLEX_BACKPRESSURE'); return false; }
  const id = ++eventId; pending.set(id, bytes); pendingBytes += bytes;
  ipc({kind:'event',id,event}); return true;
};
const send = event => {
  if (socket?.readyState !== WebSocket.OPEN) return finish('DUPLEX_CONNECTION_CLOSED');
  const data = JSON.stringify({...event,event_id:randomUUID()});
  if (socket.bufferedAmount + Buffer.byteLength(data) > 65_536) return finish('DUPLEX_BACKPRESSURE');
  try { socket.send(data); } catch { finish('DUPLEX_CONNECTION_CLOSED'); }
};
const headersChannel = channel('undici:request:headers');
const headers = ({request,response}) => {
  if (phase !== 'connecting' || !socket) return;
  const url = new URL(socket.url.replace(/^ws/, 'http'));
  if (String(request.origin) === url.origin && request.path === url.pathname + url.search
    && Number.isInteger(response.statusCode) && response.statusCode !== 101) finish('DUPLEX_CONNECTION_FAILED');
};

function numericUsage(value, depth = 0) {
  if (!object(value) || depth > 3 || Object.keys(value).length > 32) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[key] = item;
    else if (object(item)) { const nested = numericUsage(item, depth + 1); if (nested) result[key] = nested; }
  }
  return Object.keys(result).length ? result : undefined;
}

function project(event) {
  const output = {type:event.type};
  for (const key of ['event_id','item_id','question_id','response_id']) {
    if (event[key] !== undefined) { if (!text(event[key], 200)) throw Error(); output[key] = event[key]; }
  }
  if (event.content_index !== undefined) {
    if (!Number.isSafeInteger(event.content_index) || event.content_index < 0) throw Error();
    output.content_index = event.content_index;
  }
  switch (event.type) {
    case 'conversation.item.input_audio_transcription.started': return output;
    case 'conversation.item.input_audio_transcription.delta':
    case 'response.output_text.delta':
      if (!text(event.delta)) throw Error(); output.delta = event.delta; return output;
    case 'conversation.item.input_audio_transcription.completed': {
      // The observed service sends text; the published protocol says transcript.
      // Both are accepted only when they agree. Delta strings remain snapshots,
      // not append-only tokens: the consumer replaces its interim ASR text.
      if (event.text !== undefined && !text(event.text)
        || event.transcript !== undefined && !text(event.transcript)
        || event.text !== undefined && event.transcript !== undefined && event.text !== event.transcript) throw Error();
      const transcript = event.transcript ?? event.text;
      if (!text(transcript)) throw Error(); output.transcript = transcript; return output;
    }
    case 'conversation.item.input_audio_transcription.failed':
      return {...output,error:{code:'DUPLEX_TRANSCRIPTION_FAILED'}};
    case 'response.output_text.done':
      if (!text(event.text)) throw Error(); output.text = event.text; return output;
    case 'response.output_audio.started':
      if (event.tts_type !== undefined) {
        if (!['','audit_content_risky','chat_tts_text','network','default'].includes(event.tts_type)) throw Error();
        output.tts_type = event.tts_type;
      }
      resetAudio();
      audioEpoch = output.question_id && output.response_id
        ? {question_id:output.question_id,response_id:output.response_id} : null;
      return output;
    case 'response.output_audio.delta': {
      if (!text(event.delta, MAX_FRAME) || !event.delta.length || event.delta.length % 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) throw Error();
      const wire = Buffer.from(event.delta,'base64');
      if (wire.toString('base64') !== event.delta) throw Error();
      for (const key of ['question_id','response_id']) {
        if (output[key]) {
          if (audioEpoch && output[key] !== audioEpoch[key]) throw Error();
        } else {
          if (!audioEpoch) throw Error();
          output[key] = audioEpoch[key];
        }
      }
      audioEpoch = {question_id:output.question_id,response_id:output.response_id};
      // Live Seeduplex v3 `pcm` is Float32 LE, unlike its older Int16 demo.
      // Normalize once at the provider boundary; downstream clocks and browser
      // playback share a PCM16 LE / mono / 24 kHz contract. Never guess per chunk.
      const samples = Buffer.concat([audioRemainder,wire]);
      const completeBytes = samples.length - samples.length % 4;
      const pcm = Buffer.alloc(completeBytes / 2);
      for (let offset = 0; offset < completeBytes; offset += 4) {
        const sample = samples.readFloatLE(offset);
        if (!Number.isFinite(sample)) throw Error();
        pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(sample * 32768))),offset / 2);
      }
      audioRemainder = Buffer.from(samples.subarray(completeBytes));
      return pcm.length ? {...output,delta:pcm.toString('base64')} : null;
    }
    case 'response.output_audio.done':
      if (audioRemainder.length) throw Error();
      if (event.status_code !== undefined) {
        if (!['string','number'].includes(typeof event.status_code) || !/^\d{8}$/.test(String(event.status_code))) throw Error();
        output.status_code = event.status_code;
      }
      resetAudio(); return output;
    case 'response.function_call_arguments.done': {
      if (!Array.isArray(event.items) || !event.items.length || event.items.length > 8) throw Error();
      const names = new Set(config.tools.map(t => t.name)), ids = new Set();
      output.items = event.items.map(item => {
        // Live v3 FC items omit id/type. They are optional metadata, not tool
        // authority: explicit wrong metadata and all required fields still fail.
        if (!object(item) || item.type !== undefined && item.type !== 'function_call'
          || item.id !== undefined && !text(item.id,200)
          || !text(item.call_id,200) || !item.call_id || ids.has(item.call_id)
          || !names.has(item.name) || !text(item.arguments,8192) || !object(JSON.parse(item.arguments))) throw Error();
        ids.add(item.call_id);
        return {...(item.id !== undefined ? {id:item.id} : {}),type:'function_call',call_id:item.call_id,name:item.name,arguments:item.arguments};
      });
      return output;
    }
    case 'response.done': {
      if (audioRemainder.length) throw Error();
      resetAudio();
      // Docs do not specify a usage schema. Preserve only bounded numerical
      // counters, without assuming OpenAI's response.usage contract.
      const usage = numericUsage(event.usage); if (usage) output.usage = usage;
      const nested = numericUsage(event.response?.usage); if (nested) output.response = {usage:nested};
      return output;
    }
    case 'response.canceled':
    case 'input_audio_buffer.committed':
    case 'session.updated': return output;
    default: return null; // Unknown events are not a tool execution channel.
  }
}

function message({data}) {
  if (phase === 'ended' || phase === 'transport-closing') return;
  if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_FRAME) return finish('DUPLEX_PROTOCOL_INVALID');
  let event;
  try { event = JSON.parse(data); } catch { return finish('DUPLEX_PROTOCOL_INVALID'); }
  if (!object(event) || !text(event.type,100)) return finish('DUPLEX_PROTOCOL_INVALID');
  if (event.type === 'error') return finish('DUPLEX_PROVIDER_REJECTED');
  if (event.type === 'session.closed') {
    if (phase !== 'closing') return finish('DUPLEX_CONNECTION_CLOSED');
    phase = 'transport-closing'; socket.close(1000); return;
  }
  if (phase === 'closing') return;
  if (event.type === 'session.created') {
    if (phase !== 'creating' || !/^[A-Za-z0-9_-]{8,200}$/.test(event.session?.id ?? '')) return finish('DUPLEX_PROTOCOL_INVALID');
    phase = 'open'; headersChannel.unsubscribe(headers);
    emit({type:'session.created',session:{id:event.session.id}}); ipc({kind:'ready'}); return;
  }
  if (phase !== 'open') return finish('DUPLEX_PROTOCOL_INVALID');
  if (event.type.startsWith('conversation.item.input_audio_transcription.')
    || event.type === 'response.canceled') resetAudio();
  if (event.type.startsWith('conversation.item.input_audio_transcription.')
    && typeof event.item_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(event.item_id)
    && !asrHistory.has(event.item_id)) {
    // A replayed/missing ID is still projected for the UI, but cannot reopen
    // the post-cancel FC/audio gate. Any prior ASR phase reserves its ID.
    if (asrHistory.size >= 256) return finish('DUPLEX_ASR_HISTORY_LIMIT');
    asrHistory.add(event.item_id);
    if (event.type === 'conversation.item.input_audio_transcription.started') fenced = false;
  }
  if (fenced && event.type.startsWith('response.') && event.type !== 'response.canceled') return;
  try { const projected = project(event); if (projected) emit(projected); }
  catch { finish('DUPLEX_PROTOCOL_INVALID'); }
}

process.on('message', command => {
  if (!object(command) || phase === 'ended') return;
  if (command.kind === 'event-ack') {
    pendingBytes -= pending.get(command.id) ?? 0; pending.delete(command.id); return;
  }
  if (command.kind === 'start' && phase === 'waiting') {
    config = {instructions:command.instructions,tools:command.tools}; phase = 'connecting';
    headersChannel.subscribe(headers);
    try {
      socket = new WebSocket(command.endpoint, {headers:{'X-Api-Key':command.apiKey}});
      command.apiKey = undefined;
      socket.addEventListener('open', () => {
        if (phase !== 'connecting') return;
        phase = 'creating';
        send({type:'session.create',session:{model:'1.2.6.1',instructions:config.instructions,tools:config.tools,audio:{
          input:{format:{type:'pcm',rate:16000}},
          output:{format:{type:'pcm',rate:24000},voice:'zh_female_vv_jupiter_bigtts',speed:0,loudness:0},
        }}});
      });
      socket.addEventListener('message', message);
      socket.addEventListener('error', () => finish(phase === 'connecting' ? 'DUPLEX_CONNECTION_FAILED' : 'DUPLEX_CONNECTION_CLOSED'));
      socket.addEventListener('close', event => finish(phase === 'transport-closing' && event.wasClean && event.code === 1000 ? 'DUPLEX_CLOSED' : 'DUPLEX_CONNECTION_CLOSED'));
    } catch { finish('DUPLEX_CONNECTION_FAILED'); }
    return;
  }
  if (command.kind !== 'command' || phase !== 'open') return;
  switch (command.op) {
    case 'audio': if (!muted) send({type:'input_audio_buffer.append',audio:command.audio}); break;
    case 'mute': muted = command.muted; send({type:muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit'}); break;
    case 'cancel': fenced = true; resetAudio(); send({type:'response.cancel'}); break;
    case 'tool-results': send({type:'conversation.item.create',items:command.items}); break;
    case 'close': phase = 'closing'; resetAudio(); send({type:'session.close'}); break;
    default: return finish('DUPLEX_PROTOCOL_INVALID');
  }
  if (command.id) ipc({kind:'command-ack',id:command.id});
});
process.on('disconnect', () => process.exit(1));
process.on('uncaughtException', () => finish('DUPLEX_CHILD_FAILED'));
process.on('unhandledRejection', () => finish('DUPLEX_CHILD_FAILED'));
