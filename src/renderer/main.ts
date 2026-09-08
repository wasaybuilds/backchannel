import type { BackchannelApi } from '../preload'
import type { AnswerDelta, AnswerStart, Status, TranscriptTurn } from '@shared/ipc'
import { startCapture } from './audio'

declare global {
  interface Window { bc: BackchannelApi }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const answersEl = $('answers')
const feedEl = $('feed')
const statusEl = $('status')
const dotEl = $('dot')

/** One card per question; the gist and full tiers write into the same card. */
const cards = new Map<string, { gist: HTMLElement; full: HTMLElement; code: HTMLElement }>()

window.bc.onStatus((s: Status) => {
  dotEl.className = s.kind
  statusEl.textContent = s.kind === 'error' ? s.message : s.kind
  statusEl.style.color = s.kind === 'error' ? 'var(--err)' : ''
})

window.bc.onAnswerStart((a: AnswerStart) => {
  let card = cards.get(a.id)
  if (!card) {
    const el = document.createElement('div')
    el.className = a.withScreenshot ? 'answer shot' : 'answer'
    el.innerHTML =
      '<div class="q"></div><div class="gist"></div><div class="full"></div><pre class="code"></pre>'
    el.querySelector<HTMLElement>('.q')!.textContent = a.question
    answersEl.append(el)
    card = {
      gist: el.querySelector<HTMLElement>('.gist')!,
      full: el.querySelector<HTMLElement>('.full')!,
      code: el.querySelector<HTMLElement>('.code')!
    }
    cards.set(a.id, card)
    // Keep only the last few cards — this is a glance surface, not a log.
    while (answersEl.children.length > 6) answersEl.firstElementChild?.remove()
  }
  answersEl.scrollTop = answersEl.scrollHeight
})

window.bc.onAnswerDelta((d: AnswerDelta) => {
  const card = cards.get(d.id)
  if (!card || d.done) return
  const target = d.tier === 'gist' ? card.gist : d.tier === 'code' ? card.code : card.full
  target.textContent += d.text
  // Once the considered answer arrives, the fast one has served its purpose.
  if (d.tier === 'full' && card.gist.textContent) card.gist.style.opacity = '0.55'
  answersEl.scrollTop = answersEl.scrollHeight
})

window.bc.onTranscript((t: TranscriptTurn) => {
  const id = `t-${t.id}`
  let row = document.getElementById(id)
  if (!row) {
    row = document.createElement('div')
    row.id = id
    feedEl.append(row)
    while (feedEl.children.length > 30) feedEl.firstElementChild?.remove()
  }
  row.className = `${t.speaker} ${t.final ? '' : 'interim'}`.trim()
  row.textContent = `${t.speaker === 'me' ? 'you' : 'them'}: ${t.text}`
  feedEl.scrollTop = feedEl.scrollHeight
})

async function boot(): Promise<void> {
  try {
    const capture = await startCapture((pcm) => window.bc.audioChunk(pcm))
    window.bc.audioState(true, capture.sampleRate)
    window.addEventListener('beforeunload', () => {
      capture.stop()
      window.bc.audioState(false, 0)
    })
  } catch (err) {
    dotEl.className = 'error'
    statusEl.style.color = 'var(--err)'
    statusEl.textContent = err instanceof Error ? err.message : 'capture failed'
  }
}

void boot()
