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
| `820ms -> 190ms` | "820ms down to 190" |
| `A4e` | "A, then 4 unknowns, then e" |

Figures are the exception and stay as digits — you are scanning this
mid-sentence, and `24` registers where "twenty-four" does not. Translate the
symbols, leave the numbers alone.

The difference in practice, same question, before and after the rule:

> ~~"Task two is four digits arranged as HH colon MM, and I count the distinct
> valid 24-hour times."~~
>
> "Oh, that one's the clock puzzle. Four digits only give you 24 arrangements,
> so I just enumerate all of them and check the hour's at most 23 and the
> minute at most 59."

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
├── the-brief.pdf
├── their-company-notes.md
└── pricing.csv
```

**PDFs work as-is** — Claude reads them natively, layout included. Text formats
(`.md .txt .json .csv .ts .js .py .sql .yaml .yml`) are read too, in filename
order.

Everything is pinned in the prompt cache, so **being thorough is nearly free**.
Measured with a 63KB PDF plus a CV: ~27k tokens paid once at launch, then
replayed from cache on every question for the rest of the call. Put in the
things you blank on — dates, figures, headcounts, what you shipped last quarter.

Read once at startup, so restart after editing. `context/` is gitignored: your
CV and deal notes never leave the machine except to the two APIs.

### Other languages

```bash
STT_LANGUAGE=ur              # what Deepgram listens for
REPLY_LANGUAGE=Roman Urdu    # what Claude writes back
```

Deepgram nova-3 does Urdu as `ur`, and Claude writes Roman Urdu well — given an
Urdu-script question it answers like this, which is the point:

> *"Sab se bara migration jo maine kiya wo pichle Q2 mein tha, jab humne 40
> million rows MySQL se Postgres par move kiye. Poora cutover 11 minutes ki
> downtime mein ho gaya tha."*

Technical vocabulary deliberately stays English — nobody on a real call says
the Urdu word for "database" or "latency", and translating it is what makes
machine Urdu sound like a textbook. The prompt forbids it explicitly.

**The catch is code-switching.** Deepgram's `multi` mode is what handles
mid-sentence language mixing, and its set is en/es/fr/de/hi/ru/pt/ja/it/nl —
**Urdu is not in it.** So you can have native Urdu (`ur`) or mid-sentence
English (`multi`), not both. If you mix heavily, try `ur` first and fall back
to `hi` under `multi`: spoken Hindustani is near-identical to Urdu, it comes
back in Devanagari, and Claude reads that without trouble.

Verified: Deepgram accepts `ur`, `hi` and `multi` on nova-3 streaming with
multichannel, and the Roman Urdu output above is real. **Not** verified is
Urdu transcription accuracy on live speech — test that with your own voice
before a call that matters.

---

## Control console

Briefings used to mean editing a folder and restarting. Now there is a small
web console — and because it is served over HTTP rather than being a window,
**you can open it on your phone.** Mid-call, glancing at a phone is normal;
alt-tabbing to a settings window is not.

```bash
CONSOLE_PORT=7331     # default
CONSOLE_LAN=true      # bind to your Wi-Fi so a phone can reach it
```

Startup prints the URL and a scannable QR:

```
[console] http://127.0.0.1:7331/?t=e68f1bb2...
[console] phone: http://192.168.100.104:7331/?t=e68f1bb2...   (Wi-Fi)
    <QR>
[console] if that will not load, try one of these instead:
             http://172.18.160.1:7331/?t=...   (vEthernet (Default Switch))
