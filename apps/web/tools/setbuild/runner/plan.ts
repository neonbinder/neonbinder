/**
 * NEO-339 — `plan`: every step of a spec and every decision it has to make,
 * without writing to NB. Runs the same walk as `apply` on `readOnlyClient`
 * (queries, plus the marketplace candidate read `fetchRawOptions`; every
 * mutation and every other action is refused before it is sent).
 */

import type { NbClient } from "../client/convex-client";
import type { Target } from "../client/target";
import type { PlanReport } from "../service";
import { parseSpec } from "../spec/schema";
import { runSpec, type RunOptions } from "./engine";
import { readOnlyClient } from "./read-only-client";

export async function planSpec(
  client: NbClient,
  target: Target,
  raw: unknown,
  opts: RunOptions = {},
): Promise<PlanReport> {
  const spec = parseSpec(raw);
  const r = await runSpec(readOnlyClient(client), target, spec, "plan", opts);
  return {
    target: r.target,
    scope: r.scope,
    confirmPhrase: r.confirmPhrase,
    steps: r.steps,
    openDecisions: r.openDecisions,
    template: r.template,
  };
}
