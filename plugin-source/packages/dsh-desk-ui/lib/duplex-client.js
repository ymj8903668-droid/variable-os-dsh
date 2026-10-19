// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const INPUT_BATCH_BYTES = 3200; // 100 ms, mono PCM16 LE, 16 kHz.
const INPUT_QUEUE_BYTES = 32000;
const MAX_LINE_CHARS = 262144;
const PLAYOUT_BUFFER_SECONDS = 0.12; // Absorb packet jitter before scheduling contiguous PCM.
const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : fallback;
const START_ERROR_CODES = new Set(['DUPLEX_KEY_UNAVAILABLE', 'DUPLEX_BUSY', 'DUPLEX_FORBIDDEN',
  'DUPLEX_REQUEST_INVALID', 'DUPLEX_CONTEXT_INVALID', 'DUPLEX_CANCELLED', 'DUPLEX_START_FAILED']);
const UPLOAD_ERROR_CODES = new Set(['DUPLEX_AUDIO_BACKPRESSURE', 'DUPLEX_AUDIO_SEQUENCE', 'DUPLEX_AUDIO_INVALID',
  'DUPLEX_CALL_NOT_FOUND', 'DUPLEX_NOT_READY', 'DUPLEX_FORBIDDEN', 'DUPLEX_REQUEST_INVALID']);
const DIAGNOSTIC_CODES = new Set([...START_ERROR_CODES, ...UPLOAD_ERROR_CODES,
  'DUPLEX_ASR_ID_MISSING', 'DUPLEX_AUDIO_ID_MISSING', 'DUPLEX_BROWSER_UNSUPPORTED',
  'DUPLEX_CAPTURE_FAILED', 'DUPLEX_CAPTURE_INVALID', 'DUPLEX_CLOSED', 'DUPLEX_CONTROL_FAILED',
  'DUPLEX_HANGUP', 'DUPLEX_INPUT_BACKPRESSURE', 'DUPLEX_INPUT_STALE', 'DUPLEX_MICROPHONE_DENIED',
  'DUPLEX_MICROPHONE_ENDED', 'DUPLEX_OUTPUT_BACKPRESSURE', 'DUPLEX_PROTOCOL_INVALID',
  'DUPLEX_PROTOCOL_LIMIT', 'DUPLEX_PROVIDER_ERROR', 'DUPLEX_PROVIDER_CLOSED', 'DUPLEX_START_TIMEOUT',
  'DUPLEX_STREAM_DISCONNECTED', 'DUPLEX_UPLOAD_FAILED', 'DUPLEX_OUTPUT_FAILED', 'DUPLEX_PLAYBACK_FAILED',
  'DUPLEX_RESEARCH_FAILED', 'DUPLEX_EARLY_CALL_LIMIT', 'DUPLEX_TOOL_CALL_INVALID', 'DUPLEX_TOOL_CALL_CONFLICT',
  'DUPLEX_TOOL_CALL_LIMIT', 'DUPLEX_RESEARCH_CLOSED', 'DUPLEX_TOOL_SUBMISSION_FAILED']);

async function uploadError(response, signal) {
  const fallback = 'DUPLEX_UPLOAD_FAILED';
  if (!response?.body) return fallback;
  const reader = response.body.getReader();
  let cancelled = false;
  const cancel = () => { cancelled = true; void reader.cancel().catch(() => {}); };
  const timer = setTimeout(cancel, 1000);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted || !response.headers.get('content-type')?.includes('application/json')) return fallback;
    let bytes = 0, text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (cancelled || signal.aborted) return fallback;
      if (done) {
        const code = JSON.parse(text + decoder.decode())?.code;
        return UPLOAD_ERROR_CODES.has(code) ? code : fallback;
      }
      bytes += value.byteLength;
      if (bytes > 4096) return fallback;
      text += decoder.decode(value, { stream: true });
    }
  } catch { /* Only complete, bounded, allowlisted codes are observable. */ }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); cancel(); }
  return fallback;
}

