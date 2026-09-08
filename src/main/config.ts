import { config as loadEnv } from 'dotenv'
import { app } from 'electron'
import { extname, join } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

loadEnv()

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is missing. Copy .env.example to .env and fill it in.`)
  return v
}

/** Names of credentials that are absent, so startup can report instead of crash. */
export function missingKeys(): string[] {
  return ['DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY'].filter((k) => !process.env[k])
}

export const keys = {
  get deepgram() { return required('DEEPGRAM_API_KEY') },
  get anthropic() { return required('ANTHROPIC_API_KEY') }
}

/** Fast first-word model. Lands a one-liner while the real answer is still thinking. */
export const GIST_MODEL = 'claude-haiku-4-5'
/** The considered answer. Effort stays low — this is a live call, not an essay. */
export const FULL_MODEL = 'claude-opus-5'

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
      parts.push(section(name, readFileSync(file, 'utf8')))
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
  toggleClickThrough: process.env.HOTKEY_CLICK || 'Alt+C'
} as const

/** Which variable to edit when a shortcut is refused. */
export const HOTKEY_ENV: Record<keyof typeof HOTKEYS, string> = {
  hide: 'HOTKEY_HIDE',
  show: 'HOTKEY_SHOW',
  answerNow: 'HOTKEY_ANSWER',
  answerScreen: 'HOTKEY_SCREEN',
  toggleClickThrough: 'HOTKEY_CLICK'
}
