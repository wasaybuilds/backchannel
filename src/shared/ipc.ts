/** Channel names and payload types shared by main, preload and renderer. */

/** Who was speaking. Derived from the audio channel the words arrived on. */
export type Speaker = 'me' | 'them'

export interface TranscriptTurn {
  id: string
  speaker: Speaker
  text: string
  /** False while Deepgram is still revising these words. */
  final: boolean
  /** Set when this mic turn turned out to be the far side coming back through
   *  the speakers. Kept rather than deleted so the UI can grey it out. */
  echo?: boolean
  at: number
}

/**
 * A single answer as it streams in. `gist` and `full` race on spoken answers;
 * `code` is its own mode — pasteable code from the clipboard, never spoken.
 */
export type AnswerTier = 'gist' | 'full' | 'code'

export interface AnswerDelta {
  id: string
  tier: AnswerTier
  text: string
  done: boolean
}

export interface AnswerStart {
  id: string
  tier: AnswerTier
  /** The question we think we're answering. Shown as a header. */
  question: string
  withScreenshot: boolean
}

export type Status =
  | { kind: 'idle' }
  | { kind: 'listening' }
  | { kind: 'thinking' }
  | { kind: 'error'; message: string }

export const CH = {
  /** renderer -> main: interleaved stereo Int16 PCM (ch0 = me, ch1 = them). */
  audioChunk: 'audio:chunk',
  /** renderer -> main: capture started/stopped, with the real sample rate. */
  audioState: 'audio:state',
  /** main -> renderer */
  transcript: 'transcript:turn',
  answerStart: 'answer:start',
  answerDelta: 'answer:delta',
  status: 'status',
  /** main -> renderer: toggle the panel from a global hotkey. */
  visibility: 'ui:visibility',
  /** renderer -> main: user typed a question into the panel. */
  ask: 'ask',
  /** renderer -> main: pointer entered/left the panel, so the wheel can reach it. */
  interactive: 'ui:interactive'
} as const
