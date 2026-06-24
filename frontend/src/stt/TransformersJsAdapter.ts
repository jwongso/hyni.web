// transformers.js Whisper adapter — placeholder shell.
//
// Once @huggingface/transformers is added to package.json, this adapter will:
//   1. Lazy-import pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en')
//   2. Capture mic via getUserMedia + MediaRecorder (chunked) OR AudioWorklet
//   3. Decode chunks and call onResult for each transcript
//
// Kept as a stub so the engine selector can list it from day one. Switching
// to a real adapter is a drop-in replacement.

import type { SpeechRecognizer, SttEngineId } from './types';

export function isTransformersJsAvailable(): boolean {
  return typeof window !== 'undefined';
}

export class TransformersJsAdapter implements SpeechRecognizer {
  readonly id: SttEngineId = 'transformersjs';
  onResult: SpeechRecognizer['onResult'] = null;
  onError:  SpeechRecognizer['onError']  = null;
  onStatus: SpeechRecognizer['onStatus'] = null;
  private running = false;

  async init(): Promise<void> {
    this.onStatus?.('transformers.js not yet integrated');
    throw new Error(
      'transformers.js Whisper adapter not yet integrated. ' +
      'Add @huggingface/transformers and complete the pipeline wiring.');
  }
  async start(): Promise<void> { await this.init(); }
  async stop():  Promise<void> { this.running = false; }
  dispose(): void { this.running = false; }
  isRunning(): boolean { return this.running; }
}
