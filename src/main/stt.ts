import type { Speaker } from '@shared/ipc'
import { keys, languages } from './config'

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
  private sampleRate = 0
  private closing = false
  /** Audio captured before the socket finished opening. */
  private backlog: ArrayBuffer[] = []

  constructor(private readonly events: SttEvents) {}

  start(sampleRate: number): void {
    this.closing = false
    this.sampleRate = sampleRate
    const language = languages.stt
    const params = new URLSearchParams({
      model: 'nova-3',
      language,
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

    console.log(`[stt] listening in "${language}"`)
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
      this.clearKeepAlive()
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
      // A restart swaps in a new socket before this old one finishes closing;
      // it must not tear down the replacement's keep-alive or reconnect over it.
      if (this.ws !== ws) return
      this.clearKeepAlive()
      if (!this.closing) {
        // Network blips mid-call are expected; come back quietly.
        setTimeout(() => this.start(sampleRate), 1000)
      }
    })
  }

  /** Reopen with the current `languages.stt`. No-op until audio has started. */
  restart(): void {
    if (!this.sampleRate || this.closing) return
    const rate = this.sampleRate
    this.stop()
    this.start(rate)
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
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      // A restart can land mid-handshake; do not leave that socket dangling.
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
