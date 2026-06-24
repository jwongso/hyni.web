// wstream WASM adapter — local whisper.cpp + Silero VAD in the browser.
//
// Pipeline:
//   mic getUserMedia
//      └─ Silero VAD (vad.MicVAD from /wstream/bundle.min.js + ort.min.js)
//            └─ onSpeechEnd(Float32Array @ 16kHz)
//                  └─ peak-normalize + drop near-silent segments
//                        └─ Module.set_audio(instance, audio)
//                              └─ Whisper.cpp transcribe (libstream.wasm)
//                                    └─ poll Module.get_transcribed() / 100ms
//                                          └─ onResult(text, isFinal=true)
//
// Cross-origin isolation requirement:
//   libstream.wasm + the ORT runtime use SharedArrayBuffer and pthreads.
//   The browser only allows SharedArrayBuffer when the response sets:
//     Cross-Origin-Opener-Policy:   same-origin
//     Cross-Origin-Embedder-Policy: credentialless (or require-corp)
//   hyni.web's Drogon backend and Vite dev server both send these globally;
//   isAvailable() reflects the current page's `crossOriginIsolated` flag.
//
// Assets live under /wstream/ (served by Drogon static).

import type {
  RecognizerHandlers,
  RecognizerState,
  SpeechRecognizer,
  SttEngineId,
} from './types';
import { registerAdapter } from './registry';

type WhisperModel = 'tiny.en' | 'base.en' | 'small.en';

const MODEL_URLS: Record<WhisperModel, string> = {
  'tiny.en':  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin',
  'base.en':  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
  'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
};
// Bundled-local path served by the Drogon backend if present (see
// scripts/fetch-models.sh). When found, this beats HuggingFace on both
// privacy and first-load latency.
const LOCAL_MODEL_PATH = (model: WhisperModel) => `/wstream/models/ggml-${model}-q5_1.bin`;
const MODEL_SIZES_MB: Record<WhisperModel, number> = {
  'tiny.en': 31, 'base.en': 57, 'small.en': 182,
};
const DEFAULT_MODEL: WhisperModel = 'base.en';

const IDB_NAME    = 'hyni.wstream';
const IDB_VERSION = 1;
const IDB_STORE   = 'models';

// -----------------------------------------------------------------------------
// Module-scope runtime bootstrap: scripts + Module + Whisper init happen once
// per page load. Subsequent adapter instances reuse the same runtime.
// -----------------------------------------------------------------------------

interface WstreamRuntime { Module: any; instance: number }

let bootPromise: Promise<WstreamRuntime> | null = null;

function loadScriptOnce(src: string): Promise<void> {
  const existing = document.querySelector(`script[data-wstream="${src}"]`);
  if (existing) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src   = src;
    s.async = false;             // preserve execution order
    s.dataset.wstream = src;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(IDB_NAME, IDB_VERSION);
    rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
    rq.onsuccess       = () => resolve(rq.result);
    rq.onerror         = () => reject(rq.error);
  });
}
async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const rq = tx.objectStore(IDB_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result ?? null);
    rq.onerror   = () => reject(rq.error);
  });
}
async function idbPut(key: string, value: Uint8Array): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function fetchWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

async function loadWhisperModelBytes(
  model: WhisperModel,
  onStatus: (msg: string) => void,
): Promise<Uint8Array> {
  // Cache key uses the canonical HuggingFace URL so the same cached bytes
  // are valid regardless of where they were first sourced from.
  const cacheKey = MODEL_URLS[model];
  const cached = await idbGet(cacheKey).catch(() => null);
  if (cached) {
    onStatus(`model "${model}" loaded from IndexedDB cache (${(cached.byteLength / 1e6).toFixed(1)} MB)`);
    return cached;
  }

  // Prefer the locally-served copy from /wstream/models/ if present (the
  // Drogon backend serves whatever scripts/fetch-models.sh placed there).
  // This gives a fully-local first-run experience — no external CDN hit.
  const localPath = LOCAL_MODEL_PATH(model);
  try {
    const headRes = await fetch(localPath, { method: 'HEAD' });
    if (headRes.ok) {
      onStatus(`downloading "${model}" from this server (~${MODEL_SIZES_MB[model]} MB)…`);
      const data = await fetchWithProgress(localPath, (recv, total) => {
        if (total) onStatus(`local "${model}" — ${Math.round(100 * recv / total)}%`);
      });
      try { await idbPut(cacheKey, data); }
      catch (e: any) { onStatus(`downloaded locally but cache write failed (${e?.message ?? e})`); }
      return data;
    }
  } catch { /* local copy not present — fall through to HuggingFace */ }

  // Fallback: HuggingFace CDN.
  const sizeMb = MODEL_SIZES_MB[model];
  onStatus(`downloading "${model}" from huggingface.co (~${sizeMb} MB)…`);
  const data = await fetchWithProgress(cacheKey, (recv, total) => {
    if (total) onStatus(`huggingface "${model}" — ${Math.round(100 * recv / total)}%`);
  });
  try { await idbPut(cacheKey, data); }
  catch (e: any) { onStatus(`downloaded but cache write failed (${e?.message ?? e})`); }
  return data;
}

