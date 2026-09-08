import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, session, screen } from 'electron'
import { join } from 'node:path'
import { CH, type AnswerTier, type Status } from '@shared/ipc'
import { briefingPdfs, HOTKEY_ENV, HOTKEYS, meetingContext, missingKeys } from './config'
import { Transcript } from './transcript'
import { Stt } from './stt'
import { Brain } from './brain'
import { screenshot } from './capture'

let win: BrowserWindow | null = null
/** Newest code answer, kept so a hotkey can put it on the clipboard. */
let lastCode = ''
const transcript = new Transcript()
let stt: Stt | null = null
let brain: Brain | null = null
/** Last question we fired at, so auto-detect never asks the same thing twice. */
let lastAsked = ''

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const setStatus = (s: Status): void => send(CH.status, s)

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 420

  win = new BrowserWindow({
    width,
    height: workArea.height - 80,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 40,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steal focus from Zoom — typing must keep going to the call.
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // The whole point: WDA_EXCLUDEFROMCAPTURE on Windows, so the panel is absent
  // from screen shares and recordings while staying visible on the real display.
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Permanently inert. Every click and every wheel tick goes to whatever is
  // underneath — the call, the editor, the browser. An overlay that ever
  // swallows a click meant for the app behind it is worse than useless during
  // a meeting, so the panel is scrolled and copied from with hotkeys instead.
  win.setIgnoreMouseEvents(true)

  win.once('ready-to-show', () => win?.showInactive())

  // Renderer runs in Chromium with no visible devtools on an overlay window;
  // forward its console so audio-capture failures are diagnosable.
  win.webContents.on('console-message', (e) => {
    console.log(`[renderer:${e.level}] ${e.message}`)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Hand the renderer a display stream whose audio is the Windows loopback —
 * everything the machine is playing, which is the other side of the call.
 */
function wireLoopbackAudio(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' })
      })
    },
    { useSystemPicker: false }
  )
}

function startServices(): void {
  // Warm the briefing now: it is disk I/O, and the first question is the worst
  // possible moment to discover the context folder is unreadable.
  meetingContext()
  briefingPdfs()

  stt = new Stt({
    onOpen: () => setStatus({ kind: 'listening' }),
    onError: (message) => setStatus({ kind: 'error', message }),
    onTranscript: (speaker, text, final) => {
      const turn = transcript.ingest(speaker, text, final)
      if (turn) send(CH.transcript, turn)
      if (final) console.log(`[${speaker}] ${text}`)
      if (!final || speaker !== 'them') return
      if (!Transcript.isQuestion(text) || text.trim() === lastAsked) return
      void ask(text.trim())
    }
  })

  // Mirror answers to the terminal so a dev run is legible without the overlay.
  const spoken = new Map<string, string>()

  brain = new Brain(transcript, {
    onStart: (id, tier, question, withScreenshot) => {
      spoken.set(`${id}:${tier}`, '')
      send(CH.answerStart, { id, tier, question, withScreenshot })
    },
    onDelta: (id, tier, text) => {
      spoken.set(`${id}:${tier}`, (spoken.get(`${id}:${tier}`) ?? '') + text)
      send(CH.answerDelta, { id, tier, text, done: false })
    },
    onDone: (id, tier: AnswerTier) => {
      const text = spoken.get(`${id}:${tier}`) ?? ''
      console.log(`[${tier}] ${text}`)
      if (tier === 'code') lastCode = extractCode(text)
      spoken.delete(`${id}:${tier}`)
      send(CH.answerDelta, { id, tier, text: '', done: true })
      if (tier === 'full') setStatus({ kind: 'listening' })
    },
    onError: (message) => setStatus({ kind: 'error', message })
  })

  // Pay the briefing's upload cost now, while nobody is waiting on an answer.
  void brain.prewarm()
}

async function ask(question: string, withScreen = false): Promise<void> {
  if (!brain) return
  lastAsked = question
  setStatus({ kind: 'thinking' })
  const shot = withScreen ? await screenshot() : undefined
  await brain.ask(question, shot)
}

