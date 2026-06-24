// Pluggable speech-to-text adapter interface.
//
// All three back-ends (Web Speech API, wstream WASM, transformers.js Whisper)
// expose the same shape so the chat UI can swap them transparently. Each
// adapter is responsible for capturing microphone audio and emitting
// (potentially partial) transcripts via the supplied callback.
//
// Lifecycle:
//   const r = createRecognizer('webspeech');
//   await r.init();        // load model / request permission
//   r.onResult = (text, isFinal) => ...
//   await r.start();
//   await r.stop();
//   r.dispose();           // release resources

export type SttEngineId = 'webspeech' | 'wstream' | 'transformersjs';

export interface RecognizerInfo {
  id: SttEngineId;
  label: string;
  /** Hint about availability in the current browser. */
  available: boolean;
  /** One-line description shown in settings. */
  description: string;
}

export interface SpeechRecognizer {
  readonly id: SttEngineId;
  /** Called for each partial or final transcript chunk. */
  onResult: ((text: string, isFinal: boolean) => void) | null;
  /** Called when the engine reports an unrecoverable error. */
  onError:  ((message: string) => void) | null;
  /** Called when the engine state changes (started, stopped, model loading...). */
  onStatus: ((status: string) => void) | null;

  /** Load any models / request mic permission. Safe to call multiple times. */
  init(): Promise<void>;
  /** Begin capturing audio. */
  start(): Promise<void>;
  /** Stop capturing audio. */
  stop(): Promise<void>;
  /** Release all resources. */
  dispose(): void;
  /** Whether the recognizer is currently capturing audio. */
  isRunning(): boolean;
}
