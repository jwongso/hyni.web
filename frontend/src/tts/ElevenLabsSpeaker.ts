// ElevenLabs TTS — placeholder shell.
//
// Best-in-class voice quality, low latency streaming via WebSocket or HTTP
// chunked. Requires an API key (paid service). For privacy you typically
// proxy through your backend; that endpoint is not implemented yet.
//
// To finish:
//   1. Add an ElevenLabsController in the Drogon backend that proxies
//      POST /api/tts/elevenlabs/{voice_id} -> ElevenLabs streaming endpoint
//      (keeping the ELEVENLABS_API_KEY server-side).
//   2. In init(): GET /api/config to learn whether the server has the key.
//   3. In speak(text): fetch('/api/tts/elevenlabs/...', body) -> consume
//      response.body as audio chunks -> MediaSource / WebAudio playback.
//   4. listVoices() pulls the list from /api/tts/elevenlabs/voices.
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

class ElevenLabsSpeaker implements Speaker {
  readonly id: TtsEngineId = 'elevenlabs';
  private handlers: SpeakerHandlers = {};
  setHandlers(h: SpeakerHandlers): void { this.handlers = h; }
  async init(): Promise<void> {
    this.handlers.onStatus?.('error', 'ElevenLabs adapter not yet integrated');
    throw new Error('ElevenLabs adapter not yet integrated. Add the Drogon TTS proxy + finish ElevenLabsSpeaker.ts.');
  }
  async listVoices(): Promise<Voice[]> { return []; }
  async speak(): Promise<void> { await this.init(); }
  cancel(): void {}
  dispose(): void {}
  isSpeaking(): boolean { return false; }
}

registerSpeaker({
  meta: {
    id: 'elevenlabs',
    label: 'ElevenLabs (cloud, best quality)',
    description:
      'ElevenLabs streaming TTS — best-in-class realism and prosody. ' +
      'Requires an API key (set ELEVENLABS_API_KEY on the backend); audio ' +
      'is generated in the cloud. (Stub: backend proxy + streaming consumer ' +
      'still pending.)',
    capabilities: {
      offline: false,
      cloud:   true,
      needsApiKey: true,
      needsModelDownload: false,
      modelSizeMb: 0,
      streaming: true,
      voiceQuality: 'excellent',
    },
    isAvailable,
    unavailableReason: () => 'Integration not yet implemented.',
  },
  create: () => new ElevenLabsSpeaker(),
});
