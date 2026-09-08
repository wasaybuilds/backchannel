# backchannel

A live meeting copilot for Windows. It listens to both sides of a call,
watches your screen when you ask it to, and puts an answer on a panel that
**does not appear in screen shares**.

Built on Electron, Deepgram streaming STT, and the Claude API.

---

## How it works

```
  microphone ──┐
               ├─► stereo merge ─► PCM16 worklet ─► Deepgram ─► transcript
  loopback  ───┘   (L=you, R=them)                              │
  (what they say)                                               ▼
                                                       question detected
                                                               │
              ┌────────────────────────────────────────────────┤
              ▼                                                ▼
        Haiku 4.5                                          Opus 5
        one-line gist                                  considered answer
        lands in <1s                                   streams in behind
              └────────────────► overlay panel ◄──────────────┘
                                (invisible to Zoom)
```

Four decisions that matter:

**One transcription socket, not two.** Your mic and the system loopback are
merged into a single stereo stream — left is you, right is them. Deepgram's
`multichannel` mode returns a `channel_index`, which gives speaker attribution
for free. One connection, one bill.

**Two model tiers race.** Haiku 4.5 puts a headline on screen in under a
second while Opus 5 is still thinking. By the time you've drawn breath, the
real answer is streaming in underneath. Opus runs at `effort: "low"` — this is
a conversation, not an essay.

**The prompt cache does the heavy lifting.** The persona and your `context.md`
are byte-stable and cached, and the conversation is append-only, so each new
question replays the whole call at ~10% of input price. The main process logs
`cache_read` per turn — if it stays at zero, something is invalidating the
prefix.

**Screenshots are on-demand only.** A frame is ~1.1k tokens. Streaming them
continuously would wreck both latency and cost, so the screen is captured only
when you press the hotkey.

---

## Setup

Requires Node 20+ and Windows 10 2004 or newer (the invisibility and the
loopback capture are both Windows-only APIs).

```bash
npm install
node node_modules/electron/install.js   # fetches the Electron binary
cp .env.example .env                    # add your two API keys
cp context.md.example context.md        # who you are, who you're talking to
npm run dev
```

Get keys from [console.deepgram.com](https://console.deepgram.com) and
[console.anthropic.com](https://console.anthropic.com).

---

## Hotkeys

| Key | Does |
|---|---|
| `Ctrl+Shift+Space` | Answer the last thing they said |
| `Ctrl+Shift+S` | Screenshot my screen, then answer |
| `Ctrl+Shift+H` | Hide / show the panel |
| `Ctrl+Shift+C` | Toggle click-through (on = clicks pass to the app behind) |

It also fires on its own whenever the other person finishes a sentence that
looks like a question.

---

## Running cost

Per hour of call, roughly:

| | |
|---|---|
| Deepgram nova-3 streaming | ~$0.45 |
| Claude (Haiku gist + Opus 5, cached) | ~$0.30 – $2.00 |

The Claude range depends on how often it fires. Prompt caching is what keeps
it in that band instead of ten times higher.

---

## Known limits

- **Windows only.** `audio: 'loopback'` and `WDA_EXCLUDEFROMCAPTURE` have no
  macOS or Linux equivalent. macOS would need BlackHole or ScreenCaptureKit for
  audio, and has no reliable way to hide a window from capture.
- **Mixed meeting audio.** Loopback captures the whole call as one stream, not
  per-participant tracks — Zoom won't hand those over without their Meeting SDK
  or a bot that visibly joins. If several people talk at once, they all land on
  the "them" channel.
- **Verify the invisibility yourself** before trusting it. Share your screen in
  a real Zoom call and confirm the panel is absent. Content protection is a
  best-effort OS flag, not a guarantee — some capture methods bypass it.
- **OneDrive.** If this repo lives in a synced folder, OneDrive will try to sync
  `node_modules` and can hold file locks during `npm install`. Pause sync or
  move the repo out if installs start failing.

---

## Recording consent

This captures the audio of everyone on the call. Several US states and most of
the EU require all-party consent to record a conversation, and Zoom's terms
have their own rules. Worth settling before you point it at a real meeting.

---

## Layout

```
src/
├── main/          Node side — no DOM, holds the API keys
│   ├── index.ts       window, content protection, hotkeys, IPC
│   ├── stt.ts         Deepgram socket, reconnect, keepalive
│   ├── brain.ts       Claude two-tier, prompt cache, history
│   ├── transcript.ts  rolling buffer + question detection
│   ├── capture.ts     screenshot
│   └── config.ts      env + context.md
├── preload/       the only bridge between the two
├── renderer/      Chromium side — capture and UI, never sees a key
│   ├── audio.ts             mic + loopback -> stereo
│   ├── public/pcm-worklet.js  float -> interleaved PCM16, audio thread
│   └── main.ts              overlay
└── shared/ipc.ts  channel names and payload types
```

API keys live in the main process only. The renderer captures audio and posts
PCM over IPC; it never holds a credential.

## Licence

MIT
