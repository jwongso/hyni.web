// React integration for the STT abstraction.
//
// `useSpeechRecognizer(engine, handlers)` owns one SpeechRecognizer at a
// time. Swapping `engine` mid-session disposes the current recognizer and
// transparently restarts the new one if it was capturing — so a UI engine
// picker behaves like a hot swap.
//
// State updates are batched into React state so consumers can render
// statusMessage / error / running without polling the recognizer.

import { useEffect, useRef, useState, useCallback } from 'react';
import type {
  RecognizerHandlers,
  RecognizerState,
  SpeechRecognizer,
  SttEngineId,
} from './types';
import { createRecognizer } from './registry';

export interface UseSpeechRecognizerResult {
  /** Engine currently bound. */
  engine: SttEngineId;
  /** Single-source-of-truth state machine value. */
  state: RecognizerState;
  /** Latest human-readable status (for the toolbar pill / settings). */
  statusMessage: string;
  /** Last unrecoverable error, or empty string. */
  error: string;
  /** True while audio is being captured. */
  isRunning: boolean;
  /** Begin capture. Idempotent. */
  start(): Promise<void>;
  /** Stop capture. Idempotent. */
  stop():  Promise<void>;
}

export function useSpeechRecognizer(
  engine: SttEngineId,
  userHandlers: RecognizerHandlers,
): UseSpeechRecognizerResult {
  const [state,         setState]         = useState<RecognizerState>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [error,         setError]         = useState<string>('');
  const [isRunning,     setIsRunning]     = useState<boolean>(false);

  // Latest handlers ref so we don't recreate the recognizer when the caller
  // re-binds callbacks every render.
  const handlersRef = useRef<RecognizerHandlers>(userHandlers);
  handlersRef.current = userHandlers;

  const recRef = useRef<SpeechRecognizer | null>(null);

  // Build / swap the recognizer whenever `engine` changes.
  useEffect(() => {
    const wasRunning = recRef.current?.isRunning() ?? false;
    if (recRef.current) {
      try { recRef.current.dispose(); } catch { /* ignore */ }
      recRef.current = null;
    }

    let cancelled = false;
    let r: SpeechRecognizer;
    try {
      r = createRecognizer(engine);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setState('error');
      setIsRunning(false);
      return;
    }

    r.setHandlers({
      onResult: (text, isFinal) => handlersRef.current.onResult?.(text, isFinal),
      onError:  (msg) => {
        if (cancelled) return;
        setError(msg);
        setState('error');
        setIsRunning(false);
        handlersRef.current.onError?.(msg);
      },
      onStatus: (st, msg) => {
        if (cancelled) return;
        setState(st);
        if (msg !== undefined) setStatusMessage(msg);
        setIsRunning(st === 'listening');
        if (st !== 'error') setError('');
        handlersRef.current.onStatus?.(st, msg);
      },
    });

    recRef.current = r;
    setError('');
    setState('idle');
    setIsRunning(false);

    // Transparent hot-swap: if the previous engine was capturing, kick off
    // capture on the new one without requiring the user to click Start.
    if (wasRunning) {
      r.start().catch((e: any) => {
        if (cancelled) return;
        setError(e?.message ?? String(e));
        setState('error');
      });
    }

    return () => {
      cancelled = true;
      try { r.dispose(); } catch { /* ignore */ }
    };
  }, [engine]);

  const start = useCallback(async () => {
    setError('');
    const r = recRef.current;
    if (!r) return;
    try { await r.start(); }
    catch (e: any) {
      setError(e?.message ?? String(e));
      setState('error');
    }
  }, []);

  const stop = useCallback(async () => {
    const r = recRef.current;
    if (!r) return;
    try { await r.stop(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
  }, []);

  return { engine, state, statusMessage, error, isRunning, start, stop };
}
