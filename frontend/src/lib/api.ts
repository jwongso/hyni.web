// HTTP client for the Drogon backend.
//
// Every request optionally carries an `Authorization: Bearer <owner_token>`
// header. The backend ignores it in open mode (HYNI_OWNER_TOKEN unset) and
// validates it otherwise. Per-provider API keys go in the JSON body of
// /api/chat[/stream] and are never sent in headers.

import type {
  ChatRequestBody,
  ChatResponseBody,
  ServerConfig,
} from './types';
import { storage } from './storage';

function ownerAuthHeader(): Record<string, string> {
  try {
    const t = storage.loadSettings().owner_token?.trim();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config', {
    headers: { ...ownerAuthHeader() },
  });
  if (!res.ok) throw new Error(`config: HTTP ${res.status}`);
  return res.json();
}

export async function postChat(body: ChatRequestBody): Promise<ChatResponseBody> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...ownerAuthHeader(),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// -----------------------------------------------------------------------------
// Streaming variant
// -----------------------------------------------------------------------------

export interface ChatStreamDone {
  done: true;
  success: boolean;
  error: string;
  latency_ms: number;
  http_status: number;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export interface ChatStreamHandlers {
  onDelta(text: string): void;
  onDone(final: ChatStreamDone): void;
  onError(message: string): void;
  /** Abort signal: cancels the underlying fetch, which aborts the LLM call. */
  signal?: AbortSignal;
}

export async function postChatStream(
  body: ChatRequestBody,
  h: ChatStreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...ownerAuthHeader(),
      },
      body: JSON.stringify(body),
      signal: h.signal,
    });
  } catch (e: any) {
    h.onError(e?.message ?? String(e));
    return;
  }

  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || !ct.includes('text/event-stream')) {
    try {
      const errBody = await res.json();
      h.onError(errBody.error || `HTTP ${res.status}`);
    } catch {
      h.onError(`HTTP ${res.status}`);
    }
    return;
  }

  if (!res.body) { h.onError('streaming response had no body'); return; }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      while (true) {
        const sep = buf.indexOf('\n\n');
        if (sep < 0) break;
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        let dataPayload = '';
        for (const rawLine of frame.split('\n')) {
          if (!rawLine || rawLine.startsWith(':')) continue;
          if (!rawLine.startsWith('data:')) continue;
          const v = rawLine.slice(5).replace(/^ /, '');
          dataPayload += (dataPayload ? '\n' : '') + v;
        }
        if (!dataPayload) continue;

        let obj: any;
        try { obj = JSON.parse(dataPayload); }
        catch { continue; }

        if (obj.done) {
          h.onDone(obj as ChatStreamDone);
        } else if (typeof obj.delta === 'string') {
          h.onDelta(obj.delta);
        } else if (obj.error) {
          h.onError(String(obj.error));
        }
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    h.onError(e?.message ?? String(e));
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * Tiny "probe" request used by the Settings page "Test" buttons.
 * Sends a 1-token request to verify the (provider, key) combination works.
 */
export async function probeProviderKey(
  provider: 'openai' | 'anthropic' | 'deepseek' | 'mistral',
  apiKey: string,
): Promise<ChatResponseBody> {
  return postChat({
    provider,
    mode: 'general',
    profile: { resume_text: '', target_role: '', extra_notes: '' },
    history: [],
    message: 'ping',
    max_tokens: 1,
    temperature: 0,
    api_key: apiKey,
  });
}