function encodeAudio(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decodeAudio(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 131072 || value.length % 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('DUPLEX_AUDIO_INVALID');
  const binary = atob(value);
  if (!binary.length || binary.length % 2) throw new Error('DUPLEX_AUDIO_INVALID');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** Explicit, page-owned call. No credentials, recording, retries or speech synthesis. */
export function createDuplexClient({
  request, getContext = () => ({}), workletUrl, onEvent = () => {}, onState = () => {},
  onDiagnostic = () => {}, now = () => globalThis.performance?.now?.() ?? Date.now(),
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNode = globalThis.AudioWorkletNode,
} = {}) {
  let current = null;
  const live = (run) => current === run && !run.ended;
  const emit = (event) => { try { onEvent(event); } catch { /* A view callback cannot retain the microphone. */ } };
  const state = (run, status, code) => {
    run.status = status;
    const next = { status, muted: run.muted, callId: run.callId || null, ...(code ? { code } : {}) };
    if (run.lastState && ['status', 'muted', 'callId', 'code'].every(key => next[key] === run.lastState[key])) return;
    run.lastState = next;
    try { onState(next); } catch { /* View boundary. */ }
  };

  function stopLocal(run) {
    for (const key of run.responseKeys) run.blockedResponses.add(key);
    run.responseKeys.clear();
    run.activeAudio = null;
    run.requireStarted = true;
    for (const source of run.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      try { source.disconnect(); } catch { /* Already disconnected. */ }
    }
    run.sources.clear();
    run.nextPlaybackAt = 0;
    if (live(run) && run.ready) state(run, 'listening');
  }

  async function control(run, action, payload = {}, { detached = false } = {}) {
    if (!run.callId || (!detached && !live(run))) return false;
    const controller = new AbortController();
    if (!detached) run.controls.add(controller);
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('DUPLEX_CONTROL_TIMEOUT')); }, 2000); });
      const response = await Promise.race([request(action, { callId: run.callId, ...payload }, { signal: controller.signal }), timeout]);
      if (!response?.ok) throw new Error('DUPLEX_CONTROL_FAILED');
      await response.body?.cancel();
      return true;
    } catch {
      if (!detached && live(run)) finish(run, 'DUPLEX_CONTROL_FAILED');
      return false;
    } finally {
      clearTimeout(timer);
      run.controls.delete(controller);
      controller.abort();
    }
  }

  function finish(run, code, { notify = true, normal = false } = {}) {
    if (run.ended) return run.closedPromise || Promise.resolve();
    run.ended = true;
    if (current === run) current = null;
    // Snapshot before cleanup erases the queue. Client and Host observations
    // are separate: a broken stream cannot reliably carry its own final cause.
    const diagnostic = Object.freeze({event:'xiaomei-duplex-client-close',timestamp:Date.now(),
      callId:run.callId,sessionId:run.sessionId || null,
      code:DIAGNOSTIC_CODES.has(code) ? code : 'DUPLEX_PROTOCOL_INVALID',
      elapsedMs:Math.max(0,Math.round(now()-run.startedAt)),
      pendingInputBytes:run.pendingBytes+run.partialLength,
      uploadInFlightMs:run.uploadStartedAt == null ? 0 : Math.max(0,Math.round(now()-run.uploadStartedAt)),
      uploadedBatches:run.uploadedBatches});
    try { Promise.resolve(onDiagnostic(diagnostic)).catch(() => {}); } catch { /* Never retain a call for logging. */ }
    clearTimeout(run.startTimer);
    run.resolveReady?.(false);
    stopLocal(run);
    run.partial = new Uint8Array(INPUT_BATCH_BYTES);
    run.partialLength = 0;
    run.pending.length = 0;
    run.pendingBytes = 0;
    if (run.node) {
      run.node.port.onmessage = null;
      run.node.onprocessorerror = null;
      run.node.port.close?.();
      try { run.node.disconnect(); } catch { /* Cleanup. */ }
    }
    try { run.input?.disconnect(); } catch { /* Cleanup. */ }
    for (const track of run.stream?.getTracks() || []) {
      track.removeEventListener?.('ended', run.trackEnded);
      track.stop();
    }
    run.abort.abort();
    for (const controller of run.controls) controller.abort();
    run.controls.clear();
    Promise.resolve(run.reader?.cancel()).catch(() => {});
    Promise.resolve(run.audio?.close()).catch(() => {});
    state(run, normal ? 'closed' : 'error', code);
    run.closedPromise = notify && run.callId ? control(run, 'hangup', {}, { detached: true }) : Promise.resolve();
    return run.closedPromise;
  }

  async function upload(run) {
    if (run.uploading || !live(run)) return;
    run.uploading = true;
    try {
      while (live(run) && run.pending.length) {
        const bytes = run.pending.shift();
        run.uploadStartedAt = now();
        const response = await request('audio', { callId: run.callId, sequence: run.sequence++, audio: encodeAudio(bytes) }, { signal: run.abort.signal });
        if (!live(run)) return;
        if (!response?.ok) throw new Error(await uploadError(response, run.abort.signal));
        await response.body?.cancel();
        run.pendingBytes -= bytes.byteLength;
        run.uploadedBatches++;
        run.uploadStartedAt = null;
      }
    } catch (error) {
      if (live(run)) finish(run, UPLOAD_ERROR_CODES.has(error?.message) ? error.message : 'DUPLEX_UPLOAD_FAILED');
    } finally { run.uploading = false; }
  }

  function capture(run, data) {
    if (!live(run) || !run.ready || run.muted) return;
    if (!(data?.pcm instanceof ArrayBuffer) || data.pcm.byteLength !== 640 || !Number.isFinite(data.capturedAt) || data.capturedAt < 0) { finish(run, 'DUPLEX_CAPTURE_INVALID'); return; }
    if (run.audio.currentTime - data.capturedAt > 1) { finish(run, 'DUPLEX_INPUT_STALE'); return; }
    if (run.pendingBytes + run.partialLength + data.pcm.byteLength > INPUT_QUEUE_BYTES) { finish(run, 'DUPLEX_INPUT_BACKPRESSURE'); return; }
    run.partial.set(new Uint8Array(data.pcm), run.partialLength);
    run.partialLength += data.pcm.byteLength;
    if (run.partialLength === INPUT_BATCH_BYTES) {
      run.pending.push(run.partial);
      run.pendingBytes += INPUT_BATCH_BYTES;
      run.partial = new Uint8Array(INPUT_BATCH_BYTES);
      run.partialLength = 0;
      void upload(run);
    }
  }

  function audioKey(event) {
    const question = typeof event.question_id === 'string' ? event.question_id : '';
    const response = typeof event.response_id === 'string' ? event.response_id : '';
    if (question.length > 200 || response.length > 200) throw new Error('DUPLEX_PROTOCOL_INVALID');
    if (!question && !response) throw new Error('DUPLEX_AUDIO_ID_MISSING');
    return JSON.stringify([question, response]);
  }

  function providerEvent(run, event) {
    if (!event || typeof event.type !== 'string') throw new Error('DUPLEX_PROTOCOL_INVALID');
    if (event.type === 'conversation.item.input_audio_transcription.started') {
      if (typeof event.item_id !== 'string' || !event.item_id || event.item_id.length > 200) throw new Error('DUPLEX_ASR_ID_MISSING');
      // Native ASR item_id is the corresponding output question_id. Duplicates
      // and old starts must not interrupt a newer answer or reopen its old turn.
      if (run.questions.has(event.item_id)) return;
      if (run.questions.size >= 1024) throw new Error('DUPLEX_PROTOCOL_LIMIT');
      run.questions.add(event.item_id);
      run.currentQuestion = event.item_id;
      run.awaitingNewAsr = false;
      stopLocal(run);
    }
    if (event.type === 'response.output_audio.started') {
      const key = audioKey(event);
      if (run.awaitingNewAsr) return;
      if (run.currentQuestion && event.question_id !== run.currentQuestion) return;
      if (!run.blockedResponses.has(key)) {
        if (run.responseKeys.size + run.blockedResponses.size >= 1024) throw new Error('DUPLEX_PROTOCOL_LIMIT');
        if (!run.currentQuestion && event.question_id) {
          run.currentQuestion = event.question_id;
          run.questions.add(event.question_id);
        }
        run.responseKeys.add(key);
        run.activeAudio = key;
        run.requireStarted = false;
      }
    }
    if (event.type === 'response.output_audio.delta') {
      const key = audioKey(event);
      if (run.requireStarted || run.activeAudio !== key || run.blockedResponses.has(key)) return;
      const samples = decodeAudio(event.delta);
      const startAt = run.nextPlaybackAt > run.audio.currentTime + 0.01
        ? run.nextPlaybackAt : run.audio.currentTime + PLAYOUT_BUFFER_SECONDS;
      if (startAt - run.audio.currentTime + samples.length / 24000 > 2) throw new Error('DUPLEX_OUTPUT_BACKPRESSURE');
      const buffer = run.audio.createBuffer(1, samples.length, 24000);
      buffer.getChannelData(0).set(samples);
      const source = run.audio.createBufferSource();
      source.buffer = buffer;
      source.connect(run.audio.destination);
      run.sources.add(source);
      source.onended = () => {
        run.sources.delete(source);
        try { source.disconnect(); } catch { /* Already disconnected. */ }
        if (live(run) && !run.sources.size) state(run, 'listening');
      };
      source.start(startAt);
      run.nextPlaybackAt = startAt + buffer.duration;
      state(run, 'speaking');
      // Audio stays transient in Web Audio, never in UI event history or logs.
      emit({ type: 'provider', event: { type: event.type, question_id: event.question_id, response_id: event.response_id, bytes: samples.byteLength / 2 } });
      return;
    }
    if (event.type === 'error') throw new Error('DUPLEX_PROVIDER_ERROR');
    emit({ type: 'provider', event });
  }

  function receive(run, event) {
    if (!live(run)) return;
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('DUPLEX_PROTOCOL_INVALID');
    if (event.type === 'call') {
      if (run.callId || typeof event.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.callId)) throw new Error('DUPLEX_PROTOCOL_INVALID');
      run.callId = event.callId;
    } else if (event.type === 'ready') {
      if (!run.callId || run.ready) throw new Error('DUPLEX_PROTOCOL_INVALID');
      run.ready = true;
      clearTimeout(run.startTimer);
      state(run, 'listening');
      run.resolveReady(true);
    } else if (event.type === 'provider') { providerEvent(run, event.event); return; }
    else if (event.type === 'closed') {
      const code = safeCode(event.code, 'DUPLEX_PROTOCOL_INVALID');
      finish(run, code, { notify: false, normal: ['DUPLEX_CLOSED', 'DUPLEX_CANCELLED', 'DUPLEX_HANGUP'].includes(code) });
      emit({ type: 'closed', code });
      return;
    }
    else if (!['native', 'status'].includes(event.type)) throw new Error('DUPLEX_PROTOCOL_INVALID');
    emit(event);
  }

  async function consume(run, response) {
    try {
      if (!response?.ok) {
        let code = 'DUPLEX_START_FAILED';
        if (response?.body && response.headers.get('content-type')?.includes('application/json')) {
          // Error bodies are small, bounded, and never surfaced as raw text.
          run.reader = response.body.getReader();
          try {
            let bytes = 0, text = '';
            const decoder = new TextDecoder('utf-8', { fatal: true });
            while (live(run)) {
              const { value, done } = await run.reader.read();
              if (done) {
                text += decoder.decode();
                const candidate = JSON.parse(text)?.code;
                if (START_ERROR_CODES.has(candidate)) code = candidate;
                break;
              }
              bytes += value.byteLength;
              if (bytes > 4096) break;
              text += decoder.decode(value, { stream: true });
            }
          } catch { /* Malformed or cancelled HTTP body retains the generic code. */ }
        }
        throw new Error(code);
      }
      if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('DUPLEX_START_FAILED');
      run.reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffered = '';
      while (live(run)) {
        let chunk;
        try { chunk = await run.reader.read(); }
        catch { throw new Error('DUPLEX_STREAM_DISCONNECTED'); }
        const { value, done } = chunk;
        if (!live(run)) return;
        buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.length > MAX_LINE_CHARS) throw new Error('DUPLEX_PROTOCOL_LIMIT');
          if (line.trim()) receive(run, JSON.parse(line));
          if (!live(run)) return;
        }
        if (buffered.length > MAX_LINE_CHARS) throw new Error('DUPLEX_PROTOCOL_LIMIT');
        if (done) {
          if (buffered.trim()) receive(run, JSON.parse(buffered));
          if (live(run)) finish(run, 'DUPLEX_STREAM_DISCONNECTED');
          return;
        }
      }
    } catch (error) {
      if (live(run)) finish(run, safeCode(error?.message, 'DUPLEX_PROTOCOL_INVALID'));
    }
  }

  function start() {
    if (current) return Promise.resolve(false);
    const run = { ended: false, muted: false, ready: false, callId: null, abort: new AbortController(), controls: new Set(),
      startedAt:now(),uploadedBatches:0,uploadStartedAt:null,
      muteChain: Promise.resolve(), muteRevision: 0,
      pending: [], pendingBytes: 0, partial: new Uint8Array(INPUT_BATCH_BYTES), partialLength: 0, sequence: 0,
      sources: new Set(), responseKeys: new Set(), blockedResponses: new Set(), questions: new Set(), currentQuestion: null,
      requireStarted: true, nextPlaybackAt: 0 };
    current = run;
    const readiness = new Promise((resolve) => { run.resolveReady = resolve; });
    state(run, 'starting');
    run.startTimer = setTimeout(() => finish(run, 'DUPLEX_START_TIMEOUT'), 15000);
    const setup = async () => { try {
      if (!AudioContext || !AudioWorkletNode || !mediaDevices?.getUserMedia || !workletUrl || typeof request !== 'function') throw new Error('DUPLEX_BROWSER_UNSUPPORTED');
      const snapshot = getContext();
      run.sessionId = /^xiaomei-agent-[a-z0-9-]{16,96}$/.test(snapshot?.sessionId || '') ? snapshot.sessionId : null;
      // Both calls happen synchronously in the explicit button gesture, before await.
      run.audio = new AudioContext();
      const resumed = run.audio.resume();
      const permission = mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }).then((stream) => {
        if (live(run)) run.stream = stream;
        else for (const track of stream.getTracks()) track.stop();
        return stream;
      });
      await Promise.all([resumed, permission]);
      if (!live(run)) return false;
      run.trackEnded = () => finish(run, 'DUPLEX_MICROPHONE_ENDED');
      for (const track of run.stream.getTracks()) track.addEventListener?.('ended', run.trackEnded);
      await run.audio.audioWorklet.addModule(workletUrl);
      if (!live(run)) return false;
      run.input = run.audio.createMediaStreamSource(run.stream);
      run.node = new AudioWorkletNode(run.audio, 'xiaomei-duplex-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      run.node.port.onmessage = ({ data }) => capture(run, data);
      run.node.onprocessorerror = () => finish(run, 'DUPLEX_CAPTURE_FAILED');
      run.input.connect(run.node);
      run.node.connect(run.audio.destination);
      const response = await request('start', snapshot, { signal: run.abort.signal });
      if (!live(run)) { await response?.body?.cancel(); return false; }
      void consume(run, response);
    } catch (error) {
      if (live(run)) finish(run, error?.name === 'NotAllowedError' ? 'DUPLEX_MICROPHONE_DENIED' : safeCode(error?.message, 'DUPLEX_START_FAILED'));
    } };
    void setup();
    return readiness;
  }

  return {
    start,
    hangup() { return current ? finish(current, 'DUPLEX_HANGUP', { normal: true }) : Promise.resolve(); },
    setMuted(muted) {
      const run = current;
      if (!run || !run.ready || typeof muted !== 'boolean') return Promise.resolve(false);
      const revision = ++run.muteRevision;
      // Closing the microphone is immediate. Reopening waits for the latest
      // server acknowledgement; otherwise its first words hit a still-muted host.
      run.muted = true;
      for (const track of run.stream.getAudioTracks()) track.enabled = false;
      // Do not replay partial/pending speech after unmuting. An already sent batch
      // cannot be withdrawn; the server mute event is its separate privacy gate.
      run.pendingBytes -= run.pending.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      run.pending.length = 0;
      run.partialLength = 0;
      run.partial.fill(0);
      state(run, run.status);
      run.muteChain = run.muteChain.then(() => control(run, 'mute', { muted })).then((ok) => {
        if (ok && live(run) && revision === run.muteRevision) {
          run.muted = muted;
          for (const track of run.stream.getAudioTracks()) track.enabled = !muted;
          state(run, run.status);
        }
        return ok;
      });
      return run.muteChain;
    },
    stopSpeaking() {
      const run = current;
      if (!run) return Promise.resolve(false);
      run.awaitingNewAsr = true;
      stopLocal(run);
      return control(run, 'stop-speaking');
    },
    cancelResearch() { return current ? control(current, 'cancel-research') : Promise.resolve(false); },
  };
}
