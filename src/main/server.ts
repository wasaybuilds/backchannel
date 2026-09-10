import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import QRCode from 'qrcode'
import { contextDir, listContext, type ContextFile } from './config'
import { CONSOLE_HTML } from './console-html'

/** Anything larger is a mistake, and it would replay on every question. */
const MAX_UPLOAD = 8_000_000
const ALLOWED = ['.pdf', '.md', '.txt', '.json', '.csv', '.ts', '.js', '.py', '.sql', '.yaml', '.yml']

export interface ServerHooks {
  /** Reload the briefing from disk and re-warm the prompt cache. */
  apply(): Promise<void>
  /** Trigger an answer, optionally to a typed question rather than the call. */
  ask(question?: string): Promise<void>
  setPanel(visible: boolean): void
  state(): { warm: boolean; listening: boolean; language: string; reply: string }
}

export class Console {
  /** Bearer token. Without it the port is open to anything on the network. */
  readonly token = randomBytes(16).toString('hex')
  private server = createServer((req, res) => void this.route(req, res))

  constructor(private readonly hooks: ServerHooks) {}

  /**
   * Start the control console.
   *
   * Binds to loopback unless `lan` is set. LAN binding is what makes the phone
   * use case work — glancing at a phone mid-call is far more natural than
   * alt-tabbing — but it also puts the port on every network you join, which is
   * exactly why the token is not optional.
   */
  listen(port: number, lan: boolean): void {
    const host = lan ? '0.0.0.0' : '127.0.0.1'
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      const hint = err.code === 'EADDRINUSE' ? ` — port ${port} is taken, set CONSOLE_PORT` : ''
      console.log(`[console] not started: ${err.message}${hint}`)
    })
    this.server.listen(port, host, () => void this.announce(port, lan))
  }

  close(): void {
    this.server.close()
  }

  private async announce(port: number, lan: boolean): Promise<void> {
    const local = `http://127.0.0.1:${port}/?t=${this.token}`
    console.log(`\n[console] ${local}`)

    if (!lan) {
      console.log('[console] loopback only — set CONSOLE_LAN=true to reach it from your phone\n')
      return
    }
    const [best, ...rest] = lanCandidates()
    if (!best) {
      console.log('[console] no LAN address found; loopback only\n')
      return
    }

    const url = `http://${best.address}:${port}/?t=${this.token}`
    console.log(`[console] phone: ${url}   (${best.name})`)
    try {
      // Typing a 32-character token on a phone is not a thing anyone will do.
      console.log(await QRCode.toString(url, { type: 'terminal', small: true }))
    } catch {
      console.log('[console] (QR unavailable)')
    }
    // The ranking is a heuristic, so show the alternatives rather than leaving
    // someone staring at a QR that silently goes nowhere.
    if (rest.length) {
      console.log("[console] if that will not load, try one of these instead:")
      for (const c of rest) console.log(`             http://${c.address}:${port}/?t=${this.token}   (${c.name})`)
    }
    console.log('')
  }

  private authorised(req: IncomingMessage, url: URL): boolean {
    const supplied =
      url.searchParams.get('t') ?? (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const a = Buffer.from(supplied)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (!this.authorised(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('Unauthorised. Open the link printed in the terminal.')
      return
    }

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          return void res.end(CONSOLE_HTML)

        case 'GET /api/state':
          return this.json(res, { files: listContext(), ...this.hooks.state() })

        case 'POST /api/upload':
          return void (await this.upload(req, res, url))

        case 'POST /api/delete': {
          const name = safeName(url.searchParams.get('name'))
          if (!name) return this.json(res, { error: 'bad name' }, 400)
          unlinkSync(join(contextDir(), name))
          console.log(`[console] removed ${name}`)
          return this.json(res, { files: listContext() })
        }

        case 'POST /api/apply':
          await this.hooks.apply()
          return this.json(res, { files: listContext(), ...this.hooks.state() })

        case 'POST /api/ask': {
          const body = await readBody(req, 64_000)
          const question = body.toString('utf8').trim() || undefined
          void this.hooks.ask(question)
          return this.json(res, { ok: true })
        }

        case 'POST /api/panel':
          this.hooks.setPanel(url.searchParams.get('show') === '1')
          return this.json(res, { ok: true })

        default:
          return this.json(res, { error: 'not found' }, 404)
      }
    } catch (err) {
      console.log(`[console] ${String(err)}`)
      this.json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const name = safeName(url.searchParams.get('name'))
    if (!name) return this.json(res, { error: 'bad filename' }, 400)
    if (!ALLOWED.includes(extname(name).toLowerCase())) {
      return this.json(res, { error: `${extname(name)} is not a format I can read` }, 400)
    }

    // Raw body rather than multipart: the only client is the page below, so
    // there is no reason to parse form encodings.
    const data = await readBody(req, MAX_UPLOAD)
    if (!data.length) return this.json(res, { error: 'empty file' }, 400)

    writeFileSync(join(contextDir(), name), data)
    console.log(`[console] received ${name} (${(data.length / 1024).toFixed(0)}KB)`)
    this.json(res, { files: listContext() })
  }

  private json(res: ServerResponse, body: unknown, code = 200): void {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

/** Strip any path components — this name is about to become a filesystem path. */
function safeName(raw: string | null): string | null {
  if (!raw) return null
  const name = basename(raw).replace(/[^\w.\- ()]/g, '_').trim()
  return name && name !== '.' && name !== '..' ? name : null
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`too large — the cap is ${(limit / 1e6).toFixed(0)}MB`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Adapters that exist on a typical dev machine and go nowhere near a phone. */
const VIRTUAL = /vethernet|hyper-v|wsl|virtualbox|vmware|docker|loopback|tailscale|tap-|npcap/i

interface Candidate {
  name: string
  address: string
  rank: number
}

/**
 * Pick the address a phone on the same Wi-Fi can actually reach.
 *
 * Naively taking the first non-internal IPv4 is wrong on Windows: Hyper-V, WSL
 * and Docker all add adapters that enumerate ahead of the real one, and the
 * resulting QR points somewhere unreachable with no clue why. Rank by how
 * likely each is to be a real LAN, and hand back the rest so we can show them.
 */
function lanCandidates(): Candidate[] {
  const out: Candidate[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      let rank = 0
      if (VIRTUAL.test(name)) rank -= 10
      if (/wi-?fi|wlan|wireless/i.test(name)) rank += 3
      if (/ethernet/i.test(name) && !VIRTUAL.test(name)) rank += 2
      // Home networks are overwhelmingly 192.168/16; 172.16/12 is where the
      // virtual adapters live.
      if (a.address.startsWith('192.168.')) rank += 3
      else if (a.address.startsWith('10.')) rank += 2
      else if (a.address.startsWith('172.')) rank -= 1
      out.push({ name, address: a.address, rank })
    }
  }
  return out.sort((x, y) => y.rank - x.rank)
}

export type { ContextFile }
