// Tiny typed wrapper around localStorage.
//
// All keys are namespaced under `hyni:` to avoid collisions with other apps
// on the same origin. Accessors return safe defaults on missing / malformed
// values, repairing the entry in the process.

import {
  DEFAULT_SETTINGS,
  EMPTY_API_KEYS,
  PROVIDER_IDS,
  type AppSettings,
  type ProviderId,
  type SttEngineId,
  type TtsEngineId,
  type UserProfile,
} from './types';

// localStorage version stamp. Bump when changing a default that we want to
// apply retroactively to already-saved settings. The migrator in
// storage.loadSettings checks this and forces the new default through.
//
// v2: default speak_replies flipped to false.
// v3: full sanitisation pass — every field is type-checked against
//     DEFAULT_SETTINGS and snapped to its default if missing / wrong type /
//     unknown enum value. Prevents the SPA from ever sending a malformed
//     /api/chat[/stream] body that the backend silently turns into an
//     empty stream.
const SETTINGS_SCHEMA_VERSION = 3;

const PROFILE_KEY  = 'hyni:profile';
const SETTINGS_KEY = 'hyni:settings';

function readJSON<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as Partial<T>;
    return { ...fallback, ...parsed };
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function writeJSON<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---- Settings sanitiser ----------------------------------------------------
//
// Every field is forced through a per-field guard. The result is guaranteed
// to satisfy the AppSettings contract regardless of what was on disk — a
// blob from any previous version, a partially-edited blob, or even a
// tampered one (e.g. `temperature: "not a number"` from a browser extension)
// becomes a valid AppSettings without losing recognisable user values.

const STT_ENGINES: SttEngineId[] = ['webspeech', 'wstream', 'transformersjs'];
const TTS_ENGINES: TtsEngineId[] = ['webspeech', 'piper', 'elevenlabs'];

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function asNumber(v: unknown, fallback: number, min: number, max: number): number {
  // null / undefined / '' should fall back, not be coerced to 0.
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function sanitiseApiKeys(v: unknown): AppSettings['api_keys'] {
  const out = { ...EMPTY_API_KEYS };
  if (v && typeof v === 'object') {
    const bag = v as Record<string, unknown>;
    for (const id of PROVIDER_IDS) {
      const raw = bag[id];
      if (typeof raw === 'string') out[id] = raw;
    }
  }
  return out;
}

function sanitiseSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    provider:       asEnum<ProviderId>(r.provider, PROVIDER_IDS, DEFAULT_SETTINGS.provider),
    model:          asString(r.model, DEFAULT_SETTINGS.model),
    stt_engine:     asEnum<SttEngineId>(r.stt_engine, STT_ENGINES, DEFAULT_SETTINGS.stt_engine),
    tts_engine:     asEnum<TtsEngineId>(r.tts_engine, TTS_ENGINES, DEFAULT_SETTINGS.tts_engine),
    tts_voice_uri:  asString(r.tts_voice_uri, DEFAULT_SETTINGS.tts_voice_uri),
    tts_rate:       asNumber(r.tts_rate,  DEFAULT_SETTINGS.tts_rate,  0.5, 2.0),
    tts_pitch:      asNumber(r.tts_pitch, DEFAULT_SETTINGS.tts_pitch, 0.5, 2.0),
    temperature:    asNumber(r.temperature, DEFAULT_SETTINGS.temperature, 0.0, 2.0),
    max_tokens:     Math.round(asNumber(r.max_tokens, DEFAULT_SETTINGS.max_tokens, 1, 1_000_000)),
    speak_replies:  asBool(r.speak_replies,  DEFAULT_SETTINGS.speak_replies),
    stream_replies: asBool(r.stream_replies, DEFAULT_SETTINGS.stream_replies),
    api_keys:       sanitiseApiKeys(r.api_keys),
    owner_token:    asString(r.owner_token, DEFAULT_SETTINGS.owner_token),
    local_url:      asString(r.local_url,   DEFAULT_SETTINGS.local_url),
  };
}

function sanitiseProfile(raw: Partial<UserProfile> | null | undefined): UserProfile {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    resume_text: asString(r.resume_text, ''),
    target_role: asString(r.target_role, ''),
    extra_notes: asString(r.extra_notes, ''),
  };
}

export const storage = {
  loadProfile(): UserProfile {
    return sanitiseProfile(readJSON<Partial<UserProfile>>(PROFILE_KEY, {}));
  },
  saveProfile(p: UserProfile) {
    writeJSON(PROFILE_KEY, sanitiseProfile(p));
  },
  loadSettings(): AppSettings {
    let raw: Partial<AppSettings> | null = null;
    try {
      const text = localStorage.getItem(SETTINGS_KEY);
      raw = text ? (JSON.parse(text) as Partial<AppSettings>) : null;
    } catch {
      // corrupt JSON — drop it
      localStorage.removeItem(SETTINGS_KEY);
    }
    const sanitised = sanitiseSettings(raw);
    const stamped = (raw as { _schema?: number } | null)?._schema ?? 0;
    const stored  = sanitised as AppSettings & { _schema?: number };
    if (stamped < SETTINGS_SCHEMA_VERSION) {
      // Schema bump: ensure the freshly-sanitised value is the new on-disk
      // shape. Idempotent — subsequent loads find _schema == current and
      // skip the writeback.
      stored._schema = SETTINGS_SCHEMA_VERSION;
      writeJSON(SETTINGS_KEY, stored);
    }
    return sanitised;
  },
  saveSettings(s: AppSettings) {
    const cleaned = sanitiseSettings(s) as AppSettings & { _schema?: number };
    cleaned._schema = SETTINGS_SCHEMA_VERSION;
    writeJSON(SETTINGS_KEY, cleaned);
  },
  clearAll() {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  },
};
