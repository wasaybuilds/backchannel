import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, screen } from 'electron'
import { join } from 'node:path'
import { CH, type AnswerTier, type Status } from '@shared/ipc'
import { HOTKEYS, meetingContext, missingKeys } from './config'
import { Transcript } from './transcript'
import { Stt } from './stt'
import { Brain } from './brain'
import { screenshot } from './capture'

let win: BrowserWindow | null = null
let clickThrough = true
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
  win.setIgnoreMouseEvents(clickThrough, { forward: true })

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

  stt = new Stt({
    onOpen: () => setStatus({ kind: 'listening' }),
    onError: (message) => setStatus({ kind: 'error', message }),
    onTranscript: (speaker, text, final) => {
      const turn = transcript.ingest(speaker, text, final)
      if (turn) send(CH.transcript, turn)
      if (!final || speaker !== 'them') return
      if (!Transcript.isQuestion(text) || text.trim() === lastAsked) return
      void ask(text.trim())
    }
  })

  brain = new Brain(transcript, {
    onStart: (id, tier, question, withScreenshot) =>
      send(CH.answerStart, { id, tier, question, withScreenshot }),
    onDelta: (id, tier, text) => send(CH.answerDelta, { id, tier, text, done: false }),
    onDone: (id, tier: AnswerTier) => {
      send(CH.answerDelta, { id, tier, text: '', done: true })
      if (tier === 'full') setStatus({ kind: 'listening' })
    },
    onError: (message) => setStatus({ kind: 'error', message })
  })
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

  globalShortcut.register(HOTKEYS.toggleVisible, () => {
    if (!win) return
    if (win.isVisible()) win.hide()
    else win.showInactive()
  })

  globalShortcut.register(HOTKEYS.toggleClickThrough, () => {
    clickThrough = !clickThrough
    win?.setIgnoreMouseEvents(clickThrough, { forward: true })
    win?.setFocusable(!clickThrough)
    send(CH.visibility, { clickThrough })
  })
}

app.whenReady().then(() => {
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
