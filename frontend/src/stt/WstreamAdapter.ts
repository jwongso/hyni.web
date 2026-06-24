// wstream WASM adapter — placeholder shell.
//
// The full integration loads whisper.cpp + Silero VAD from /wstream/ (assets
// served by the Drogon backend, copied from ~/proj/priv/wstream/stream2.wasm/
// during deployment). For now we expose a non-functional stub so the UI can
// reference the adapter and the Benchmark page can show it as "coming soon".
//
// TODO: integrate libstream.js + worklets. Pattern:
//   1. dynamic import('/wstream/libstream.js') -> Module factory
//   2. await Module(); init AudioContext + worklet
//   3. wire VAD callback -> Whisper.cpp transcribe() -> onResult
// See stream2.wasm/index.html in the upstream repo for the reference wiring.

import type { SpeechRecognizer, SttEngineId } from './types';

export function isWstreamAvailable(): boolean {
  // The asset is present iff /wstream/libstream.js loads. We do not eagerly
  // probe the network here; settings will surface "needs assets" if a load
  // fails.
  return typeof window !== 'undefined';
}

export class WstreamAdapter implements SpeechRecognizer {
  readonly id: SttEngineId = 'wstream';
  onResult: SpeechRecognizer['onResult'] = null;
  onError:  SpeechRecognizer['onError']  = null;
  onStatus: SpeechRecognizer['onStatus'] = null;
  private running = false;

  async init(): Promise<void> {
    this.onStatus?.('wstream not yet integrated — see stt/WstreamAdapter.ts');
    throw new Error(
      'wstream WASM adapter not yet integrated. Copy stream2.wasm assets ' +
      'into public/wstream/ and finish the libstream wiring.');
  }
  async start(): Promise<void> { await this.init(); }
  async stop():  Promise<void> { this.running = false; }
  dispose(): void { this.running = false; }
  isRunning(): boolean { return this.running; }
}
