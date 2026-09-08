import { contextBridge, ipcRenderer } from 'electron'
import { CH, type AnswerDelta, type AnswerStart, type Status, type TranscriptTurn } from '@shared/ipc'

const api = {
  audioState: (active: boolean, sampleRate: number) =>
    ipcRenderer.send(CH.audioState, { active, sampleRate }),
  audioChunk: (chunk: ArrayBuffer) => ipcRenderer.send(CH.audioChunk, chunk),
  ask: (question: string) => ipcRenderer.send(CH.ask, question),

  onTranscript: (fn: (t: TranscriptTurn) => void) =>
    ipcRenderer.on(CH.transcript, (_e, t) => fn(t)),
  onAnswerStart: (fn: (a: AnswerStart) => void) =>
    ipcRenderer.on(CH.answerStart, (_e, a) => fn(a)),
  onAnswerDelta: (fn: (a: AnswerDelta) => void) =>
    ipcRenderer.on(CH.answerDelta, (_e, a) => fn(a)),
  onStatus: (fn: (s: Status) => void) => ipcRenderer.on(CH.status, (_e, s) => fn(s)),
  onVisibility: (fn: (v: { clickThrough: boolean }) => void) =>
    ipcRenderer.on(CH.visibility, (_e, v) => fn(v)),
  onScroll: (fn: (dir: 'up' | 'down') => void) =>
    ipcRenderer.on(CH.scroll, (_e, dir) => fn(dir))
}

contextBridge.exposeInMainWorld('bc', api)

export type BackchannelApi = typeof api
