// Central TTS adapter registry. Mirrors stt/registry.ts.

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
  bootstrap();
  return Array.from(registry.values())
    .map((r) => r.meta)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getSpeakerReg(id: TtsEngineId): SpeakerRegistration {
  bootstrap();
  const reg = registry.get(id);
  if (!reg) throw new Error(`Unknown TTS engine: ${id}`);
  return reg;
}

export function createSpeaker(id: TtsEngineId): Speaker {
  return getSpeakerReg(id).create();
}

let booted = false;
function bootstrap(): void {
  if (booted) return;
  booted = true;
  void import('./WebSpeechSpeaker');
  void import('./PiperSpeaker');
  void import('./ElevenLabsSpeaker');
}
