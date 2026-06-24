// Centralised STT adapter registry.
//
// Adapters self-register at module load via `registerAdapter()`. The list
// of shipped adapters is materialised by `src/stt/init.ts`, which is
// imported once at app startup from `main.tsx` — that guarantees every
// adapter module has executed (and registered) before any consumer calls
// `listAdapters()` / `createRecognizer()`. Keep init.ts in sync when
// adding a new engine.

import type {
  AdapterRegistration,
  RecognizerMeta,
  SpeechRecognizer,
  SttEngineId,
} from './types';

const registry = new Map<SttEngineId, AdapterRegistration>();

export function registerAdapter(reg: AdapterRegistration): void {
  if (registry.has(reg.meta.id)) {
    // Hot-module-reload in dev can re-execute side effects; tolerate it.
    console.debug('[stt] re-registering adapter', reg.meta.id);
  }
  registry.set(reg.meta.id, reg);
}

export function listAdapters(): RecognizerMeta[] {
  return Array.from(registry.values())
    .map((r) => r.meta)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getAdapter(id: SttEngineId): AdapterRegistration {
  const reg = registry.get(id);
  if (!reg) throw new Error(`Unknown STT engine: ${id}`);
  return reg;
}

export function createRecognizer(id: SttEngineId): SpeechRecognizer {
  return getAdapter(id).create();
}