function registerHotkeys(): void {
  globalShortcut.register(HOTKEYS.answerNow, () => {
    const q = transcript.lastFromThem()
    void ask(q || 'Catch me up — what should I say next?')
  })

  globalShortcut.register(HOTKEYS.answerScreen, () => {
    const q = transcript.lastFromThem()
    void ask(q || "What's on my screen, and what should I say about it?", true)
  })

  // Separate hide and show rather than one toggle: when you need it gone you
  // are usually not sure whether it is currently up, and a toggle guesses wrong
  // exactly when it matters.
  globalShortcut.register(HOTKEYS.solveClipboard, async () => {
    // Electron 44 returns a promise here, unlike older versions.
    const snippet = (await clipboard.readText()).trim()
    if (!snippet) {
      setStatus({ kind: 'error', message: 'clipboard is empty — copy the code first' })
      return
    }
    // Guard the request size rather than the model's context: a stray Ctrl+A in
    // a big file would otherwise send the whole thing.
    const clipped = snippet.length > 24_000 ? `${snippet.slice(0, 24_000)}
...[truncated]` : snippet
    console.log(`[code] solving ${clipped.length} chars from clipboard`)
    setStatus({ kind: 'thinking' })
    void brain?.askCode(clipped, transcript.lastFromThem()).finally(() =>
      setStatus({ kind: 'listening' })
    )
  })

  globalShortcut.register(HOTKEYS.hide, () => win?.hide())
  globalShortcut.register(HOTKEYS.show, () => win?.showInactive())
  globalShortcut.register(HOTKEYS.quit, () => {
    console.log('[app] quit requested')
    app.quit()
  })

  // The panel takes no mouse input at all, so these are the only way to move
  // through a long answer or get code out of it.
  globalShortcut.register(HOTKEYS.scrollUp, () => send(CH.scroll, 'up'))
  globalShortcut.register(HOTKEYS.scrollDown, () => send(CH.scroll, 'down'))

  globalShortcut.register(HOTKEYS.copyCode, () => {
    if (!lastCode) {
      setStatus({ kind: 'error', message: 'no code answer yet — press Alt+V first' })
      return
    }
    clipboard.writeText(lastCode)
    console.log(`[code] copied ${lastCode.length} chars to clipboard`)
    setStatus({ kind: 'copied' })
    setTimeout(() => setStatus({ kind: 'listening' }), 1200)
  })

  for (const [name, accel] of Object.entries(HOTKEYS)) {
    if (globalShortcut.isRegistered(accel)) continue
    const envVar = HOTKEY_ENV[name as keyof typeof HOTKEYS]
    console.log(`[hotkey] ${accel} was refused — another app already owns it. Set ${envVar} in .env to pick a different key.`)
  }
}

// Only one copy may run. A second instance cannot take the global shortcuts
// the first one holds, so it comes up mute and makes the original look broken —
// which is exactly the confusing failure this avoids.
const isOnlyInstance = app.requestSingleInstanceLock()

if (!isOnlyInstance) {
  // app.quit() is asynchronous — startup would carry on and fail to take the
  // shortcuts the first instance already holds, logging five confusing
  // refusals on the way out. exit() stops here.
  console.log('[app] another Backchannel is already running — exiting.')
  app.exit(0)
}

app.on('second-instance', () => {
  win?.showInactive()
})

if (isOnlyInstance) app.whenReady().then(() => {
  const missing = missingKeys()

  wireLoopbackAudio()
  if (!missing.length) startServices()
  createWindow()
  registerHotkeys()

  if (missing.length) {
    // Report it on the panel rather than dying on first use.
    win?.webContents.once('did-finish-load', () =>
      setStatus({ kind: 'error', message: `set ${missing.join(' and ')} in .env` })
    )
  }

  ipcMain.on(CH.audioState, (_e, payload: { active: boolean; sampleRate: number }) => {
    if (payload.active) stt?.start(payload.sampleRate)
    else stt?.stop()
  })

  let chunks = 0
  ipcMain.on(CH.audioChunk, (_e, chunk: ArrayBuffer) => {
    if (chunks++ === 0) console.log(`[audio] capture live, first chunk ${chunk.byteLength} bytes`)
    stt?.send(chunk)
  })

  ipcMain.on(CH.ask, (_e, question: string) => void ask(question))


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stt?.stop()
})

app.on('window-all-closed', () => app.quit())

/**
 * Pull the fenced block out of a code answer.
 *
 * The answer also carries a line to say out loud and a trailing note, and
 * pasting those into an editor alongside the code would be embarrassing — so
 * the clipboard gets the code only. Falls back to the whole text when the model
 * did not fence it.
 */
function extractCode(answer: string): string {
  const blocks = [...answer.matchAll(/```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/g)]
  if (!blocks.length) return answer.trim()
  return blocks.map((m) => m[1].replace(/\s+$/, '')).join('\n\n')
}
