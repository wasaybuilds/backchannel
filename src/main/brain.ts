import Anthropic from '@anthropic-ai/sdk'
import type { AnswerTier } from '@shared/ipc'
import { FULL_MODEL, GIST_MODEL, keys, meetingContext } from './config'
import type { Transcript } from './transcript'

/**
 * Byte-stable. Anything varying per request (timestamps, ids) must stay out of
 * here or the prompt cache stops hitting and every turn pays full price.
 */
const PERSONA = `You are Backchannel, a live assistant running on a screen only the user can see, during a call the user is on right now.

You are fed a rolling transcript. "THEM" is the other participant. "ME" is the user you work for. Sometimes a screenshot of the user's screen is attached.

How to answer:
- The user is mid-conversation and reading you at a glance. Lead with the answer. No preamble, no "Great question", no restating what was asked.
- Write what the user should SAY, not a description of what they could say.
- Short lines. Fragments are fine. Prefer 3-5 bullets over a paragraph.
- Numbers, names, dates and specifics beat generalities — those are what the user cannot recall under pressure.
- If the meeting context below answers it, use those exact facts.
- If you do not know, say so in one line and give the best framing instead of inventing detail. A confident wrong number said out loud on a call is the worst outcome.
- Never mention that you are an AI, and never address the other participant.`

const GIST_PERSONA = `${PERSONA}

You are the FAST tier. A slower, better answer is already streaming in behind you. Give the single most useful line — the headline fact or the opening sentence the user should say. One or two lines maximum. Never apologise for brevity.`

export interface BrainEvents {
  onStart(id: string, tier: AnswerTier, question: string, withScreenshot: boolean): void
  onDelta(id: string, tier: AnswerTier, text: string): void
  onDone(id: string, tier: AnswerTier): void
  onError(message: string): void
}

type UserContent = Anthropic.MessageParam['content']

export class Brain {
  private client = new Anthropic({ apiKey: keys.anthropic })
  /** Canonical conversation for the full tier. Append-only, so the cache prefix grows. */
  private history: Anthropic.MessageParam[] = []
  private inFlight: AbortController | null = null
  private seq = 0

  constructor(
    private readonly transcript: Transcript,
    private readonly events: BrainEvents
  ) {}

  /**
   * Answer `question`. Cancels any answer still streaming — on a live call the
   * newest question is always the one that matters.
   */
  async ask(question: string, screenshot?: string): Promise<void> {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller

    const id = `a${++this.seq}`
    const delta = this.transcript.drain()

    // A screenshot means the question is about what's on screen; a blind fast
    // answer would just be noise, so the gist tier sits that one out.
    if (!screenshot) {
      void this.gist(id, question, controller.signal)
    }
    await this.full(id, question, delta, screenshot, controller.signal)
  }

  private async gist(id: string, question: string, signal: AbortSignal): Promise<void> {
    this.events.onStart(id, 'gist', question, false)
    try {
      const stream = this.client.messages.stream(
        {
          model: GIST_MODEL,
          max_tokens: 200,
          system: GIST_PERSONA,
          messages: [
            {
              role: 'user',
              content: `Recent call transcript:\n${this.transcript.tail(8)}\n\nTHEM just asked: ${question}\n\nOne or two lines.`
            }
          ]
        },
        { signal }
      )
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.events.onDelta(id, 'gist', ev.delta.text)
        }
      }
      this.events.onDone(id, 'gist')
    } catch (err) {
      if (!signal.aborted) this.events.onError(describe(err))
    }
  }

  private async full(
    id: string,
    question: string,
    delta: string,
    screenshot: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    this.events.onStart(id, 'full', question, Boolean(screenshot))

    const text = `New speech since your last answer:\n${delta}\n\nAnswer this: ${question}`
    const content: UserContent = screenshot
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } },
          { type: 'text', text: `${text}\n\nThe user's current screen is attached.` }
        ]
      : text

    this.history.push({ role: 'user', content })

    let answer = ''
    try {
      const stream = this.client.messages.stream(
        {
          model: FULL_MODEL,
          max_tokens: 1500,
          // Low effort keeps thinking short. Do not disable thinking on Opus 5 —
          // it starts writing tool calls and stray tags into visible text.
          output_config: { effort: 'low' },
          // Auto-caches the last cacheable block, so the persona, the meeting
          // context and the whole conversation so far replay at ~10% of cost.
          cache_control: { type: 'ephemeral' },
          system: [
            { type: 'text', text: PERSONA },
            { type: 'text', text: `MEETING CONTEXT\n${meetingContext()}` }
          ],
          messages: this.history
        },
        { signal }
      )

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          answer += ev.delta.text
          this.events.onDelta(id, 'full', ev.delta.text)
        }
      }

      const final = await stream.finalMessage()
      if (final.stop_reason === 'refusal') {
        this.events.onError('Claude declined that one.')
      }
      // Log cache effectiveness — if reads stay at 0, something is invalidating
      // the prefix and the call is costing ~10x what it should.
      const u = final.usage
      console.log(
        `[brain] in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`
      )

      this.history.push({ role: 'assistant', content: answer || '(no answer)' })
      this.events.onDone(id, 'full')
    } catch (err) {
      if (signal.aborted) {
        // Cancelled by a newer question — drop the orphan user turn so the
        // history never ends on an unanswered prompt.
        this.history.pop()
        return
      }
      this.history.pop()
      this.events.onError(describe(err))
    }
  }

  reset(): void {
    this.inFlight?.abort()
    this.history = []
  }
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `Claude ${err.status}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
