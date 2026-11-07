import Anthropic from '@anthropic-ai/sdk'
import type { AnswerTier } from '@shared/ipc'
import {
  briefingPdfs, FULL_MODEL, GEMINI_FULL_MODEL, GEMINI_GIST_MODEL, GIST_MODEL, keys, languages,
  MATCH_SPEAKER, meetingContext
} from './config'
import { GeminiError, streamGemini, toGemini, type GeminiRequest } from './gemini'
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
- Never mention that you are an AI, and never address the other participant.

The call is often in Urdu, or Urdu mixed with English. Urdu speech may reach you transcribed in Devanagari (Hindi script), in Urdu script, or in Roman letters — treat all of it as spoken Urdu. Live transcription of Urdu is imperfect: when a word looks wrong, work out what they most likely said from context rather than answering the garbled word.

If the MEETING CONTEXT contains a JOB DESCRIPTION, this call is an interview for that role:
- Aim every answer at what that role needs. When the user's CV or notes have something relevant, lead with it and connect it to the role in plain words — "that's basically what you'd want for the payout side here".
- Pick the parts of the user's real experience that match the role's requirements and stack, and mention those first.
- The job description is about the employer, not the user. Never borrow its tools, domains or years of experience as if the user has them. If the role asks for something the CV does not show, say so honestly, bring the closest real experience, and show how they would pick it up.
- Questions like "why this role" or "what do you know about us" get answered from the job description's actual content, not generic praise.`

/**
 * Appended to every persona. Changes only through the console's apply path,
 * which resets the conversation and re-warms, so within a call it stays
 * byte-stable and inside the cached prefix.
 */
function languageRule(): string {
  const reply = languages.reply.trim()
  if (reply.toLowerCase() === 'english') return ''

  const target =
    reply.toLowerCase() === MATCH_SPEAKER
      ? `answer in the language THEM just used. If they asked in English, answer in English. If they asked in Urdu or Hindi — or mixed it with English — answer in Roman Urdu`
      : `answer in ${reply}, whatever language the transcript arrives in`

  return `

LANGUAGE: ${target}. The user is going to say your words out loud, so write the language they actually speak.

When the answer is in Roman Urdu, the thing that matters most is this: do NOT translate technical or business vocabulary. Nobody on a real call says the Urdu word for "database", "deployment", "function", "API", "migration", "latency" or "sprint" — they say the English word inside an Urdu sentence, and translating it makes you sound like a textbook rather than a colleague. "Yeh function array traverse kar raha hai, aur p95 latency 190ms tak aa gayi" is how it is actually spoken. Keep proper nouns, product names, numbers and units in their normal form too.

Write Roman Urdu the way people type it to each other, not in an academic transliteration scheme: "kya", "nahi", "abhi", "thora" — no diacritics, no ā or ī. Use ONLY Latin letters — never Urdu script and never Devanagari, even when the question reached you in those scripts. The user is reading this at a glance and Latin letters scan faster.`
}

const gistPersona = (): string => `${PERSONA}${languageRule()}

You are the FAST tier. A fuller answer is already streaming in behind you, so your only job is to get the user talking. Give them ONE sentence they can start saying immediately — the opening line, in their voice, that buys them the seconds the real answer needs. One sentence. Never apologise for brevity, never say you are being brief.`

const fullPersona = (): string => PERSONA + languageRule()

/** Devanagari (how Deepgram's `multi` writes Urdu) and Arabic script (`ur`). */
const URDU_SCRIPT = /[ऀ-ॿ؀-ۿݐ-ݿ]/

/**
 * The language to answer this question in, stated in the final turn.
 *
 * Fast models drift: told to "match the speaker" Flash-Lite answered an
 * English question in Roman Urdu, and the fast tier slips into Devanagari when
 * the question arrives in it. So the code decides rather than the model — the
 * transcript's script says which language was spoken, since English arrives in
 * Latin letters and Urdu never does. The final turn is uncached, so this costs
 * nothing extra.
 */
