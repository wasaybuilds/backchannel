# backchannel

A live meeting copilot for Windows. It hears both sides of a call, reads your
screen when you ask, and writes the sentences you should say next — on a panel
that **does not appear in screen shares**.

Electron + Deepgram streaming STT + the Claude API. Measured on a real call:
first words on screen in **~1.5s**, the considered answer at **~2.5s** — with a
27k-token briefing loaded, because the cache is pre-warmed at launch.

> Not a transcript tool. Otter and Fathom tell you what was said. This tells you
> what to say, while there is still time to say it.

---

## What it looks like in practice

They ask a question out loud. Roughly a second and a half later a line appears
that you can read straight out:

> *"Yeah, the one that sticks out is our checkout latency. Our p95 was sitting
> at 820 milliseconds, and it turned out to be an N+1 in the cart service. I
> batched the queries instead of looping over them, and that took us down to
> 190 milliseconds."*
>
> *"if they push: The other big one was a MySQL to Postgres migration in Q2,
> about 40 million rows, with 11 minutes of downtime."*

Those numbers came out of a file you dropped in `context/` before the call. That
is the whole idea: you know your own work, you just can't recall the figures
with someone watching.

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
        one sentence                                   considered answer
        ~1.5s                                              ~2.5s
              └────────────────► overlay panel ◄──────────────┘
                             (invisible to Zoom)
