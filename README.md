# hyni.web

A self-hosted web app to help you **practice live interviews and reduce anxiety**.

A human (friend, partner) plays the interviewer. The app captures the question via
speech-to-text, sends it to an LLM along with your resume and target role, and
returns a tailored answer — rendered as text **and** spoken back via TTS so you
can hear how it sounds and internalize the framing.

## Modes

| Mode | What the LLM does |
|------|-------------------|
| **General**    | Concise, interview-appropriate answer on any topic. |
| **Coding**     | Working code. Python by default, unless the prompt names another language. |
| **Behavioral** | Strict **STAR** answer (Situation / Task / Action / Result), grounded **only** in concrete experiences from your stored resume. No invented stories. |

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  React + Vite frontend  │  HTTP  │   Drogon (C++) backend   │
│  - STT adapters (3)     │ <────> │   - /api/chat (hyni)     │
│  - Web Speech TTS       │        │   - /api/chat/stream     │
│  - Chat + drag-drop img │        │   - /api/config          │
│  - Settings (localStorage)       │   - static + COOP/COEP   │
└─────────────────────────┘        └─────────┬────────────────┘
                                             │
                                             ▼
                                   OpenAI / Anthropic APIs
```

- **Backend** is C++ with [Drogon](https://github.com/drogonframework/drogon),
  embedding a trimmed copy of [`hyni`](../hyni) (chat client + provider schemas).
- **Frontend** is React + TypeScript + Vite.
- **STT** is pluggable. Three swappable adapters behind one interface:
  1. **Web Speech API** (browser-native, Chrome/Edge/Safari).
  2. **wstream** — whisper.cpp + Silero VAD compiled to WASM (private, offline).
  3. **transformers.js** — Whisper via ONNX (private, cross-browser).
  A built-in **Benchmark** page lets you A/B them on the same audio.
- **TTS** uses the browser's Web Speech API.
- **Storage** is browser `localStorage` (resume, settings). Self-contained.

## Repo layout

```
hyni.web/
├── backend/             # Drogon C++ server
│   ├── CMakeLists.txt
│   ├── src/
│   │   ├── main.cc
│   │   ├── controllers/  # HTTP endpoint handlers
│   │   └── hyni/         # in-tree copy of hyni LLM client
│   ├── schemas/          # provider JSON schemas (openai, claude, ...)
│   └── config/           # drogon runtime config
├── frontend/            # React + Vite + TypeScript
│   ├── src/
│   │   ├── pages/        # Chat, Settings, Benchmark
│   │   ├── stt/          # SpeechRecognizer adapters
│   │   └── lib/          # API client, storage helpers
│   ├── index.html
│   └── vite.config.ts
├── public/wstream/      # whisper.cpp + VAD WASM assets (served by backend)
├── cloudflared/         # tunnel config for hyni.localrun.ai
└── scripts/             # build / dev helpers
```

## Quick start

### Prerequisites
- CMake ≥ 3.20, a C++17 compiler, `libcurl`, `nlohmann/json`, OpenSSL, zlib, c-ares, uuid
- Node ≥ 20, npm ≥ 10
- `cloudflared` (only needed for the public hostname)

### One-shot build + run

```bash
cp .env.example .env       # add OPENAI_API_KEY and/or ANTHROPIC_API_KEY
scripts/build.sh           # builds frontend (Vite) then backend (CMake)
scripts/run.sh             # exports .env and runs the Drogon binary
```

Open <http://localhost:8848> — `/` redirects to `/app/`, the SPA.

### Manual workflow

```bash
# Frontend (Vite dev server with hot reload, proxies /api -> :8848)
cd frontend
npm install
npm run dev                # http://localhost:5173

# Backend (in another shell)
cd backend
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
OPENAI_API_KEY=sk-... ./build/hyni_web_server
```

The first backend build pulls and compiles Drogon via CPM (~3-5 min). All
subsequent builds are incremental.

### Public hostname via Cloudflare Tunnel

See [`cloudflared/README.md`](cloudflared/README.md). Two paths:
- **Option A** (recommended): add a single ingress entry to your existing
  `~/.cloudflared/config.yml` to expose `hyni.localrun.ai` → `:8848`.
- **Option B**: spin up a dedicated tunnel using
  `cloudflared/config.standalone.example.yml`.

## Session UX

- Pick a **mode** (General / Coding / Behavioral) at the top of the chat page.
- Click **🎙 Start listening** — STT runs continuously, appending the
  interviewer's words to a buffer (you can edit the buffer text if needed).
- Press **`s`** (no modifier) to send the buffer to the LLM and clear it.
  The hotkey is suppressed while any `<input>` / `<textarea>` has focus.
- Drag-and-drop one or more images into the chat panel to attach them to
  the next send (whiteboard photo, code screenshot, system-design sketch).
- The assistant's reply is displayed in the chat and spoken aloud via TTS
  (toggle in **Settings**).

## License

See [LICENSE](LICENSE).