async function boot(
  model: WhisperModel,
  onStatus: (msg: string) => void,
): Promise<WstreamRuntime> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (!crossOriginIsolated) {
      throw new Error(
        'Page is not cross-origin-isolated. wstream WASM needs SharedArrayBuffer ' +
        'which requires COOP/COEP headers. Use https://hyni.localrun.ai or ' +
        'http://localhost so the backend can deliver them.');
    }
    onStatus('loading WASM runtime…');

    // Module must exist before libstream.js loads — it reads from window.Module.
    (window as any).Module = {
      print:    (t: string) => console.log('[wstream]', t),
      printErr: (t: string) => console.warn('[wstream]', t),
      setStatus: (t: string) => onStatus(t),
      monitorRunDependencies: () => {},
      preRun:  () => {},
      postRun: () => {},
    };
    (window as any).printTextarea = (...args: any[]) => console.log('[wstream]', ...args);

    // Load order: ORT then VAD then whisper.cpp.
    await loadScriptOnce('/wstream/ort.min.js');
    await loadScriptOnce('/wstream/bundle.min.js');
    await loadScriptOnce('/wstream/libstream.js');

    // libstream.js finishes bring-up asynchronously; wait until its function
    // table is populated.
    await new Promise<void>((resolve) => {
      const tick = () => {
        const M = (window as any).Module;
        if (M && typeof M.FS_createDataFile === 'function' && typeof M.init === 'function') {
          resolve();
        } else {
          setTimeout(tick, 50);
        }
      };
      tick();
    });

    const M = (window as any).Module;
    const data = await loadWhisperModelBytes(model, onStatus);

    onStatus('initializing whisper.cpp…');
    try { M.FS_unlink('whisper.bin'); } catch { /* ignore */ }
    M.FS_createDataFile('/', 'whisper.bin', data, true, true);

    const instance = M.init('whisper.bin');
    if (!instance) throw new Error('Whisper init failed (see console for libstream errors)');

    onStatus(`ready — model ${model} loaded`);
    return { Module: M, instance: instance as number };
  })().catch((e) => {
    bootPromise = null;          // allow retry
    throw e;
  });
  return bootPromise;
}

// -----------------------------------------------------------------------------
// DSP helpers
// -----------------------------------------------------------------------------

function normalizePeak(samples: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > max) max = a;
  }
  if (max < 0.01) return samples;
  const gain = Math.min(1.0 / max, 10.0);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}
