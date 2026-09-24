/**
 * Parity between `preprocessCapacity.json` (the single source of truth,
 * NEO-299) and the workflow `env:` literals that pass `--max-instances` to
 * each preprocess Cloud Run deploy.
 *
 * `scripts/check-capacity-parity.sh` is the full CI gate (`capacity-parity` in
 * pr-pipeline.yml): it checks these same workflow literals AND fetches the
 * `neonbinder_ioc` Terraform tfvars over the network to check those too. This
 * test deliberately covers only the workflow-literal half, with NO network
 * call (NEO-188 forbids one from a unit test regardless), so it runs in the
 * fast local gate (`npm run test:unit`) rather than only in CI. If a future
 * change to the workflow files renames or re-values one of these literals
 * without updating the JSON (or vice versa), this is the test that catches it
 * before a push, not just at CI.
 *
 * A strict regex rather than a YAML parser: `js-yaml` is not a dependency of
 * apps/web, and the six literals this test reads are always a plain
 * `NAME: <integer>` line under a workflow's top-level `env:` block — a shape
 * simple enough that a full parser would add a dependency to prove nothing
 * further.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import capacity from "./preprocessCapacity.json";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

/** Read one workflow file's text, failing loudly if it has moved. */
function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), "utf8");
}

/**
 * Pull `NAME: <integer>` out of a workflow's text. Throws (rather than
 * returning undefined) when the literal is missing, so a rename shows up as a
 * test failure naming exactly which variable vanished, instead of a silent
 * `undefined !== 12`.
 */
function envLiteral(text: string, name: string): number {
  const match = new RegExp(`^\\s*${name}:\\s*(\\d+)\\s*$`, "m").exec(text);
  if (!match) {
    throw new Error(
      `${name} not found as a plain "NAME: <integer>" env literal — has it been renamed or moved out of an env: block?`,
    );
  }
  return Number(match[1]);
}

describe("preprocessCapacity.json matches the workflow literals it documents", () => {
  test("preprocess-deploy.yml's dev/prod literals equal the JSON's dev/prod values", () => {
    const text = readWorkflow("preprocess-deploy.yml");
    expect(envLiteral(text, "DEV_HEAVY_MAX_INSTANCES")).toBe(capacity.heavy.dev);
    expect(envLiteral(text, "PROD_HEAVY_MAX_INSTANCES")).toBe(capacity.heavy.prod);
    expect(envLiteral(text, "DEV_FAST_MAX_INSTANCES")).toBe(capacity.fast.dev);
    expect(envLiteral(text, "PROD_FAST_MAX_INSTANCES")).toBe(capacity.fast.prod);
  });

  test("preprocess.yml's preview literals equal the JSON's preview values", () => {
    const text = readWorkflow("preprocess.yml");
    expect(envLiteral(text, "PREVIEW_HEAVY_MAX_INSTANCES")).toBe(capacity.heavy.preview);
    expect(envLiteral(text, "PREVIEW_FAST_MAX_INSTANCES")).toBe(capacity.fast.preview);
  });
});
