# Whisper Voice Input Design

## Problem

The Web Speech API (`SpeechRecognition`) doesn't work in Electron because Google blocks their cloud speech servers from Chromium shell environments. Voice input only works in the browser, not the desktop app.

## Solution

Replace the Web Speech API with `whisper-web-transcriber` — a WASM-based Whisper implementation that runs entirely in the browser. No external APIs, no server calls. The model downloads once (~57MB) and caches in IndexedDB.

## Architecture

### Dependencies
- `whisper-web-transcriber` — WASM Whisper, runs client-side
- Model: `base-en-q5_1` (57MB, quantized, good accuracy/speed balance)

### Changes

**`server/middleware.ts` or `electron/server.ts`** — Add Cross-Origin Isolation headers:
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`
- Required for SharedArrayBuffer which Whisper WASM needs

**`src/components/ChatInput.tsx`** — Replace voice implementation:
- Remove `SpeechRecognition` / `webkitSpeechRecognition` code
- Create `WhisperTranscriber` instance with `onTranscription` callback
- Model loads lazily on first voice toggle
- Show loading progress on first use
- Same `toggleVoice` API exposed via `useImperativeHandle`

### States
- **idle** — mic button shows Mic icon
- **loading** — first use only, model downloading, show progress %
- **listening** — mic button shows MicOff icon (red), transcribing in real-time
- **error** — mic permission denied or WASM unsupported

### Keyboard Shortcut
- `Ctrl+Shift+M` — already wired, triggers `toggleVoice()` + `focus()`

## Constraints
- Whisper used everywhere (browser + Electron) for consistency
- No external API calls
- Model cached in IndexedDB after first download
- Cross-Origin Isolation headers required on all server responses
