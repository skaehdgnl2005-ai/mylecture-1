import { defineConfig, devices } from '@playwright/test'

/**
 * PRD §9 acceptance criteria that are cross-page or multi-actor flows — the
 * ones Vitest structurally cannot reach (it cannot render async Server
 * Components at all).
 *
 * Runs against `next build && next start`, never `next dev`: dev-mode timing
 * and error overlays hide exactly the problems this is meant to catch.
 * Requires MOCK_OPENAI=1 so a full run costs nothing.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      // 360px wide is the PRD §7 design target.
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } },
    },
  ],
})
