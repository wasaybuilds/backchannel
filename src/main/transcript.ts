import type { Speaker, TranscriptTurn } from '@shared/ipc'

/** Words that start a question even when the speaker never lands the '?'. */
const INTERROGATIVE =
  /^(what|how|why|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|have|has|should|tell me|walk me|explain|describe|talk me)\b/i

/**
 * Rolling record of the call. Holds every finalised turn plus the one
 * in-flight turn per speaker, and hands the model only what it hasn't seen.
 */
export class Transcript {
  private turns: TranscriptTurn[] = []
  private pending = new Map<Speaker, TranscriptTurn>()
  /** Index into `turns` of the first turn the model has not been shown. */
  private sent = 0

  /** Returns the turn to render, or null if the text was empty. */
  ingest(speaker: Speaker, text: string, final: boolean): TranscriptTurn | null {
    const clean = text.trim()
    if (!clean) return null

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
    return turn
  }

  /** True when `text` looks like something the other side expects an answer to. */
  static isQuestion(text: string): boolean {
    const t = text.trim()
    if (t.length < 8) return false
    return t.endsWith('?') || INTERROGATIVE.test(t)
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
    const fresh = this.turns.slice(this.sent)
    this.sent = this.turns.length
    if (!fresh.length) return '(no new speech)'
    return fresh.map((t) => `${t.speaker === 'me' ? 'ME' : 'THEM'}: ${t.text}`).join('\n')
  }

  /** Recent history for a cold start, without moving the cursor. */
  tail(n = 12): string {
    return this.turns.slice(-n)
      .map((t) => `${t.speaker === 'me' ? 'ME' : 'THEM'}: ${t.text}`).join('\n')
  }

  reset(): void {
    this.turns = []
    this.pending.clear()
    this.sent = 0
  }
}
