/**
 * Playwright E2E suite (NEO-341; born in the NEO-338 bake-off).
 * Guide: playwright/GUIDE.md.
 * CI: .github/workflows/e2e-playwright-idiomatic.yml.
 *
 * The Maestro flows (.maestro/flows/**) are the SPECIFICATION of what each
 * test covers; the tests are written the way a Playwright engineer would
 * write them (role/label/text locators, web-first assertions, auto-waiting),
 * not translated step by step.
 *
 * Project chain:
 *   setup     — tests/setup.spec.ts, the seed track. Seed job only, worker 0.
 *   bootstrap — tests/profile/worker-bootstrap.spec.ts. `e2e` depends on it,
 *               so every shard first resets + seeds ITS account.
 *   e2e       — everything else. CI hands each shard an explicit file list
 *               (shard-plan.mjs, longest-first) instead of --shard.
 *
 * One worker per shard: each shard owns one test account (TEST_EMAIL_<n>).
 *
 * Budgets: 7 s per action / expect — the suite's UX budget. A step the flow
 * states a longer timeout for (live marketplace round-trips, the launch
 * gate) passes that number on that one call. No retries.
 */
import { defineConfig } from "@playwright/test";

const CI = !!process.env.CI;
const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Not a dot-folder: upload-artifact skips hidden paths.
const REPORT_DIR = process.env.PW_REPORT_DIR ?? "playwright/report";

const UX_BUDGET = 7_000;

const SETUP = /tests[\\/]setup\.spec\.ts$/;
const BOOTSTRAP = /tests[\\/]profile[\\/]worker-bootstrap\.spec\.ts$/;

export default defineConfig({
  testDir: "./playwright/tests",
  outputDir: "./playwright/results",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  forbidOnly: CI,
  // Budgets are per step; a few specs legitimately wait minutes on a live
  // marketplace sync, so the per-test cap is generous.
  timeout: 1_200_000,
  expect: { timeout: UX_BUDGET },
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
    actionTimeout: UX_BUDGET,
    navigationTimeout: 30_000,
    // CI headless viewport, same as Maestro and the first port.
    viewport: { width: 1024, height: 629 },
    // No traces in CI: blob reports land in PUBLIC artifacts and a trace
    // records network traffic (Clerk testing tokens).
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
  // CI: localhost:3000 -> Vercel preview proxy that injects the
  // deployment-protection bypass header (shared with the first port).
  // Locally, leave PREVIEW_URL unset and point APP_URL at your own Vite.
  webServer: process.env.PREVIEW_URL
    ? {
        command: "node playwright/support/bypass-proxy.mjs",
        url: "http://localhost:3000/",
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
