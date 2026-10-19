// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
const DEFAULT_MAX_TRANSCRIPT = 500;
const DEFAULT_VAD_MIN_RMS = 0.035;
const DEFAULT_VAD_SPEECH_FRAMES = 2;
const DEFAULT_VAD_RELEASE_FRAMES = 6;
const DEFAULT_VAD_COOLDOWN_MS = 400;
const MAX_LATENCY_SAMPLES = 100;
const recognitionStopTimers = new WeakMap();
const recognitionObservers = new WeakMap();
let recognitionAttempt = 0;

function observeRecognition(recognition, stage, event) {
  recognitionObservers.get(recognition)?.(stage, event);
}

function clearRecognitionStopTimer(recognition) {
  const timer = recognitionStopTimers.get(recognition);
  if (timer !== undefined) clearTimeout(timer);
  recognitionStopTimers.delete(recognition);
}

// Browsers may deliver final/result/error/end after abort. Only the owner of
// the current utterance may mutate shared transcript or submit a question.
export function guardResearchHostRecognition(recognition, owner, { mode = "ptt", onObservation, now = () => performance.now() } = {}) {
  if (typeof onObservation === "function") {
    const startedAt = now();
    const snapshot = { id: ++recognitionAttempt, mode: mode === "wake" ? "wake" : "ptt", stage: "starting",
      elapsedMs: 0, audioStartMs: null, speechStartMs: null, firstResultMs: null, finalResultMs: null, audioEnded: false, error: null };
    recognitionObservers.set(recognition, (stage, event) => {
      const elapsedMs = Math.max(snapshot.elapsedMs, Math.round(now() - startedAt));
      if (stage === "result") {
        const results = Array.from(event?.results || []).slice(Math.max(0, event?.resultIndex || 0));
        const nonempty = results.filter(result => String(result?.[0]?.transcript || "").trim());
        if (!nonempty.length) return;
        const first = snapshot.firstResultMs === null;
        const final = snapshot.finalResultMs === null && nonempty.some(result => result.isFinal);
        if (!first && !final) return;
        if (first) snapshot.firstResultMs = elapsedMs;
        if (final) snapshot.finalResultMs = elapsedMs;
        stage = final ? "final-result" : "first-result";
      }
      if (stage === "audio-start" && snapshot.audioStartMs === null) snapshot.audioStartMs = elapsedMs;
      if (stage === "speech-start" && snapshot.speechStartMs === null) snapshot.speechStartMs = elapsedMs;
      if (stage === "audio-end") snapshot.audioEnded = true;
      if (stage === "error") {
        const code = event?.error;
        snapshot.error = ["aborted", "no-speech", "audio-capture", "network", "not-allowed", "service-not-allowed", "language-not-supported"].includes(code) ? code : "unknown";
      }
      Object.assign(snapshot, { stage, elapsedMs });
      if (["ended", "error", "cancelled", "start-failed", "stop-failed", "stop-timeout"].includes(stage)) recognitionObservers.delete(recognition);
      // Project-owned diagnostics retain timings/codes only, never the event or transcript.
      onObservation(Object.freeze({ ...snapshot }));
    });
    observeRecognition(recognition, "starting");
  }
  const stages = { onstart: "started", onaudiostart: "audio-start", onaudioend: "audio-end", onspeechstart: "speech-start", onspeechend: "speech-end", onresult: "result", onerror: "error", onend: "ended" };
  for (const [name, stage] of Object.entries(stages)) {
    const handler = recognition[name];
    recognition[name] = function (...args) {
      if (owner.current !== recognition) return;
      if (name === "onend") clearRecognitionStopTimer(recognition);
      observeRecognition(recognition, stage, args[0]);
      return handler?.apply(this, args);
    };
  }
}

export function abortResearchHostRecognition(owner, reason = "cancelled") {
  const recognition = owner.current;
  owner.current = null; // Revoke before abort, including synchronous callbacks.
  if (recognition) observeRecognition(recognition, reason);
  if (recognition) clearRecognitionStopTimer(recognition);
  try { recognition?.abort?.(); } catch { /* already stopped; still retired */ }
}

// stop keeps final results; abort discards them (Web Speech API 4.1.2).
// This is a missing-end recovery deadline, not a speech/VAD silence threshold.
export function stopResearchHostRecognition(owner, onTimeout) {
  const recognition = owner.current;
  if (!recognition || recognitionStopTimers.has(recognition)) return;
  const expire = (reason = "stop-timeout") => {
    clearRecognitionStopTimer(recognition);
    if (owner.current !== recognition) return;
    abortResearchHostRecognition(owner, reason);
    onTimeout();
  };
  recognitionStopTimers.set(recognition, setTimeout(expire, 2_000));
  observeRecognition(recognition, "stopping");
  try { recognition.stop(); } catch { expire("stop-failed"); }
}

