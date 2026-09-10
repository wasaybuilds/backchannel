import type { Speaker } from '@shared/ipc'
import { keys, STT_LANGUAGE } from './config'

/** ch0 carries your mic, ch1 carries the meeting. See renderer/audio.ts. */
const CHANNEL_TO_SPEAKER: Speaker[] = ['me', 'them']

interface DeepgramResult {
  type: string
  channel_index?: [number, number]
  is_final?: boolean
  speech_final?: boolean
  channel?: { alternatives: { transcript: string }[] }
}

export interface SttEvents {
  onTranscript(speaker: Speaker, text: string, final: boolean): void
  onError(message: string): void
  onOpen(): void
}

/**
 * Streaming speech-to-text over Deepgram's realtime socket.
 *
 * Audio arrives as one interleaved stereo stream rather than two connections:
 * one socket, one bill, and Deepgram's `multichannel` mode tells us which
 * side spoke via `channel_index`.
 */
export class Stt {
  private ws: WebSocket | null = null
  private keepAlive: NodeJS.Timeout | null = null
  private closing = false
  /** Audio captured before the socket finished opening. */
  private backlog: ArrayBuffer[] = []

  constructor(private readonly events: SttEvents) {}

  start(sampleRate: number): void {
    this.closing = false
    const params = new URLSearchParams({
      model: 'nova-3',
      language: STT_LANGUAGE,
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '2',
      multichannel: 'true',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      // Finalise a turn after 300ms of silence; short enough to feel live.
      endpointing: '300'
    })

    console.log(`[stt] listening in "${STT_LANGUAGE}"`)
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, [
      'token',
      keys.deepgram
    ])
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      for (const chunk of this.backlog) ws.send(chunk)
      this.backlog = []
      // Deepgram drops idle sockets after ~10s of no audio.
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
      }, 8000)
      this.events.onOpen()
    })

    ws.addEventListener('message', (ev) => {
      let msg: DeepgramResult
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.type !== 'Results') return

      const text = msg.channel?.alternatives?.[0]?.transcript ?? ''
      if (!text.trim()) return

      const speaker = CHANNEL_TO_SPEAKER[msg.channel_index?.[0] ?? 1] ?? 'them'
      this.events.onTranscript(speaker, text, Boolean(msg.is_final))
    })

    ws.addEventListener('error', () => {
      this.events.onError('Deepgram connection failed — check DEEPGRAM_API_KEY.')
    })

    ws.addEventListener('close', () => {
      this.clearKeepAlive()
      if (!this.closing) {
        // Network blips mid-call are expected; come back quietly.
        setTimeout(() => this.start(sampleRate), 1000)
      }
    })
  }

  send(chunk: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    } else if (this.backlog.length < 200) {
      this.backlog.push(chunk)
    }
  }

  stop(): void {
    this.closing = true
    this.clearKeepAlive()
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      this.ws.close()
    }
    this.ws = null
    this.backlog = []
  }

  private clearKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }
}
