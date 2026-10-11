/**
 * Playwright port of the Maestro web E2E suite — NEO-338 timing bake-off.
 * Guide: playwright/PORTING.md. CI: .github/workflows/e2e-playwright.yml.
 *
 * Ordering mirrors the Maestro pipeline (e2e.yml):
 *   1. seed job   — `e2e-baseline.sh reset`, then `--project=setup` (the port
 *                   of flows/setup.yaml) as worker 0. Never sharded.
 *   2. shard jobs — `--project=e2e --shard=i/8`. `e2e` depends on `bootstrap`
 *                   (the port of profile/worker-bootstrap.yaml), so every shard
 *                   first bootstraps ITS account (TEST_EMAIL_<WORKER_INDEX>)
 *                   — run-e2e-queue.sh's Phase 0 — then runs its slice.
 *
 * One worker per shard: each shard owns exactly one test account, and the
 * account's per-user state (reset, credentials, profile) is not safe to share
 * between concurrent browsers — same as Maestro's one-Chrome-per-runner.
 *
 * Budgets mirror Maestro: 7 s per action / expect (R5), no retries, 600 s per
 * test (MAESTRO_FLOW_TIMEOUT_SEC default) and 1500 s for the seed.
 */
import { defineConfig } from "@playwright/test";

const CI = !!process.env.CI;
const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const REPORT_DIR = process.env.PW_REPORT_DIR ?? "playwright/report";

// Unstated-timeout budget (see DEFAULT_TIMEOUT in playwright/support/maestro.ts).
const STEP_TIMEOUT = Number(process.env.PW_UNSTATED_TIMEOUT ?? 7_000);

const SETUP = /tests[\\/]setup\.spec\.ts$/;
const BOOTSTRAP = /tests[\\/]profile[\\/]worker-bootstrap\.spec\.ts$/;

export default defineConfig({
  testDir: "./playwright/tests",
  outputDir: "./playwright/results",
  // Shard by TEST, not by file (one spec per flow, so the same thing here).
  fullyParallel: true,
  workers: 1,
  retries: 0,
  forbidOnly: CI,
  // Maestro has no per-flow cap; two flows wait up to 600s on one step.
  timeout: 1_200_000,
  expect: { timeout: STEP_TIMEOUT },
  reporter: CI
    ? [
        ["list"],
        ["blob", { outputDir: `${REPORT_DIR}/blob` }],
        ["json", { outputFile: `${REPORT_DIR}/results.json` }],
        ["junit", { outputFile: `${REPORT_DIR}/junit.xml` }],
      ]
    : [["list"]],
  use: {
    baseURL: APP_URL,
    actionTimeout: STEP_TIMEOUT,
    navigationTimeout: 30_000,
    // maestro-web's headless viewport in CI (README: 1024x629).
    viewport: { width: 1024, height: 629 },
    // No traces in CI: blob reports carry attachments into PUBLIC artifacts,
    // and a trace records network traffic (Clerk testing tokens). Screenshots
    // only, like the Maestro artifacts.
    trace: CI ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: SETUP, timeout: 1_500_000 },
    { name: "bootstrap", testMatch: BOOTSTRAP },
    {
      name: "e2e",
      testIgnore: [SETUP, BOOTSTRAP],
      dependencies: ["bootstrap"],
    },
  ],
  // CI: the same localhost:3000 -> Vercel preview proxy the Maestro runner
  // starts (injects the deployment-protection bypass header). Locally, leave
  // PREVIEW_URL unset and point APP_URL at your own Vite.
  webServer: process.env.PREVIEW_URL
    ? {
        command: "node playwright/support/bypass-proxy.mjs",
        url: "http://localhost:3000/",
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
