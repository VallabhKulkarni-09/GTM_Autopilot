import { defineConfig } from '@playwright/test'

/**
 * Dashboard E2E against the production build.
 *  - "signed-out" server: Supabase/API unreachable → exercises redirects and the proxy's 401.
 *  - "signed-in"  server: Supabase Auth + API played by e2e/stub-server.mjs, so the real
 *    middleware, proxy and pages run with no live credentials.
 */
const OUT = 3100
const IN = 3101
const STUB = 3199

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  // CI keeps an HTML report and traces of failures (uploaded as an artifact).
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'signed-out', testMatch: /auth\.spec\.ts/, use: { baseURL: `http://localhost:${OUT}` } },
    { name: 'signed-in', testMatch: /signed-in\.spec\.ts/, use: { baseURL: `http://localhost:${IN}` } },
  ],
  webServer: [
    {
      command: `npx next start -p ${OUT}`,
      port: OUT,
      reuseExistingServer: !process.env.CI,
      env: { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'test-anon-key', API_URL: 'http://127.0.0.1:9', DASHBOARD_URL: `http://localhost:${OUT}` },
    },
    { command: `node e2e/stub-server.mjs`, port: STUB, reuseExistingServer: !process.env.CI, env: { STUB_PORT: String(STUB) } },
    {
      command: `npx next start -p ${IN}`,
      port: IN,
      reuseExistingServer: !process.env.CI,
      env: {
        SUPABASE_URL: `http://127.0.0.1:${STUB}`, SUPABASE_ANON_KEY: 'test-anon-key',
        API_URL: `http://127.0.0.1:${STUB}`, DASHBOARD_URL: `http://localhost:${IN}`,
        PUBLIC_API_URL: 'https://autopilot.example.com',
      },
    },
  ],
})
