/**
 * Browser smoke tests. Run with `npm run smoke`.
 *
 * They drive the real app in Chromium with the mouse and keyboard, the way
 * a person uses it, and check the results against the exact kernel.
 *
 * SAFETY: these tests must never start the real Claude Code (that would spend
 * the user's Claude usage). The dev server is always started fresh by Playwright with
 * CHATCAD_CLAUDE_PATH pointing at a file that does not exist, and an already
 * running server is never reused (it could have the real Claude configured).
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5187;
/** e2e/production.spec.ts uses the same number. */
export const PREVIEW_PORT = 5188;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../smoke-report' }]] : 'list',
  outputDir: '../smoke-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } }],
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort`,
      cwd: '..',
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { CHATCAD_CLAUDE_PATH: '/nonexistent/chatcad-smoke-test/claude-must-not-run' },
    },
    {
      // The production build, served the way a static host serves it (with the COOP/COEP headers
      // from vite.config.ts). e2e/production.spec.ts runs against it. No Claude bridge here.
      command: `npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${PREVIEW_PORT} --strictPort`,
      cwd: '..',
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
