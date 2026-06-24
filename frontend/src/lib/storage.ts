import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  type AppSettings,
  type UserProfile,
} from './types';

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

export const storage = {
  loadProfile(): UserProfile {
    return readJSON<UserProfile>(PROFILE_KEY, EMPTY_PROFILE);
  },
  saveProfile(p: UserProfile) {
    writeJSON(PROFILE_KEY, p);
  },
  loadSettings(): AppSettings {
    return readJSON<AppSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  },
  saveSettings(s: AppSettings) {
    writeJSON(SETTINGS_KEY, s);
  },
  clearAll() {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  },
};
