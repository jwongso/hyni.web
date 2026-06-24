// Shared types mirroring backend JSON shapes.

export type Mode = 'general' | 'coding' | 'behavioral' | 'system_design';
export const MODES: Mode[] = ['general', 'coding', 'behavioral', 'system_design'];

export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'mistral';
export const PROVIDER_IDS: ProviderId[] = ['openai', 'anthropic', 'deepseek', 'mistral'];

export interface ModelInfo {
  id: string;
  label: string;
  vision: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  default_model: string;
  /**
   * EFFECTIVE availability of a server-side key for the CURRENT request.
   * In owner-mode lockdown, this only flips true when the request carried
   * the correct Authorization: Bearer token.
   */
  has_key: boolean;
  /** Curated dropdown options surfaced by the backend. */
  models: ModelInfo[];
}

export interface ServerConfig {
  providers: ProviderInfo[];
  modes: Mode[];
  /** True iff the server has HYNI_OWNER_TOKEN configured. */
  owner_mode_enabled: boolean;
  /**
   * True iff the most recent /api/config request was recognised as the owner
   * (either open mode OR token matched).
   */
  is_owner: boolean;
}

export interface ImageData {
  image_base64: string;
  mime_type: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ImageData[];
  /** Epoch-ms creation time. Used by the per-message auspice dot. */
  at?: number;
}

export interface UserProfile {
  resume_text: string;
  target_role: string;
  extra_notes: string;
}

export const EMPTY_PROFILE: UserProfile = {
  resume_text: '',
  target_role: '',
  extra_notes: '',
};

export type SttEngineId = 'webspeech' | 'wstream' | 'transformersjs';
export type TtsEngineId = 'webspeech' | 'piper' | 'elevenlabs';

/**
 * BYOK store. Each entry is the bearer / key string for that provider, or
 * empty if not configured. Stored in localStorage as `hyni:api_keys`.
 */
export type ApiKeyBag = Record<ProviderId, string>;

export const EMPTY_API_KEYS: ApiKeyBag = {
  openai:    '',
  anthropic: '',
  deepseek:  '',
  mistral:   '',
};

export interface AppSettings {
  provider: ProviderId;
  model: string;             // empty string -> use server default
  stt_engine: SttEngineId;
  tts_engine: TtsEngineId;
  tts_voice_uri: string;     // engine-specific voice id; empty -> default
  tts_rate: number;          // 0.5 - 2.0
  tts_pitch: number;         // 0.5 - 2.0
  temperature: number;       // 0.0 - 1.5
  max_tokens: number;
  speak_replies: boolean;
  /** True -> /api/chat/stream + live token render. False -> blocking. */
  stream_replies: boolean;
  /**
   * Per-provider API keys stored locally in this browser. When non-empty,
   * the chat request will forward this key in the body and the server uses
   * it instead of any server-side env var. Always allowed (no auth needed).
   */
  api_keys: ApiKeyBag;
  /**
   * Owner token. When the server has HYNI_OWNER_TOKEN set, supplying the
   * matching value here lets this browser use server-side API keys for free.
   * Otherwise BYOK (api_keys) is required for paid providers.
   */
  owner_token: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'openai',
  model: '',
  stt_engine: 'webspeech',
  tts_engine: 'webspeech',
  tts_voice_uri: '',
  tts_rate: 1.0,
  tts_pitch: 1.0,
  temperature: 0.7,
  max_tokens: 4096,
  speak_replies: true,
  stream_replies: true,
  api_keys: { ...EMPTY_API_KEYS },
  owner_token: '',
};

export interface ChatRequestBody {
  provider: ProviderId;
  model?: string;
  mode: Mode;
  profile: UserProfile;
  history: ChatMessage[];
  message: string;
  images?: ImageData[];
  temperature: number;
  max_tokens: number;
  /** Optional client-supplied key — wins over server env var if set. */
  api_key?: string;
}

export interface ChatResponseBody {
  success: boolean;
  content: string;
  error: string;
  latency_ms: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  http_status: number;
}
