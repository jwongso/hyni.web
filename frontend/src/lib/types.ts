// Shared types mirroring backend JSON shapes.

export type Mode = 'general' | 'coding' | 'behavioral' | 'system_design';
export const MODES: Mode[] = ['general', 'coding', 'behavioral', 'system_design'];

export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'mistral' | 'local';
export const PROVIDER_IDS: ProviderId[] = ['openai', 'anthropic', 'deepseek', 'mistral', 'local'];

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

export interface ToolCallLog {
  id:         string;
  name:       string;
  arguments:  unknown;
  result:     string;
  is_error:   boolean;
  latency_ms: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ImageData[];
  /** Epoch-ms creation time. Used by the per-message auspice dot. */
  at?: number;
  /** Provider+model that produced this assistant message (shown in the bubble header). */
  model?: string;
  provider?: string;
  /** Reasoning-model chain-of-thought; rendered in a collapsible widget. */
  reasoning?: string;
  /** Tool calls executed during this response (MCP-backed). */
  tool_calls?: ToolCallLog[];
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
  local:     '',
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
  /**
   * Endpoint URL for the Local OpenAI-compatible provider (llama.cpp,
   * Ollama, vLLM, LM Studio, ...). Plain URL, NOT a secret — kept out of
   * the api_keys bag on purpose. When empty, the backend falls back to the
   * LOCAL_LLM_URL env var, then a compiled-in default of
   * http://localhost:8080/v1/chat/completions (llama.cpp's port).
   */
  local_url: string;
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
  /**
   * Off by default: TTS is noisy in shared spaces and the answer is
   * already on screen. Users who want it can toggle in Settings.
   */
  speak_replies: false,
  stream_replies: true,
  api_keys: { ...EMPTY_API_KEYS },
  owner_token: '',
  local_url: '',
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
  /** Override for the Local provider URL (ignored for cloud providers). */
  local_url?: string;
}

export interface ChatResponseBody {
  success: boolean;
  content: string;
  error: string;
  latency_ms: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  http_status: number;
  /** MCP tool calls executed during this turn. Empty when no tools fired. */
  tool_calls?: ToolCallLog[];
}
