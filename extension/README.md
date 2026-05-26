# DRL-ZH AI Companion — Developer Guide

The AI Companion is a VS Code extension that lives alongside the drl-zh course notebooks.
It provides a context-aware, voice-capable learning assistant that observes the student's
cursor, understands which TODO they are implementing, and offers Socratic guidance.

## Running locally (without Docker)

This is the fastest way to iterate on the extension during development.

### Prerequisites

- Node.js 18+
- VS Code (desktop) or a locally running Code Server instance
- A Google AI Studio free-tier API key (get one at https://aistudio.google.com — one-click sign-in with a Google account)

### Setup

```bash
cd extension
npm install
npm run build        # compiles TypeScript to out/
```

### Launch in VS Code (desktop)

1. Open the `extension/` folder in VS Code.
2. Press `F5` to launch the Extension Development Host — a new VS Code window opens
   with the companion extension active.
3. In the new window, open any `.ipynb` file from the `drl-zh/` repo root.
4. The DRL Companion panel appears in the activity bar (robot icon).
5. Complete onboarding with your API key and start testing.

> Changes to TypeScript files: run `npm run build` and reload the Extension Development
> Host (`Ctrl+R` / `Cmd+R` in the host window).

### Launch in Code Server (local)

If you want to test the browser-based VS Code environment without Docker:

```bash
# Install code-server globally if needed
npm install -g code-server

# From the drl-zh repo root:
code-server --install-extension extension/  # or install the .vsix after vsce package
code-server .
```

Open http://localhost:8080 in your browser.

### Running tests

```bash
cd extension
npm test             # runs vitest — all unit tests
npx tsc --noEmit     # type check only
```

## Architecture overview

### Key files

| File | Purpose |
|---|---|
| `src/extension.ts` | VS Code activation, sidebar registration, message routing, mic recording |
| `src/contextTracker.ts` | Watches cursor, cell content, errors, fires awareness signals |
| `src/aiClient.ts` | LLM streaming, context window, sentence boundary detection, markdown stripping |
| `src/ttsClient.ts` | TTS sentence pipelining, provider switching, playback coordination |
| `src/providers.ts` | LLM/TTS provider interfaces, factory functions, UserConfig, API clients |
| `src/kokoroWorker.ts` | Worker thread for Kokoro local TTS inference (keeps event loop responsive) |
| `src/transcriptStore.ts` | Per-notebook transcript read/write, rolling window, archiving |
| `src/constants.ts` | All magic numbers and default values |
| `src/webview/chat.js` | Transcript panel UI, mode toggle, STT, audio playback, mute |
| `src/webview/index.html` | Webview HTML structure |
| `src/webview/style.css` | Webview styles |

### Voice pipeline

The extension supports two interaction modes: **chat** (text) and **voice** (speech).

**Speech-to-text (STT):**
- Audio is always captured in the webview via `getUserMedia` + `MediaRecorder` (webm/opus). An `AnalyserNode` drives frequency-domain voice activity detection; once a speech segment ends (post-roll silence), the webview decodes the blob with `AudioContext.decodeAudioData` and resamples to 16 kHz mono Float32 PCM via `OfflineAudioContext` before forwarding it to the extension host.
- The extension host stays stateless for audio — no system recorders, no device plumbing. The same code path runs in desktop VS Code, code-server, and the Dockerized environment; it also unblocks macOS/Windows out of the box.
- **Moonshine**: local ASR via `@huggingface/transformers` + ONNX Runtime WASM. Runs in a worker thread to keep the event loop responsive. Model (~150 MB) downloads on first use to `.localassets/`. English-only, but works offline and needs no API key.
- Noise filtering: short phrases containing "thank" (a common ASR hallucination from keyboard clicks) are silently dropped.

**Text-to-speech (TTS):**
- **Kokoro**: local neural TTS via `kokoro-js` + ONNX Runtime WASM. Runs in a worker thread to keep the event loop responsive. Model (~100 MB) downloads on first use to `.localassets/`. This is the only TTS provider — it works offline, needs no API key, and sounds better than OS speech synthesis.

If Kokoro fails three times in a row (e.g. model download blocked), the extension warns the user once and continues in text-only mode; the transcript panel still shows every AI reply.

TTS sentences are pipelined individually — the first sentence starts generating immediately while the AI is still producing later sentences, giving fast time-to-first-audio. Code blocks are replaced with "written code" and LaTeX with "written formula" before speaking.

Audio playback uses a persistent `AudioContext` (created on user gesture) so playback works even when audio arrives seconds after the last interaction. The extension waits for the webview to confirm playback is complete (`api_tts_done`) before returning to recording mode, preventing mic feedback loops.

**Voice mode UX:**
- Mic is automatically paused during AI speech and resumed after playback completes.
- A mute button allows temporarily disabling the mic (e.g., background noise).
- Stop button in the header interrupts AI speech at any time.

### Awareness system

The `ContextTracker` watches the student's cursor and activity, then fires signals:

| Signal | Trigger |
|---|---|
| `idle` | No interaction for cooldown period |
| `stuck` | 3+ consecutive code cell errors |
| `reading` | Lingering on a markdown cell (12s active / 35s attentive) |
| `confusion` | Long time on markdown without running code |
| `drift` | Code diverges from TODO instructions |
| `flow` | Student is making good progress (active mode only) |

Signal timing scales with awareness level: **active** (frequent), **attentive** (moderate), **quiet** (rare).

### Configuration

All settings are persisted in VS Code's `workspaceState` (non-secret) and `globalState` (API keys). The webview settings panel allows configuring:

- LLM provider: Gemini (default), OpenAI, Anthropic, Groq
- Voice responses toggle, speech rate, awareness level
- Proactive suggestions, LLM drift detection

## .companion/ folder

The extension writes per-notebook transcripts to `.companion/` at the workspace root.
This folder is automatically added to `.gitignore` on first run. You can inspect
transcript files directly — they are plain JSON.

## .localassets/ folder

Kokoro TTS model files are cached in `.localassets/` at the workspace root.
This folder is gitignored. The model downloads automatically on first voice use.
For Docker images, pre-populate this folder to avoid runtime downloads.

## Useful VS Code commands (open Command Palette with Ctrl+Shift+P)

- `DRL: Open AI Companion` — opens the companion panel
- `DRL: Clear Conversation History` — clears the active context window (not the transcript file)
- `DRL: Companion Settings` — opens the settings panel directly
