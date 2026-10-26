import { defineConfig, devices } from '@playwright/test';

// Read without Node type definitions, which the browser code must not see.
const CI = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: CI,
  reporter: CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          // Expose real host candidates so two browser contexts on one machine
          // can connect over WebRTC without STUN servers or the internet.
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: !CI,
    timeout: 120_000,
  },
});
