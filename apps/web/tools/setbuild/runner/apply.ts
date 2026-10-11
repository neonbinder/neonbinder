/**
 * NEO-339 — `apply`: run a spec, writing. The confirm phrase is checked
 * before anything touches the network (the spec is parsed locally first, so a
 * bad spec also costs nothing). Stops at the first decision the spec does not
 * answer and returns it with a fill-in template; a re-run resumes.
 */

import type { NbClient } from "../client/convex-client";
import { assertConfirm, type Target } from "../client/target";
import { specScope, type ApplyReport } from "../service";
import { parseSpec } from "../spec/schema";
import { runSpec, type RunOptions, type RunResult } from "./engine";

export type ApplyResult = ApplyReport & Pick<RunResult, "sessions">;

/** Check the phrase against the raw spec's scope, then parse. No network. */
export function confirmedSpec(target: Target, raw: unknown, confirm: string | undefined) {
  const declared = specScope(raw);
  if (declared) assertConfirm(target, declared, confirm);
  const spec = parseSpec(raw);
  assertConfirm(target, spec.scope, confirm);
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
