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
 * Answers need Claude or Gemini, not both: with both set, Gemini is the fallback.
 */
export function missingKeys(): string[] {
  const missing = process.env.DEEPGRAM_API_KEY ? [] : ['DEEPGRAM_API_KEY']
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    missing.push('ANTHROPIC_API_KEY or GEMINI_API_KEY')
  }
  return missing
}

export const keys = {
  get deepgram() { return required('DEEPGRAM_API_KEY') },
  /** Empty when unset — either answer provider may be absent. */
  get anthropic() { return process.env.ANTHROPIC_API_KEY ?? '' },
  get gemini() { return process.env.GEMINI_API_KEY ?? '' }
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
