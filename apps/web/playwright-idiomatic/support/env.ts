/**
 * Per-test environment: the Playwright equivalent of the `-e` variables the
 * Maestro runners pass (`run-e2e-queue.sh` / `run-e2e-smoke.sh`).
 *
 * | Maestro (-e)       | Here                    | Notes                                   |
 * |--------------------|-------------------------|-----------------------------------------|
 * | APP_URL            | config `use.baseURL`     | goto('/path') is relative to it         |
 * | WORKER_INDEX       | env.WORKER_INDEX         | from process.env.WORKER_INDEX (CI: shard-1) |
 * | ATTEMPT_ID         | env.ATTEMPT_ID           | `pw<worker>-a1-<random>` (fresh per test) |
 * | (flow-set) ATTEMPT_TOKEN | env.ATTEMPT_TOKEN  | ATTEMPT_ID with hyphens stripped         |
 * | TEST_USERNAME      | env.TEST_USERNAME        | fresh per test, ^[a-z0-9-]+$             |
 * | PAUSED_PLATFORMS   | env.PAUSED_PLATFORMS     | from process.env.PAUSED_PLATFORMS        |
 * | output.SL_PAUSED   | env.SL_PAUSED            | util-paused-platforms.yaml's boolean     |
 *
 * ATTEMPT_ID spelling: CI Maestro uses `r<n>-a<attempt>-<RANDOM>` and local
 * Maestro `w<n>-a<attempt>-<RANDOM>`. Playwright uses `pw<n>-a1-<random>` so a
 * minted token (`pw3a112345`) can never equal a Maestro one (`r3a112345`),
 * even when both suites run against the same preview on the same night.
 * Retries are off (retries: 0), so the attempt is always 1.
 */

export interface FlowEnv {
  APP_URL: string;
  WORKER_INDEX: string;
  ATTEMPT_ID: string;
  /** ATTEMPT_ID with hyphens stripped: the suite's single-token idiom. */
  ATTEMPT_TOKEN: string;
  TEST_USERNAME: string;
  PAUSED_PLATFORMS: string;
  /** True when PAUSED_PLATFORMS names sportlots (util-paused-platforms.yaml). */
  SL_PAUSED: boolean;
}

export function workerIndex(): string {
  const raw = process.env.WORKER_INDEX ?? "0";
  return /^\d+$/.test(raw) ? raw : "0";
}

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function pausedPlatforms(): string {
  return process.env.PAUSED_PLATFORMS ?? "";
}

/** util/util-paused-platforms.yaml, verbatim logic. */
export function isSlPaused(paused = pausedPlatforms()): boolean {
  return paused
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes("sportlots");
}

function rand(max: number): number {
  return Math.floor(Math.random() * max);
}

export function makeEnv(): FlowEnv {
  const w = workerIndex();
  const attemptId = `pw${w}-a1-${rand(100000)}`;
  return {
    APP_URL: appUrl(),
    WORKER_INDEX: w,
    ATTEMPT_ID: attemptId,
    ATTEMPT_TOKEN: attemptId.split("-").join(""),
    TEST_USERNAME: `neontester-pw${w}-${Math.floor(Date.now() / 1000)}-${rand(100000)}`,
    PAUSED_PLATFORMS: pausedPlatforms(),
    SL_PAUSED: isSlPaused(),
  };
}
