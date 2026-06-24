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

async function mockStream(page: import('@playwright/test').Page, frames: object[]) {
  await page.route('**/api/chat/stream', async (route) => {
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });
}

// Pin Markdown rendering: bold, lists, code blocks must turn into the
// matching HTML elements, NOT remain as raw asterisks/backticks.
test('markdown: assistant bubble renders bold, lists, and fenced code', async ({ page }) => {
  await seedClean(page);

  const md = [
    '**Situation:** I worked at *Resideo*.',
    '',
    '- bullet one',
    '- bullet two',
    '',
    '```python',
    'def add(a, b):',
    '    return a + b',
    '```',
  ].join('\n');

  await mockStream(page, [
    { delta: md },
    { done: true, success: true, error: '', http_status: 200, latency_ms: 5,
      usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]);

  await page.reload();
  await page.locator('textarea').first().fill('test markdown');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toBeVisible({ timeout: 5000 });

  // <strong> for **Situation**
  await expect(bubble.locator('strong')).toHaveText('Situation:');
  // <em> for *Resideo*
  await expect(bubble.locator('em')).toHaveText('Resideo');
  // <ul><li>...</li><li>...</li>
  await expect(bubble.locator('ul li').first()).toHaveText('bullet one');
  await expect(bubble.locator('ul li').nth(1)).toHaveText('bullet two');
  // Fenced code block: <pre><code class="language-python">
  await expect(bubble.locator('pre code')).toContainText('def add(a, b):');

  // The raw markdown syntax characters should NOT be visible — find any
  // raw '**' or '```' in the rendered text, which would indicate a regression.
  const text = (await bubble.textContent()) ?? '';
  expect(text).not.toContain('**Situation:**');
  expect(text).not.toContain('```python');
});

// Copy button: click → navigator.clipboard.writeText(text). Playwright
// intercepts the clipboard via permissions and we read it back.
test('copy button: writes the assistant text to the clipboard', async ({ page, context }) => {
  // Grant clipboard read so we can verify what got written.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedClean(page);

  await mockStream(page, [
    { delta: 'Hello clipboard!' },
    { done: true, success: true, error: '', http_status: 200, latency_ms: 5,
      usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]);

  await page.reload();
  await page.locator('textarea').first().fill('say hi');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('Hello clipboard!');

  // The copy button is inside the bubble's role header. Click it.
  const copyBtn = bubble.getByRole('button', { name: /copy reply/i });
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();

  // Verify the clipboard now holds the assistant text.
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('Hello clipboard!');

  // After clicking, the button switches to its "ok" state (checkmark).
  await expect(copyBtn).toHaveClass(/copy-btn--ok/);
});
