/**
 * NEO-239 — `process.env` does not belong to one test file.
 *
 * ## The bug this closes
 *
 * Vitest's default `forks` pool reuses a worker process across test FILES.
 * Module state is re-imported per file, so it is isolated; `process.env` is
 * not — it lives on the process, and every assignment a test makes is visible
 * to every later file that worker happens to run.
 *
 * The convex suite assigns env liberally and by hand, and the counts did not
 * balance: `placeholderEscalation.test.ts` set `NEONBINDER_PREPROCESS_URL` and
 * never cleared it, `adapters.preprocess.test.ts` set thirteen values against
 * five deletes, `machineAuth.test.ts` five against three. The symptom was a
 * full run failing 3-7 tests at random — always in a LATER file, always as
 * "the marketplace returned nothing", because a leaked
 * `NEONBINDER_BROWSER_URL` / `NEONBINDER_PREPROCESS_URL` pointing at a dead
 * loopback port makes the adapter's credential fetch fail exactly the way a
 * missing credential does. Each file passed alone, which is what made it look
 * like flake rather than a leak.
 *
 * `delete process.env.X` is the same bug wearing the other hat: a file that
 * "cleans up" by deleting a variable the environment legitimately had removes
 * it for every later file too.
 *
 * ## Why here rather than in fifteen files
 *
 * Because the fifteenth file is not the last one. A per-file convention that
 * has already been forgotten a dozen times will be forgotten again, and the
 * failure it produces lands somewhere else entirely — the most expensive kind
 * of bug to trace. This makes the isolation a property of the runner, exactly
 * as the network guard (NEO-188) did for `fetch`, and for the same reason: a
 * rule only some files honour is not a rule.
 *
 * ## Two snapshots, because there are two scopes
 *
 * `beforeEach` → `afterEach` restores what the FILE set up (a `beforeAll`
 * assignment survives, a test-body assignment does not leak to the next test).
 * Module scope → `afterAll` restores what the file INHERITED, so nothing
 * escapes into the next file in this worker.
 *
 * A test that wants to set env still just sets it. Nothing here needs calling.
 */
import { afterAll, afterEach, beforeEach } from "vitest";

type Env = Record<string, string | undefined>;

/** Restore `process.env` to exactly `snapshot`, additions and deletions alike. */
function restoreEnv(snapshot: Env): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else if (process.env[key] !== value) process.env[key] = value;
  }
}

/**
 * Taken when this setup module is evaluated — once per test FILE, before any
 * of that file's `beforeAll` hooks run. This is the environment the file
 * inherited, and the one the next file in this worker must also inherit.
 */
const fileEntryEnv: Env = { ...process.env };

/** Re-taken per test, so a file-level `beforeAll` assignment is not undone. */
let testEntryEnv: Env = { ...process.env };

beforeEach(() => {
  testEntryEnv = { ...process.env };
});

afterEach(() => {
  restoreEnv(testEntryEnv);
});

afterAll(() => {
  restoreEnv(fileEntryEnv);
});
