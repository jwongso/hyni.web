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
