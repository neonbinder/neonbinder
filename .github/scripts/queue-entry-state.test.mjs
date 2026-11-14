// NEO-546 S5: queue-entry-state.sh with a stubbed `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "queue-entry-state.sh");

function run({ body, fail, pr = "12", repo = "acme/app" }) {
  const dir = mkdtempSync(join(tmpdir(), "nb-qe-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, fail ? "#!/usr/bin/env bash\nexit 1\n" : `#!/usr/bin/env bash\nprintf '%s' "$STUB_BODY"\n`);
  chmodSync(gh, 0o755);
  const r = spawnSync("bash", [SCRIPT], {
    env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: repo, PR: pr, STUB_BODY: body ?? "" },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout.trim(), stderr: r.stderr };
}
const pr = (entry) => JSON.stringify({ data: { repository: { pullRequest: { mergeQueueEntry: entry } } } });

test("non-null mergeQueueEntry -> present", () => {
  assert.equal(run({ body: pr({ id: "MQE_1" }) }).out, "entry=present");
});
test("null mergeQueueEntry -> absent", () => {
  assert.equal(run({ body: pr(null) }).out, "entry=absent");
});
test("API failure, empty body, garbage, errors, missing PR -> unknown", () => {
  assert.equal(run({ fail: true }).out, "entry=unknown");
  assert.equal(run({ body: "" }).out, "entry=unknown");
  assert.equal(run({ body: "<html>" }).out, "entry=unknown");
  assert.equal(run({ body: JSON.stringify({ errors: [{ message: "boom" }], data: null }) }).out, "entry=unknown");
  assert.equal(run({ body: JSON.stringify({ data: { repository: { pullRequest: null } } }) }).out, "entry=unknown");
});
test("bad inputs -> unknown, exit 0", () => {
  for (const o of [{ pr: "" }, { pr: "12; x" }, { repo: "noslash" }, { repo: "" }]) {
    const r = run({ body: pr(null), ...o });
    assert.equal(r.status, 0);
    assert.equal(r.out, "entry=unknown", JSON.stringify(o));
  }
});

test("N-b: every unknown prints a ::warning:: on stderr, known answers do not", () => {
  assert.match(run({ fail: true }).stderr, /::warning::/);
  assert.match(run({ body: "<html>" }).stderr, /::warning::/);
  assert.match(run({ body: pr(null), pr: "x" }).stderr, /::warning::/);
  assert.equal(run({ body: pr(null) }).stderr, "");
  assert.equal(run({ body: pr({ id: "x" }) }).stderr, "");
});

test("N-c: owner and name are passed with -f (strings), only the PR number with -F", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-qe-args-"));
  const gh = join(dir, "gh");
  const log = join(dir, "args.txt");
  writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\nprintf '%s' '{"data":{"repository":{"pullRequest":{"mergeQueueEntry":null}}}}'\n`);
  chmodSync(gh, 0o755);
  spawnSync("bash", [SCRIPT], { env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "acme/app", PR: "12" }, encoding: "utf8" });
  const args = readFileSync(log, "utf8").split("\n");
  const pair = (flag, kv) => args.some((a, i) => a === flag && args[i + 1] === kv);
  assert.ok(pair("-f", "owner=acme"));
  assert.ok(pair("-f", "name=app"));
  assert.ok(pair("-F", "pr=12"));
  assert.ok(!pair("-F", "owner=acme") && !pair("-F", "name=app"));
});
