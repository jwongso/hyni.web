import type {
  ChatRequestBody,
  ChatResponseBody,
  ServerConfig,
} from './types';

export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`config: HTTP ${res.status}`);
  return res.json();
}

export async function postChat(body: ChatRequestBody): Promise<ChatResponseBody> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The Drogon controller always returns a JSON body, even on failure.
  return res.json();
}

// -----------------------------------------------------------------------------
// Streaming
//
// Server emits one SSE frame per delta plus a final frame with `done: true`:
//   data: {"delta":"Hello"}
//
//   data: {"delta":" world"}
//
//   data: {"done":true,"success":true,"latency_ms":1234,"usage":{...}}
//
// We consume the response body as a ReadableStream, split on the blank-line
// frame terminator (\n\n), and dispatch parsed JSON to the caller's handlers.
// -----------------------------------------------------------------------------

export interface ChatStreamDelta { delta: string }
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
  /** Optional AbortSignal — abort the underlying fetch to cancel the stream. */
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
      },
      body: JSON.stringify(body),
      signal: h.signal,
    });
  } catch (e: any) {
    h.onError(e?.message ?? String(e));
    return;
  }

  // Drogon returns JSON on early validation failures (no SSE body).
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

  if (!res.body) {
    h.onError('streaming response had no body');
    return;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Pull complete \n\n-terminated frames from the buffer.
      while (true) {
        const sep = buf.indexOf('\n\n');
        if (sep < 0) break;
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        // Each frame can have multiple "field: value" lines. We only care
        // about `data:` lines; concatenate their values with '\n'.
        let dataPayload = '';
        for (const rawLine of frame.split('\n')) {
          if (!rawLine || rawLine.startsWith(':')) continue;          // blank / comment
          if (!rawLine.startsWith('data:')) continue;                  // event:, id:, etc.
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
    if (e?.name === 'AbortError') return;  // expected on user cancel
    h.onError(e?.message ?? String(e));
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
