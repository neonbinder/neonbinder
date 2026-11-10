// Coverage for wait-preprocess-revision.sh (NEO-484). Stubs `gcloud` on PATH;
// node built-ins only, same house style as discord-notify-recovered.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "wait-preprocess-revision.sh");

// `tagged` null = the tag is absent; `previewSha` null = the env var is absent.
function makeGcloud({ tagged, previewSha }) {
  const dir = mkdtempSync(join(tmpdir(), "nb-gcloud-stub-"));
  const svc = { status: { traffic: tagged ? [{ tag: "pr-7", revisionName: tagged }] : [{ percent: 100 }] } };
  const env = previewSha === null ? [] : [{ name: "PREVIEW_SHA", value: previewSha }];
  const rev = { spec: { containers: [{ env }] } };
  writeFileSync(join(dir, "svc.json"), JSON.stringify(svc));
  writeFileSync(join(dir, "rev.json"), JSON.stringify(rev));
  const stub = `#!/usr/bin/env bash
if [ "$2" = "services" ]; then cat "${dir}/svc.json"; exit 0; fi
if [ "$2" = "revisions" ]; then cat "${dir}/rev.json"; exit 0; fi
exit 1
`;
  writeFileSync(join(dir, "gcloud"), stub);
  chmodSync(join(dir, "gcloud"), 0o755);
  return dir;
}

function run(state, extra = []) {
  const dir = makeGcloud(state);
  return spawnSync(
    "bash",
    [SCRIPT, "--project", "p", "--service", "svc", "--tag", "pr-7", "--sha", "abc123",
      "--attempts", "2", "--interval", "0", ...extra],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" },
  );
}

test("passes when the tagged revision carries the head sha", () => {
  const r = run({ tagged: "rev-2", previewSha: "abc123" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("fails with an ::error:: when the revision is the previous push's", () => {
  const r = run({ tagged: "rev-1", previewSha: "old999" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::svc tag pr-7 never served a revision built from abc123/);
  assert.match(r.stdout, /PREVIEW_SHA='old999'/);
});

test("fails when PREVIEW_SHA is unset on the revision", () => {
  const r = run({ tagged: "rev-1", previewSha: null });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /<unset>/);
});

test("fails when no revision serves the tag", () => {
  const r = run({ tagged: null, previewSha: "abc123" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no revision serves tag pr-7/);
});

test("usage error exits 2", () => {
  const r = spawnSync("bash", [SCRIPT, "--project", "p"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