function replyHint(question: string): string {
  const reply = languages.reply.trim().toLowerCase()
  if (reply === 'english') return ''
  const latinOnly = ' Latin letters only — no Devanagari, no Urdu script.'
  if (reply !== MATCH_SPEAKER) return latinOnly
  return URDU_SCRIPT.test(question)
    ? ` They asked in Urdu: answer in Roman Urdu.${latinOnly}`
    : ' They asked in English: answer in English.'
}

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

export type Provider = 'claude' | 'gemini'

/**
 * Streams one answer, calling `onText` per chunk; resolves to a usage log line.
 * `alive` is called on any sign of life, before the first word if need be.
 */
type Attempt = (onText: (text: string) => void, signal: AbortSignal, alive: () => void) => Promise<string>

/**
 * How long Claude may take to start responding before we give up on it for
 * this answer. It responds in well under a second when healthy; anything near
 * this is a hang or an overloaded API, and a live call cannot wait it out.
 * Measured to the first stream event, not the first word — a code question can
 * legitimately think for longer than this before writing anything.
 */
const CLAUDE_START_MS = 10_000
/**
 * How long Gemini's answer model may take to start before Flash-Lite answers
 * instead. Gemini thinks before it sends a byte, so this covers thinking: ~3s
 * at LOW when healthy, but 3.8 Flash was seen sitting silent for 50–90s.
 */
const GEMINI_START_MS = 10_000
/** Code questions think at MEDIUM, which legitimately takes longer. */
const GEMINI_CODE_START_MS = 25_000
/** After a key, permission or billing failure — it will not fix itself soon. */
const HARD_COOLDOWN_MS = 30 * 60_000
/** After an overload, rate limit or network blip — worth retrying shortly. */
const SOFT_COOLDOWN_MS = 2 * 60_000

export class Brain {
  /** Null when there is no Anthropic key; Gemini then answers everything. */
  private client = keys.anthropic
    ? new Anthropic({
        apiKey: keys.anthropic,
        // With a fallback ready, the SDK's own retries only delay it.
        maxRetries: keys.gemini ? 0 : 2
      })
    : null
  /** Canonical conversation for the full tier. Append-only, so the cache prefix grows. */
  private history: Anthropic.MessageParam[] = []
  private inFlight: AbortController | null = null
  private seq = 0
  /** Claude is skipped until this time after it fails. */
  private claudeDownUntil = 0
  private claudeDownReason = ''
  private lastProvider: Provider | null = null

  constructor(
    private readonly transcript: Transcript,
    private readonly events: BrainEvents
  ) {}

  /** Which provider answered last, and why Claude is benched if it is. */
  status(): { provider: Provider | null; claudeDown: string } {
    return {
      provider: this.lastProvider,
      claudeDown: !this.client ? 'no key' : this.claudeUsable() ? '' : this.claudeDownReason
    }
  }

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
    this.events.onStart(id, 'code', spokenQuestion || 'from clipboard', false)

    const messages: Anthropic.MessageParam[] = [
      ...this.briefingTurns(),
      {
        role: 'user',
        content:
          `From my editor:\n\n${snippet}\n\n` +
          (spokenQuestion ? `They just asked: ${spokenQuestion}` : 'Solve it.')
      }
    ]