```

Five decisions that carry the design:

**One transcription socket, not two.** Your mic and the Windows loopback are
merged into a single stereo stream — left is you, right is them. Deepgram's
`multichannel` mode returns a `channel_index`, so speaker attribution is free.
One connection, one bill.

**Two model tiers race.** Haiku 4.5 puts a usable sentence up while Opus 5 is
still thinking, then the fuller answer streams in underneath. Opus runs at
`effort: "low"` — this is a conversation, not an essay. Both tiers get the same
briefing: a fast answer that says *"I don't have context"* is worse than no fast
answer at all.

**It writes speech, not notes.** This took the most iteration and matters more
than anything else. Two things give away that someone is reading off a screen:
naming the question back ("Task two is...") and reading notation out loud ("H H
colon M M", "O of n log n"). Both are banned outright, with explicit
substitutions — notation becomes the words a person actually says:

| written | spoken |
|---|---|
| `HH:MM` | "a time, hours and minutes" |
| `O(1)` | "constant time" |
| `820ms -> 190ms` | "820 milliseconds down to 190" |
| `A4e` | "A, then four unknowns, then e" |

The difference in practice, same question, before and after the rule:

> ~~"Task two is four digits arranged as HH colon MM, and I count the distinct
> valid 24-hour times."~~
>
> "Oh, that one's the clock puzzle. Four digits only give you twenty-four
> arrangements, so I just enumerate all of them and check the hour's at most
> twenty-three and the minute at most fifty-nine."

It is also told firmly that every specific — figure, date, headcount — must come
from your brief or the transcript. Invented detail is the real failure mode
here: you would read it out as fact and get caught.

**Echo is killed in text, not audio.** Your speakers leak the other person's
voice into your mic, so their question gets transcribed twice and half of it is
attributed to you. Acoustic echo cancellation cannot fix this — Chromium only
cancels audio *Chromium* plays, and the call is played by Zoom. So the two
channels are compared after transcription instead, in both arrival orders
(the mic's copy often finalises *first*).

**The prompt cache is load-bearing.** Briefings are big and replay on every
question. Breakpoints are placed by hand, not left to top-level `cache_control`:
the fast tier keeps no history, so its last block is the ever-changing
transcript, and auto-caching that rewrites the cache every call and never reads
one. That bug cost ~12x on the fast tier before it was caught. Both tiers log
`cache_read` per turn — if it stays at zero, something is invalidating the prefix.

---

## Setup

Windows 10 2004+ and Node 20+. The invisibility and the loopback capture are
both Windows-only APIs.

```bash
npm install
node node_modules/electron/install.js   # fetches the Electron binary
cp .env.example .env                    # add your two API keys
npm run dev
```

Keys from [console.deepgram.com](https://console.deepgram.com) and
[console.anthropic.com](https://console.anthropic.com).

If `npm run dev` dies instantly with `Cannot read properties of undefined
(reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE=1` set — VS Code
and some IDE terminals do this. Use a plain terminal, or
`env -u ELECTRON_RUN_AS_NODE npm run dev`.

### Briefing it before a call

Drop anything it should know into `context/`:

```
context/
├── my-cv.pdf
├── interview-prep-guide.pdf
├── their-company-notes.md
└── pricing.csv
```

**PDFs work as-is** — Claude reads them natively, layout included. Text formats
(`.md .txt .json .csv .ts .js .py .sql .yaml .yml`) are read too, in filename
order.

Everything is pinned in the prompt cache, so **being thorough is nearly free**.
Measured with a 63KB prep guide plus a CV: ~27k tokens paid once at launch, then
replayed from cache on every question for the rest of the call. Put in the
things you blank on — dates, figures, headcounts, what you shipped last quarter.

Read once at startup, so restart after editing. `context/` is gitignored: your
CV and deal notes never leave the machine except to the two APIs.

---

## Hotkeys

| Key | Does |
|---|---|
| `Alt+Space` | Answer the last thing they said |
| `Alt+D` | Screenshot my screen, then answer about it |
| `Alt+H` | Hide the panel |
| `Alt+S` | Show it again |
| `Alt+C` | Toggle click-through |

It also fires on its own whenever the other person finishes something that reads
like a question — including "So walk me through…" and "Okay, and how big was the
team.", which do not open on an interrogative or end in a question mark.

Override any key with `HOTKEY_HIDE`, `HOTKEY_SHOW`, `HOTKEY_ANSWER`,
`HOTKEY_SCREEN`, `HOTKEY_CLICK` in `.env`.

**Why Alt and not Shift.** These register system-wide. A bare `Shift+H` would
swallow every capital H you type — in Zoom chat, in your editor, everywhere —
and hide the panel instead. Alt is the lightest modifier that does not collide
with typing. If another app already owns a shortcut, startup logs which one was
refused rather than failing silently.

**Clicking it never reveals it.** Content protection and mouse handling are
independent. The panel is excluded from capture whether or not you can click it.
`Alt+C` only decides where clicks land — on the panel, or through it onto Zoom
behind. Click-through is on by default so you never steal focus from the call.

**One instance only.** A second copy cannot take global shortcuts the first one
already holds, so it would come up mute and make the original look broken.
Launching again just re-shows the running panel.

---

## Running cost

Per hour of call, roughly:

| | |
|---|---|
| Deepgram nova-3 streaming | ~$0.45 |
| Claude (Haiku gist + Opus 5, cached) | ~$0.30 – $2.00 |

The Claude range depends on how often it fires. Caching is what keeps it in that
band — the same workload with broken caching costs about 10x.

---

## Known limits

- **Windows only.** `audio: 'loopback'` and `WDA_EXCLUDEFROMCAPTURE` have no
  macOS or Linux equivalent. macOS would need BlackHole or ScreenCaptureKit for
  audio and has no dependable way to hide a window from capture.
- **Verify the invisibility yourself.** Share your screen in a real call and
  confirm the panel is absent before trusting it. Content protection is a
  best-effort OS flag, not a guarantee, and it does nothing about a phone
  pointed at your monitor.
- **Mixed meeting audio.** Loopback captures the call as one stream, not
  per-participant tracks — Zoom will not hand those over without their Meeting
  SDK or a bot that visibly joins. With several people talking, they all land on
  the "them" channel.
- **Headphones still help.** The text-level echo filter is a safety net, not a
  substitute. Short fragments under four words are deliberately not filtered,
  because dropping a genuine "okay" is worse than keeping a stray one.
- **It can still be wrong.** The prompt forbids inventing specifics, and that
  measurably works, but it is a prompt and not a guarantee. Anything you would
  be embarrassed to be wrong about, check before you say it.
- **OneDrive.** In a synced folder, OneDrive tries to sync `node_modules` and
  can hold file locks during `npm install`. Pause sync or move the repo out if
  installs start failing.

---

## Recording consent

This captures the audio of everyone on the call. Several US states and most of
the EU require all-party consent to record a conversation, and Zoom's terms have
their own rules. Worth settling before you point it at a real meeting.

---

## Layout

```
src/
├── main/          Node side — no DOM, holds the API keys
│   ├── index.ts       window, content protection, hotkeys, IPC
│   ├── stt.ts         Deepgram socket, reconnect, keepalive
│   ├── brain.ts       Claude two-tier, prompt cache, prewarm, history
│   ├── transcript.ts  rolling buffer, question detection, echo removal
│   ├── capture.ts     screenshot
│   └── config.ts      env, hotkeys, context/ loader (text and PDF)
├── preload/       the only bridge between the two
├── renderer/      Chromium side — capture and UI, never sees a key
│   ├── audio.ts               mic + loopback -> stereo
│   ├── public/pcm-worklet.js  float -> interleaved PCM16, audio thread
│   └── main.ts                overlay
├── shared/ipc.ts  channel names and payload types
└── test/          npm test — question detection and echo, no API calls
```

API keys live in the main process only. The renderer captures audio and posts
PCM over IPC; it never holds a credential.

```bash
npm test        # logic tests, no network, no cost
npm run build   # typecheck + bundle
```

## Licence

MIT
