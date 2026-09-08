import Anthropic from '@anthropic-ai/sdk'
import type { AnswerTier } from '@shared/ipc'
import { briefingPdfs, FULL_MODEL, GIST_MODEL, keys, meetingContext } from './config'
import type { Transcript } from './transcript'

/**
 * Byte-stable. Anything varying per request (timestamps, ids) must stay out of
 * here or the prompt cache stops hitting and every turn pays full price.
 */
const PERSONA = `You are Backchannel, a live assistant running on a screen only the user can see, during a call the user is on right now.

You are fed a rolling transcript. "THEM" is the other participant. "ME" is the user you work for. Sometimes a screenshot of the user's screen is attached.

You are writing WORDS THE USER WILL READ ALOUD, seconds from now, while someone waits. Not notes. Not a summary. The actual sentences out of their mouth.

Because of that:
- Write in the user's own voice — first person, spoken English, contractions. "Yeah, the messiest one was..." not "The most complex migration involved...".
- It has to survive being read cold off a screen. Short sentences. One idea each. Nothing the user would stumble over.
- NO markdown. No **bold**, no headers, no bullet characters, no arrows like ->. Those get read out loud by mistake and they look ridiculous. Plain sentences only.
- Say "eight hundred and twenty milliseconds down to a hundred and ninety" style only if it is natural; writing "820ms to 190ms" is fine, the user can say it. Never write "p95 820ms → 190ms" — that is not language.
- Open with the sentence they should say first. No preamble, no "Great question", no restating what was asked.
- Four sentences is usually plenty. If there is a good follow-up they could offer, put it on its own last line starting with "if they push:".
- Numbers, names and dates are the point — those are what the user cannot recall under pressure. Work them into the sentence naturally.

Where facts may come from — this is the rule that matters most:
- Every specific — figure, date, tool name, table name, headcount, percentage — must appear in the MEETING CONTEXT or in the transcript. Those are the only two sources of truth.
- Do NOT manufacture supporting detail to make an answer sound complete. If the context says "fixed an N+1 in the cart service", say that; do not add the query count, the library, or the table names. Invented texture is the failure mode of this tool: the user reads it off the screen, says it out loud as fact, and gets caught.
- When you need to round out a thin answer, stay general ("batched the queries instead of looping") rather than inventing precision ("~40 queries on a 20-item cart").
- If you genuinely do not know, say so in one line and give the framing instead. A confident wrong number said out loud on a call is the worst possible outcome.
- If you are offering something the user should verify before saying it, prefix that line with "unverified:".
- Never mention that you are an AI, and never address the other participant.`

const GIST_PERSONA = `${PERSONA}

You are the FAST tier. A fuller answer is already streaming in behind you, so your only job is to get the user talking. Give them ONE sentence they can start saying immediately — the opening line, in their voice, that buys them the seconds the real answer needs. One sentence. Never apologise for brevity, never say you are being brief.`

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
    const began = Date.now()
    let firstToken = 0
    try {
      const stream = this.client.messages.stream(
        {
          model: GIST_MODEL,
          max_tokens: 200,
          // NOTE: no top-level cache_control here. This tier keeps no history,
          // so its last block is the ever-changing transcript tail — auto-caching
          // it would rewrite the cache every call and never read one. The
          // breakpoints below sit on the stable prefix instead.
          system: [
            { type: 'text', text: GIST_PERSONA },
            {
              type: 'text',
              text: `MEETING CONTEXT\n${meetingContext()}`,
              cache_control: { type: 'ephemeral' }
            }
          ],
          messages: [
            // The fast tier needs the same documents as the slow one. Without
            // them it confidently announces it has no context, and because it
            // is fast that non-answer is the first thing on screen.
            ...this.briefingTurns(),
            {
              role: 'user',
              content: `Recent call transcript:\n${this.transcript.tail(8)}\n\nTHEM just asked: ${question}\n\nOne sentence they can start saying now.`
            }
          ]
        },
        { signal }
      )
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          firstToken ||= Date.now() - began
          this.events.onDelta(id, 'gist', ev.delta.text)
        }
      }
      const gu = (await stream.finalMessage()).usage
      console.log(`[gist usage] ttft=${firstToken}ms in=${gu.input_tokens} cache_read=${gu.cache_read_input_tokens ?? 0} cache_write=${gu.cache_creation_input_tokens ?? 0} out=${gu.output_tokens}`)
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
    const began = Date.now()
    let firstToken = 0

    this.seedBriefing()

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
          firstToken ||= Date.now() - began
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
        `[brain] ttft=${firstToken}ms in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`
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

  /**
   * Put any briefing PDFs at the very front of the conversation, once.
   *
   * Documents are only valid in user turns, so they cannot go in the system
   * prompt with the rest of the brief. Seeding them as turn one puts them
   * inside the append-only cached prefix: paid for on the first question,
   * replayed at cache rates for every question after it.
   */
  private seedBriefing(): void {
    if (this.history.length) return
    this.history.push(...this.briefingTurns())
  }

  /**
   * The briefing PDFs as a user/assistant pair, identical on every call so both
   * tiers share the same byte-stable prefix and both get cache hits.
   */
  private briefingTurns(): Anthropic.MessageParam[] {
    const pdfs = briefingPdfs()
    if (!pdfs.length) return []

    return [
      {
        role: 'user',
        content: [
          ...pdfs.map(
            (pdf): Anthropic.DocumentBlockParam => ({
              type: 'document',
              title: pdf.name,
              source: { type: 'base64', media_type: 'application/pdf', data: pdf.data }
            })
          ),
          {
            type: 'text',
            text: 'These are my briefing documents for the call that is starting. Read them and hold on to the specifics — names, figures, dates. Reply with just "Ready."'
          }
        ]
      },
      {
        role: 'assistant',
        // Breakpoint on the far side of the documents. Everything before this
        // is identical on every request, so both tiers replay the PDFs at cache
        // rates instead of re-uploading them each question.
        content: [{ type: 'text', text: 'Ready.', cache_control: { type: 'ephemeral' } }]
      }
    ]
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