    try {
      await this.route(
        'code',
        controller.signal,
        (text) => this.events.onDelta(id, 'code', text),
        async (onText, attempt, alive) => {
          const stream = this.claude().messages.stream(
            {
              model: FULL_MODEL,
              max_tokens: 4000,
              output_config: { effort: 'medium' },
              system: [
                { type: 'text', text: CODE_PERSONA + languageRule() },
                {
                  type: 'text',
                  text: `MEETING CONTEXT\n${meetingContext()}`,
                  cache_control: { type: 'ephemeral' }
                }
              ],
              messages
            },
            { signal: attempt }
          )
          const u = (await pump(stream, onText, alive)).usage
          return `in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`
        },
        (onText, attempt) =>
          this.viaGemini(GEMINI_FULL_MODEL, CODE_PERSONA + languageRule(), messages, 8000, 'MEDIUM', onText, attempt, GEMINI_CODE_START_MS)
      )
      this.events.onDone(id, 'code')
    } catch (err) {
      if (!controller.signal.aborted) this.events.onError(describe(err))
    }
  }

  private async gist(id: string, question: string, signal: AbortSignal): Promise<void> {
    this.events.onStart(id, 'gist', question, false)

    const messages: Anthropic.MessageParam[] = [
      // The fast tier needs the same documents as the slow one. Without
      // them it confidently announces it has no context, and because it
      // is fast that non-answer is the first thing on screen.
      ...this.briefingTurns(),
      {
        role: 'user',
        content: `Recent call transcript:\n${this.transcript.tail(8)}\n\nTHEM just asked: ${question}\n\nOne sentence they can start saying now.${replyHint(question)}`
      }
    ]

    try {
      await this.route(
        'gist',
        signal,
        (text) => this.events.onDelta(id, 'gist', text),
        async (onText, attempt, alive) => {
          const stream = this.claude().messages.stream(
            {
              model: GIST_MODEL,
              max_tokens: 200,
              // NOTE: no top-level cache_control here. This tier keeps no history,
              // so its last block is the ever-changing transcript tail — auto-caching
              // it would rewrite the cache every call and never read one. The
              // breakpoints below sit on the stable prefix instead.
              system: [
                { type: 'text', text: gistPersona() },
                {
                  type: 'text',
                  text: `MEETING CONTEXT\n${meetingContext()}`,
                  cache_control: { type: 'ephemeral' }
                }
              ],
              messages
            },
            { signal: attempt }
          )
          const u = (await pump(stream, onText, alive)).usage
          return `in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`
        },
        (onText, attempt) =>
          // Flash-Lite already thinks minimally by default; the headroom covers it.
          this.viaGemini(GEMINI_GIST_MODEL, gistPersona(), messages, 600, undefined, onText, attempt)
      )
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

    this.seedBriefing()

    const text = `New speech since your last answer:\n${delta}\n\nAnswer this: ${question}${replyHint(question)}`
    const content: UserContent = screenshot
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } },
          { type: 'text', text: `${text}\n\nThe user's current screen is attached.` }
        ]
      : text

    this.history.push({ role: 'user', content })

    let answer = ''
    try {
      await this.route(
        'full',
        signal,
        (chunk) => {
          answer += chunk
          this.events.onDelta(id, 'full', chunk)
        },
        async (onText, attempt, alive) => {
          const stream = this.claude().messages.stream(
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
                { type: 'text', text: fullPersona() },
                { type: 'text', text: `MEETING CONTEXT\n${meetingContext()}` }
              ],
              messages: this.history
            },
            { signal: attempt }
          )
          const final = await pump(stream, onText, alive)
          if (final.stop_reason === 'refusal') this.events.onError('Claude declined that one.')
          // Log cache effectiveness — if reads stay at 0, something is invalidating
          // the prefix and the call is costing ~10x what it should.
          const u = final.usage
          return `in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`
        },
        (onText, attempt) =>
          this.viaGemini(GEMINI_FULL_MODEL, fullPersona(), this.history, 4000, 'LOW', onText, attempt)
      )

      this.history.push({ role: 'assistant', content: answer || '(no answer)' })
      this.events.onDone(id, 'full')
    } catch (err) {
      // Either way, drop the orphan user turn so the history never ends on an
      // unanswered prompt. Cancelled by a newer question is not an error.
      this.history.pop()
      if (!signal.aborted) this.events.onError(describe(err))
    }
  }

  /**
   * Run one answer on Claude, falling back to Gemini.
   *
   * Falls back only if Claude fails before its first word. Once text is on
   * screen, switching providers would splice two different answers together,
   * so a mid-stream failure is reported instead. After a failure Claude is
   * benched for a while, so the next questions go straight to Gemini rather
   * than paying for the same failure every time.
   */
  private async route(
    tier: AnswerTier,
    signal: AbortSignal,
    onText: (text: string) => void,
    viaClaude: Attempt,
    viaGemini: Attempt
  ): Promise<void> {
    const began = Date.now()
    let firstWord = 0
    const emit = (text: string): void => {
      firstWord ||= Date.now() - began
      onText(text)
    }

    if (this.claudeUsable()) {
      // A per-attempt controller, so a silent Claude can be cut off without
      // cancelling the answer itself.
      const attempt = new AbortController()
      const relay = (): void => attempt.abort()
      signal.addEventListener('abort', relay)
      const watchdog = keys.gemini ? setTimeout(() => attempt.abort(), CLAUDE_START_MS) : null
      const alive = (): void => {
        if (watchdog) clearTimeout(watchdog)
      }

      try {
        const usage = await viaClaude(emit, attempt.signal, alive)
        this.lastProvider = 'claude'
        console.log(`[${tier} usage] claude ttft=${firstWord}ms ${usage}`)
        return
      } catch (err) {
        if (signal.aborted || firstWord || !keys.gemini) throw err
        this.benchClaude(attempt.signal.aborted ? new Error(`no response in ${CLAUDE_START_MS / 1000}s`) : err)
      } finally {
        if (watchdog) clearTimeout(watchdog)
        signal.removeEventListener('abort', relay)
      }
    }

    if (!keys.gemini) {
      throw new Error(this.claudeDownReason || 'No answer provider — set ANTHROPIC_API_KEY or GEMINI_API_KEY')
    }
    // No watchdog on Gemini: it is the last resort, so there is nothing to cut over to.
    const usage = await viaGemini(emit, signal, () => {})
    this.lastProvider = 'gemini'
    console.log(`[${tier} usage] gemini ttft=${firstWord}ms ${usage}`)
  }

  private claudeUsable(): boolean {
    return Boolean(this.client) && Date.now() >= this.claudeDownUntil
  }

  private claude(): Anthropic {
    if (!this.client) throw new Error('ANTHROPIC_API_KEY is not set')
    return this.client
  }

  private benchClaude(err: unknown): void {
    const status = err instanceof Anthropic.APIError ? err.status : undefined
    const message = describe(err)
    // Bad key, no permission, or out of credit: retrying in seconds is pointless.
    const hard = status === 401 || status === 403 || /credit balance|billing/i.test(message)
    const ms = hard ? HARD_COOLDOWN_MS : SOFT_COOLDOWN_MS
    // Gist and full fail together; only announce it once.
    if (Date.now() >= this.claudeDownUntil) {
      console.log(`[brain] Claude unavailable (${message}) — answering with Gemini for ${ms / 60_000} min`)
    }
    this.claudeDownUntil = Date.now() + ms
    this.claudeDownReason = message
  }

  private async viaGemini(
    model: string,
    persona: string,
    messages: Anthropic.MessageParam[],
    maxOutputTokens: number,
    thinkingLevel: GeminiRequest['thinkingLevel'],
    onText: (text: string) => void,
    signal: AbortSignal,
    patienceMs = GEMINI_START_MS
  ): Promise<string> {
    let started = false
    const run = async (m: string, level: GeminiRequest['thinkingLevel'], sig: AbortSignal, onOpen?: () => void): Promise<string> => {
      const u = await streamGemini({
        apiKey: keys.gemini,
        model: m,
        system: `${persona}\n\nMEETING CONTEXT\n${meetingContext()}`,
        contents: toGemini(messages),
        maxOutputTokens,
        thinkingLevel: level,
        signal: sig,
        onOpen,
        onText: (text) => {
          started = true
          onText(text)
        }
      })
      return `${m} in=${u.promptTokenCount ?? 0} cached=${u.cachedContentTokenCount ?? 0} out=${u.candidatesTokenCount ?? 0} thinking=${u.thoughtsTokenCount ?? 0}`
    }

    // Flash-Lite is the backup, so it has nothing to fall back to.
    if (model === GEMINI_GIST_MODEL) return run(model, thinkingLevel, signal)

    // Gemini models get overloaded independently (3.7 Flash returned 503 while
    // Flash-Lite answered in a second), so a silent or failing answer model
    // hands the question to Flash-Lite rather than leaving the user waiting.
    const attempt = new AbortController()
    const relay = (): void => attempt.abort()
    signal.addEventListener('abort', relay)
    const timer = setTimeout(() => attempt.abort(), patienceMs)
    try {
      return await run(model, thinkingLevel, attempt.signal, () => clearTimeout(timer))
    } catch (err) {
      if (signal.aborted || started) throw err
      // A bad key or a malformed request fails on Flash-Lite just the same.
      if (err instanceof GeminiError && err.status < 500 && err.status !== 429) throw err
      const why = attempt.signal.aborted ? `no response in ${patienceMs / 1000}s` : describe(err)
      console.log(`[gemini] ${model} unavailable (${why}) — answering with ${GEMINI_GIST_MODEL}`)
      // Flash-Lite's default thinking is minimal; keep it that way for speed.
      return run(GEMINI_GIST_MODEL, undefined, signal)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', relay)
    }
  }

  /**
   * Write both tiers' cache entries before the call starts.
   *
   * A large briefing costs seconds on the first question — measured at 4.6s
   * with a 63KB guide, against 2.7s once warm — and the first question of a
   * call is the worst possible moment to be slow. This pays that cost at launch
   * while nobody is waiting. Requests are shaped exactly like the real ones up
   * to the cache breakpoint, or they would write a prefix nothing later reads.
   *
   * Doubles as a health check: if Claude cannot answer now (out of credit, bad
   * key), it is benched before the first question rather than during it.
   * Gemini needs no warming; its cache is implicit.
   */
  async prewarm(): Promise<void> {
    if (!this.client) {
      console.log('[prewarm] no ANTHROPIC_API_KEY — answering with Gemini')
      return
    }
    const briefing = this.briefingTurns()
    const began = Date.now()
    const probe: Anthropic.MessageParam = { role: 'user', content: 'Ready?' }

    const results = await Promise.allSettled([
      this.client.messages.create({
        model: GIST_MODEL,
        max_tokens: 1,
        system: [
          { type: 'text', text: gistPersona() },
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
          { type: 'text', text: fullPersona() },
          { type: 'text', text: `MEETING CONTEXT\n${meetingContext()}` }
        ],
        messages: [...briefing, probe]
      })
    ])

    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    console.log(
      `[prewarm] ${results.length - failures.length}/${results.length} tiers warmed in ${Date.now() - began}ms` +
        (failures.length ? ` — ${describe(failures[0])}` : '')
    )
    if (failures.length === results.length && keys.gemini) this.benchClaude(failures[0])
  }

  private seedBriefing(): void {
    if (this.history.length) return
    this.history.push(...this.briefingTurns())
  }

  /**
   * The briefing PDFs as a user/assistant pair, identical on every call so both
   * tiers share the same byte-stable prefix and both get cache hits.
   *
   * Documents are only valid in user turns, so they cannot go in the system
   * prompt with the rest of the brief. Seeding them as turn one puts them
   * inside the append-only cached prefix: paid for on the first question,
   * replayed at cache rates for every question after it.
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

/**
 * Forward a Claude stream's text to `onText`. Every event counts as a sign of
 * life — message_start lands within a second on a healthy API, long before a
 * thinking model writes its first word.
 */
async function pump(
  stream: ReturnType<Anthropic['messages']['stream']>,
  onText: (text: string) => void,
  alive: () => void
): Promise<Anthropic.Message> {
  for await (const ev of stream) {
    alive()
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') onText(ev.delta.text)
  }
  return stream.finalMessage()
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    // The SDK's message is "401 {json}"; the API's own sentence reads better
    // on the console and in the log.
    const inner = (err.error as { error?: { message?: string } } | undefined)?.error?.message
    return `Claude ${err.status}: ${inner ?? err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
