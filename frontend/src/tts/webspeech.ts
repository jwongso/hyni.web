// Web Speech API TTS wrapper.
//
// speechSynthesis is universally supported but voices load asynchronously
// in Chrome. We provide:
//   - listVoices(): currently-known voices (may be empty before first event).
//   - onVoicesReady(cb): fires when the voice list becomes non-empty.
//   - speak(opts): cancels prior utterances, speaks the text with the
//                  selected voice / rate / pitch.

export interface SpeakOptions {
  text: string;
  voiceURI?: string;       // SpeechSynthesisVoice.voiceURI; empty = default
  rate?: number;           // 0.1 .. 10, default 1
  pitch?: number;          // 0 .. 2, default 1
  lang?: string;           // BCP-47
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices();
}

export function onVoicesReady(cb: (voices: SpeechSynthesisVoice[]) => void): () => void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return () => {};
  const handler = () => {
    const v = window.speechSynthesis.getVoices();
    if (v.length > 0) cb(v);
  };
  // Fire immediately if already loaded.
  if (window.speechSynthesis.getVoices().length > 0) handler();
  window.speechSynthesis.addEventListener('voiceschanged', handler);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', handler);
}

export function isSpeakable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speak(opts: SpeakOptions): void {
  if (!isSpeakable() || !opts.text.trim()) return;
  const synth = window.speechSynthesis;
  synth.cancel(); // single-utterance policy: replace anything currently speaking
  const u = new SpeechSynthesisUtterance(opts.text);
  if (opts.rate  != null) u.rate  = opts.rate;
  if (opts.pitch != null) u.pitch = opts.pitch;
  if (opts.lang)          u.lang  = opts.lang;
  if (opts.voiceURI) {
    const v = synth.getVoices().find(v => v.voiceURI === opts.voiceURI);
    if (v) u.voice = v;
  }
  synth.speak(u);
}

export function cancelSpeech() {
  if (isSpeakable()) window.speechSynthesis.cancel();
}
