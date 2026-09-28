// Shared helpers for running a shell script under a stubbed gcloud/python3
// PATH, and for pulling an unmodified copy of a script out of HEAD so a test
// can prove it fails there and passes on the working tree's fixed version
// without ever needing `git stash`.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function runScript(scriptPath, args, env) {
  const result = spawnSync("bash", [scriptPath, ...args], {
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
 * Materializes the HEAD-committed version of a repo-relative script path
 * into a fresh temp file, so a test can run the pre-fix script without
 * touching the working tree (no `git stash`, which would be unsafe to run
 * concurrently with other work in this worktree).
 */
export function checkoutHeadCopy(repoRelativePath) {
  const contents = execFileSync("git", ["show", `HEAD:${repoRelativePath}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const dir = mkdtempSync(join(tmpdir(), "nb-head-copy-"));
  const dest = join(dir, repoRelativePath.split("/").pop());
  writeFileSync(dest, contents);
  chmodSync(dest, 0o755);
  return dest;
}
