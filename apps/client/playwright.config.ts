import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Use a preinstalled Chromium when one is provided (e.g. cloud dev containers).
const chromium = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:8787',
    viewport: { width: 1280, height: 800 },
    launchOptions: existsSync(chromium) ? { executablePath: chromium } : {},
  },
  // The edge Worker serves the built client as static assets plus the API: same shape as production.
  webServer: {
    command: 'pnpm build && pnpm --filter @otherhere/edge dev',
    url: 'http://localhost:8787/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
