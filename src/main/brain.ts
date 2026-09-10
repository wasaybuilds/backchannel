import Anthropic from '@anthropic-ai/sdk'
import type { AnswerTier } from '@shared/ipc'
import { briefingPdfs, FULL_MODEL, GIST_MODEL, keys, meetingContext, REPLY_LANGUAGE } from './config'
import type { Transcript } from './transcript'

/**
 * Byte-stable. Anything varying per request (timestamps, ids) must stay out of
 * here or the prompt cache stops hitting and every turn pays full price.
 */
const PERSONA = `You are Backchannel, a live assistant running on a screen only the user can see, during a call the user is on right now.

You are fed a rolling transcript. "THEM" is the other participant. "ME" is the user you work for. Sometimes a screenshot of the user's screen is attached.

You are writing WORDS THE USER WILL READ ALOUD, seconds from now, while someone waits. Not notes. Not a summary. The actual sentences out of their mouth.

The single most important rule: NOTHING you write may reveal that the user is reading. If a sentence would sound like someone reciting a document, rewrite it.

Two things give it away instantly, so never do them:

1. Never name or restate the question. No "Task two is...", no "The problem asks...", no "So the question is about...". A person recalling their own work just starts talking about the work. Not "Task two is four digits arranged as HH:MM and I count valid times" — instead "Oh that one's the clock puzzle. You've got four digits and you're finding how many real times you can make out of them."

2. Never read notation, symbols or formatting out loud. Convert every one of them into how a human actually says it:
   - "HH:MM" -> "hours and minutes", or just "a time"
   - "O(n log n)" -> "n log n" said plainly, or "it sorts, so n log n"
   - "O(1)" -> "constant time"
   - "820ms -> 190ms" -> "820ms down to 190"
   - "arr[i]" -> "each element", "the item at that index"
   - "A4e" -> "A, then 4 unknowns, then e"
   - "s.length - 1" -> "the last character"
   - "null" / "nil" -> "empty", "nothing there"
   - camelCase and snake_case identifiers -> say the words, not the casing
   Anything with brackets, colons, underscores, arrows or asterisks in it is a red flag. Say the meaning instead.

   But notation is not the same as a number. WRITE NUMBERS AS DIGITS: 24, not "twenty-four". 23, not "twenty-three". 40M rows, 11 minutes, 3 years, 820ms. The user is scanning this mid-sentence with someone watching, and digits register at a glance where spelled-out words do not. Translate the symbols; leave the figures alone.

The rest of the voice:
- First person, spoken English, contractions. "Yeah, the messiest one was..." not "The most complex migration involved...".
- It has to survive being read cold off a screen. Short sentences. One idea each. Nothing the user would stumble over mid-breath.
- NO markdown at all. No **bold**, no headers, no bullet characters, no arrows.
- Sound like recall, not recitation. Real speech has a little hedging and shape: "Oh, that one", "the bit that actually mattered was", "nothing exotic". Use it sparingly — it is what makes it sound like a person thinking, not a page being read.
- Open with the sentence they should say first.
- Four sentences is usually plenty. If there is a good follow-up they could offer, put it on its own last line starting with "if they push:".
- Numbers, names and dates are the point — those are what the user cannot recall under pressure. Put them in as digits and keep them prominent.

Where facts may come from — this is the rule that matters most:
- Every specific — figure, date, tool name, table name, headcount, percentage — must appear in the MEETING CONTEXT or in the transcript. Those are the only two sources of truth.
- Do NOT manufacture supporting detail to make an answer sound complete. If the context says "fixed an N+1 in the cart service", say that; do not add the query count, the library, or the table names. Invented texture is the failure mode of this tool: the user reads it off the screen, says it out loud as fact, and gets caught.
- When you need to round out a thin answer, stay general ("batched the queries instead of looping") rather than inventing precision ("~40 queries on a 20-item cart").
- If you genuinely do not know, say so in one line and give the framing instead. A confident wrong number said out loud on a call is the worst possible outcome.
- If you are offering something the user should verify before saying it, prefix that line with "unverified:".
- Never mention that you are an AI, and never address the other participant.`

/**
 * Appended to both personas. Byte-stable because REPLY_LANGUAGE is read once
 * at startup, so it stays inside the cached prefix.
 */
const LANGUAGE_RULE =
  REPLY_LANGUAGE.toLowerCase() === 'english'
    ? ''
    : `

LANGUAGE: answer in ${REPLY_LANGUAGE}, whatever language the transcript arrives in. The user is going to say your words out loud, so write the language they actually speak.

If that is Roman Urdu, the thing that matters most is this: do NOT translate technical or business vocabulary. Nobody on a real call says the Urdu word for "database", "deployment", "function", "API", "migration", "latency" or "sprint" — they say the English word inside an Urdu sentence, and translating it makes you sound like a textbook rather than a colleague. "Yeh function array traverse kar raha hai, aur p95 latency 190ms tak aa gayi" is how it is actually spoken. Keep proper nouns, product names, numbers and units in their normal form too.

Write Roman Urdu the way people type it to each other, not in an academic transliteration scheme: "kya", "nahi", "abhi", "thora" — no diacritics, no ā or ī. Never use Urdu script; the user is reading this at a glance and Latin letters scan faster.`

