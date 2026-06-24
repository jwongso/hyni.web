import { test, expect, type Page } from '@playwright/test';

// Seed the SPA's localStorage so we land on a known-good state without
// having to click through Settings every test. Must be called BEFORE
// page.goto('/app/') because the SPA reads localStorage at mount time.
export async function seedStorage(page: Page, opts: {
  provider?: 'openai' | 'anthropic' | 'deepseek' | 'mistral' | 'local';
  model?: string;
  ownerToken?: string;
  streamReplies?: boolean;
  apiKey?: string;
} = {}) {
  // Visit *something* on the same origin first so localStorage is writable.
  await page.goto('/app/');
  await page.evaluate((o) => {
    const settings = {
      provider: o.provider ?? 'local',
      model: o.model ?? 'Qwen_Qwen3-8B-Q5_K_M.gguf',
      api_keys: { openai: '', anthropic: '', deepseek: '', mistral: '', local: o.apiKey ?? '' },
      owner_token: o.ownerToken ?? '',
      local_url: '',
      stt_engine: 'web-speech',
      tts_engine: 'web-speech',
      tts_voice_uri: '',
      tts_rate: 1,
      tts_pitch: 1,
      temperature: 0.7,
      max_tokens: 4096,
      speak_replies: false,
      stream_replies: o.streamReplies ?? true,
      _schema: 2,
    };
    localStorage.setItem('hyni:settings', JSON.stringify(settings));
    localStorage.setItem('hyni:profile', JSON.stringify({
      resume_text: '', target_role: '', extra_notes: '',
    }));
  }, opts);
}

// Mock the streaming endpoint with a sequence of SSE frames. The handler
// also asserts the request body shape so payload regressions surface.
export async function mockChatStream(page: Page, frames: object[], opts: {
  onRequest?: (body: any) => void;
} = {}) {
  await page.route('**/api/chat/stream', async (route) => {
    const req = route.request();
    let body: any = {};
    try { body = JSON.parse(req.postData() ?? '{}'); } catch { /* ignore */ }
    opts.onRequest?.(body);

    const sse = frames
      .map((f) => `data: ${JSON.stringify(f)}\n\n`)
      .join('');

    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
      body: sse,
    });
  });
}

export { test, expect };
