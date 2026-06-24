// Web Speech API adapter.
//
// Free, zero-setup, no API key. Works in Chrome / Edge / Safari. Firefox does
// not support SpeechRecognition.
//
// We use continuous + interim-results mode and accumulate the final segments
// in the buffer the chat page maintains. We auto-restart on browser-imposed
// silence stops so the recognizer behaves as a true streaming source.

import type { SpeechRecognizer, SttEngineId } from './types';

// The standard / vendor-prefixed constructor.
const SpeechRecognitionImpl: any =
  (typeof window !== 'undefined' &&
    ((window as any).SpeechRecognition ||
     (window as any).webkitSpeechRecognition)) ||
  null;

export function isWebSpeechAvailable(): boolean {
  return !!SpeechRecognitionImpl;
}

export class WebSpeechAdapter implements SpeechRecognizer {
  readonly id: SttEngineId = 'webspeech';
  onResult: SpeechRecognizer['onResult'] = null;
  onError:  SpeechRecognizer['onError']  = null;
  onStatus: SpeechRecognizer['onStatus'] = null;

  private rec: any = null;
  private want_running = false;
  private running = false;

  async init(): Promise<void> {
    if (!isWebSpeechAvailable()) {
      throw new Error('Web Speech API is not available in this browser.');
    }
    if (this.rec) return;
    const rec = new SpeechRecognitionImpl();
    rec.continuous       = true;
    rec.interimResults   = true;
    rec.lang             = navigator.language || 'en-US';

    rec.onresult = (event: any) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = r[0]?.transcript ?? '';
        if (r.isFinal) finalText += t;
        else           interimText += t;
      }
      if (finalText && this.onResult) this.onResult(finalText, true);
      if (interimText && this.onResult) this.onResult(interimText, false);
    };

    rec.onerror = (event: any) => {
      const msg = event.error || 'unknown error';
      // 'no-speech' fires constantly when the user is quiet — ignore.
      if (msg === 'no-speech' || msg === 'aborted') return;
      this.onError?.(`Web Speech error: ${msg}`);
    };

    rec.onend = () => {
      this.running = false;
      // Browsers auto-stop after silence. Restart to keep streaming.
      if (this.want_running) {
        try { rec.start(); this.running = true; }
        catch (e: any) { this.onError?.(`restart failed: ${e?.message ?? e}`); }
      } else {
        this.onStatus?.('stopped');
      }
    };

    rec.onstart = () => {
      this.running = true;
      this.onStatus?.('listening');
    };

    this.rec = rec;
  }

  async start(): Promise<void> {
    await this.init();
    this.want_running = true;
    if (!this.running) {
      try { this.rec.start(); }
      catch (e: any) {
        // 'InvalidStateError' if already started — safe to ignore.
        if (!(e?.name === 'InvalidStateError')) throw e;
      }
    }
  }

  async stop(): Promise<void> {
    this.want_running = false;
    if (this.rec && this.running) {
      try { this.rec.stop(); } catch { /* ignore */ }
    }
  }

  dispose(): void {
    this.want_running = false;
    if (this.rec) {
      try { this.rec.abort(); } catch { /* ignore */ }
      this.rec = null;
    }
  }

  isRunning(): boolean { return this.running; }
}
