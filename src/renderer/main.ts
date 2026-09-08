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

/**
 * Stick to the newest answer only while the reader is already at the bottom.
 *
 * Forcing scrollTop on every streaming token means you can never read back to
 * an earlier answer — the next token yanks you down again, mid-sentence.
 */
const NEAR_BOTTOM_PX = 48

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

function keepPinned(el: HTMLElement, wasAtBottom: boolean): void {
  if (wasAtBottom) el.scrollTop = el.scrollHeight
}

/** One card per question; the gist and full tiers write into the same card. */
const cards = new Map<string, { gist: HTMLElement; full: HTMLElement; code: HTMLElement }>()

window.bc.onStatus((s: Status) => {
  dotEl.className = s.kind
  statusEl.textContent = s.kind === 'error' ? s.message : s.kind
  statusEl.style.color = s.kind === 'error' ? 'var(--err)' : ''
})

window.bc.onAnswerStart((a: AnswerStart) => {
  const wasAtBottom = atBottom(answersEl)
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
  // A brand new question is worth jumping to even if they had scrolled up.
  keepPinned(answersEl, wasAtBottom || a.tier !== 'full')
})

window.bc.onAnswerDelta((d: AnswerDelta) => {
  const card = cards.get(d.id)
  if (!card || d.done) return
  const wasAtBottom = atBottom(answersEl)
  const target = d.tier === 'gist' ? card.gist : d.tier === 'code' ? card.code : card.full
  target.textContent += d.text
  // Once the considered answer arrives, the fast one has served its purpose.
  if (d.tier === 'full' && card.gist.textContent) card.gist.style.opacity = '0.55'
  keepPinned(answersEl, wasAtBottom)
})

window.bc.onTranscript((t: TranscriptTurn) => {
  const wasAtBottom = atBottom(feedEl)
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
  keepPinned(feedEl, wasAtBottom)
})

/**
 * Tell the main process when the pointer is over the panel.
 *
 * The window ignores mouse events so clicks fall through to the call, but that
 * also means the scroll wheel never reaches us. `forward: true` keeps delivering
 * mousemove, so we can switch interactivity on the moment the pointer arrives
 * and back off when it leaves.
 */
function trackHover(): void {
  let inside = false
  const set = (on: boolean): void => {
    if (on === inside) return
    inside = on
    window.bc.setInteractive(on)
  }
  document.addEventListener('mousemove', () => set(true))
  document.addEventListener('mouseleave', () => set(false))
  window.addEventListener('blur', () => set(false))
}

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

trackHover()
void boot()
