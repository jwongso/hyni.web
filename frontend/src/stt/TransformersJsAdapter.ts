// transformers.js Whisper adapter — placeholder shell.
//
// To finish: `npm i @huggingface/transformers`, then in init():
//   const { pipeline } = await import('@huggingface/transformers');
//   this.asr = await pipeline('automatic-speech-recognition',
//                             'Xenova/whisper-base.en');
// In start(): capture mic via MediaRecorder, decode to Float32@16kHz,
// chunk every ~2s with overlap, feed to this.asr, emit final transcripts.
//
// The skeleton is here so the engine picker can list it from day one;
// flipping the integration into life is a focused 1-file task.

import type {
  RecognizerHandlers,
  SpeechRecognizer,
  SttEngineId,
} from './types';
import { registerAdapter } from './registry';

function isAvailable(): boolean {
  return false;  // flip to true once integration lands
}

class TransformersJsAdapter implements SpeechRecognizer {
  readonly id: SttEngineId = 'transformersjs';
  private handlers: RecognizerHandlers = {};
  private running = false;

  setHandlers(h: RecognizerHandlers): void { this.handlers = h; }

  async init(): Promise<void> {
    this.handlers.onStatus?.('error', 'transformers.js adapter not yet integrated');
    throw new Error(
      'transformers.js Whisper adapter not yet integrated. ' +
      'Add @huggingface/transformers and complete TransformersJsAdapter.ts.');
  }
  async start(): Promise<void> { await this.init(); }
  async stop():  Promise<void> { this.running = false; }
  dispose():     void          { this.running = false; }
  isRunning():   boolean       { return this.running; }
}

registerAdapter({
  meta: {
    id: 'transformersjs',
    label: 'transformers.js Whisper (ONNX)',
    description:
      'Whisper via Hugging Face transformers.js / ONNX Runtime — cross-browser, ' +
      'in-browser, private. (Stub: package + pipeline wiring still pending.)',
    capabilities: {
      interim: false,
      offline: true,
      cloud:   false,
      needsModelDownload: true,
      modelSizeMb: 75,
    },
    isAvailable,
    unavailableReason: () => 'Integration not yet implemented.',
  },
  create: () => new TransformersJsAdapter(),
});
