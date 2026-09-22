# Band Alone
Improving solo modes from the [original BandTogether](https://agduan.github.io/BandTogether/)

A webcam and an on-device hand-tracking model let you play guitar, bass and drums in the air, with instruments and the song's chords drawn over the live video. Anyone can sing along through the microphone. If you are lonely, a generated backing band fills in every part nobody is playing. Everything runs in the page: no instrument, no controller, no account, and no backend!

I named this BandAlone, but you can still play it with two people. But you should probably do that [here...](https://agduan.github.io/BandTogether/)

## Stack

Vite + React + TypeScript · [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) hand landmarker (in-browser, GPU) · [Tone.js](https://tonejs.github.io/) audio · Canvas 2D overlay · Zod config and song schemas · Vitest. No backend; everything runs offline once loaded. Pitch detection for the singer is a dependency-free YIN implementation, so the microphone audio never leaves the page.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest
npm run build      # typecheck + production build
```

Every push to `main` builds and deploys to GitHub Pages (`.github/workflows/deploy-pages.yml`).

Tunable thresholds can be overridden from the URL without a rebuild, e.g. `http://localhost:5173/?drum.vMin=1.4&debug.panel=true`. See `src/app/config.ts` for every key. The backtick key toggles the debug panel. While it is open, keys `1` to `6` fire drum hits and `j` / `k` fire strums, so the audio path can be tested without a camera.

The MediaPipe WASM runtime, the hand-landmark model and all audio samples are committed under `public/` so the app runs with no network access. `npm run vendor` re-fetches them (sources and licenses in `public/samples/LICENSES.md`).

## Layout

```
public/       vendored MediaPipe wasm + model, drum and guitar samples, landmark recordings
src/app       React UI, config, session (the one object the UI calls), per-player instrument wiring
src/core      shared types + conventions, typed event bus, frame loop
src/vision    camera, hand landmarker, frame adapter (mirror once, h-units), identity tracker, player regions, filters, recorder
src/detectors gesture state machines (crossing core, drum hits, guitar and bass strums, hand roles, body anchor, drum feedback)
src/audio     Tone.js engine, instrument voices, easy/hard note resolvers, song clock, backing band, singer, harmonizer
src/song      song schema, charts, chord voicings
src/render    canvas overlay, instrument art and effects, HUD, debug panel
test/         vitest specs, including fixture-driven detector tests replayed from recordings
```
