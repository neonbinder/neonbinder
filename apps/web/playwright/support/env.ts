/**
 * Per-test environment: the Playwright equivalent of the `-e` variables the
 * Maestro runners pass (`run-e2e-queue.sh` / `run-e2e-smoke.sh`).
 *
 * | Maestro (-e)       | Here                    | Notes                                   |
 * |--------------------|-------------------------|-----------------------------------------|
 * | APP_URL            | config `use.baseURL`     | goto('/path') is relative to it         |
 * | WORKER_INDEX       | env.WORKER_INDEX         | from process.env.WORKER_INDEX (CI: shard-1) |
 * | ATTEMPT_ID         | env.ATTEMPT_ID           | `pw<worker><d|m>-a1-<random>` (fresh per test) |
 * | (flow-set) ATTEMPT_TOKEN | env.ATTEMPT_TOKEN  | ATTEMPT_ID with hyphens stripped         |
 * | TEST_USERNAME      | env.TEST_USERNAME        | fresh per test, ^[a-z0-9-]+$             |
 * | (new) WORKER_KEY   | env.WORKER_KEY           | `<worker><d|m>`: per worker AND project  |
 * | PAUSED_PLATFORMS   | env.PAUSED_PLATFORMS     | from process.env.PAUSED_PLATFORMS        |
 * | output.SL_PAUSED   | env.SL_PAUSED            | util-paused-platforms.yaml's boolean     |
 *
 * ATTEMPT_ID spelling: CI Maestro used `r<n>-a<attempt>-<RANDOM>` and local
 * Maestro `w<n>-a<attempt>-<RANDOM>`. Playwright uses `pw<n><p>-a1-<random>`,
 * where <p> is the project marker: `d` for the desktop projects (`e2e`, and
 * `setup`/`bootstrap`), `m` for `e2e-mobile`. Every spec runs on both
 * projects on the same worker, one after the other, and nothing deletes a
 * minted row mid-run, so the mobile run must never mint the desktop run's
 * names: the marker makes `pw3da112345` and `pw3ma112345` different tokens by
 * construction, not by the luck of the random half. Retries are off
 * (retries: 0), so the attempt is always 1.
 *
 * WORKER_KEY (`3d` / `3m`) is the same marker for per-WORKER names (a
 * hand-made set `cft-${env.WORKER_KEY}`): one private row per worker per
 * project. WORKER_INDEX stays the bare account number: it picks the test
 * account (`signIn`'s `worker=`) and names what that account's bootstrap
 * seeded, and is shared by both projects.
 */

export interface FlowEnv {
  APP_URL: string;
  WORKER_INDEX: string;
  /** WORKER_INDEX plus the project marker (`3d` / `3m`): for per-worker names. */
  WORKER_KEY: string;
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

/**
 * `m` for the mobile project, `d` for every other (desktop) project. Keyed on
 * the `-mobile` suffix so a future `setup-mobile` would follow suit.
 */
export function projectMarker(projectName: string): "d" | "m" {
  return projectName.endsWith("-mobile") ? "m" : "d";
}

function rand(max: number): number {
  return Math.floor(Math.random() * max);
}

/** `projectName` is the running test's `testInfo.project.name`. */
export function makeEnv(projectName: string): FlowEnv {
  const w = workerIndex();
  const key = `${w}${projectMarker(projectName)}`;
  const attemptId = `pw${key}-a1-${rand(100000)}`;
  return {
    APP_URL: appUrl(),
    WORKER_INDEX: w,
    WORKER_KEY: key,
    ATTEMPT_ID: attemptId,
    ATTEMPT_TOKEN: attemptId.split("-").join(""),
    TEST_USERNAME: `neontester-pw${key}-${Math.floor(Date.now() / 1000)}-${rand(100000)}`,
    PAUSED_PLATFORMS: pausedPlatforms(),
    SL_PAUSED: isSlPaused(),
  };
}
