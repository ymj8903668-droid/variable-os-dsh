// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const FRAME_BYTES = 960; // 20 ms, mono PCM16 LE at 24 kHz.
const MAX_PENDING_BYTES = 1440000; // 30 seconds; never grow an unbounded speech backlog.
const MAX_EVENTS = 256;
const MAX_WIRE_BYTES = 131072;
const AUDIO = 'response.output_audio.';
const ASR_STARTED = 'conversation.item.input_audio_transcription.started';

/** Transient server-side PCM pacing. No audio persistence or browser budget change. */
export function createDuplexPlayback({ emit, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now() } = {}) {
  if (typeof emit !== 'function') throw Error('DUPLEX_PLAYBACK_CONFIG');
  let queue = [], pendingBytes = 0, timer = null, pumping = false, closed = false, generation = 0;
  let question = null, inputSegment = null, awaitingAsr = false;
  let nextFrameAt = null;
  const questions = new Set(), responses = new Set();

  function clear() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null; queue = []; pendingBytes = 0; inputSegment = null; nextFrameAt = null;
  }
  function fail(code) {
    closed = true; clear();
    const error = Error(code);
    try { onError(error); } catch { /* A diagnostic callback cannot retain audio. */ }
    return error;
  }
  function validId(value, empty = false) {
    return typeof value === 'string' && (empty || value.length > 0) && value.length <= 200 && !/[\s\p{Cf}\p{Cc}]/u.test(value);
  }
  function identify(event) {
    if (!validId(event.question_id) || !validId(event.response_id, true)) throw fail('DUPLEX_PLAYBACK_ID_INVALID');
    return JSON.stringify([event.question_id, event.response_id]);
  }
  function marker(event) {
    const output = { type: event.type, question_id: event.question_id, response_id: event.response_id };
    for (const key of ['event_id', 'item_id']) if (event[key] !== undefined) {
      if (!validId(event[key], true)) throw fail('DUPLEX_PLAYBACK_ID_INVALID');
      output[key] = event[key];
    }
    if (event.content_index !== undefined) {
      if (!Number.isSafeInteger(event.content_index) || event.content_index < 0) throw fail('DUPLEX_PLAYBACK_EVENT_INVALID');
      output.content_index = event.content_index;
    }
    if (event.type === `${AUDIO}started` && event.tts_type !== undefined) {
      if (!['', 'audit_content_risky', 'chat_tts_text', 'network', 'default'].includes(event.tts_type)) throw fail('DUPLEX_PLAYBACK_EVENT_INVALID');
      output.tts_type = event.tts_type;
    }
    if (event.type === `${AUDIO}done` && event.status_code !== undefined) {
      if (!['string', 'number'].includes(typeof event.status_code) || !/^\d{8}$/.test(String(event.status_code))) throw fail('DUPLEX_PLAYBACK_EVENT_INVALID');
      output.status_code = event.status_code;
    }
    return output;
  }
  function remember(set, key) {
    if (!set.has(key) && set.size >= MAX_EVENTS) throw fail('DUPLEX_PLAYBACK_LIMIT');
    set.add(key);
  }
  function frameLength() {
    let bytes = 0;
    for (const item of queue) {
      if (!item.pcm) return bytes;
      bytes += item.pcm.length - item.offset;
      if (bytes >= FRAME_BYTES) return FRAME_BYTES;
    }
    // A short cloud chunk is not an utterance boundary. Wait for more PCM or done.
    return 0;
  }
  function schedule() {
    if (closed || pumping || !queue.length || (queue[0].pcm && !frameLength()) || timer !== null) return;
    // Correct sub-frame jitter against a monotonic media clock. After a full
    // missed frame, rebase instead of sending a burst of obsolete clock ticks.
    const time = now();
    if (nextFrameAt === null || time - nextFrameAt >= 20) nextFrameAt = time + 20;
    timer = setTimer(() => {
      timer = null;
      return pump();
    }, Math.max(0, nextFrameAt - time));
  }
  async function pump() {
    if (closed || pumping || !queue.length) return;
    pumping = true;
    const epoch = generation;
    try {
      // Control markers preserve audio order, but consume no audio duration.
      while (!closed && epoch === generation && queue.length) {
        const item = queue[0];
        if (!item.pcm) {
          queue.shift(); await emit(item.event);
          continue;
        }
        const length = frameLength();
        if (!length) break;
        const frame = Buffer.allocUnsafe(length);
        let copied = 0;
        while (copied < length) {
          const chunk = queue[0];
          const bytes = Math.min(length - copied, chunk.pcm.length - chunk.offset);
          chunk.pcm.copy(frame, copied, chunk.offset, chunk.offset + bytes);
          chunk.offset += bytes; copied += bytes; pendingBytes -= bytes;
          if (chunk.offset === chunk.pcm.length) queue.shift();
        }
        const sentAt = now();
        nextFrameAt = sentAt - nextFrameAt >= 20 ? sentAt + 20 : nextFrameAt + 20;
        await emit({ type: `${AUDIO}delta`, question_id: item.question_id, response_id: item.response_id, delta: frame.toString('base64') });
        break;
      }
    } catch {
      if (!closed && epoch === generation) fail('DUPLEX_PLAYBACK_OUTPUT_FAILED');
    } finally {
      pumping = false;
      schedule();
    }
  }
  async function handle(event) {
    if (closed) return false;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw fail('DUPLEX_PLAYBACK_EVENT_INVALID');
    if (event.type === ASR_STARTED) {
      if (!validId(event.item_id)) throw fail('DUPLEX_PLAYBACK_ID_INVALID');
      if (questions.has(event.item_id)) return false;
      remember(questions, event.item_id);
      clear(); question = event.item_id; awaitingAsr = false;
      return emit(event);
    }
    if (!event.type.startsWith(AUDIO)) return emit(event);
    const key = identify(event);
    if (awaitingAsr || (question && event.question_id !== question)) return false;
    if (!['started', 'delta', 'done'].includes(event.type.slice(AUDIO.length))) throw fail('DUPLEX_PLAYBACK_EVENT_INVALID');
    if (queue.length >= MAX_EVENTS) throw fail('DUPLEX_PLAYBACK_LIMIT');
    if (event.type === `${AUDIO}started`) {
      if (responses.has(key)) return false;
      if (inputSegment) throw fail('DUPLEX_PLAYBACK_ID_INVALID');
      remember(responses, key); remember(questions, event.question_id);
      question = event.question_id; inputSegment = key;
      queue.push({ event: marker(event) });
    } else {
      if (inputSegment !== key) throw fail('DUPLEX_PLAYBACK_ID_INVALID');
      if (event.type === `${AUDIO}delta`) {
        const value = event.delta;
        if (typeof value !== 'string' || !value.length || value.length > MAX_WIRE_BYTES || value.length % 4
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
          || Buffer.byteLength(JSON.stringify(event)) > MAX_WIRE_BYTES) throw fail('DUPLEX_PLAYBACK_AUDIO_INVALID');
        const pcm = Buffer.from(value, 'base64');
        if (!pcm.length || pcm.length % 2 || pcm.toString('base64') !== value) throw fail('DUPLEX_PLAYBACK_AUDIO_INVALID');
        if (pendingBytes + pcm.length > MAX_PENDING_BYTES) throw fail('DUPLEX_PLAYBACK_LIMIT');
        pendingBytes += pcm.length;
        queue.push({ pcm, offset: 0, question_id: event.question_id, response_id: event.response_id });
      } else {
        inputSegment = null;
        queue.push({ event: marker(event) });
      }
    }
    schedule();
    return true;
  }
  return Object.freeze({
    handle,
    cancel() { if (!closed) { clear(); awaitingAsr = true; } },
    close() { if (!closed) { closed = true; clear(); } },
    status() { return Object.freeze({ closed, pendingBytes, pendingSeconds: pendingBytes / 48000,
      queuedEvents: queue.length, timerActive: timer !== null, questionCount: questions.size, responseCount: responses.size }); },
  });
}
