/**
 * Reading every Maestro flow off disk, safely, while something else may be
 * writing one.
 *
 * Two unit tests (`maestro-flow-names.test.mjs`, `maestro-pairing-sync.test.mjs`)
 * glob and read all ~105 files under `.maestro/flows` on every run. That is
 * normally fine — but NeonBinder's whole working model is parallel agents
 * editing flows in ONE worktree while other work runs in the same worktree, so
 * a test run overlapping a flow edit is routine, not exotic.
 *
 * A plain `readFileSync` during such an edit can return an EMPTY or PARTIAL
 * file. Measured on this machine (NEO-260, 2026-09-09): a reader looping over
 * the flows directory while a Python `open(path, "w")` rewrote one file saw
 * **3,250 empty and 23,917 partial reads out of 32,925**. Python truncates on
 * open and then writes in chunks, so the file is observably short for the whole
 * write. Node's `writeFileSync` did NOT reproduce it (0 torn reads in 22,625),
 * which is why this only bites when a script — or an agent's editing tool — is
 * the writer.
 *
 * Why that is worse than a normal flake: a torn read does not throw. It parses
 * as "a flow with no `name:`", which `flowNames()` silently drops — so the
 * suite fails on a COUNT assertion (`length > 50`) and blames the glob or the
 * flows, pointing at everything except the actual cause.
 *
 * The fix is a stable read: re-read until two consecutive reads are
 * byte-identical. A file nobody is writing satisfies that on the first retry
 * and costs one extra read; a file mid-write settles as soon as the writer
 * closes it. This deliberately does NOT paper over a genuinely malformed flow —
 * the content is returned unchanged and every assertion still runs against it.
 */
import { readFileSync, statSync } from "node:fs";

/** Attempts before giving up and reporting what we saw. */
const MAX_ATTEMPTS = 12;

/**
 * Read a file, retrying until the content stops changing under us.
 *
 * Two independent checks, because stability ALONE is not enough: measured
 * against a writer rewriting in a tight loop, "two consecutive identical reads"
 * still returned torn content 94 times in 6,518 attempts — the same partial
 * state can repeat. So each read must ALSO account for the whole file as the
 * filesystem currently reports it (`byteLength === statSync().size`), and only
 * then be confirmed by a matching second read.
 *
 * Throws rather than returning torn content: a caller must never silently treat
 * a half-written flow as a flow that failed a rule.
 */
export function readFileStable(path) {
  let previous = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let buf;
    try {
      buf = readFileSync(path);
      // A short read is a write in progress. Comparing BYTES, not characters —
      // these files contain em dashes, so utf8 length != byte length.
      if (buf.length === 0 || buf.length !== statSync(path).size) {
        previous = null;
        continue;
      }
    } catch (err) {
      // ENOENT mid-write (a writer replacing rather than truncating) is the
      // same race; retry it rather than failing the suite.
      if (err.code !== "ENOENT") throw err;
      previous = null;
      continue;
    }
    const text = buf.toString("utf8");
    if (previous !== null && text === previous) return text;
    previous = text;
  }
  throw new Error(
    `read-flow-files: ${path} kept changing across ${MAX_ATTEMPTS} reads — ` +
      `something is writing it while the tests run. This is a concurrency ` +
      `problem, not a flow problem: do not "fix" it by relaxing an assertion.`,
  );
}
