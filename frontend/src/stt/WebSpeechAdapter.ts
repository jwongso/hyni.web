// Web Speech API adapter — browser-native cloud STT.
//
// Chrome / Edge / Safari ship a SpeechRecognition implementation. On Chrome
// the audio is sent to Google's cloud recognizer. Firefox does NOT implement
// SpeechRecognition. We require a secure context (https:// or http://localhost)
// for the underlying getUserMedia call.
//
// Permission UX: instead of letting SpeechRecognition.start() silently
// trigger the permission dialog with an opaque "not-allowed" error, we
// pre-request the microphone via getUserMedia for a clear, actionable
// permission prompt + friendlier error mapping.

import type {
  RecognizerHandlers,
  RecognizerState,
  SpeechRecognizer,
  SttEngineId,
} from './types';
import { registerAdapter } from './registry';

// Vendor-prefixed constructor probe.
const SpeechRecognitionImpl: any =
  (typeof window !== 'undefined' &&
    ((window as any).SpeechRecognition ||
     (window as any).webkitSpeechRecognition)) ||
  null;

function isAvailable(): boolean {
  return !!SpeechRecognitionImpl;
}

async function ensureMicPermission(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Microphone API not available. Are you on a secure context ' +
      '(https:// or http://localhost)?');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
  } catch (e: any) {
    const name = e?.name ?? 'Error';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error(
        'Microphone permission was denied. Click the 🎙 icon in the address bar ' +
        'and allow microphone access for this site, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new Error('No microphone detected. Check your input device in system settings.');
    }
    if (name === 'NotReadableError') {
      throw new Error('Microphone is busy. Close other tabs / apps using the mic and retry.');
    }
    throw new Error(`Microphone access failed: ${name}${e?.message ? ' — ' + e.message : ''}`);
  }
}

function friendlyRecognitionError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied for this site.';
    case 'audio-capture':
      return 'No microphone detected.';
    case 'network':
      return 'Web Speech failed to reach its cloud recognizer (network error).';
    case 'language-not-supported':
      return 'Browser does not support speech recognition for the current language.';
    default:
      return `Web Speech error: ${code}`;
  }
}

class WebSpeechAdapter implements SpeechRecognizer {
  readonly id: SttEngineId = 'webspeech';
  private handlers: RecognizerHandlers = {};
  private rec: any = null;
  private permissionOk = false;
  private wantRunning = false;
  private running = false;

  setHandlers(h: RecognizerHandlers): void { this.handlers = h; }

  private emit(state: RecognizerState, msg?: string): void {
    this.handlers.onStatus?.(state, msg);
  }

  async init(): Promise<void> {
    if (!isAvailable()) {
      throw new Error('Web Speech API is not available in this browser. Try Chrome / Edge / Safari.');
    }
    if (!this.permissionOk) {
      this.emit('initializing', 'requesting microphone permission…');
      await ensureMicPermission();
      this.permissionOk = true;
    }
    if (this.rec) { this.emit('ready'); return; }

    const rec = new SpeechRecognitionImpl();
    rec.continuous     = true;
    rec.interimResults = true;
    rec.lang           = navigator.language || 'en-US';

    rec.onresult = (event: any) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = r[0]?.transcript ?? '';
        if (r.isFinal) finalText += t;
        else           interimText += t;
      }
      if (finalText)   this.handlers.onResult?.(finalText,   true);
      if (interimText) this.handlers.onResult?.(interimText, false);
    };

    rec.onerror = (event: any) => {
      const code = event.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.permissionOk = false;
        this.wantRunning = false;
      }
      this.handlers.onError?.(friendlyRecognitionError(code));
    };

    rec.onend = () => {
      this.running = false;
      if (this.wantRunning) {
        try { rec.start(); this.running = true; }
        catch (e: any) { this.handlers.onError?.('restart failed: ' + (e?.message ?? e)); }
      } else {
        this.emit('stopped');
      }
    };

    rec.onstart = () => {
      this.running = true;
      this.emit('listening', 'cloud (browser-native)');
    };

    this.rec = rec;
    this.emit('ready');
  }

  async start(): Promise<void> {
    await this.init();
    this.wantRunning = true;
    if (!this.running) {
      try { this.rec.start(); }
      catch (e: any) {
        if (e?.name !== 'InvalidStateError') throw e;
      }
    }
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    if (this.rec && this.running) {
      try { this.rec.stop(); } catch { /* ignore */ }
    }
  }

  dispose(): void {
    this.wantRunning = false;
    if (this.rec) {
      try { this.rec.abort(); } catch { /* ignore */ }
      this.rec = null;
    }
    this.running = false;
  }

  isRunning(): boolean { return this.running; }
}

registerAdapter({
  meta: {
    id: 'webspeech',
    label: 'Web Speech (browser cloud)',
    description:
      'Browser-native SpeechRecognition. Zero setup, instant streaming. ' +
      'Audio leaves your machine — Chrome routes it to Google. ' +
      'Chrome / Edge / Safari only; Firefox is not supported.',
    capabilities: {
      interim: true,
      offline: false,
      cloud:   true,
      needsModelDownload: false,
      modelSizeMb: 0,
    },
    isAvailable,
    unavailableReason: () => isAvailable() ? undefined :
      'Browser does not implement window.SpeechRecognition.',
  },
  create: () => new WebSpeechAdapter(),
});
