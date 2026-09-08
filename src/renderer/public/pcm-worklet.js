/**
 * Converts the merged stereo graph into the exact bytes Deepgram wants:
 * interleaved 16-bit little-endian PCM. Runs on the audio thread, so the
 * UI never janks the capture.
 *
 * Channel 0 = microphone (you). Channel 1 = system loopback (them).
 */
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    // 128-frame render quanta are too chatty for IPC; batch to ~85ms.
    this.buffer = new Int16Array(4096 * 2)
    this.offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const mic = input[0]
    const sys = input[1] || input[0]
    const frames = mic.length

    for (let i = 0; i < frames; i++) {
      if (this.offset >= this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0, this.offset).buffer)
        this.offset = 0
      }
      this.buffer[this.offset++] = clamp(mic[i])
      this.buffer[this.offset++] = clamp(sys[i])
    }
    return true
  }
}

function clamp(sample) {
  const s = Math.max(-1, Math.min(1, sample))
  return s < 0 ? s * 0x8000 : s * 0x7fff
}

registerProcessor('pcm-worklet', PcmWorklet)
