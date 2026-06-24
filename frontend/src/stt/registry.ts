// Centralised STT adapter registry.
//
// Adapters self-register at module load (their import side-effects call
// registerAdapter). This file deliberately re-exports nothing about the
// concrete adapters — UI code interacts with the registry only, so adding
// a new STT engine is a single-file change.
//
// The `bootstrap()` call below ensures every shipped adapter is imported
// at least once so its side-effect registration runs even if no other
// module imports it directly.

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
  bootstrap();
  return Array.from(registry.values())
    .map((r) => r.meta)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getAdapter(id: SttEngineId): AdapterRegistration {
  bootstrap();
  const reg = registry.get(id);
  if (!reg) throw new Error(`Unknown STT engine: ${id}`);
  return reg;
}

export function createRecognizer(id: SttEngineId): SpeechRecognizer {
  return getAdapter(id).create();
}

// Force-import every shipped adapter so its registerAdapter() side effect
// runs. Tree-shakers respect import-for-side-effect when the file does
// nothing else exportable — adapter modules use a top-level registerAdapter
// call so the side effect is preserved.
let booted = false;
function bootstrap(): void {
  if (booted) return;
  booted = true;
  // Side-effect imports — order does not matter functionally.
  /* eslint-disable @typescript-eslint/no-require-imports */
  void import('./WebSpeechAdapter');
  void import('./WstreamAdapter');
  void import('./TransformersJsAdapter');
}
