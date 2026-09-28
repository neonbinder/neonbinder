// Shared helpers for running a shell script under a stubbed gcloud/python3
// PATH.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRE_NEO_309_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pre-neo-309",
);

export function runScript(scriptPath, args, env) {
  // Belt-and-suspenders against the script's `gcloud`/`python3` calls
  // silently resolving to something other than this test's PATH stub:
  //   - stubs.mjs strips BASH_ENV and any BASH_FUNC_* from `env` before it
  //     ever reaches here — that is the load-bearing fix. A non-interactive
  //     bash sources BASH_ENV (if set) and reconstitutes BASH_FUNC_* as
  //     shell functions *regardless* of --norc/--noprofile (verified: those
  //     flags only govern interactive/login startup files, which a
  //     `bash script.sh` invocation never reads anyway), so if either var
  //     were still present, a function literally named `gcloud` or `python3`
  //     would shadow the PATH lookup and run instead of the stub.
  //   - --norc --noprofile costs nothing and covers the (here, inapplicable)
  //     interactive/login-shell startup-file path too, in case this helper
  //     is ever reused to spawn one.
  const result = spawnSync("bash", ["--norc", "--noprofile", scriptPath, ...args], {
    env,
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Path to the frozen, committed pre-NEO-309 copy of a script (see
 * scripts/test/fixtures/pre-neo-309/README.md) — used instead of any git
 * history lookup, which is unavailable on a shallow CI checkout and would
 * silently point at the wrong commit the moment HEAD moves.
 */
export function preNeo309Fixture(basename) {
  return join(PRE_NEO_309_FIXTURES_DIR, basename);
}
