import type Anthropic from '@anthropic-ai/sdk'

/**
 * Gemini over plain REST, used when Claude is unavailable.
 *
 * No SDK: one streaming endpoint is all this needs, and fetch plus a small SSE
 * reader is less to keep in step with than another client library. The
 * conversation is kept in Anthropic's shape everywhere else and converted here,
 * so falling back never forks the history.
 */

interface Part {
  text?: string
  inlineData?: { mimeType: string; data: string }
  /** Set on thought-summary parts, which must never reach the screen. */
  thought?: boolean
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: Part[]
}

export interface GeminiUsage {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
}

export class GeminiError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Gemini ${status}: ${message}`)
  }
}

export interface GeminiRequest {
  apiKey: string
  model: string
  /** Persona plus meeting context. Large and stable, so it leads the request
   *  and Gemini's implicit cache can reuse it across questions. */
  system: string
  contents: GeminiContent[]
  /** Includes thinking tokens on Gemini, so leave headroom above the answer. */
  maxOutputTokens: number
  /** Omit to keep the model's default. 3.8 Flash rejects 'MINIMAL'. */
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'
  signal: AbortSignal
  onText(text: string): void
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export async function streamGemini(req: GeminiRequest): Promise<GeminiUsage> {
  const res = await fetch(`${BASE}/${req.model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': req.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.contents,
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        ...(req.thinkingLevel ? { thinkingConfig: { thinkingLevel: req.thinkingLevel } } : {})
      }
    }),
    signal: req.signal
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    let message = body.slice(0, 200)
    try {
      message = JSON.parse(body).error?.message ?? message
    } catch {
      // not JSON; keep the raw text
    }
    throw new GeminiError(res.status, message || res.statusText)
  }

  let usage: GeminiUsage = {}
  let buffer = ''
  const decoder = new TextDecoder()
  const reader = res.body.getReader()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue

      const chunk = JSON.parse(line.slice(5))
      if (chunk.error) throw new GeminiError(chunk.error.code ?? 500, chunk.error.message ?? 'stream error')
      if (chunk.usageMetadata) usage = chunk.usageMetadata

      const candidate = chunk.candidates?.[0]
      for (const part of (candidate?.content?.parts ?? []) as Part[]) {
        if (part.text && !part.thought) req.onText(part.text)
      }
      if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
        console.log(`[gemini] finished early: ${candidate.finishReason}`)
      }
    }
  }
  return usage
}

/** Convert the Anthropic-shaped conversation into Gemini contents. */
export function toGemini(messages: Anthropic.MessageParam[]): GeminiContent[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts:
      typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content.flatMap((block): Part[] => {
            if (block.type === 'text') return [{ text: block.text }]
            if ((block.type === 'image' || block.type === 'document') && block.source.type === 'base64') {
              return [{ inlineData: { mimeType: block.source.media_type, data: block.source.data } }]
            }
            return []
          })
  }))
}