function cleanSpeechText(value, maxLength = DEFAULT_MAX_TRANSCRIPT) {
  return String(value || "")
    .replace(/[\p{Cf}\u0000]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeWakeEchoText(value) {
  return cleanSpeechText(value, DEFAULT_MAX_TRANSCRIPT)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

export function isResearchHostWakeEcho({
  transcript = "",
  awaiting = false,
  assistantSpeech = "",
  assistantSpeechAt,
  now = Date.now(),
  echoWindowMs = 3_000,
} = {}) {
  if (!awaiting) return false;
  const spoken = normalizeWakeEchoText(transcript);
  const expected = normalizeWakeEchoText(assistantSpeech);
  if (!spoken || !expected || spoken !== expected) return false;
  const spokenAt = Number(assistantSpeechAt);
  const observedAt = Number(now);
  const windowMs = Number(echoWindowMs);
  return Number.isFinite(spokenAt)
    && Number.isFinite(observedAt)
    && Number.isFinite(windowMs)
    && windowMs >= 0
    && observedAt >= spokenAt
    && observedAt - spokenAt <= windowMs;
}

// Conservative text echo guard, not speaker identification. A user repeating
// playback verbatim must use PTT; unrelated explicit wake commands stay usable.
// Recent entries are existing TTS text in page memory, never recorded audio.
export function isResearchHostPlaybackEcho({
  transcript = "", activeText = "", recent = [], now = Date.now(),
} = {}) {
  const spoken = normalizeWakeEchoText(transcript);
  if (!spoken) return false;
  const candidates = [activeText, ...recent.slice(-3)
    .filter(({ endedAt }) => Number.isFinite(endedAt) && Number.isFinite(now)
      && now >= endedAt && now - endedAt <= 3_000)
    .map(({ text }) => text)];
  return candidates.some((text) => normalizeWakeEchoText(text).includes(spoken));
}

export function accumulateResearchHostTranscript({
  finalText = "",
  event,
  maxLength = DEFAULT_MAX_TRANSCRIPT,
} = {}) {
  const results = event?.results || [];
  const start = Number.isSafeInteger(event?.resultIndex)
    ? Math.max(0, event.resultIndex)
    : 0;
  let nextFinal = cleanSpeechText(finalText, maxLength);
  let interimText = "";
  let hasSpeech = false;
  for (let index = start; index < results.length; index += 1) {
    const result = results[index];
    const text = cleanSpeechText(result?.[0]?.transcript, maxLength);
    if (!text) continue;
    hasSpeech = true;
    if (result?.isFinal) nextFinal = cleanSpeechText(`${nextFinal}${text}`, maxLength);
    else interimText = cleanSpeechText(`${interimText}${text}`, maxLength);
  }
  const displayText = cleanSpeechText(`${nextFinal}${interimText}`, maxLength);
  return Object.freeze({
    finalText: nextFinal,
    interimText,
    displayText,
    hasSpeech,
  });
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function createResearchHostVadGate({
  minRms = DEFAULT_VAD_MIN_RMS,
  speechFrames = DEFAULT_VAD_SPEECH_FRAMES,
  releaseFrames = DEFAULT_VAD_RELEASE_FRAMES,
  cooldownMs = DEFAULT_VAD_COOLDOWN_MS,
  onSpeechStart = null,
} = {}) {
  const threshold = positiveNumber(minRms, DEFAULT_VAD_MIN_RMS);
  const onsetFrames = positiveInteger(speechFrames, DEFAULT_VAD_SPEECH_FRAMES);
  const quietFrames = positiveInteger(releaseFrames, DEFAULT_VAD_RELEASE_FRAMES);
  const cooldown = Math.max(0, Number.isFinite(Number(cooldownMs)) ? Number(cooldownMs) : DEFAULT_VAD_COOLDOWN_MS);
  let above = 0;
  let below = quietFrames;
  let speaking = false;
  let lastOnsetAt = Number.NEGATIVE_INFINITY;

  return Object.freeze({
    push(rawRms, rawAt = Date.now()) {
      const rms = Number.isFinite(Number(rawRms)) ? Math.max(0, Number(rawRms)) : 0;
      const at = Number.isFinite(Number(rawAt)) ? Number(rawAt) : Date.now();
      if (rms >= threshold) {
        above += 1;
        below = 0;
      } else if (rms <= threshold * 0.6) {
        below += 1;
        above = 0;
        if (below >= quietFrames) speaking = false;
      } else {
        above = 0;
        below = 0;
      }
      if (
        speaking
        || above < onsetFrames
        || at - lastOnsetAt < cooldown
      ) return false;
      speaking = true;
      above = 0;
      lastOnsetAt = at;
      onSpeechStart?.(Object.freeze({ at, rms }));
      return true;
    },
    reset() {
      above = 0;
      below = quietFrames;
      speaking = false;
    },
    status() {
      return Object.freeze({ speaking, threshold, lastOnsetAt });
    },
  });
}

function frameRms(analyser, samples) {
  if (typeof analyser?.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(samples);
    let squareTotal = 0;
    for (const sample of samples) squareTotal += sample * sample;
    return Math.sqrt(squareTotal / Math.max(1, samples.length));
  }
  const bytes = new Uint8Array(samples.length);
  analyser?.getByteTimeDomainData?.(bytes);
  let squareTotal = 0;
  for (const sample of bytes) {
    const normalized = (sample - 128) / 128;
    squareTotal += normalized * normalized;
  }
  return Math.sqrt(squareTotal / Math.max(1, bytes.length));
}

export async function createResearchHostVadMonitor({
  mediaDevices = globalThis?.navigator?.mediaDevices,
  AudioContextCtor = globalThis?.AudioContext || globalThis?.webkitAudioContext,
  requestFrame = globalThis?.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis?.cancelAnimationFrame?.bind(globalThis),
  now = () => globalThis?.performance?.now?.() ?? Date.now(),
  onSpeechStart,
} = {}) {
  if (!mediaDevices?.getUserMedia || typeof AudioContextCtor !== "function" || typeof requestFrame !== "function") {
    return Object.freeze({ status: "unsupported", stop() {} });
  }
  const stream = await mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let context;
  let source;
  let analyser;
  try {
    context = new AudioContextCtor();
    await context.resume?.();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
  } catch (error) {
    for (const track of stream?.getTracks?.() || []) {
      try { track?.stop?.(); } catch { /* best-effort microphone release */ }
    }
    try { await context?.close?.(); } catch { /* best-effort audio context release */ }
    throw error;
  }
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const gate = createResearchHostVadGate({ onSpeechStart });
  let frameId = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    gate.push(frameRms(analyser, samples), now());
    frameId = requestFrame(tick);
  };
  frameId = requestFrame(tick);

  return Object.freeze({
    status: "running",
    stop() {
      if (stopped) return;
      stopped = true;
      if (frameId !== null) cancelFrame?.(frameId);
      try { source.disconnect?.(); } catch { /* already disconnected */ }
      try { analyser.disconnect?.(); } catch { /* already disconnected */ }
      for (const track of stream?.getTracks?.() || []) {
        try { track?.stop?.(); } catch { /* best-effort microphone release */ }
      }
      void context.close?.();
    },
  });
}

function latencySamples(value) {
  return (Array.isArray(value) ? value : [])
    .map(Number)
    .filter((sample) => Number.isFinite(sample) && sample >= 0)
    .slice(-MAX_LATENCY_SAMPLES)
    .sort((left, right) => left - right);
}

function percentile(samples, ratio) {
  if (!samples.length) return null;
  const index = Math.max(0, Math.ceil(samples.length * ratio) - 1);
  return Math.round(samples[index]);
}

export function summarizeResearchHostLatency({
  firstVoiceMs = [],
  localInterruptionMs = [],
  cancellationConvergenceMs = [],
} = {}) {
  const voice = latencySamples(firstVoiceMs);
  const localInterruption = latencySamples(localInterruptionMs);
  const cancellationConvergence = latencySamples(cancellationConvergenceMs);
  const firstVoice = {
    count: voice.length,
    p50Ms: percentile(voice, 0.5),
    p95Ms: percentile(voice, 0.95),
    target: "700-1500ms",
  };
  const localStop = {
    count: localInterruption.length,
    p50Ms: percentile(localInterruption, 0.5),
    p95Ms: percentile(localInterruption, 0.95),
    target: "<150ms",
  };
  const convergence = {
    count: cancellationConvergence.length,
    p50Ms: percentile(cancellationConvergence, 0.5),
    p95Ms: percentile(cancellationConvergence, 0.95),
    target: "仅记录，无速度门槛",
  };
  return Object.freeze({
    firstVoice: Object.freeze({
      ...firstVoice,
      targetMet: voice.length > 0
        && firstVoice.p50Ms >= 700
        && firstVoice.p50Ms <= 1_500
        && firstVoice.p95Ms >= 700
        && firstVoice.p95Ms <= 1_500,
    }),
    localInterruption: Object.freeze({
      ...localStop,
      targetMet: localInterruption.length > 0
        && localStop.p50Ms < 150
        && localStop.p95Ms < 150,
    }),
    cancellationConvergence: Object.freeze({
      ...convergence,
      targetMet: null,
    }),
  });
}
