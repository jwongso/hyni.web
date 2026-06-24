import { test, expect } from '@playwright/test';

async function seedClean(page: import('@playwright/test').Page) {
  await page.goto('/app/');
  await page.evaluate(() => {
    localStorage.setItem('hyni:settings', JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      stream_replies: false,    // tool calls only flow through the blocking path in V1
      _schema: 3,
    }));
  });
}

// Pin the MCP tool-call rendering: when /api/chat returns a non-empty
// tool_calls array, the assistant bubble shows a "🛠 N tool calls"
// disclosure that expands to per-call args + result.
test('chat: assistant bubble surfaces tool_calls in a collapsible block', async ({ page }) => {
  await seedClean(page);
  await page.route('**/api/chat', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        content: 'You can refer to NZTT-MOJ-5167821.',
        error: '',
        latency_ms: 1234,
        http_status: 200,
        usage: { prompt_tokens: 100, completion_tokens: 30 },
        tool_calls: [{
          id: 'call_xyz',
          name: 'astraea__legal_search',
          arguments: { query: 'bond refund', top_k: 5 },
          result: '{"count":1,"sources":[{"case_id":"NZTT-MOJ-5167821"}]}',
          is_error: false,
          latency_ms: 850,
        }],
      }),
    });
  });

  await page.reload();
  await page.locator('textarea').first().fill('search bond refund cases');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('NZTT-MOJ-5167821', { timeout: 5000 });

  // The tool-calls disclosure is in the DOM and the summary mentions "1 tool call".
  const tc = bubble.locator('.tool-calls');
  await expect(tc).toBeAttached();
  await expect(tc.locator('summary').first()).toContainText('1 tool call');

  // The qualified tool name shows up in the body even while collapsed (it's
  // styled via CSS, not hidden via JS).
  await expect(bubble.locator('.tool-call__name')).toHaveText('astraea__legal_search');

  // Expand the outer disclosure and the args sub-disclosure; the JSON args
  // should render with both keys.
  await tc.locator('summary').first().click();
  await tc.locator('.tool-call__args > summary').click();
  await expect(tc.locator('.tool-call__args pre')).toContainText('"query"');
  await expect(tc.locator('.tool-call__args pre')).toContainText('"top_k"');

  // Verify the error variant: if a call returns is_error=true the row
  // gets the err class + a badge. We don't trigger that here — covered
  // separately for brevity, but the CSS path is exercised in dev manually.
});

// Empty tool_calls array (or missing field) must render NO disclosure.
test('chat: no tool_calls means no tool-calls disclosure', async ({ page }) => {
  await seedClean(page);
  await page.route('**/api/chat', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        content: 'Plain reply, no tools.',
        error: '', latency_ms: 10, http_status: 200,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        tool_calls: [],
      }),
    });
  });
  await page.reload();
  await page.locator('textarea').first().fill('hi');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toContainText('Plain reply, no tools.');
  await expect(bubble.locator('.tool-calls')).toHaveCount(0);
});

// Backend /api/config exposes mcp.enabled / tool_count so the frontend can
// show a "🛠 N tools" badge somewhere. We at least verify the shape.
test('GET /api/config exposes mcp summary', async ({ request }) => {
  const res = await request.get('/api/config');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json).toHaveProperty('mcp');
  expect(typeof json.mcp.enabled).toBe('boolean');
  expect(typeof json.mcp.tool_count).toBe('number');
  expect(Array.isArray(json.mcp.servers)).toBe(true);
});
