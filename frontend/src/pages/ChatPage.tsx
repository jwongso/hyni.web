import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatMessages } from '../components/ChatMessages';
import { ImageDropZone } from '../components/ImageDropZone';
import { ModeToggle } from '../components/ModeToggle';
import { postChat, postChatStream } from '../lib/api';
import { storage } from '../lib/storage';
import type {
  AppSettings,
  ChatMessage,
  ImageData,
  Mode,
  ServerConfig,
} from '../lib/types';
import { fetchConfig } from '../lib/api';
import { createRecognizer } from '../stt';
import type { SpeechRecognizer } from '../stt/types';
import { cancelSpeech, speak } from '../tts/webspeech';

// The main interview-practice page.
//
// Lifecycle:
//   - Mounting loads the user's profile + settings from localStorage and the
//     server config (which provider keys are configured) from /api/config.
//   - "Start listening" instantiates the chosen STT adapter. Partial
//     transcripts replace the working buffer; final ones append.
//   - Pressing `s` (when no input/textarea has focus) flushes the buffer:
//     it becomes a new user message in `history`, the request goes to
//     /api/chat, and the assistant's reply is appended + spoken via TTS.
//   - Drag-dropped images attach to the NEXT send and are cleared on send.
//
// History is fully owned by this component. It is NOT persisted across
// reloads — interview practice sessions are ephemeral by design. (Trivial to
// add localStorage if you ever want it.)
export function ChatPage() {
  const [mode, setMode]               = useState<Mode>('general');
  const [history, setHistory]         = useState<ChatMessage[]>([]);
  const [buffer, setBuffer]           = useState('');
  const [interim, setInterim]         = useState('');
  const [pendingImgs, setImgs]        = useState<ImageData[]>([]);
  const [sending, setSending]         = useState(false);
  const [streamingText, setStreaming] = useState('');         // assistant text as it arrives
  const [status, setStatus]           = useState<string>('idle');
  const [error, setError]             = useState<string>('');
  const [settings, setSettings]       = useState<AppSettings>(() => storage.loadSettings());
  const [profile]                     = useState(() => storage.loadProfile());
  const [config, setConfig]           = useState<ServerConfig | null>(null);

  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const messagesRef   = useRef<HTMLDivElement>(null);
  const abortRef      = useRef<AbortController | null>(null);

  // Load server config once.
  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(e => setError(`Could not load /api/config: ${e}`));
  }, []);

  // Always reload settings on focus — the Settings page may have changed
  // them in another tab / route.
  useEffect(() => {
    const onFocus = () => setSettings(storage.loadSettings());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Auto-scroll chat to bottom on new messages or streaming updates.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, sending, streamingText]);

  // Tear down the recognizer when the engine selection changes.
  useEffect(() => {
    return () => {
      recognizerRef.current?.dispose();
      recognizerRef.current = null;
    };
  }, [settings.stt_engine]);

  const startListening = useCallback(async () => {
    setError('');
    let r = recognizerRef.current;
    if (!r) {
      r = createRecognizer(settings.stt_engine);
      r.onResult = (text, isFinal) => {
        if (isFinal) {
          setBuffer(prev => (prev ? prev + ' ' : '') + text.trim());
          setInterim('');
        } else {
          setInterim(text);
        }
      };
      r.onError  = (m) => setError(m);
      r.onStatus = (s) => setStatus(s);
      recognizerRef.current = r;
    }
    try { await r.start(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
  }, [settings.stt_engine]);

  const stopListening = useCallback(async () => {
    const r = recognizerRef.current;
    if (r) await r.stop();
    setInterim('');
  }, []);

  const send = useCallback(async () => {
    const text = buffer.trim();
    if (!text && pendingImgs.length === 0) return;
    if (sending) return;

    setSending(true);
    setError('');
    setBuffer('');
    setInterim('');
    setStreaming('');

    const userMsg: ChatMessage = { role: 'user', text, images: pendingImgs };
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    setImgs([]);

    const requestBody = {
      provider:    settings.provider,
      model:       settings.model,
      mode,
      profile,
      history,
      message:     text,
      images:      pendingImgs,
      temperature: settings.temperature,
      max_tokens:  settings.max_tokens,
    };

    // Rollback closure shared across both code paths.
    const rollback = (reason: string) => {
      setError(reason);
      setHistory(history);
      setBuffer(text);
      setImgs(pendingImgs);
    };

    if (settings.stream_replies) {
      // Streaming path: render tokens as they arrive, speak full text on done.
      const ac = new AbortController();
      abortRef.current = ac;
      let assembled = '';

      await postChatStream(requestBody, {
        signal: ac.signal,
        onDelta: (chunk) => {
          assembled += chunk;
          setStreaming(assembled);
        },
        onDone: (final) => {
          if (!final.success) {
            rollback(final.error || `LLM error (HTTP ${final.http_status})`);
          } else {
            const asst: ChatMessage = { role: 'assistant', text: assembled };
            setHistory([...nextHistory, asst]);
            if (settings.speak_replies) {
              speak({
                text: assembled,
                voiceURI: settings.tts_voice_uri,
                rate:  settings.tts_rate,
                pitch: settings.tts_pitch,
              });
            }
          }
          setStreaming('');
          setSending(false);
          abortRef.current = null;
        },
        onError: (msg) => {
          rollback(msg);
          setStreaming('');
          setSending(false);
          abortRef.current = null;
        },
      });
      return;
    }

    // Blocking path (fallback for benchmarking / engines that don't stream).
    try {
      const reply = await postChat(requestBody);
      if (!reply.success) {
        rollback(reply.error || `LLM error (HTTP ${reply.http_status})`);
      } else {
        const asst: ChatMessage = { role: 'assistant', text: reply.content };
        setHistory([...nextHistory, asst]);
        if (settings.speak_replies) {
          speak({
            text: reply.content,
            voiceURI: settings.tts_voice_uri,
            rate:  settings.tts_rate,
            pitch: settings.tts_pitch,
          });
        }
      }
    } catch (e: any) {
      rollback(e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }, [buffer, pendingImgs, sending, history, settings, profile, mode]);

  const cancelInflight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming('');
    setSending(false);
  }, []);

  // Global `s` hotkey -> send. Suppressed while typing in inputs/textareas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 's' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase() ?? '';
      if (tag === 'input' || tag === 'textarea' || (t && (t as any).isContentEditable)) return;
      e.preventDefault();
      void send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send]);

  // Cleanly cancel pending TTS when navigating away from the page.
  useEffect(() => () => cancelSpeech(), []);

  const provider = config?.providers.find(p => p.id === settings.provider);
  const hasKey   = provider?.has_key ?? false;
  const isListening = recognizerRef.current?.isRunning() ?? false;
  const displayedBuffer = useMemo(() => {
    if (interim) return buffer ? `${buffer} ${interim}` : interim;
    return buffer;
  }, [buffer, interim]);

  return (
    <div className="chat">
      <div className="toolbar">
        <ModeToggle value={mode} onChange={setMode} disabled={sending} />
        <span className="status-pill">STT: {settings.stt_engine}</span>
        <span className={'status-pill ' + (status === 'listening' ? 'ok' : '')}>{status}</span>
        <span className={'status-pill ' + (hasKey ? 'ok' : 'warn')}>
          {settings.provider}: {hasKey ? 'ready' : 'no key'}
        </span>
        <span style={{ flex: 1 }} />
        {isListening
          ? <button className="secondary" onClick={stopListening}>⏹ Stop listening</button>
          : <button onClick={startListening}>🎙 Start listening</button>}
        <button className="secondary" onClick={() => { setHistory([]); cancelSpeech(); }}>Clear</button>
      </div>

      <div className="chat__messages" ref={messagesRef}>
        <ChatMessages
          messages={history}
          streamingText={streamingText}
          pendingAssistant={sending}
        />
        {error && <div className="chat__msg system" style={{ color: 'var(--error)' }}>⚠ {error}</div>}
      </div>

      <div className="chat__input">
        <textarea
          placeholder="Live transcript appears here. Edit if needed, then press 's' (outside this box) to send."
          value={displayedBuffer}
          onChange={(e) => { setBuffer(e.target.value); setInterim(''); }}
        />
        <ImageDropZone pending={pendingImgs} setPending={setImgs} />
        <div className="input-row">
          <span className="hint">
            Press <kbd>s</kbd> to send (works while not typing).
            {settings.stream_replies ? ' Replies stream in real time.' : ' Replies wait for completion.'}
            {!hasKey && ' Configure an API key on the backend (env var) to receive answers.'}
          </span>
          {sending && abortRef.current && (
            <button className="danger" onClick={cancelInflight}>Stop</button>
          )}
          <button onClick={() => void send()} disabled={sending || (!buffer.trim() && pendingImgs.length === 0)}>
            {sending ? 'Sending…' : 'Send (s)'}
          </button>
        </div>
      </div>
    </div>
  );
}
