/**
 * NEO-339 — `apply`: run a spec, writing. The spec is parsed and the confirm
 * phrase checked before anything touches the network; the phrase carries the
 * parsed spec's digest, so it confirms this spec and no edited copy of it.
 * With `stopAt: "first"` (the default) it stops at the first decision the spec
 * does not answer; with `"end"` it runs every step that does not depend on an
 * open decision and returns them all. Either way the report carries a fill-in
 * template, and a re-run resumes.
 *
 * A run ends by reading what every set it reached still needs from a person
 * (runner/attention.ts, queries only): each `setLinks` entry gains
 * `attention`, and `attentionLine` says "Built and all clear." only when
 * nothing on any of them is waiting. A build that leaves "1 needs you" is
 * reported as that, never as done. Reading it never costs the report: a set
 * whose attention cannot be read says so in the line.
 */

import type { NbClient } from "../client/convex-client";
import { assertPhrase, type Target } from "../client/target";
import { formatPath, specConfirmPhrase, type ApplyReport, type AttentionSummary, type SetPath } from "../service";
import { parseSpec, type SetBuildSpec } from "../spec/schema";
import { applyEndLine, attentionSummaryOf } from "./attention";
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
  const result = await runSpec(client, target, spec, "apply", opts);
  return withAttention(client, spec, result);
}

/** The set path each `setLinks` entry names, from the spec's own set steps. */
function setPathsOf(spec: SetBuildSpec): Map<string, SetPath> {
  const out = new Map<string, SetPath>();
  for (const step of spec.steps) {
    if (step.kind !== "set") continue;
    const p = step.path as SetPath;
    const path: SetPath = { sport: p.sport, year: String(p.year), manufacturer: p.manufacturer, set: p.set };
    out.set(formatPath(path), path);
  }
  return out;
}

/** Each reached set's attention, and the run's last line. */
async function withAttention(client: NbClient, spec: SetBuildSpec, result: ApplyResult): Promise<ApplyResult> {
  const paths = setPathsOf(spec);
  const read: Array<{ path: string; attention?: AttentionSummary; error?: string }> = [];
  const setLinks = [];
  for (const link of result.setLinks ?? []) {
    const path = paths.get(link.path);
    if (!path) {
      setLinks.push(link);
      continue;
    }
    try {
      const attention = await attentionSummaryOf(client, path);
      read.push({ path: link.path, attention });
      setLinks.push({ ...link, attention });
    } catch (err) {
      read.push({ path: link.path, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      setLinks.push(link);
    }
  }
  const stopped = result.stops?.length ?? (result.stoppedAt ? 1 : 0);
  const attentionLine = applyEndLine(read, stopped);
  return { ...result, setLinks, ...(attentionLine ? { attentionLine } : {}) };
}

/** The report without the in-process review sessions (for JSON / MCP output). */
export function publicApplyReport(r: ApplyResult): ApplyReport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sessions: _sessions, ...report } = r;
  return report;
}
