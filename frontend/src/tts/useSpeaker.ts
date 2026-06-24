// React hook for the TTS layer. Owns one Speaker at a time; swapping engine
// disposes the previous one cleanly. Voice list and runtime state are
// reflected as React state for declarative consumption.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Speaker,
  SpeakerHandlers,
  SpeakerState,
  SpeakOptions,
  TtsEngineId,
  Voice,
} from './types';
import { createSpeaker } from './registry';

export interface UseSpeakerResult {
  engine: TtsEngineId;
  state: SpeakerState;
  statusMessage: string;
  error: string;
  voices: Voice[];
  isSpeaking: boolean;
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  cancel(): void;
}

export function useSpeaker(engine: TtsEngineId): UseSpeakerResult {
  const [state, setState]                 = useState<SpeakerState>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [error, setError]                 = useState<string>('');
  const [voices, setVoices]               = useState<Voice[]>([]);
  const [isSpeaking, setIsSpeaking]       = useState<boolean>(false);

  const speakerRef = useRef<Speaker | null>(null);

  useEffect(() => {
    if (speakerRef.current) {
      try { speakerRef.current.dispose(); } catch { /* ignore */ }
      speakerRef.current = null;
    }

    let cancelled = false;
    let s: Speaker;
    try {
      s = createSpeaker(engine);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setState('error');
      setVoices([]);
      setIsSpeaking(false);
      return;
    }

    const handlers: SpeakerHandlers = {
      onStatus: (st, msg) => {
        if (cancelled) return;
        setState(st);
        if (msg !== undefined) setStatusMessage(msg);
        if (st !== 'error') setError('');
        if (st !== 'speaking') setIsSpeaking(false);
      },
      onError: (msg) => {
        if (cancelled) return;
        setError(msg);
        setState('error');
        setIsSpeaking(false);
      },
      onSpeakStart: () => { if (!cancelled) setIsSpeaking(true);  },
      onSpeakEnd:   () => { if (!cancelled) setIsSpeaking(false); },
    };
    s.setHandlers(handlers);
    speakerRef.current = s;
    setError('');
    setState('idle');
    setVoices([]);
    setIsSpeaking(false);

    // Eagerly init so the voice list is available for the picker without
    // requiring the user to click Speak first.
    s.init().then(async () => {
      if (cancelled) return;
      try {
        const v = await s.listVoices();
        if (!cancelled) setVoices(v);
      } catch { /* leave voices empty */ }
    }).catch((e: any) => {
      if (cancelled) return;
      setError(e?.message ?? String(e));
      setState('error');
    });

    return () => {
      cancelled = true;
      try { s.dispose(); } catch { /* ignore */ }
    };
  }, [engine]);

  const speak = useCallback(async (text: string, opts?: SpeakOptions) => {
    const s = speakerRef.current;
    if (!s) return;
    try { await s.speak(text, opts); }
    catch (e: any) { setError(e?.message ?? String(e)); setState('error'); }
  }, []);

  const cancel = useCallback(() => {
    speakerRef.current?.cancel();
  }, []);

  return { engine, state, statusMessage, error, voices, isSpeaking, speak, cancel };
}
