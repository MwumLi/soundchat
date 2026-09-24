# SoundChat

[中文](README.md) | **English**

> Text chat over sound waves — speaker to microphone. No Wi-Fi, no Bluetooth, no internet.
>
> 两台设备用**扬声器 → 麦克风**直接互传文字，不需要局域网、蓝牙或联网。

[![CI](https://github.com/MwumLi/soundchat/actions/workflows/ci.yml/badge.svg)](https://github.com/MwumLi/soundchat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```
Device A                        Device B
 [text] → modulate → speaker ~~~~~~~> mic → demodulate → [text]
                       (1–7 kHz audio)
```

## What it is

A working implementation, not a demo:

- **Physical layer** — 16-tone continuous-phase MFSK, preamble sync, per-symbol timing
  tracking, CRC8 on the header + CRC16 on the whole frame
- **Session layer** — broadcast / scan / connect (PIN-authorized), message fragmentation,
  stop-and-wait ARQ, carrier sense, dedup & reassembly
- **App layer** — browser chat UI on the Web Audio API; runs on macOS, Windows, Android, iOS

**129 automated tests** cover AWGN, sample-rate mismatch (44.1k ↔ 48k), multipath reverb,
broadcast/scan/connect timing, PIN validation & lockout, packet loss, and duplicate ACKs.

> Design details (frame formats, timing, tunables, known boundaries) live in
> [`docs/design.md`](docs/design.md) (Chinese). Change the doc before changing behaviour.

## Quick start

### Easiest: use the hosted version

Open this on **both** devices:

```
https://mwumli.github.io/soundchat/
```

GitHub Pages serves over **https**, so the browser will grant microphone access.
No file transfer, no install, no server. Then follow [How to use](#how-to-use).

### Local self-test (30 seconds)

```bash
node tools/cli.mjs loopback "hello"
```

Prints `✓ 回环成功` if the encode/decode chain works. You can also render real audio:

```bash
node tools/cli.mjs encode "hello" out.wav   # generate a playable sound-wave WAV
afplay out.wav                              # macOS
```

### Offline single file (phones / air-gapped)

```bash
node build.mjs     # → dist/soundchat.html  (~93 KB, zero dependencies)
```

Copy that file to the device and open it in a browser.

- **Android** — Chrome treats `file://` as a secure context, so the mic works
- **iOS** — Safari does **not** grant mic access from `file://`. Either use the hosted
  https version, or host the file somewhere over https and "Add to Home Screen"

### Development server

```bash
node tools/serve.mjs      # http://localhost:8080/
```

> ⚠️ **Why "run the server on one device and open it from the other over LAN IP" does not work.**
> Microphone access requires a *secure context*. Per the
> [spec](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts),
> only `https`, `wss`, `file`, `localhost` and `127.0.0.0/8` qualify — a LAN IP over plain
> `http` does not. `navigator.mediaDevices` is simply `undefined` there.

## How to use

**Silent by default.** Clicking "开始使用 / Start" only opens the microphone; nothing is
transmitted until you explicitly press "广播 / Broadcast".

| Step | Device A (wants to be found) | Device B (wants to find) |
|---|---|---|
| 1 | Start, allow microphone | Start, allow microphone |
| 2 | Press **Broadcast** | Open **Devices → Scan** |
| 3 | A 4-digit PIN appears — **read it aloud to B** | "Device A" shows up in the list |
| 4 | wait | Tap **Connect**, type the PIN |
| 5 | Both sides pair automatically | same |

Both devices must use the **same profile** (Robust / Fast), selectable in the Devices view.

### Why does broadcasting beep every few seconds?

Sound is a **half-duplex broadcast** channel: while transmitting, the microphone input is
discarded. So broadcasting cannot be continuous — it must be
**[beep ~1.2 s] → [silence ~2.8 s]** in a loop. That silent window is exactly when the peer
can send its connect request. Hence a beep roughly every 4 seconds, until pairing succeeds
or you stop it.

### What the PIN is (and is not)

The 4-digit PIN is shown **only on A's screen** and never enters the audio stream — you have
to tell it to B out loud. It stops **strangers from connecting to your device**.

It does **not** stop **anyone in the room from listening to your conversation** — sound is a
broadcast medium, and no connection is needed to decode it. Three wrong PINs automatically
stop the broadcast (4 digits is only 10 000 combinations).

## Performance (measured)

| Profile | Symbol | Tone spacing | Raw rate | Effective throughput (60-byte frame) |
|---|---|---|---|---|
| Robust | 21.33 ms | 400 Hz | 188 bit/s | **18.5 B/s** (~3.2 s per 60 bytes) |
| Fast | 13.33 ms | 400 Hz | 300 bit/s | **29.6 B/s** (~2.0 s per 60 bytes) |

| Content | Robust | Fast |
|---|---|---|
| One 20-character Chinese message (60 B) | 3.2 s | 2.0 s |
| A 200-character message (600 B) | 32 s | 20 s |
| A 100 KB image | 1.5 hours | 56 min |

**Text is fine; images are a stretch; large files are impractical.** That is the physics of
an acoustic channel, not an implementation limit.

## How it works

### Physical layer (`src/modem.js`)

```
[preamble: 16 tones 0..15] [header 6B] [payload ≤200B] [crc16 2B]
        each byte → 2 nibbles → each nibble = one tone (16-tone MFSK)
```

- **Modulation** — continuous-phase FSK: phase is never reset between symbols, so there are
  no clicks and no extra spectral splatter
- **Sync** — the receiver does a 2-D search over (start offset × samples-per-symbol) on a
  symbol-energy matrix, then a fine 2-D search on the preamble
- **Demodulation** — Hann-windowed Goertzel tone bank, argmax; non-coherent, no carrier recovery
- **Timing tracking** — per-symbol bounded bang-bang early/late gate locking the sampling
  phase to each symbol centre

### Session layer (`src/protocol.js`)

- **Pairing** — `BEACON` / `CONNECT_REQ` / `CONNECT_ACK` / `REJECT`. Sound is a broadcast
  medium, so each frame carries `src`/`dst` and the receiver filters its own echo
- **ARQ** — send one frame, wait for ACK, retransmit on timeout (max 3); give up and report
- **Carrier sense** — defer while the peer is transmitting, plus a random start-up jitter
- **Fragmentation** — long text is split into 196-byte chunks and reassembled by `(src, msgId)`

## Limitations

1. **The PIN authorises, it does not encrypt.** It stops others from *connecting*; it does
   not stop them from *listening*. Encryption (ECDH + AES-GCM) is the next step — the PIN
   can be reused as the authentication material, like Bluetooth numeric comparison.
2. **One active connection at a time.** Sound is a half-duplex broadcast channel; you cannot
   talk to two devices simultaneously.
3. **Broadcasting is periodic and audible** — a beep every ~4 s until paired or stopped.
4. **The peer's device ID changes** if they clear browser data, switch browsers, or use
   private mode — the conversation history then appears as a new device.
5. **Reverberation-sensitive.** The Fast profile is less tolerant of long RT60 rooms than
   Robust; switch to Robust if connections are flaky.
6. **No forward error correction.** Only CRC + retransmission so far; Reed-Solomon would help.
7. **No ultrasonic mode.** Most phone speakers roll off hard above 18 kHz and mic input
   filters cut it anyway, so real-world usability is poor.
8. **Microphone permissions** require a secure context, which is why the phone workflow
   starts with "get the file onto the phone".

## Deployment

Two workflows are configured:

| Workflow | What it does |
|---|---|
| `.github/workflows/ci.yml` | Runs the full test suite on Node 18 / 20 / 22 for pushes and PRs, and uploads the single-file build as an artifact |
| `.github/workflows/pages.yml` | On push to `main`: run tests, then build and deploy to GitHub Pages |

Live: **https://mwumli.github.io/soundchat/**

The page shows a **build stamp** (status bar and device panel), e.g. `v0.2.0 · e86574a`.
**Both devices must show the same stamp** — if they differ, one is serving a cached older
build; force-reload it (`Cmd+Shift+R` on macOS).

> ⚠️ Pages must be enabled **once**, manually:
> **Settings → Pages → Build and deployment → Source** → **GitHub Actions**.
> Otherwise the deploy step fails with `Get Pages site failed ... 404`.
>
> The workflow can also enable it automatically, but that requires a Personal Access
> Token with `repo` scope stored as the `PAGES_PAT` secret — `configure-pages`'
> `enablement` option **cannot use the default `GITHUB_TOKEN`**.

## Development

```bash
npm test        # 129 tests: modem / protocol / store / bundle
npm run build   # → dist/soundchat.html
npm run serve   # local dev server
npm run cli     # command-line tool
```

Individually:

```bash
node test/modem.test.mjs      # 39: loopback / noise / sample-rate offset / multipath / flush
node test/protocol.test.mjs   # 50: broadcast / scan / connect / PIN / ARQ / ID collision
node test/store.test.mjs      # 29: per-peer history / caps / rename / storage failure
node test/bundle.test.mjs     # 11: single-file build / dependency completeness / DOM wiring
```

### Layout

```
src/modem.js        physical layer: modulation, demodulation, framing, CRC (no DOM)
src/protocol.js     session layer: broadcast/scan/connect, fragmentation, ARQ
src/store.js        persistence: per-peer history + known devices (pure, injectable)
src/app.js          browser: Web Audio I/O + UI
web/index.html      dev page (HTML + CSS)
build.mjs           inlines all modules into the single-file dist/soundchat.html
tools/              cli.mjs / wav.mjs / serve.mjs (all zero-dependency)
docs/design.md      design document (Chinese, source of truth)
LICENSE             MIT
```

### Why the receiver must track timing

This is the single most important detail in the project:

The preamble is only 16 symbols long, so the "samples per symbol" it yields carries about
**0.5 % error**. Over a 432-symbol frame that accumulates to **2 symbols** of drift — enough
to break demodulation entirely. So timing must be tracked symbol by symbol.

And the obvious tool for that, a continuous early/late gate, **diverges** here: the
energy-versus-offset curve is "flat top + triangle", so once the offset is large enough the
sign of `E_late − E_early` flips and the loop runs the wrong way (observed: the whole
demodulated stream shifting by one symbol). What works is a **bounded bang-bang** loop:
compare the energy of the same tone at the current centre versus at ±δ, and step a fixed
small amount (≤5 % of a symbol) toward the higher one. Bounded by construction, wide capture
range.

Other traps are documented in the git log, including:

- the preamble score window must be near-full-symbol (0.95) and rectangular, otherwise the
  perfect-score plateau is too wide and the period estimate is off
- the scan window must look back `lookback` columns, because a column exists about 15 symbols
  before the preamble is fully decidable
- the frame header needs its own checksum (CRC8); otherwise a false sync produces a garbage
  length and the receiver waits for tens of seconds
- when the ring buffer evicts old columns, **every** column index must be shifted together,
  or after ~20 s of audio the scan start goes out of range and no frame is ever decoded again

## References

- [ggwave](https://github.com/ggerganov/ggwave) — similar library, FSK, 8–16 B/s, very robust
- [libquiet / quiet.js](https://github.com/quiet/quiet) — OFDM, ~7 kbps audible, 64 kbps over cable
- [wave-share](https://github.com/ggerganov/wave-share) — WebRTC signalling over sound
- [PairSonic](https://github.com/seemoo-lab/pairsonic) — academic acoustic pairing
- [Evaluating Acoustic Data Transmission Schemes for Ad-Hoc Communication Between Nearby Smart Devices](https://arxiv.org/abs/2602.02249)
  (ACM TIoT 2026) — 11 000+ real-device transmissions; most published schemes degrade badly
  in real rooms

## License

[MIT](LICENSE) © MwumLi

> Unrelated to the license, but worth stating: sound is a **broadcast medium** and this
> implementation is **not encrypted**. Any device in the room can decode your conversation
> without connecting and without the PIN. Add your own encryption layer for sensitive content.
