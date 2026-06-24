// Shared types mirroring backend JSON shapes.

export type Mode = 'general' | 'coding' | 'behavioral';
export const MODES: Mode[] = ['general', 'coding', 'behavioral'];

export type ProviderId = 'openai' | 'anthropic';

export interface ProviderInfo {
  id: ProviderId;
  default_model: string;
  has_key: boolean;
}

export interface ServerConfig {
  providers: ProviderInfo[];
  modes: Mode[];
}

export interface ImageData {
  image_base64: string;
  mime_type: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: ImageData[];
}

export interface UserProfile {
  resume_text: string;
  target_role: string;
  strengths: string;
  weaknesses: string;
  extra_notes: string;
}

export const EMPTY_PROFILE: UserProfile = {
  resume_text: '',
  target_role: '',
  strengths: '',
  weaknesses: '',
  extra_notes: '',
};

export type SttEngineId = 'webspeech' | 'wstream' | 'transformersjs';

export interface AppSettings {
  provider: ProviderId;
  model: string;             // empty string -> use server default
  stt_engine: SttEngineId;
  tts_voice_uri: string;     // empty -> default
  tts_rate: number;          // 0.5 - 2.0
  tts_pitch: number;         // 0.5 - 2.0
  temperature: number;       // 0.0 - 1.5
  max_tokens: number;
  speak_replies: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'openai',
  model: '',
  stt_engine: 'webspeech',
  tts_voice_uri: '',
  tts_rate: 1.0,
  tts_pitch: 1.0,
  temperature: 0.7,
  max_tokens: 4096,
  speak_replies: true,
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
}

export interface ChatResponseBody {
  success: boolean;
  content: string;
  error: string;
  latency_ms: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  http_status: number;
}
