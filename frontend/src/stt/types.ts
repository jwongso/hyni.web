// Pluggable speech-to-text abstraction.
//
// Each STT engine is exposed as a `SpeechRecognizer` implementation paired
// with a declarative `RecognizerMeta` describing its capabilities. Engines
// self-register into the central registry so adding a new one is a single
// file edit — the UI picks it up automatically.
//
// Lifecycle / state machine:
//
//     idle ── init() ──> initializing ── ok ──> ready ── start() ──> listening
//                                         ↑                              │
//                                         └────────── stop() ────────────┤
//                                                                        │
//                              dispose() ── from any state ──> idle      │
//                                                                        │
//                              any failure path ──> error ── retry ──────┘
//
// The state machine is single-threaded: only one engine instance per page
// at a time. The React `useSpeechRecognizer` hook in `useSpeechRecognizer.ts`
// guarantees that.

export type SttEngineId = 'webspeech' | 'wstream' | 'transformersjs';

export type RecognizerState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'listening'
  | 'stopped'
  | 'error';

/** Static (compile-time) capabilities of an STT engine. */
export interface RecognizerCapabilities {
  /** Emits partial (interim) transcripts as the user is still speaking. */
  interim: boolean;
  /** Runs entirely on the user's device — no network calls. */
  offline: boolean;
  /** Audio bytes leave the device (e.g. Web Speech → Google). */
  cloud: boolean;
  /** Requires a one-time model download cached in IndexedDB / Cache API. */
  needsModelDownload: boolean;
  /** Approximate model size in MB (0 if no model). For UX hints. */
  modelSizeMb: number;
}

/**
 * Static metadata about an STT engine — safe to surface in UI without
 * instantiating the engine. `isAvailable()` is a quick capability probe (no
 * network, no permission prompts).
 */
export interface RecognizerMeta {
  id: SttEngineId;
  /** Human-readable label for the engine picker. */
  label: string;
  /** Two-sentence description shown in tooltips / settings page. */
  description: string;
  capabilities: RecognizerCapabilities;
  /** Engine can run in the current browser / environment. */
  isAvailable(): boolean;
  /** Optional reason string when isAvailable() === false. */
  unavailableReason?(): string | undefined;
}

export interface RecognizerHandlers {
  /** Called for each partial or final transcript chunk. */
  onResult?(text: string, isFinal: boolean): void;
  /** Called on unrecoverable error. State will transition to 'error'. */
  onError?(message: string): void;
  /** Called on every state transition; `message` is optional human text. */
  onStatus?(state: RecognizerState, message?: string): void;
}

/** The actual capture engine — created lazily by the registry factory. */
export interface SpeechRecognizer {
  readonly id: SttEngineId;
  /** Replace all event handlers in one shot. */
  setHandlers(h: RecognizerHandlers): void;
  /** Idempotent: loads models, primes the runtime. May trigger permission UI. */
  init(): Promise<void>;
  /** Begin capturing audio. Must call init() first (start() does so internally). */
  start(): Promise<void>;
  /** Stop capturing audio. Engine remains alive for fast restart. */
  stop(): Promise<void>;
  /** Release all resources. Safe to call from any state. */
  dispose(): void;
  /** True while audio is being captured. */
  isRunning(): boolean;
}

/** What an adapter registers into the central registry. */
export interface AdapterRegistration {
  meta: RecognizerMeta;
  /** Factory — each call returns a fresh recognizer instance. */
  create(): SpeechRecognizer;
}
