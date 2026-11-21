import { defineConfig } from '@playwright/test'

// Acceptance run against the LIVE stack: LocalNet + backend (:8787) + Vite UI (:5173) must already be running.
export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    headless: process.env.HEADLESS === '1',
    viewport: { width: 1280, height: 860 },
    launchOptions: { slowMo: Number(process.env.SLOWMO ?? 250) },
    screenshot: 'on',
    video: 'on',
  },
})
