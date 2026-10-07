import { fileURLToPath } from "node:url"
import path from "node:path"
import { defineConfig, devices } from "@playwright/test"
import { E2E_CLOUDFLARED_DIE_FILE, E2E_DATA_DIR, E2E_WORKSPACES_ROOT } from "./paths"

const e2eDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(e2eDir, "..")

const MOCK_PORT = 4097
const BFF_PORT = 8788

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${BFF_PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx mock-opencode.ts",
      cwd: e2eDir,
      env: { MOCK_PORT: String(MOCK_PORT) },
      url: `http://127.0.0.1:${MOCK_PORT}/global/health`,
      // Never reuse: a server left behind by a killed run would serve the
      // previous build and state instead of this run's hermetic setup.
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run build -w @masterhand/web && npx tsx apps/server/src/index.ts",
      cwd: repoRoot,
      env: {
        PORT: String(BFF_PORT),
        OPENCODE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        MASTERHAND_PASSWORD: "e2e-password",
        // Shorten the client's request deadline so the stalled-send spec is fast.
        VITE_REQUEST_TIMEOUT_MS: "5000",
        // `finish` gets its own (longer) budget; shorten it for the spec that
        // simulates a lost finish response.
        VITE_FINISH_TIMEOUT_MS: "5000",
        SESSION_SECRET: "e2e-secret",
        COOKIE_SECURE: "false",
        DATA_DIR: E2E_DATA_DIR,
        WORKSPACES_ROOT: E2E_WORKSPACES_ROOT,
        PREVIEW_ORIGIN: "127.0.0.1",
        // The mock's own port doubles as the session's dev server: the BFF's
        // reachability probe only needs a listener, and this avoids a second
        // hardcoded port (32950 was already taken on GitHub runners).
        PREVIEW_PORT_RANGE: `${MOCK_PORT}-${MOCK_PORT}`,
        // The fake trycloudflare URL is not a real host, so the BFF must not
        // wait for it to become reachable.
        PREVIEW_READINESS_MS: "0",
        CLOUDFLARED_BIN: path.join(e2eDir, "fake-cloudflared.sh"),
        // Creating this file makes the fake tunnel exit on its own (#89).
        E2E_CLOUDFLARED_DIE_FILE: E2E_CLOUDFLARED_DIE_FILE,
      },
      url: `http://127.0.0.1:${BFF_PORT}/api/health`,
      // Same as above: a stale BFF would serve another run's database.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
