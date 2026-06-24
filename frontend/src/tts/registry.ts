// Central TTS adapter registry. Mirrors stt/registry.ts.
//
// Speakers self-register via `registerSpeaker()` at module load. The list
// is materialised by `src/tts/init.ts`, which is imported once at app
// startup from `main.tsx` — that guarantees every speaker module has
// executed before any consumer calls `listSpeakers()` / `createSpeaker()`.

import type {
  Speaker,
  SpeakerMeta,
  SpeakerRegistration,
  TtsEngineId,
} from './types';

const registry = new Map<TtsEngineId, SpeakerRegistration>();

export function registerSpeaker(reg: SpeakerRegistration): void {
  registry.set(reg.meta.id, reg);
}

export function listSpeakers(): SpeakerMeta[] {
  return Array.from(registry.values())
    .map((r) => r.meta)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getSpeakerReg(id: TtsEngineId): SpeakerRegistration {
  const reg = registry.get(id);
  if (!reg) throw new Error(`Unknown TTS engine: ${id}`);
  return reg;
}

export function createSpeaker(id: TtsEngineId): Speaker {
  return getSpeakerReg(id).create();
}
