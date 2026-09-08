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

**Two model tiers race.** Haiku 4.5 puts a sentence on screen while Opus 5 is
still thinking. Measured on a real call: **first words at ~1.3s, the considered
answer at ~2.1s.** Opus runs at `effort: "low"` — this is a conversation, not an
essay. Both tiers get the same briefing; a fast answer that says "I don't have
context" is worse than no fast answer at all.

**It writes speech, not notes.** The output is the sentences you say, in first
person, no markdown — "Yeah, the one that sticks out is our checkout latency..."
rather than a bulleted report you can't read aloud. It is also told, firmly,
that every specific must come from your brief or the transcript: invented
detail is the failure mode here, because you'd read it out as fact.

**The prompt cache does the heavy lifting.** The persona, your briefing and the
conversation so far are all byte-stable, so each new question replays the lot at
~10% of input price. Note the breakpoints are placed by hand, not left to
top-level `cache_control`: the fast tier keeps no history, so its last block is
the ever-changing transcript, and auto-caching that rewrites the cache every
call and never reads one. That bug cost ~12x on the fast tier before it was
caught. Both tiers log `cache_read` per turn — if it stays at zero, something is
invalidating the prefix.

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

If `npm run dev` exits instantly with `Cannot read properties of undefined
(reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code
and some IDE terminals do this). Launch from a plain terminal, or
`env -u ELECTRON_RUN_AS_NODE npm run dev`.

Get keys from [console.deepgram.com](https://console.deepgram.com) and
[console.anthropic.com](https://console.anthropic.com).

### Briefing it before a call

Drop anything the model should know into a `context/` folder next to the app:

```
context/
├── my-cv.pdf
├── job-description.txt
├── their-company-notes.md
└── pricing.csv
```

**PDFs work** — drop your CV in as-is, no conversion. Claude reads them
natively, layout and all. Text formats (`.md .txt .json .csv .ts .js .py .sql
.yaml .yml`) are read too, in filename order.

All of it is pinned in the prompt cache, so **being thorough here is nearly
free**. Measured on a real 2-page CV: paid for once at ~5.5k tokens, then
replayed from cache on every question after. Put in the numbers you always
fumble — dates, figures, headcounts, the thing you shipped in Q2.

Read once at startup, so restart the app after editing. `context/` is
gitignored: your CV and deal notes never leave the machine except to the two
APIs.

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
| Same, with caching broken | ~10x the Claude line |

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
│   ├── transcript.ts  rolling buffer, question detection, echo removal
│   ├── capture.ts     screenshot
│   └── config.ts      env + context/ loader (text and PDF)
├── test/          npm test — question detection and echo, no API calls
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
