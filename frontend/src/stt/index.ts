import type { RecognizerInfo, SpeechRecognizer, SttEngineId } from './types';
import { WebSpeechAdapter, isWebSpeechAvailable } from './WebSpeechAdapter';
import { WstreamAdapter, isWstreamAvailable } from './WstreamAdapter';
import { TransformersJsAdapter, isTransformersJsAvailable } from './TransformersJsAdapter';

export function listRecognizers(): RecognizerInfo[] {
  return [
    {
      id: 'webspeech',
      label: 'Web Speech API (browser native)',
      available: isWebSpeechAvailable(),
      description:
        'Zero setup, real-time. Chrome / Edge / Safari only. Chrome routes ' +
        'audio through Google servers.',
    },
    {
      id: 'wstream',
      label: 'wstream — whisper.cpp WASM',
      available: isWstreamAvailable(),
      description:
        'Local Whisper.cpp + Silero VAD running entirely in your browser. ' +
        'Private, offline. (Integration pending.)',
    },
    {
      id: 'transformersjs',
      label: 'transformers.js — Whisper ONNX',
      available: isTransformersJsAvailable(),
      description:
        'Whisper via Hugging Face transformers.js. Cross-browser, in-browser ' +
        'model. (Integration pending.)',
    },
  ];
}

export function createRecognizer(id: SttEngineId): SpeechRecognizer {
  switch (id) {
    case 'webspeech':       return new WebSpeechAdapter();
    case 'wstream':         return new WstreamAdapter();
    case 'transformersjs':  return new TransformersJsAdapter();
  }
}

export type { SpeechRecognizer, RecognizerInfo, SttEngineId };
