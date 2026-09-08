import type { Speaker, TranscriptTurn } from '@shared/ipc'

/** Words that start a question even when the speaker never lands the '?'. */
const INTERROGATIVE =
  /^(what|how|why|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|have|has|should|tell me|walk me|explain|describe|talk me)\b/i

/** How far back to look for the original when deciding something is echo. */
const ECHO_WINDOW_MS = 8000
/** Share of the mic's words that must also appear in their turn. */
const ECHO_SIMILARITY = 0.7
/** Below this many words, an overlap score means nothing. */
const ECHO_MIN_WORDS = 4

/**
 * Discourse markers people open questions with. Speech almost never starts
 * clean — "So walk me through your last project" is a question, but only after
 * the "So" is stripped.
 */
const FILLER = /^(?:(?:so|and|but|ok|okay|now|well|um|uh|er|right|yeah|yes|alright|anyway|like|i mean|you know|just|actually|sorry)\b[,.\s]*)+/i

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean))
}

/** Fraction of `a` that also appears in `b`. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hits = 0
  for (const w of a) if (b.has(w)) hits++
  return hits / a.size
}

/**
 * Rolling record of the call. Holds every finalised turn plus the one
 * in-flight turn per speaker, and hands the model only what it hasn't seen.
 */
export class Transcript {
  private turns: TranscriptTurn[] = []
  private pending = new Map<Speaker, TranscriptTurn>()
  /** Index into `turns` of the first turn the model has not been shown. */
  private sent = 0

  /** Returns the turn to render, or null if the text was empty or was echo. */
  ingest(speaker: Speaker, text: string, final: boolean): TranscriptTurn | null {
    const clean = text.trim()
    if (!clean) return null
    if (speaker === 'me' && this.isEchoOfThem(clean)) return null

    if (!final) {
      const turn: TranscriptTurn = {
        id: `p-${speaker}`, speaker, text: clean, final: false, at: Date.now()
      }
      this.pending.set(speaker, turn)
      return turn
    }

    this.pending.delete(speaker)
    const turn: TranscriptTurn = {
      id: `${Date.now()}-${this.turns.length}`, speaker, text: clean, final: true, at: Date.now()
    }
    this.turns.push(turn)
    if (speaker === 'them') this.retractEchoOf(turn)
    return turn
  }

  /**
   * Echo does not reliably arrive after the thing it echoes — the two channels
   * are endpointed independently, so the mic's copy often finalises first. The
   * forward check in `isEchoOfThem` cannot catch that case, so when one of their
   * turns lands we also sweep backwards and retract any mic turn that was really
   * this same audio.
   */
  private retractEchoOf(theirs: TranscriptTurn): void {
    const cutoff = theirs.at - ECHO_WINDOW_MS
    const words = tokens(theirs.text)

    for (let i = this.turns.length - 2; i >= 0; i--) {
      const prior = this.turns[i]
      if (prior.at < cutoff) break
      if (prior.speaker !== 'me' || prior.echo) continue
      const mine = tokens(prior.text)
      if (mine.size < ECHO_MIN_WORDS) continue
      if (overlap(mine, words) >= ECHO_SIMILARITY) prior.echo = true
    }
  }

  /** Everything actually said, with echo of the far side filtered out. */
  private real(): TranscriptTurn[] {
    return this.turns.filter((t) => !t.echo)
  }

  /**
   * True when words on the mic channel are really the other person's voice
   * coming back out of your speakers.
   *
   * Acoustic echo cancellation cannot help here: Chromium can only cancel audio
   * Chromium is playing, and the call is being played by Zoom. So we catch the
   * echo after transcription instead, where both channels are visible — if the
   * mic just repeated something THEY said in the last few seconds, it is echo.
   * Headphones make this moot; this is the safety net when you forget them.
   */
  private isEchoOfThem(text: string): boolean {
    const mine = tokens(text)
    // Too short to judge. "Okay" or "right" would match almost anything they
    // said, and dropping a genuine acknowledgement is worse than keeping echo.
    if (mine.size < ECHO_MIN_WORDS) return false

    const cutoff = Date.now() - ECHO_WINDOW_MS

    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]
      if (turn.at < cutoff) break
      if (turn.speaker !== 'them') continue
      if (overlap(mine, tokens(turn.text)) >= ECHO_SIMILARITY) return true
    }
    // The other side's in-flight turn counts too — echo often lands first.
    const live = this.pending.get('them')
    return live ? overlap(mine, tokens(live.text)) >= ECHO_SIMILARITY : false
  }

  /** True when `text` looks like something the other side expects an answer to. */
  static isQuestion(text: string): boolean {
    const t = text.trim()
    if (t.length < 8) return false
    if (t.endsWith('?')) return true
    // Strip the run-up before testing: transcribed speech rarely opens on the
    // interrogative, and Deepgram punctuates plenty of real questions with '.'.
    return INTERROGATIVE.test(t.replace(FILLER, ''))
  }

  /** The most recent thing the other person said, question or not. */
  lastFromThem(): string {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].speaker === 'them') return this.turns[i].text
    }
    return ''
  }

  /**
   * Everything said since the last call to this method, formatted for the model.
   * Advances the read cursor — the prompt prefix stays byte-stable, which is
   * what keeps the Anthropic cache hitting.
   */
  drain(): string {
    const fresh = this.turns.slice(this.sent).filter((t) => !t.echo)
    this.sent = this.turns.length
    if (!fresh.length) return '(no new speech)'
    return fresh.map((t) => `${t.speaker === 'me' ? 'ME' : 'THEM'}: ${t.text}`).join('\n')
  }

  /** Recent history for a cold start, without moving the cursor. */
  tail(n = 12): string {
    return this.real().slice(-n)
      .map((t) => `${t.speaker === 'me' ? 'ME' : 'THEM'}: ${t.text}`).join('\n')
  }

  reset(): void {
    this.turns = []
    this.pending.clear()
    this.sent = 0
  }
}
