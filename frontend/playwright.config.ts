import { defineConfig, devices } from '@playwright/test';

// hyni.web frontend smoke tests.
//
// All tests drive the REAL Drogon backend on :8848. The backend must be
// running (either `scripts/run.sh` or the systemd --user unit) and the
// frontend bundle must be built into `public/app/` (`scripts/build.sh`).
//
// For the streaming regression test we intercept /api/chat/stream at the
// browser fetch layer with route.fulfill(), so no real LLM call is made.
// The "live" smoke uses real /api/config which never touches an LLM key.
//
// Run:
//   cd frontend
//   npx playwright test               # headless
//   npx playwright test --ui          # interactive
//   npx playwright test --headed      # see the browser
const BASE_URL = process.env.HYNI_E2E_BASE_URL ?? 'http://localhost:8848';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,            // single backend; keep tests serial
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The SPA lives at /app/, so most tests goto('/app/').
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // We deliberately do NOT auto-start the backend from Playwright.
  // The backend lifecycle is owned by systemd --user (or scripts/run.sh)
  // and Vite's dev server isn't what we want to test against — we want
  // the *built* bundle served by Drogon, exactly what production users hit.
});
