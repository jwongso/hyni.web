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

// A fenced ```mermaid block in an assistant message must render as an
// SVG diagram, not as a plain <pre><code> block. The mermaid package is
// dynamic-imported on first use, so we wait a few seconds for the SVG.
test('markdown: fenced mermaid block renders as a diagram', async ({ page }) => {
  await seedClean(page);
  await page.route('**/api/chat/stream', async (route) => {
    const md = [
      'Here is the design:',
      '',
      '```mermaid',
      'flowchart LR',
      '  client[Browser] --> api[hyni API]',
      '  api --> llm[LLM]',
      '  api --> mcp[MCP server]',
      '```',
      '',
      'That covers the data flow.',
    ].join('\n');
    const frames = [
      { delta: md },
      { done: true, success: true, error: '', http_status: 200, latency_ms: 5,
        usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });
  await page.reload();
  await page.locator('textarea').first().fill('draw me the stack');
  await page.getByRole('button', { name: /send/i }).click();

  // First the bubble appears with the text.
  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('Here is the design:', { timeout: 5000 });

  // Mermaid lazy-loads — give it a generous window to fetch + parse + render.
  const block = bubble.locator('.mermaid-block');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block.locator('svg')).toBeVisible({ timeout: 15_000 });

  // The "view source" disclosure has the original fenced code.
  await expect(block.locator('details > summary')).toContainText('view source');

  // The rest of the markdown still rendered normally.
  await expect(bubble).toContainText('That covers the data flow.');
});

// Non-mermaid fenced blocks must still render as plain <pre><code>.
test('markdown: non-mermaid fenced blocks stay as code blocks', async ({ page }) => {
  await seedClean(page);
  await page.route('**/api/chat/stream', async (route) => {
    const md = ['```python', 'print("hi")', '```'].join('\n');
    const frames = [
      { delta: md },
      { done: true, success: true, error: '', http_status: 200, latency_ms: 5,
        usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sse,
    });
  });
  await page.reload();
  await page.locator('textarea').first().fill('show me python');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble.locator('pre code')).toContainText('print("hi")', { timeout: 5000 });
  await expect(bubble.locator('.mermaid-block')).toHaveCount(0);
});
