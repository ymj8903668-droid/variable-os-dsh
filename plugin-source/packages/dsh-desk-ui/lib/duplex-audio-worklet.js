// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
/** Continuous mono PCM resampling. Fractional input windows survive render quanta. */
export function createPcm16Resampler({ inputRate, onFrame }) {
  if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000) throw new RangeError('Invalid input sample rate');
  const width = inputRate / 16000;
  let remaining = width;
  let sum = 0;
  let buffer = new ArrayBuffer(640);
  let view = new DataView(buffer);
  let offset = 0;
  return {
    push(samples) {
      for (let i = 0; i < samples.length; i++) {
        const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
        let available = 1;
        while (available > 1e-9) {
          const weight = Math.min(available, remaining);
          sum += sample * weight;
          available -= weight;
          remaining -= weight;
          if (remaining < 1e-9) {
            const average = Math.max(-1, Math.min(1, sum / width));
            view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(average * 32768))), true);
            offset += 2;
            sum = 0;
            remaining = width;
            if (offset === 640) {
              onFrame(buffer);
              buffer = new ArrayBuffer(640);
              view = new DataView(buffer);
              offset = 0;
            }
          }
        }
      }
    },
  };
}

if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
  class DuplexCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.resampler = createPcm16Resampler({ inputRate: sampleRate, onFrame: (pcm) => this.port.postMessage({ pcm, capturedAt: currentTime }, [pcm]) });
    }
    process(inputs, outputs) {
      // A connected, silent output keeps capture rendering without mic loopback.
      for (const output of outputs) for (const channel of output) channel.fill(0);
      const channel = inputs[0]?.[0];
      if (channel) this.resampler.push(channel);
      return true;
    }
  }
  registerProcessor('xiaomei-duplex-capture', DuplexCaptureProcessor);
}
