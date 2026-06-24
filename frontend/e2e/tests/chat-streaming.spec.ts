import { test, expect } from '@playwright/test';

// Helper: seed clean localStorage so each test starts from the same state.
async function seedClean(page: import('@playwright/test').Page) {
  await page.goto('/app/');
  await page.evaluate(() => {
    localStorage.setItem('hyni:settings', JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      stream_replies: true,
      _schema: 3,
    }));
  });
}

// Mock the streaming endpoint and assert deltas reach the bubble.
async function mockStream(page: import('@playwright/test').Page, frames: object[],
                          onRequest?: (body: any) => void) {
  await page.route('**/api/chat/stream', async (route) => {
    if (onRequest) {
      try { onRequest(JSON.parse(route.request().postData() ?? '{}')); }
      catch { /* ignore */ }
    }
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });
}

// Pin the regression that caused the bug we just fixed: a mock backend
// emitting reasoning_content-style deltas should end up rendered in the
// assistant bubble exactly as text. If the frontend SSE consumer ever
// breaks (e.g. switches to a JSON content-type expectation), this fails.
test('streaming: deltas accumulate into the chat bubble', async ({ page }) => {
  await seedClean(page);

  let capturedBody: any = null;
  await mockStream(page, [
    { delta: 'Hello ' },
    { delta: 'world!' },
    { done: true, success: true, error: '', http_status: 200, latency_ms: 42,
      usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ], (b) => { capturedBody = b; });

  await page.reload();
  await page.locator('textarea').first().fill('what is 2+2?');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.locator('.chat__msg.assistant').last())
    .toContainText('Hello world!', { timeout: 5000 });
  await expect(page.getByText('stream finished with empty content')).not.toBeVisible();

  // Text-field-to-payload sanity: typed message reached the backend.
  expect(capturedBody.message).toBe('what is 2+2?');
});

// Reasoning channel: reasoning frames must NOT pollute the visible bubble;
// they should render inside a collapsible "Thinking…" disclosure widget.
test('streaming: reasoning frames stay in the disclosure, not the answer', async ({ page }) => {
  await seedClean(page);

  await mockStream(page, [
    { reasoning: 'Okay, the user is asking...' },
    { reasoning: ' I should answer with "Four".' },
    { delta: 'Four' },
    { delta: '.' },
    { done: true, success: true, error: '', http_status: 200, latency_ms: 42,
      usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]);

  await page.reload();
  await page.locator('textarea').first().fill('what is 2+2?');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('Four.', { timeout: 5000 });

  // Reasoning lives in a <details> element, default-collapsed; its content
  // is NOT visible by default but IS in the DOM.
  const reasoning = bubble.locator('.reasoning');
  await expect(reasoning).toBeAttached();
  // When closed, the body still exists in the DOM but is folded away.
  const body = bubble.locator('.reasoning__body');
  await expect(body).toContainText('Okay, the user is asking');

  // CRITICAL: the visible answer text must NOT contain the reasoning prose.
  // Read the textContent of the bubble, excluding the .reasoning subtree.
  const visibleAnswer = await bubble.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.reasoning, .role').forEach((n) => n.remove());
    return clone.textContent ?? '';
  });
  expect(visibleAnswer).toContain('Four.');
  expect(visibleAnswer).not.toContain('Okay, the user is asking');
});

// 4-arg overload backward-compat: a stream with no reasoning frames still
// renders the visible answer normally (no disclosure widget appears).
test('streaming: no reasoning channel -> no disclosure widget', async ({ page }) => {
  await seedClean(page);
  await mockStream(page, [
    { delta: 'Plain ' },
    { delta: 'answer.' },
    { done: true, success: true, error: '', http_status: 200, latency_ms: 1,
      usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]);
  await page.reload();
  await page.locator('textarea').first().fill('hi');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('Plain answer.');
  await expect(bubble.locator('.reasoning')).toHaveCount(0);
});

// Failure path: backend says success=false. The frontend should surface
// the error AND restore the user's typed text so they don't have to retype.
test('streaming: error rollback restores the typed text', async ({ page }) => {
  await seedClean(page);

  await mockStream(page, [
    { done: true, success: false, error: 'simulated upstream error',
      http_status: 500, latency_ms: 10,
      usage: { prompt_tokens: 0, completion_tokens: 0 } },
  ]);

  await page.reload();
  const textarea = page.locator('textarea').first();
  await textarea.fill('please rollback me');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.locator('.chat__msg.system').filter({ hasText: /simulated upstream error/ }))
    .toBeVisible({ timeout: 5000 });

  // Typed text was restored (the user can press send again).
  await expect(textarea).toHaveValue('please rollback me');
});