function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
function isHallucinationOrBlank(text: string): boolean {
  const c = text.trim();
  if (c.length < 2) return true;
  if (/^\[.*\]$/.test(c)) return true;
  if (/^\(.*\)$/.test(c)) return true;
  if (/^[.\-–—,;:!?♪♫*]+$/.test(c)) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Adapter
// -----------------------------------------------------------------------------

function isAvailable(): boolean {
  return typeof window !== 'undefined'
      && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
      && typeof SharedArrayBuffer !== 'undefined';
}

class WstreamAdapter implements SpeechRecognizer {
  readonly id: SttEngineId = 'wstream';
  private handlers: RecognizerHandlers = {};
  private model: WhisperModel = DEFAULT_MODEL;
  private rt: WstreamRuntime | null = null;
  private vad: any = null;
  private pollTimer: number | null = null;
  private running = false;
  private wantRunning = false;
  private lastEmitted = '';

  setHandlers(h: RecognizerHandlers): void { this.handlers = h; }
  private emit(state: RecognizerState, msg?: string): void {
    this.handlers.onStatus?.(state, msg);
  }

  async init(): Promise<void> {
    if (this.rt) return;
    if (!isAvailable()) {
      throw new Error(
        'wstream WASM needs a cross-origin-isolated context with SharedArrayBuffer. ' +
        'Use https://hyni.localrun.ai or http://localhost.');
    }
    this.emit('initializing', 'wstream bootstrap…');
    this.rt = await boot(this.model, (m) => this.emit('initializing', m));
    this.emit('ready');
  }

  async start(): Promise<void> {
    await this.init();
    if (this.running) return;
    this.wantRunning = true;
    this.lastEmitted = '';
    this.rt!.Module.reset_transcription?.();

    const vadGlobal = (window as any).vad;
    if (!vadGlobal?.MicVAD) {
      throw new Error('Silero VAD is not available (bundle.min.js failed to load).');
    }

    this.emit('initializing', 'requesting microphone permission…');
    try {
      this.vad = await vadGlobal.MicVAD.new({
        model: 'legacy',
        baseAssetPath:    '/wstream/',
        onnxWASMBasePath: '/wstream/',
        ortConfig: (ort: any) => { ort.env.wasm.wasmPaths = '/wstream/'; },
        onSpeechStart: () => this.emit('listening', 'speech detected…'),
        onSpeechEnd:   (audio: Float32Array) => this.feedAudio(audio),
        onVADMisfire:  () => {},
      });
      this.vad.start();
    } catch (e: any) {
      const name = e?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error(
          'Microphone permission denied. Click the address-bar mic icon and ' +
          'allow access for this site, then try again.');
      }
      throw new Error('wstream VAD failed to start: ' + (e?.message ?? e));
    }

    this.pollTimer = window.setInterval(() => this.pollTranscription(), 100);
    this.running = true;
    this.emit('listening', `local · whisper ${this.model}`);
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    if (this.vad)       { try { this.vad.destroy?.(); } catch { /* ignore */ } this.vad = null; }
    if (this.pollTimer != null) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.rt?.Module.reset_transcription?.();
    this.running = false;
    this.emit('stopped');
  }

  dispose(): void {
    this.wantRunning = false;
    if (this.vad)       { try { this.vad.destroy?.(); } catch { /* ignore */ } this.vad = null; }
    if (this.pollTimer != null) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.running = false;
    // boot() runtime is module-scoped and intentionally NOT torn down — the
    // 57 MB whisper.bin in WASM memory should be reused on re-init.
  }

  isRunning(): boolean { return this.running; }

  // ---------------------------------------------------------------------------

  private feedAudio(audio: Float32Array): void {
    if (!this.wantRunning || !this.rt) return;
    if (rms(audio) < 0.005) return;
    const audioNorm = normalizePeak(audio);
    try {
      this.rt.Module.set_audio(this.rt.instance, audioNorm);
    } catch (e: any) {
      this.handlers.onError?.('wstream: set_audio failed — ' + (e?.message ?? e));
    }
  }

  private pollTranscription(): void {
    if (!this.rt) return;
    const text: string = this.rt.Module.get_transcribed?.() || '';
    if (!text) return;
    if (isHallucinationOrBlank(text)) {
      this.rt.Module.reset_transcription?.();
      return;
    }
    if (text === this.lastEmitted) return;
    this.lastEmitted = text;
    this.handlers.onResult?.(text.trim(), true);
    this.rt.Module.reset_transcription?.();
    this.lastEmitted = '';
  }
}

registerAdapter({
  meta: {
    id: 'wstream',
    label: 'wstream (local whisper.cpp)',
    description:
      'whisper.cpp + Silero VAD running entirely in your browser. Fully private — ' +
      'audio never leaves the device. First run downloads the ~57 MB base.en model ' +
      'into IndexedDB; subsequent loads are instant. Needs a cross-origin-isolated ' +
      'context (https:// or http://localhost) for SharedArrayBuffer + WASM threads.',
    capabilities: {
      interim: false,           // final-segment-only via Whisper
      offline: true,
      cloud:   false,
      needsModelDownload: true,
      modelSizeMb: MODEL_SIZES_MB[DEFAULT_MODEL],
    },
    isAvailable,
    unavailableReason: () => {
      if (typeof window === 'undefined') return 'No window object (SSR?).';
      if (typeof SharedArrayBuffer === 'undefined')
        return 'SharedArrayBuffer is unavailable in this browser.';
      if (typeof crossOriginIsolated === 'undefined' || !crossOriginIsolated)
        return 'Page is not cross-origin-isolated (need https:// or http://localhost ' +
               'with COOP/COEP headers).';
      return undefined;
    },
  },
  create: () => new WstreamAdapter(),
});
