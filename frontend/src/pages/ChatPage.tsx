import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatMessages } from '../components/ChatMessages';
import { ImageDropZone } from '../components/ImageDropZone';
import { ModeToggle } from '../components/ModeToggle';
import { fetchConfig, postChat, postChatStream } from '../lib/api';
import { fileToBase64 } from '../lib/files';
import { storage } from '../lib/storage';
import type {
  AppSettings,
  ChatMessage,
  ServerConfig,
} from '../lib/types';
import { useChatStore } from '../state/ChatStore';
import { useSpeechRecognizer } from '../stt/useSpeechRecognizer';
import { useSpeaker } from '../tts/useSpeaker';

// The main interview-practice page.
//
// STT and TTS engines are configured in the Settings page (saved into
// localStorage). The chat page reads them on mount and re-binds via
// useSpeechRecognizer / useSpeaker hooks — both of which transparently
// dispose the prior engine when the selection changes, so flipping
// engines in Settings + revisiting Chat just works.
//
// Session UX:
//   - "🎙 Start listening" engages the chosen STT.
//   - Partial transcripts replace the working buffer; final ones append.
//   - Pressing `s` (when no input/textarea has focus) flushes the buffer:
//     it becomes a new user message, the request goes to /api/chat[/stream],
//     and the assistant's reply is rendered and (optionally) spoken via TTS.
//   - Drag-dropped images attach to the NEXT send and are cleared on send.
//
// History is fully owned by this component — ephemeral by design (interview
// practice sessions don't need persistence). Trivial to add localStorage if
// you ever want it.
export function ChatPage() {
  // Cross-navigation state lives in the ChatStore context. Per-render
  // transient state (sending flag, streaming text, errors, interim STT
  // partial transcripts, in-flight abort controller) stays local.
  const { mode, setMode, history, setHistory, buffer, setBuffer,
          pendingImgs, setPendingImgs } = useChatStore();

  const [interim, setInterim]         = useState('');
  const [sending, setSending]         = useState(false);
  const [streamingText, setStreaming] = useState('');
  const [error, setError]             = useState<string>('');
  const [settings, setSettings]       = useState<AppSettings>(() => storage.loadSettings());
  const [profile]                     = useState(() => storage.loadProfile());
  const [config, setConfig]           = useState<ServerConfig | null>(null);

  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);

  // --- STT --------------------------------------------------------------
  const stt = useSpeechRecognizer(settings.stt_engine, {
    onResult: (text, isFinal) => {
      if (isFinal) {
        setBuffer((prev) => (prev ? prev + ' ' : '') + text.trim());
        setInterim('');
      } else {
        setInterim(text);
      }
    },
    onError: (msg) => setError(msg),
  });

  // --- TTS --------------------------------------------------------------
  const tts = useSpeaker(settings.tts_engine);

  // Page-wide drag-and-drop: dropping image files anywhere on the chat
  // (textarea, message scroll area, toolbar, anywhere) attaches them as
  // pending images. This is what ChatGPT / Claude do — dropping on the
  // textarea by mistake otherwise inserts the file paths as plain text
  // which the LLM cannot see as images.
  const [pageDragOver, setPageDragOver] = useState(false);
  const dragCountRef = useRef(0);
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCountRef.current += 1;
      setPageDragOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // preventDefault on dragover is what enables drop on the target.
      e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // dragleave fires when crossing child boundaries; track depth so the
      // overlay only disappears when the cursor truly leaves the page.
      dragCountRef.current = Math.max(0, dragCountRef.current - 1);
      if (dragCountRef.current === 0) setPageDragOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCountRef.current = 0;
      setPageDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter(
        (f) => f.type.startsWith('image/'),
      );
      if (files.length === 0) return;
      const encoded = await Promise.all(files.map(fileToBase64));
      setPendingImgs((prev) => [...prev, ...encoded]);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover',  onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop',      onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover',  onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop',      onDrop);
    };
  }, [setPendingImgs]);

  // Load server config + reload settings on focus (so Settings-page edits
  // in another tab propagate without a manual refresh).
  useEffect(() => {
    fetchConfig().then(setConfig).catch((e) => setError(`Could not load /api/config: ${e}`));
    const onFocus = () => setSettings(storage.loadSettings());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Auto-scroll on chat / streaming updates.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, sending, streamingText]);

  // --- Send -------------------------------------------------------------
  const send = useCallback(async () => {
    const text = buffer.trim();
    if (!text && pendingImgs.length === 0) return;
    if (sending) return;

    setSending(true);
    setError('');
    setBuffer('');
    setInterim('');
    setStreaming('');

    const userMsg: ChatMessage = { role: 'user', text, images: pendingImgs, at: Date.now() };
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    setPendingImgs([]);

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
      // Per-provider local key (BYOK). When empty, backend falls back to
      // its own env var IF the request bearer matches HYNI_OWNER_TOKEN.
      api_key:     settings.api_keys[settings.provider] || undefined,
    };

    const rollback = (reason: string) => {
      setError(reason);
      setHistory(history);
      setBuffer(text);
      setPendingImgs(pendingImgs);
    };

    if (settings.stream_replies) {
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
            const asst: ChatMessage = { role: 'assistant', text: assembled, at: Date.now() };
            setHistory([...nextHistory, asst]);
            if (settings.speak_replies) {
              void tts.speak(assembled, {
                voiceId: settings.tts_voice_uri,
                rate:    settings.tts_rate,
                pitch:   settings.tts_pitch,
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

    // Blocking path (fallback / when stream_replies is off in settings).
    try {
      const reply = await postChat(requestBody);
      if (!reply.success) {
        rollback(reply.error || `LLM error (HTTP ${reply.http_status})`);
      } else {
        const asst: ChatMessage = { role: 'assistant', text: reply.content, at: Date.now() };
        setHistory([...nextHistory, asst]);
        if (settings.speak_replies) {
          void tts.speak(reply.content, {
            voiceId: settings.tts_voice_uri,
            rate:    settings.tts_rate,
            pitch:   settings.tts_pitch,
          });
        }
      }
    } catch (e: any) {
      rollback(e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  }, [buffer, pendingImgs, sending, history, settings, profile, mode, tts]);

  const cancelInflight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming('');
    setSending(false);
  }, []);

  // Global `s` -> send (suppressed inside inputs / textareas).
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

  // Cancel any in-flight TTS when ChatPage unmounts (e.g. navigating to
  // Settings). MUST use an empty dep array — `tts` is a new object each
  // render, and a [tts] dep would re-run cleanup on every render and
  // cancel the speech we just started during a streaming reply. The
  // hook's tts.cancel is stable (useCallback with []), so calling it from
  // a cleanup created on first render still hits the latest speaker.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => tts.cancel(), []);

  const provider     = config?.providers.find((p) => p.id === settings.provider);
  const hasServerKey = provider?.has_key ?? false;
  const hasOwnKey    = !!settings.api_keys[settings.provider];
  const canCall      = hasServerKey || hasOwnKey;
  const keyLabel     = hasOwnKey ? 'your key'
                    : hasServerKey ? 'server key'
                    : 'no key';
  const displayedBuffer = useMemo(() => {
    if (interim) return buffer ? `${buffer} ${interim}` : interim;
    return buffer;
  }, [buffer, interim]);

  return (
    <div className="chat">
      {pageDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay__inner">
            <div style={{ fontSize: '2rem' }}>📥</div>
            <div>Drop images to attach to your next message</div>
          </div>
        </div>
      )}
      <div className="toolbar">
        <ModeToggle value={mode} onChange={setMode} disabled={sending} />
        <span className="status-pill" title="Change in Settings">STT: {settings.stt_engine}</span>
        <span className={'status-pill ' + (stt.state === 'listening' ? 'ok' : stt.state === 'error' ? 'err' : '')}>
          {stt.state}{stt.statusMessage ? ` — ${stt.statusMessage}` : ''}
        </span>
        <span className="status-pill" title="Change in Settings">TTS: {settings.tts_engine}</span>
        <span className={'status-pill ' + (canCall ? 'ok' : 'warn')}>
          {settings.provider}: {keyLabel}
        </span>
        <span style={{ flex: 1 }} />
        {stt.isRunning
          ? <button className="secondary" onClick={() => void stt.stop()}>⏹ Stop listening</button>
          : <button onClick={() => void stt.start()}>🎙 Start listening</button>}
        <button className="secondary" onClick={() => { setHistory([]); tts.cancel(); }}>Clear</button>
      </div>

      <div className="chat__messages" ref={messagesRef}>
        <ChatMessages
          messages={history}
          streamingText={streamingText}
          pendingAssistant={sending}
        />
        {(error || stt.error) && (
          <div className="chat__msg system" style={{ color: 'var(--error)' }}>
            ⚠ {error || stt.error}
          </div>
        )}
      </div>

      <div className="chat__input">
        <textarea
          placeholder="Live transcript appears here. Edit if needed, then press 's' (outside this box) to send."
          value={displayedBuffer}
          onChange={(e) => { setBuffer(e.target.value); setInterim(''); }}
        />
        <ImageDropZone pending={pendingImgs} setPending={setPendingImgs} />
        <div className="input-row">
          <span className="hint">
            Press <kbd>s</kbd> to send (works while not typing).
            {settings.stream_replies ? ' Replies stream in real time.' : ' Replies wait for completion.'}
            {!canCall && ' Configure an API key for ' + settings.provider + ' in Settings.'}
          </span>
          {sending && abortRef.current && (
            <button className="danger" onClick={cancelInflight}>Stop</button>
          )}
          <button
            onClick={() => void send()}
            disabled={sending || (!buffer.trim() && pendingImgs.length === 0)}
          >
            {sending ? 'Sending…' : 'Send (s)'}
          </button>
        </div>
      </div>
    </div>
  );
}
