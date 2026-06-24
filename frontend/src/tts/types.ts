// Pluggable text-to-speech abstraction.
//
// Mirrors the STT layer in stt/types.ts: each engine self-registers a
// declarative meta + factory into a central registry; UI code consumes the
// registry (never the concrete engines) so adding a new TTS = single file.

export type TtsEngineId = 'webspeech' | 'piper' | 'elevenlabs';

export type SpeakerState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'speaking'
  | 'error';

/** Static capabilities of a TTS engine, surfaced to the UI. */
export interface SpeakerCapabilities {
  /** Runs entirely on-device, no network. */
  offline: boolean;
  /** Audio is generated in / streamed from the cloud. */
  cloud: boolean;
  /** Engine requires an API key to function. */
  needsApiKey: boolean;
  /** Engine downloads & caches a voice model on first use. */
  needsModelDownload: boolean;
  /** Approx model size in MB (0 if N/A). */
  modelSizeMb: number;
  /** Engine emits audio incrementally as text is processed. */
  streaming: boolean;
  /** Subjective tier — surfaced as a tag in the picker. */
  voiceQuality: 'system' | 'good' | 'excellent';
}

export interface SpeakerMeta {
  id: TtsEngineId;
  label: string;
  description: string;
  capabilities: SpeakerCapabilities;
  isAvailable(): boolean;
  unavailableReason?(): string | undefined;
}

export interface Voice {
  /** Engine-specific opaque ID. Stored in settings, passed back in speak(). */
  id: string;
  /** Human-readable label, e.g. "Karen — en-AU (female)". */
  label: string;
  /** BCP-47 language tag (best-effort). */
  language: string;
  /** True if the engine considers this the default voice. */
  isDefault?: boolean;
}

export interface SpeakOptions {
  /** Voice ID (engine-specific) or empty for engine default. */
  voiceId?: string;
  /** 0.5 .. 2.0 (engine clamps). */
  rate?: number;
  /** 0.5 .. 2.0 (engine clamps). */
  pitch?: number;
  /** BCP-47 language override. */
  lang?: string;
}

export interface SpeakerHandlers {
  onStatus?(state: SpeakerState, message?: string): void;
  onError?(message: string): void;
  /** Called when an utterance starts being spoken. */
  onSpeakStart?(): void;
  /** Called when an utterance finishes (or is cancelled). */
  onSpeakEnd?(): void;
}

export interface Speaker {
  readonly id: TtsEngineId;
  setHandlers(h: SpeakerHandlers): void;
  /** Idempotent: load any models, populate voice list. */
  init(): Promise<void>;
  /**
   * Voices available for this engine. May change after init() (Web Speech in
   * particular populates the voice list asynchronously on Chrome).
   */
  listVoices(): Promise<Voice[]>;
  /**
   * Speak the given text. Cancels any in-flight utterance first. Returns
   * once the utterance has been QUEUED with the underlying engine — not when
   * playback finishes. Use the onSpeakEnd handler for that.
   */
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  /** Stop any in-flight utterance immediately. */
  cancel(): void;
  /** Release any per-engine resources. Safe to call from any state. */
  dispose(): void;
  isSpeaking(): boolean;
}

export interface SpeakerRegistration {
  meta: SpeakerMeta;
  create(): Speaker;
}
