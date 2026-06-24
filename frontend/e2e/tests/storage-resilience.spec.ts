import { test, expect } from '@playwright/test';

// Resilience smoke: poison localStorage with a settings blob that uses an
// unknown stt_engine ('web-speech' — the old kebab-case spelling), a
// stringified number for temperature, a missing api_keys field, and a
// missing _schema version. The sanitiser in storage.ts MUST repair this
// in-place so a normal chat round-trip still works.
//
// Regression: before the v3 sanitiser, this exact shape on disk caused
// the SPA to send a malformed request body that the backend silently
// turned into an empty stream — and the only fix was "clear localStorage"
// from DevTools.
test('storage sanitiser auto-heals corrupt settings on load', async ({ page }) => {
  await page.goto('/app/');

  // Inject the poisoned blob and reload so the sanitiser runs.
  await page.evaluate(() => {
    localStorage.setItem('hyni:settings', JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      stt_engine: 'web-speech',         // BAD: registry key is 'webspeech'
      tts_engine: 42 as any,            // BAD: wrong type
      temperature: '0.7' as any,        // BAD: string instead of number
      tts_rate: 999 as any,             // BAD: out of range
      max_tokens: null as any,          // BAD: null
      stream_replies: true,
      // intentionally missing: api_keys, owner_token, local_url, _schema
    }));
    localStorage.setItem('hyni:profile', JSON.stringify({
      resume_text: 'preserved across the heal',
      // missing target_role + extra_notes
    }));
  });
  await page.reload();

  // After load, the sanitiser should have rewritten the blob.
  const healed = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('hyni:settings') ?? '{}');
    const p = JSON.parse(localStorage.getItem('hyni:profile')  ?? '{}');
    return { s, p };
  });
  expect(healed.s.stt_engine).toBe('webspeech');         // snapped to default
  expect(healed.s.tts_engine).toBe('webspeech');         // snapped to default
  expect(typeof healed.s.temperature).toBe('number');    // coerced
  expect(healed.s.temperature).toBeCloseTo(0.7);
  expect(healed.s.tts_rate).toBe(2.0);                   // clamped to max
  expect(healed.s.max_tokens).toBe(4096);                // null -> default
  expect(healed.s.api_keys).toBeTruthy();
  expect(healed.s.api_keys.local).toBe('');
  expect(healed.s._schema).toBeGreaterThanOrEqual(3);

  // Profile was saved on save, but loadProfile sanitises on read — so
  // after reload, the in-memory shape is healed. We can't directly
  // observe localStorage healing for profile because saveProfile only
  // runs on explicit save. That's fine; the sanitiser fires on every
  // load so requests always get a clean shape.
  expect(healed.p.resume_text).toBe('preserved across the heal');
});

// Live end-to-end after corruption: send a real message via the SPA and
// confirm the assistant bubble renders. This is what would have failed
// before the v3 sanitiser if any registry key mismatched.
test('LIVE: chat round-trip works after corrupt-storage heal', async ({ page }) => {
  test.skip(!process.env.HYNI_E2E_OWNER_TOKEN,
    'set HYNI_E2E_OWNER_TOKEN to run the live chat round-trip');

  await page.goto('/app/');
  await page.evaluate((token) => {
    localStorage.setItem('hyni:settings', JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      stt_engine: 'web-speech',                 // bad spelling
      tts_engine: 'web_speech',                 // bad spelling
      temperature: 0.5,
      max_tokens: 64,
      stream_replies: true,
      owner_token: token,
    }));
  }, process.env.HYNI_E2E_OWNER_TOKEN);
  await page.reload();

  await page.locator('textarea').first().fill('Say hi in 3 words.');
  await page.getByRole('button', { name: /send/i }).click();

  const bubble = page.locator('.chat__msg.assistant').last();
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  await expect(bubble).not.toContainText('stream finished with empty content');
  const txt = (await bubble.textContent()) ?? '';
  expect(txt.length).toBeGreaterThan(2);
});