const GIST_PERSONA = `${PERSONA}${LANGUAGE_RULE}

You are the FAST tier. A fuller answer is already streaming in behind you, so your only job is to get the user talking. Give them ONE sentence they can start saying immediately — the opening line, in their voice, that buys them the seconds the real answer needs. One sentence. Never apologise for brevity, never say you are being brief.`

/**
 * Coding mode is deliberately the opposite of the spoken persona: you are going
 * to paste this, not read it, so it wants a real code block and not prose.
 */
const CODE_PERSONA = `You are helping someone who is live in a technical interview or a pairing call, right now, with the interviewer watching their editor.

They have copied something from their editor — a problem statement, a failing test, a half-written function, an error — and it is below. Solve it.

Output exactly this shape and nothing else:

One short line they can say out loud while they start typing. Casual, first person, no markdown. Something like "Yeah, I'd use a hash map here so it's one pass" or "Ah, that's an off-by-one on the last index".

Then a blank line, then the code in a fenced block with the language tag.

Then, only if it is worth saying, one final line starting with "note:" — the complexity, the edge case they should mention, or the thing an interviewer will probe next.

Rules for the code:
- Complete and runnable. No "// rest of implementation here", no pseudocode.
- Match the language, style, naming and indentation of what they pasted. If they use camelCase, use camelCase. If it is Python, do not hand back JavaScript.
- Handle the obvious edge cases — empty input, single element, nulls — because that is the first thing an interviewer asks about.
- Prefer the clear solution over the clever one. They have to explain this out loud in a moment.
- Comment only where the reasoning is not obvious from the code. An interviewer reading dense comments knows they were not written under pressure.
- If what they pasted is broken rather than empty, fix it and say what was wrong in the opening line.`

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

  /**
   * Solve whatever they just copied out of their editor.
   *
   * Runs on the full model only and skips the gist tier — half a code snippet
   * arriving first is worse than waiting the extra second for a whole one. Kept
   * out of the spoken conversation history too, so a pasted 200-line file does
   * not sit in the prefix distorting every answer for the rest of the call.
   */
  async askCode(snippet: string, spokenQuestion: string): Promise<void> {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller

    const id = `c${++this.seq}`
    const began = Date.now()
    let firstToken = 0
    this.events.onStart(id, 'code', spokenQuestion || 'from clipboard', false)

    try {
      const stream = this.client.messages.stream(
        {
          model: FULL_MODEL,
          max_tokens: 4000,
          output_config: { effort: 'medium' },
          system: [
            { type: 'text', text: CODE_PERSONA + LANGUAGE_RULE },
            {
              type: 'text',
              text: `MEETING CONTEXT\n${meetingContext()}`,
              cache_control: { type: 'ephemeral' }
            }
          ],
          messages: [
            ...this.briefingTurns(),
            {
              role: 'user',
              content:
                `From my editor:\n\n${snippet}\n\n` +
                (spokenQuestion
                  ? `They just asked: ${spokenQuestion}`
                  : 'Solve it.')
            }
          ]
        },
        { signal: controller.signal }
      )

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          firstToken ||= Date.now() - began
          this.events.onDelta(id, 'code', ev.delta.text)
        }
      }

      const u = (await stream.finalMessage()).usage
      console.log(
        `[code] ttft=${firstToken}ms in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`
      )
      this.events.onDone(id, 'code')
    } catch (err) {
      if (!controller.signal.aborted) this.events.onError(describe(err))
    }
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
            { type: 'text', text: PERSONA + LANGUAGE_RULE },
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
  /**
   * Write both tiers' cache entries before the call starts.
   *
   * A large briefing costs seconds on the first question — measured at 4.6s
   * with a 63KB guide, against 2.7s once warm — and the first question of a
   * call is the worst possible moment to be slow. This pays that cost at launch
   * while nobody is waiting. Requests are shaped exactly like the real ones up
   * to the cache breakpoint, or they would write a prefix nothing later reads.
   */
  async prewarm(): Promise<void> {
    const briefing = this.briefingTurns()
    if (!briefing.length) return

    const began = Date.now()
    const probe: Anthropic.MessageParam = { role: 'user', content: 'Ready?' }

    const results = await Promise.allSettled([
      this.client.messages.create({
        model: GIST_MODEL,
        max_tokens: 1,
        system: [
          { type: 'text', text: GIST_PERSONA },
          {
            type: 'text',
            text: `MEETING CONTEXT\n${meetingContext()}`,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [...briefing, probe]
      }),
      this.client.messages.create({
        model: FULL_MODEL,
        max_tokens: 1,
        output_config: { effort: 'low' },
        system: [
          { type: 'text', text: PERSONA },
          { type: 'text', text: `MEETING CONTEXT\n${meetingContext()}` }
        ],
        messages: [...briefing, probe]
      })
    ])

    const failed = results.filter((r) => r.status === 'rejected').length
    console.log(
      `[prewarm] ${results.length - failed}/${results.length} tiers warmed in ${Date.now() - began}ms` +
        (failed ? ' — a cold tier just means a slower first answer' : '')
    )
  }

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