```

From it you can upload briefing files, drop ones you no longer want, apply the
change, trigger an answer, type a specific question, and hide or show the
panel — all without touching the machine running the call.

**Uploading does not take effect until you press "Apply & warm."** That is
deliberate. The briefing is part of the cached prompt prefix, so changing it
invalidates Anthropic's cache; applying reloads it and re-pays the cache up
front (~2-3s) so your next question is fast rather than waiting on a cold
upload. Verified end to end: a file uploaded over HTTP is answerable seconds
later with no restart.

**On the token.** `CONSOLE_LAN=true` puts the port on every network you join,
so every request needs the token from that URL. Without one, any page you
happened to visit could POST to the port and upload context or trigger runs.
Requests with a wrong or missing token get a 401. Uploads are capped at 8MB,
restricted to readable formats, and filenames are stripped to a basename so
`../../escaped.md` lands inside `context/` rather than anywhere else.

The address is a guess — Windows enumerates Hyper-V, WSL and Docker adapters
ahead of the real one, so the ranking prefers Wi-Fi and Ethernet over virtual
adapters and prints the rest as fallbacks.

---

## Hotkeys

| Key | Does |
|---|---|
| `Alt+Space` | Answer the last thing they said |
| `Alt+D` | Screenshot my screen, then answer about it |
| `Alt+V` | Solve whatever I just copied — returns code |
| `Alt+X` | Copy that code to my clipboard |
| `Alt+↑` / `Alt+↓` | Scroll the answers |
| `Alt+H` / `Alt+S` | Hide / show the panel |
| `Alt+Q` | Quit |

It also fires on its own whenever the other person finishes something that reads
like a question — including "So walk me through…" and "Okay, and how big was the
team.", neither of which opens on an interrogative or ends in a question mark.

Override any key with `HOTKEY_ANSWER`, `HOTKEY_SCREEN`, `HOTKEY_CODE`,
`HOTKEY_COPY`, `HOTKEY_UP`, `HOTKEY_DOWN`, `HOTKEY_HIDE`, `HOTKEY_SHOW`,
`HOTKEY_QUIT` in `.env`.

**Why Alt and not Shift.** These register system-wide. A bare `Shift+H` would
swallow every capital H you type — in Zoom chat, in your editor, everywhere —
and hide the panel instead. Alt is the lightest modifier that does not collide
with typing. If another app already owns a shortcut, startup logs which one was
refused rather than failing silently.

**`Alt+Q` is the only way out.** The window is frameless and hidden from the
taskbar by design, so there is no close button and nothing to alt-tab to. Only
one instance runs at a time — a second copy cannot take the shortcuts the first
one holds, so it would come up mute and make the original look broken.

---

## The panel takes no mouse input, ever

No clicks, no selection, no cursor change. Every click and wheel tick passes
straight through to whatever is underneath.

This is deliberate and it cost a rewrite to get right. An earlier version made
the panel live while the pointer was over it, so the wheel could reach it — but
that meant it could swallow a click you aimed at Zoom or your editor, and it put
a text cursor under anything selectable. An overlay that occasionally eats a
click is worse than one you cannot point at.

So the mouse is replaced by keys: `Alt+↑`/`Alt+↓` to scroll, `Alt+X` to lift the
code out. One key beats sweeping a selection with a mouse the panel cannot see.

Answers auto-scroll only while you are already at the bottom, so scrolling up to
re-read is not undone by the next streaming token.

None of this affects the invisibility. Content protection and mouse handling are
independent — the panel is excluded from screen capture regardless.

---

## Coding rounds

If they put you in an editor, copy the problem or the broken function and press
`Alt+V`. The clipboard beats the screenshot here: Claude gets exact text rather
than pixels, and you get something you can paste back.

Coding mode is the inverse of the spoken persona. One line to say while you
start typing, then a real fenced code block, then the thing an interviewer
probes next:

> *"Yeah, that nested scan is O(n²) — I'd keep a map of value to index so it's
> one pass."*
>
> ```python
> def two_sum(nums, target):
>     if not nums or len(nums) < 2:
>         return None
>     seen = {}  # value -> index of first occurrence
>     for i, num in enumerate(nums):
>         complement = target - num
>         if complement in seen:
>             return [seen[complement], i]
>         seen[num] = i
>     return None
> ```
>
> *note: O(n) time, O(n) extra space. Checking the complement before inserting
> is what stops an element pairing with itself.*

It matches the language, naming and indentation of what you pasted, and adds the
edge-case guards an interviewer asks about first. `Alt+X` then copies **only the
fenced code** — not the line you were meant to say aloud, not the trailing note,
since pasting either into an editor would be its own tell.

Code answers stay out of the spoken conversation history: a pasted 200-line file
would otherwise distort every answer for the rest of the call. Clipboard input is
capped at 24k characters so a stray `Ctrl+A` does not upload your whole file.

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
└── shared/ipc.ts  channel names and payload types

test/              npm test — question detection and echo, no API calls
context/           your briefing files (gitignored)
```

API keys live in the main process only. The renderer captures audio and posts
PCM over IPC; it never holds a credential.

```bash
npm test        # logic tests, no network, no cost
npm run build   # typecheck + bundle
```

## Licence

MIT — see [LICENSE](LICENSE).
