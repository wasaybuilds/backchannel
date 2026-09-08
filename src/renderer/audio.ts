/**
 * Captures both sides of the call and merges them into one stereo stream.
 *
 * Left  channel = your microphone.
 * Right channel = Windows system loopback (everything you hear, i.e. them).
 *
 * Merging beats opening two transcription sockets: one connection, one bill,
 * and Deepgram's multichannel mode gives speaker attribution for free.
 */
export interface Capture {
  sampleRate: number
  stop(): void
}

export async function startCapture(onChunk: (pcm: ArrayBuffer) => void): Promise<Capture> {
  // The main process pins audio to 'loopback'; video is requested only because
  // getDisplayMedia will not hand over a stream without it.
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  display.getVideoTracks().forEach((t) => t.stop())

  if (display.getAudioTracks().length === 0) {
    throw new Error('No loopback audio track. Loopback capture is Windows-only.')
  }

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
  })

  const ctx = new AudioContext()
  await ctx.audioWorklet.addModule('pcm-worklet.js')

  const merger = ctx.createChannelMerger(2)
  ctx.createMediaStreamSource(mic).connect(mono(ctx), 0, 0).connect(merger, 0, 0)
  ctx.createMediaStreamSource(display).connect(mono(ctx), 0, 0).connect(merger, 0, 1)

  const node = new AudioWorkletNode(ctx, 'pcm-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete'
  })
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(e.data)
  merger.connect(node)

  return {
    sampleRate: ctx.sampleRate,
    stop() {
      node.port.onmessage = null
      node.disconnect()
      merger.disconnect()
      mic.getTracks().forEach((t) => t.stop())
      display.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

/** Downmix whatever arrives to a single channel so the merger stays predictable. */
function mono(ctx: AudioContext): GainNode {
  const g = ctx.createGain()
  g.channelCount = 1
  g.channelCountMode = 'explicit'
  g.channelInterpretation = 'speakers'
  return g
}
