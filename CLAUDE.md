# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Start Vite dev server with HMR
pnpm build        # Type-check (tsc -b) then build production bundle
pnpm lint         # Run ESLint
pnpm preview      # Preview production build locally
make prepare-gh   # Initialize GitHub repo and enable Pages deployment
```

## Architecture

Single-page React app: a **MIDI crossfader/blender** themed around Banjo-Kazooie. Users upload two MIDI files, assign them to Deck A and Deck B, then blend playback volume between them via a crossfader slider.

**Key dependencies:**
- `@tonejs/midi` — MIDI file parsing
- `soundfont-player` — Web Audio API synthesis via MusyngKite acoustic piano font

**Data flow:**

1. User uploads `.mid` → `handleFileUpload` reads as `ArrayBuffer`
2. `parseMidi()` extracts `NoteEvent[]` (note, velocity, time, duration) via `@tonejs/midi`
3. Tracks persisted to `localStorage` key `bk-crossfader-tracks-v2`
4. User assigns tracks to Deck A or B; assignments stored in a `Map<string, DeckId>`
5. On play, fader position (0–100) determines per-deck gain; notes scheduled on Web Audio clock (not `setTimeout`) via `soundfont-player`
6. `clampToRange()` octave-transposes notes outside the acoustic piano range (MIDI 21–108)

**Code organization:** Nearly the entire app lives in `src/App.tsx` as a single component with an internal `WaveDisplay` helper. CSS variables define the color theme; `index.css` handles global styles and the scanline background effect.

**Deployment:** Vite base path is `/midi-experiments/` for GitHub Pages.
