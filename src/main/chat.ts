import type Anthropic from '@anthropic-ai/sdk'

/**
 * OpenAI-style Chat Completions over plain REST — one transport for OpenAI and
 * xAI's Grok, which speaks the same wire format.
 *
 * Like gemini.ts, the conversation stays in Anthropic's shape everywhere else
 * and is converted here, so changing provider mid-call never forks history.
 */

type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Part[]
}

export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export class ChatError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string
  ) {
    super(`${provider} ${status}: ${message}`)
  }
}

export interface ChatRequest {
  /** For error messages: "OpenAI", "Grok". */
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  maxTokens: number
  /** OpenAI wants max_completion_tokens (max_tokens is deprecated there). */
  tokenField: 'max_tokens' | 'max_completion_tokens'
  /** Omit to keep the model's default. Includes reasoning in the token budget. */
  reasoningEffort?: string
  headers?: Record<string, string>
  signal: AbortSignal
  onText(text: string): void
  /** Called once the provider accepts the request. */
  onOpen?(): void
}

export async function streamChat(req: ChatRequest): Promise<ChatUsage> {
  const res = await fetch(`${req.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${req.apiKey}`,
      ...req.headers
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      [req.tokenField]: req.maxTokens,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {})
    }),
    signal: req.signal
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    let message = body.slice(0, 200)
    try {
      const err = JSON.parse(body).error
      message = (typeof err === 'string' ? err : err?.message) ?? message
    } catch {
      // not JSON; keep the raw text
    }
    throw new ChatError(req.provider, res.status, message || res.statusText)
  }
  req.onOpen?.()

  let usage: ChatUsage = {}
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
      const data = line.slice(5).trim()
      if (data === '[DONE]') return usage

      const chunk = JSON.parse(data)
      if (chunk.error) {
        throw new ChatError(req.provider, chunk.error.code ?? 500, chunk.error.message ?? 'stream error')
      }
      if (chunk.usage) usage = chunk.usage
      const text = chunk.choices?.[0]?.delta?.content
      if (typeof text === 'string' && text) req.onText(text)
    }
  }
  return usage
}

/**
 * Convert the Anthropic-shaped conversation into Chat Completions messages.
 * PDFs become inline file parts, screenshots become data-URL images.
 *
 * With `files: false` (text-only models) PDFs are replaced by a note naming
 * them, so the model knows they exist and does not invent their contents, and
 * images are dropped — callers keep screenshot questions away from such models.
 */
export function toChat(
  system: string,
  messages: Anthropic.MessageParam[],
  { files = true }: { files?: boolean } = {}
): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      // Assistant turns take plain text only.
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      out.push({ role: 'assistant', content: text })
      continue
    }
    const unread = files
      ? []
      : m.content.flatMap((b) => (b.type === 'document' ? [b.title ?? 'a PDF'] : []))
    const parts = m.content.flatMap((block): Part[] => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }]
      if (!files) return []
      if (block.type === 'image' && block.source.type === 'base64') {
        return [{ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }]
      }
      if (block.type === 'document' && block.source.type === 'base64') {
        return [{
          type: 'file',
          file: {
            filename: block.title ?? 'briefing.pdf',
            file_data: `data:${block.source.media_type};base64,${block.source.data}`
          }
        }]
      }
      return []
    })
    if (unread.length) {
      parts.unshift({
        type: 'text',
        text: `[Briefing PDFs not available to you: ${unread.join(', ')}. Work from the meeting context and the conversation; never guess what those files say.]`
      })
    }
    out.push({ role: 'user', content: parts })
  }
  return out
}
