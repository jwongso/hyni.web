import { test, expect } from '@playwright/test';

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

// The composer should be visibly larger than the legacy 70-px box and
// should grow as the user types multi-line input. We don't pin an exact
// pixel value (DPR / font-metrics vary), only that height monotonically
// increases as the textarea gains content.
test('composer auto-grows with content', async ({ page }) => {
  await seedClean(page);
  await page.reload();

  const ta = page.locator('textarea.composer').first();
  await expect(ta).toBeVisible();

  const h0 = await ta.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(h0).toBeGreaterThanOrEqual(100);   // min-height: 110px in CSS

  // Add many lines and check the textarea got taller.
  await ta.fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten');
  const h1 = await ta.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(h1).toBeGreaterThan(h0);

  // After clearing, it shrinks back near the minimum.
  await ta.fill('');
  const h2 = await ta.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
  expect(h2).toBeLessThan(h1);
});

// Cmd/Ctrl + Enter inside the textarea sends. Plain Enter inserts a
// newline so multi-line transcripts stay editable.
test('Ctrl+Enter inside the composer triggers send', async ({ page }) => {
  await seedClean(page);
  await page.route('**/api/chat/stream', async (route) => {
    const sse = [
      'data: {"delta":"ok"}\n\n',
      'data: {"done":true,"success":true,"error":"","http_status":200,"latency_ms":1,"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
    ].join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });
  await page.reload();

  const ta = page.locator('textarea.composer').first();
  await ta.fill('test ctrl-enter');
  await ta.press('Control+Enter');

  await expect(page.locator('.chat__msg.assistant').last()).toContainText('ok',
    { timeout: 5000 });
  // Buffer was cleared on send.
  await expect(ta).toHaveValue('');
});

// Chat layout: the .chat container fills the viewport horizontally (no
// 1100px cap like before), so the scrollbar of .chat__messages sits at
// the right viewport edge.
test('chat view stretches to viewport edges', async ({ page }) => {
  await seedClean(page);
  await page.reload();

  const chat = page.locator('.chat').first();
  const widths = await chat.evaluate((el) => ({
    chat:     el.getBoundingClientRect().width,
    viewport: window.innerWidth,
    maxWidth: getComputedStyle(el).maxWidth,
  }));
  // Should be no max-width cap.
  expect(widths.maxWidth === 'none' || widths.maxWidth === '').toBe(true);
  // Chat takes essentially the full viewport (accounting for any sidebar).
  expect(widths.chat).toBeGreaterThan(widths.viewport * 0.7);
});
