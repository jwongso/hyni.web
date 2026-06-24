// Piper TTS WASM — placeholder shell.
//
// Piper produces very natural prosody from compact ONNX voice models. To
// finish: pick one of
//   - https://github.com/mintplex-labs/piper-tts-web
//   - https://github.com/wide-video/piper-wasm
// then in init():
//   - import the runtime
//   - download + cache a voice model (e.g. en_US-amy-medium ~70 MB)
//   - keep the synthesizer instance for speak()
// In speak(text):
//   - synthesizer.synthesize(text) -> Float32Array @ 22050 Hz
//   - feed to a WebAudio AudioBufferSourceNode
//   - emit onSpeakStart / onSpeakEnd around playback
//
// Stub is registered so the engine picker can list it from day one.

import type {
  Speaker,
  SpeakerHandlers,
  TtsEngineId,
  Voice,
} from './types';
import { registerSpeaker } from './registry';

function isAvailable(): boolean { return false; }

class PiperSpeaker implements Speaker {
  readonly id: TtsEngineId = 'piper';
  private handlers: SpeakerHandlers = {};
  setHandlers(h: SpeakerHandlers): void { this.handlers = h; }
  async init(): Promise<void> {
    this.handlers.onStatus?.('error', 'Piper adapter not yet integrated');
    throw new Error('Piper WASM adapter not yet integrated. Add piper-tts-web and finish PiperSpeaker.ts.');
  }
  async listVoices(): Promise<Voice[]> { return []; }
  async speak(): Promise<void> { await this.init(); }
  cancel(): void {}
  dispose(): void {}
  isSpeaking(): boolean { return false; }
}

registerSpeaker({
  meta: {
    id: 'piper',
    label: 'Piper (local, fast, high quality)',
    description:
      'Neural TTS running entirely in your browser via ONNX. Voice models ' +
      'are ~50-80 MB, cached after first download. Fast (faster than realtime) ' +
      'and far more natural than the system TTS. (Stub: voice model + runtime ' +
      'wiring still pending.)',
    capabilities: {
      offline: true,
      cloud:   false,
      needsApiKey: false,
      needsModelDownload: true,
      modelSizeMb: 70,
      streaming: true,
      voiceQuality: 'excellent',
    },
    isAvailable,
    unavailableReason: () => 'Integration not yet implemented.',
  },
  create: () => new PiperSpeaker(),
});
