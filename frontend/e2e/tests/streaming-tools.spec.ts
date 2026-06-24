import { test, expect } from '@playwright/test';

async function seedClean(page: import('@playwright/test').Page) {
  await page.goto('/app/');
  await page.evaluate(() => {
    localStorage.setItem('hyni:settings', JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      stream_replies: true,   // <-- streaming path is what this test pins
      _schema: 3,
    }));
  });
}

// Phase 2 regression: tool_call frames arriving on the SSE stream must
// (a) render the in-flight tool-calls disclosure DURING streaming, and
// (b) end up attached to the saved assistant message after `done`.
test('streaming: tool_call frames render in-flight and stick after done', async ({ page }) => {
  await seedClean(page);

  await page.route('**/api/chat/stream', async (route) => {
    // Sequence mirrors what the real backend emits: tool_call first,
    // then visible deltas, then done.
    const frames = [
      { tool_call: {
          id: 'call_abc',
          name: 'astraea__legal_search',
          arguments: { query: 'bond refund' },
          result: '{"count":1,"sources":[{"case_id":"NZTT-MOJ-4921978"}]}',
          is_error: false,
          latency_ms: 88,
      }},
      { delta: 'The case ' },
      { delta: 'NZTT-MOJ-4921978' },
      { delta: ' covers bond refund rules.' },
      { done: true, success: true, error: '',
        http_status: 200, latency_ms: 1500,
        usage: { prompt_tokens: 200, completion_tokens: 30 },
        tool_calls: [{
          id: 'call_abc',
          name: 'astraea__legal_search',
          arguments: { query: 'bond refund' },
          result: '{"count":1,"sources":[{"case_id":"NZTT-MOJ-4921978"}]}',
          is_error: false,
          latency_ms: 88,
        }],
      },
    ];
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });

  await page.reload();
  await page.locator('textarea').first().fill('what about bond refunds?');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('NZTT-MOJ-4921978', { timeout: 5000 });

  // Tool calls disclosure is attached + summary mentions 1 tool call.
  const tc = bubble.locator('.tool-calls');
  await expect(tc).toBeAttached();
  await expect(tc.locator('summary').first()).toContainText('1 tool call');
  await expect(bubble.locator('.tool-call__name')).toHaveText('astraea__legal_search');
});

// Negative pin: a streaming response with NO tool_calls must NOT render
// a tool-calls disclosure (regression for the earlier reasoning_content
// shape mistake).
test('streaming: no tool_call frames -> no disclosure', async ({ page }) => {
  await seedClean(page);
  await page.route('**/api/chat/stream', async (route) => {
    const frames = [
      { delta: 'Plain ' },
      { delta: 'streaming reply.' },
      { done: true, success: true, error: '', http_status: 200, latency_ms: 5,
        usage: { prompt_tokens: 5, completion_tokens: 5 } },
    ];
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });
  await page.reload();
  await page.locator('textarea').first().fill('hi');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('Plain streaming reply.');
  await expect(bubble.locator('.tool-calls')).toHaveCount(0);
});
