import { config as loadEnv } from 'dotenv'
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

loadEnv()

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is missing. Copy .env.example to .env and fill it in.`)
  return v
}

export const keys = {
  get deepgram() { return required('DEEPGRAM_API_KEY') },
  get anthropic() { return required('ANTHROPIC_API_KEY') }
}

/** Fast first-word model. Lands a one-liner while the real answer is still thinking. */
export const GIST_MODEL = 'claude-haiku-4-5'
/** The considered answer. Effort stays low — this is a live call, not an essay. */
export const FULL_MODEL = 'claude-opus-5'

/**
 * Free-text notes about this meeting: who you're talking to, the deal, your CV,
 * the product. Loaded once at launch and cached with Anthropic's prompt cache,
 * so making it long is cheap. Edit `context.md` next to the app and restart.
 */
export function meetingContext(): string {
  for (const p of [join(process.cwd(), 'context.md'), join(app.getPath('userData'), 'context.md')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  }
  return 'No meeting context provided.'
}

export const HOTKEYS = {
  answerNow: 'CommandOrControl+Shift+Space',
  answerScreen: 'CommandOrControl+Shift+S',
  toggleVisible: 'CommandOrControl+Shift+H',
  toggleClickThrough: 'CommandOrControl+Shift+C'
} as const
