/**
 * NEO-339 — `apply`: run a spec, writing. The spec is parsed and the confirm
 * phrase checked before anything touches the network; the phrase carries the
 * parsed spec's digest, so it confirms this spec and no edited copy of it.
 * With `stopAt: "first"` (the default) it stops at the first decision the spec
 * does not answer; with `"end"` it runs every step that does not depend on an
 * open decision and returns them all. Either way the report carries a fill-in
 * template, and a re-run resumes.
 */

import type { NbClient } from "../client/convex-client";
import { assertPhrase, type Target } from "../client/target";
import { specConfirmPhrase, type ApplyReport } from "../service";
import { parseSpec } from "../spec/schema";
import { runSpec, type RunOptions, type RunResult } from "./engine";

export type ApplyResult = ApplyReport & Pick<RunResult, "sessions">;

/** Parse the spec, then check the phrase against it. No network. */
export function confirmedSpec(target: Target, raw: unknown, confirm: string | undefined) {
  const spec = parseSpec(raw);
  assertPhrase(specConfirmPhrase(target, spec), confirm);
  return spec;
}

export async function applySpec(
  client: NbClient,
  target: Target,
  raw: unknown,
  confirm: string | undefined,
  opts: RunOptions = {},
): Promise<ApplyResult> {
  const spec = confirmedSpec(target, raw, confirm);
  return runSpec(client, target, spec, "apply", opts);
}

/** The report without the in-process review sessions (for JSON / MCP output). */
export function publicApplyReport(r: ApplyResult): ApplyReport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sessions: _sessions, ...report } = r;
  return report;
}
