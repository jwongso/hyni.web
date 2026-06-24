import { test, expect } from '@playwright/test';

// Smoke: SPA loads /api/config and renders the provider dropdown with
// all five known providers. Local row should NOT carry a `· no key` /
// `· your key` suffix (regression for commit 8125506).
test('settings page loads providers from /api/config', async ({ page }) => {
  await page.goto('/app/#/settings');

  const providerSelect = page.locator('select').first();
  await expect(providerSelect).toBeVisible({ timeout: 10_000 });

  const options = await providerSelect.locator('option').allTextContents();
  const joined = options.join(' | ');
  expect(joined).toContain('openai');
  expect(joined).toContain('anthropic');
  expect(joined).toContain('deepseek');
  expect(joined).toContain('mistral');
  expect(joined).toContain('local');

  // Local renders as bare "local", no key annotation.
  const localOpt = options.find((t) => t.trim().startsWith('local'));
  expect(localOpt?.trim()).toBe('local');
});

// Sanity: /api/config endpoint itself answers and reports the curated
// model catalogue. Catches Drogon mis-registration and CORS regressions.
test('GET /api/config returns curated providers + models', async ({ request }) => {
  const res = await request.get('/api/config');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.providers).toBeTruthy();
  expect(json.providers.length).toBeGreaterThanOrEqual(5);
  for (const p of json.providers) {
    expect(p).toHaveProperty('id');
    expect(p).toHaveProperty('models');
    expect(Array.isArray(p.models)).toBe(true);
  }
});
