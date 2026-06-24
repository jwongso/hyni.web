// Tiny typed wrapper around localStorage.
//
// All keys are namespaced under `hyni:` to avoid collisions with other apps
// on the same origin. Accessors return safe defaults on missing / malformed
// values, repairing the entry in the process.

import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  type AppSettings,
  type UserProfile,
} from './types';

// localStorage version stamp. Bump when changing a default that we want to
// apply retroactively to already-saved settings. The migrator in
// storage.loadSettings checks this and forces the new default through.
const SETTINGS_SCHEMA_VERSION = 2;

const PROFILE_KEY  = 'hyni:profile';
const SETTINGS_KEY = 'hyni:settings';

function readJSON<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as Partial<T>;
    // Shallow merge so newly-added fields in `fallback` show up on old
    // settings blobs without losing the user's existing values.
    return { ...fallback, ...parsed };
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function writeJSON<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const storage = {
  loadProfile(): UserProfile {
    return readJSON<UserProfile>(PROFILE_KEY, EMPTY_PROFILE);
  },
  saveProfile(p: UserProfile) {
    writeJSON(PROFILE_KEY, p);
  },
  loadSettings(): AppSettings {
    const s = readJSON<AppSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
    // Defensive: ensure nested api_keys bag is well-formed even if an old
    // blob is missing it.
    s.api_keys = { ...DEFAULT_SETTINGS.api_keys, ...(s.api_keys ?? {}) };
    // Schema migration: pre-v2 stored speak_replies=true by default. v2
    // flips it off and forces the change on existing browsers exactly once.
    const stamped = (s as unknown as { _schema?: number })._schema ?? 1;
    if (stamped < SETTINGS_SCHEMA_VERSION) {
      s.speak_replies = false;
      (s as unknown as { _schema?: number })._schema = SETTINGS_SCHEMA_VERSION;
      writeJSON(SETTINGS_KEY, s);
    }
    return s;
  },
  saveSettings(s: AppSettings) {
    writeJSON(SETTINGS_KEY, s);
  },
  clearAll() {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  },
};
