// Web Speech API (SpeechSynthesis) — browser-native, the universal fallback.
//
// Pros: zero setup, no API key, available everywhere SpeechSynthesis is.
// Cons: voice quality varies wildly per OS (good on macOS/Win, often poor
// on Linux), and Chrome's higher-quality voices route audio through Google.
//
// Voice list quirk: on Chrome the voice list is populated *asynchronously*
// after a 'voiceschanged' event. We wait for it (with a timeout) in
// listVoices() so the picker is never empty on first render.

import type {
  Speaker,
  SpeakerHandlers,
  SpeakerState,
  SpeakOptions,
  TtsEngineId,
  Voice,
} from './types';
import { registerSpeaker } from './registry';

function isAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

async function waitForVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!isAvailable()) return [];
  const synth = window.speechSynthesis;
  const first = synth.getVoices();
  if (first.length > 0) return first;
  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener('voiceschanged', onChanged);
      resolve(synth.getVoices());
    };
    const onChanged = () => finish();
    synth.addEventListener('voiceschanged', onChanged);
    setTimeout(finish, timeoutMs);
  });
}

class WebSpeechSpeaker implements Speaker {
  readonly id: TtsEngineId = 'webspeech';
  private handlers: SpeakerHandlers = {};
  private speaking = false;
  private inited = false;

  setHandlers(h: SpeakerHandlers): void { this.handlers = h; }

  private emit(state: SpeakerState, msg?: string): void {
    this.handlers.onStatus?.(state, msg);
  }

  async init(): Promise<void> {
    if (this.inited) { this.emit('ready'); return; }
    if (!isAvailable()) {
      throw new Error('window.speechSynthesis is not available in this browser.');
    }
    this.emit('initializing', 'loading voices…');
    await waitForVoices();
    this.inited = true;
    this.emit('ready');
  }

  async listVoices(): Promise<Voice[]> {
    const raw = await waitForVoices();
    return raw.map((v) => ({
      id:       v.voiceURI,
      label:    `${v.name} — ${v.lang}${v.default ? ' [default]' : ''}`,
      language: v.lang,
      isDefault: v.default,
    }));
  }

  async speak(text: string, opts?: SpeakOptions): Promise<void> {
    await this.init();
    if (!text.trim()) return;
    const synth = window.speechSynthesis;
    synth.cancel();                              // single-utterance policy

    const u = new SpeechSynthesisUtterance(text);
    if (opts?.rate  != null) u.rate  = opts.rate;
    if (opts?.pitch != null) u.pitch = opts.pitch;
    if (opts?.lang)          u.lang  = opts.lang;
    if (opts?.voiceId) {
      const voices = synth.getVoices();
      const v = voices.find((x) => x.voiceURI === opts.voiceId);
      if (v) u.voice = v;
    }

    u.onstart = () => {
      this.speaking = true;
      this.emit('speaking');
      this.handlers.onSpeakStart?.();
    };
    u.onend = () => {
      this.speaking = false;
      this.emit('ready');
      this.handlers.onSpeakEnd?.();
    };
    u.onerror = (e: any) => {
      this.speaking = false;
      const code = e?.error || 'unknown';
      if (code === 'canceled' || code === 'interrupted') {
        this.handlers.onSpeakEnd?.();
        this.emit('ready');
        return;
      }
      this.handlers.onError?.(`Web Speech TTS error: ${code}`);
    };

    synth.speak(u);
  }

  cancel(): void {
    if (isAvailable()) window.speechSynthesis.cancel();
    this.speaking = false;
  }

  dispose(): void { this.cancel(); }
  isSpeaking(): boolean { return this.speaking; }
}

registerSpeaker({
  meta: {
    id: 'webspeech',
    label: 'Web Speech (browser fallback)',
    description:
      'Browser-native SpeechSynthesis. Universally available, no setup. ' +
      'Voice quality depends on the OS and browser — generally good on ' +
      'macOS / Windows / Chrome, often plain on Linux. Chrome\'s premium ' +
      'voices route audio through Google.',
    capabilities: {
      offline: true,            // local voices exist on most OSes
      cloud:   true,            // Chrome's premium voices route to Google
      needsApiKey: false,
      needsModelDownload: false,
      modelSizeMb: 0,
      streaming: false,
      voiceQuality: 'system',
    },
    isAvailable,
    unavailableReason: () => isAvailable() ? undefined
      : 'Browser does not implement window.speechSynthesis.',
  },
  create: () => new WebSpeechSpeaker(),
});
