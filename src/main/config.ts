import { config as loadEnv } from 'dotenv'
import { app } from 'electron'
import { extname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

loadEnv()

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is missing. Copy .env.example to .env and fill it in.`)
  return v
}

/**
 * Names of credentials that are absent, so startup can report instead of crash.
 * Answers need any one provider; with several set, the rest are fallbacks.
 */
export function missingKeys(): string[] {
  const missing = process.env.DEEPGRAM_API_KEY ? [] : ['DEEPGRAM_API_KEY']
  if (!PROVIDERS.some((p) => keys[p])) {
    missing.push('ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GROQ_API_KEY or GEMINI_API_KEY')
  }
  return missing
}

export const keys = {
  get deepgram() { return required('DEEPGRAM_API_KEY') },
  /** Empty when unset — any answer provider may be absent. */
  get claude() { return process.env.ANTHROPIC_API_KEY ?? '' },
  get openai() { return process.env.OPENAI_API_KEY ?? '' },
  get grok() { return process.env.XAI_API_KEY || process.env.GROK_API_KEY || '' },
  get groq() { return process.env.GROQ_API_KEY ?? '' },
  get gemini() { return process.env.GEMINI_API_KEY ?? '' }
}

export type Provider = 'claude' | 'openai' | 'grok' | 'groq' | 'gemini'
export const PROVIDERS: Provider[] = ['claude', 'openai', 'grok', 'groq', 'gemini']

export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  grok: 'Grok',
  groq: 'Groq',
  gemini: 'Gemini'
}

/**
 * Which provider to try first, then next. Providers without a key are skipped.
 * Set PROVIDER_ORDER=gemini,claude to change it; unknown names are ignored and
 * any provider left out is appended, so a key is never silently unused.
 */
export function providerOrder(): Provider[] {
  const asked = (process.env.PROVIDER_ORDER ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s === 'anthropic' ? 'claude' : s === 'xai' ? 'grok' : s))
    .filter((s): s is Provider => (PROVIDERS as string[]).includes(s))
  const order = [...new Set([...asked, ...PROVIDERS])]
  return order.filter((p) => keys[p])
}

/** The OpenAI-compatible providers: same wire format, different models. */
export interface ChatProvider {
  baseUrl: string
  /** Gist tier — the one-line opener. */
  fast: string
  /** Full and code tiers. */
  full: string
  effort: { fast?: string; full?: string; code?: string }
  tokenField: 'max_tokens' | 'max_completion_tokens'
  /** False when the models take text only: PDFs are left out, screenshot questions skip it. */
  files: boolean
  /** Send only this many recent turns, to stay under a small tokens-per-minute limit. */
  maxTurns?: number
}

export type ChatProviderId = 'openai' | 'grok' | 'groq'

export const CHAT_PROVIDERS: Record<ChatProviderId, ChatProvider> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    // Luna is OpenAI's fastest tier and takes effort `none`; Terra is the fast
    // general model. Sol and Astra reject `none` and are slower.
    fast: process.env.OPENAI_FAST_MODEL || 'gpt-6-luna',
    full: process.env.OPENAI_FULL_MODEL || 'gpt-6.1-terra',
    effort: { fast: 'none', full: 'low', code: 'medium' },
    tokenField: 'max_completion_tokens',
    files: true
  },
  grok: {
    baseUrl: 'https://api.x.ai/v1',
    // Grok's reasoning cannot be turned off, and its Fast variant is not on
    // the public API, so both tiers use the same model at low effort.
    fast: process.env.GROK_FAST_MODEL || 'grok-4.7',
    full: process.env.GROK_FULL_MODEL || 'grok-4.7',
    effort: { fast: 'low', full: 'low', code: 'medium' },
    tokenField: 'max_tokens',
    files: true
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    // Measured: 120B finishes a full answer in ~1.7s, 20B the opener in ~1.4s,
    // both writing good Roman Urdu. Qwen was faster but answered an Urdu
    // question in English despite being told not to.
    fast: process.env.GROQ_FAST_MODEL || 'openai/gpt-oss-20b',
    full: process.env.GROQ_FULL_MODEL || 'openai/gpt-oss-120b',
    effort: { fast: 'low', full: 'low', code: 'medium' },
    tokenField: 'max_completion_tokens',
    // Groq's models read text only.
    files: false,
    // The free tier allows 8,000 tokens a minute per model, and the briefing
    // alone is a few thousand, so only the last three exchanges go along.
    maxTurns: 6
  }
}

/**
 * What Deepgram should listen for. `en` by default.
 *
 * `ur` gets you Urdu on nova-3, returned in Urdu script. `multi` is the
 * code-switching mode, but its language set is en/es/fr/de/hi/ru/pt/ja/it/nl —
 * Urdu is NOT in it, so you cannot have native Urdu and mid-sentence English
 * at the same time. For Urdu-English mixing, `hi` under `multi` is the closest
 * thing: spoken Hindustani is near-identical to Urdu and Claude reads the
 * Devanagari it returns without trouble.
 */
/**
 * What Claude should answer in. Free text, so "Roman Urdu", "Urdu script",
 * "Spanish" all work, plus `MATCH_SPEAKER` to answer in whatever they spoke.
 *
 * Both start from .env and can be switched live from the console. The reply
 * language is part of the cached prompt prefix, so changing it goes through
 * the console's apply path, which resets the conversation and re-warms.
 */
export const languages = {
  stt: process.env.STT_LANGUAGE || 'en',
  reply: process.env.REPLY_LANGUAGE || 'English'
}

/** Reply-language value meaning "answer in the language they just used". */
export const MATCH_SPEAKER = 'match'

/** Fast first-word model. Lands a one-liner while the real answer is still thinking. */
export const GIST_MODEL = 'claude-haiku-4-5'
/** The considered answer. Effort stays low — this is a live call, not an essay. */
export const FULL_MODEL = 'claude-opus-5'

/**
 * Gemini fallback, same two tiers. Flash-Lite thinks minimally by default.
 * 3.6 Flash for the full answer: measured at ~3s to first word at LOW thinking,
 * where 3.8 Flash took 50–90s on the same key and 3.7 Flash returned 503.
 */
export const GEMINI_GIST_MODEL = process.env.GEMINI_FAST_MODEL || 'gemini-3.5-flash-lite'
export const GEMINI_FULL_MODEL = process.env.GEMINI_FULL_MODEL || 'gemini-3.6-flash'

/** Text formats we can drop straight into the prompt. */
const READABLE = ['.md', '.txt', '.json', '.csv', '.ts', '.js', '.py', '.sql', '.yaml', '.yml']

/**
 * Everything you want the model to know before the call: your CV, the job
 * description, the deal notes, pricing, the product spec.
 *
 * Drop files into a `context/` folder next to the app (or a single
 * `context.md`). All of it is read once at launch and pinned in Anthropic's
 * prompt cache, so replays cost ~10% of input price — being thorough here is
 * the cheapest quality win available. Restart to pick up changes.
 */
export interface BriefingPdf {
  name: string
  /** base64, ready for a Claude document content block. */
  data: string
}

let pdfCache: BriefingPdf[] | null = null

/**
 * PDFs from the same `context/` folder — CVs and job descriptions usually
 * arrive as PDFs and converting them by hand loses the layout Claude can read.
 *
 * These cannot ride in the system prompt (documents are only valid in user
 * turns), so `Brain` seeds them into the first conversation turn where they sit
 * inside the cached prefix for the rest of the call.
 */
export function briefingPdfs(): BriefingPdf[] {
  if (pdfCache !== null) return pdfCache

  const found: BriefingPdf[] = []
  for (const root of [process.cwd(), app.getPath('userData')]) {
    const dir = join(root, 'context')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue

    for (const name of readdirSync(dir).sort()) {
      if (extname(name).toLowerCase() !== '.pdf') continue
      const file = join(dir, name)
      const size = statSync(file).size
      // The whole request must stay under 32MB, and these replay every turn.
      if (size > MAX_PDF_BYTES) {
        console.log(`[context] skipping ${name} — ${(size / 1e6).toFixed(1)}MB exceeds the ${MAX_PDF_BYTES / 1e6}MB limit`)
        continue
      }
      found.push({ name, data: readFileSync(file).toString('base64') })
    }
  }

  if (found.length) console.log(`[context] loaded ${found.length} PDF(s): ${found.map((f) => f.name).join(', ')}`)
  pdfCache = found
  return pdfCache
}

const MAX_PDF_BYTES = 8_000_000

let contextCache: string | null = null

export function meetingContext(): string {
  // Read once and freeze. This string is part of the cached prompt prefix — if
  // it changed between turns every request would miss the cache and pay 10x.
  if (contextCache !== null) return contextCache

  const roots = [process.cwd(), app.getPath('userData')]
  const parts: string[] = []

  for (const root of roots) {
    const single = join(root, 'context.md')
    if (existsSync(single)) parts.push(section('context.md', readFileSync(single, 'utf8')))

    const dir = join(root, 'context')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue

    for (const name of readdirSync(dir).sort()) {
      if (!READABLE.includes(extname(name).toLowerCase())) continue
      const file = join(dir, name)
      if (!statSync(file).isFile()) continue
      // Labelled so the persona's job-description rule knows which part is the
      // role and which parts are the user's own history.
      const label = name === JD_FILE ? 'JOB DESCRIPTION (the role this call is about)' : name
      parts.push(section(label, readFileSync(file, 'utf8')))
    }
  }

  if (!parts.length) {
    contextCache = 'No meeting context provided. Create a context/ folder or context.md next to the app.'
    console.log('[context] no files found')
    return contextCache
  }
  console.log(`[context] loaded ${parts.length} file(s)`)
  contextCache = parts.join('\n\n')
  return contextCache
}

function section(name: string, body: string): string {
  return `--- ${name} ---
${body.trim()}`
}

/**
 * Global shortcuts. Override any of them in .env.
 *
 * A word on modifiers: these are registered system-wide, so a bare `Shift+H`
 * swallows every capital H you type anywhere on the machine — in Zoom chat, in
 * your editor, everywhere. Alt is the lightest modifier that does not collide
 * with ordinary typing, which is why these default to Alt rather than Shift.
 * Electron accepts Alt / Control / Shift / Super / CommandOrControl.
 */
export const HOTKEYS = {
  hide: process.env.HOTKEY_HIDE || 'Alt+H',
  show: process.env.HOTKEY_SHOW || 'Alt+S',
  answerNow: process.env.HOTKEY_ANSWER || 'Alt+Space',
  answerScreen: process.env.HOTKEY_SCREEN || 'Alt+D',
  // Copy code in your editor, press this, get working code back.
  solveClipboard: process.env.HOTKEY_CODE || 'Alt+V',
  // The panel never takes the mouse, so scrolling and copying are keys.
  scrollUp: process.env.HOTKEY_UP || 'Alt+Up',
  scrollDown: process.env.HOTKEY_DOWN || 'Alt+Down',
  copyCode: process.env.HOTKEY_COPY || 'Alt+X',
  // The window is frameless and hidden from the taskbar, so without this the
  // only way out is Task Manager.
  quit: process.env.HOTKEY_QUIT || 'Alt+Q'
} as const

/** Which variable to edit when a shortcut is refused. */
export const HOTKEY_ENV: Record<keyof typeof HOTKEYS, string> = {
  hide: 'HOTKEY_HIDE',
  show: 'HOTKEY_SHOW',
  answerNow: 'HOTKEY_ANSWER',
  answerScreen: 'HOTKEY_SCREEN',
  solveClipboard: 'HOTKEY_CODE',
  scrollUp: 'HOTKEY_UP',
  scrollDown: 'HOTKEY_DOWN',
  copyCode: 'HOTKEY_COPY',
  quit: 'HOTKEY_QUIT'
}

/** The pasted job description, kept apart from the file list in the console. */
export const JD_FILE = 'job-description.md'

/** Where uploaded briefing files live. Created on demand. */
export function contextDir(): string {
  const dir = join(process.cwd(), 'context')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export interface ContextFile {
  name: string
  bytes: number
  kind: 'pdf' | 'text' | 'ignored'
}

/** What is currently in the briefing folder, and whether we can read it. */
export function listContext(): ContextFile[] {
  const dir = contextDir()
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && n !== JD_FILE)
    .sort()
    .map((name) => {
      const ext = extname(name).toLowerCase()
      return {
        name,
        bytes: statSync(join(dir, name)).size,
        kind: ext === '.pdf' ? 'pdf' : READABLE.includes(ext) ? 'text' : 'ignored'
      }
    })
}

/** The saved job description, or '' if none. */
export function readJobDescription(): string {
  const file = join(contextDir(), JD_FILE)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** Save the job description; empty text removes it. */
export function writeJobDescription(text: string): void {
  const file = join(contextDir(), JD_FILE)
  if (text.trim()) writeFileSync(file, text.trim() + '\n', 'utf8')
  else if (existsSync(file)) unlinkSync(file)
}

/**
 * Forget the frozen briefing so the next read picks up new files.
 *
 * Both caches exist to keep the prompt prefix byte-stable, so clearing them
 * deliberately invalidates Anthropic's cache too — the caller is expected to
 * re-warm afterwards, or the next question pays full price for the whole
 * briefing instead of ~10%.
 */
export function reloadContext(): void {
  contextCache = null
  pdfCache = null
}
