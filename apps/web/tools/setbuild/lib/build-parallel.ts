/**
 * NEO-339 — "Build from Base" for one Parallel row: the same
 * `getParallelsForBuild` plan the panel reads, the same send-or-not rule
 * (`planParallelBuildOrder` → `initialLine`), and one `buildParallelChecklist`.
 *
 * Idempotent: a row that already has cards is skipped unless the spec says
 * `rebuild: true`. A row the server would refuse (no marketplace id of its own,
 * or `blocked`) is reported, never sent.
 */

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { planParallelBuildOrder } from "../../../lib/set-build/parallel-build";
import type { NbClient } from "../client/convex-client";
import { pickExactlyOne } from "../spec/resolve";
import { cardCount } from "./commit";

export type ParallelBuildResult = FunctionReturnType<typeof api.parallelChecklistBuild.buildParallelChecklist>;
export type ParallelsPlan = FunctionReturnType<typeof api.parallelChecklistBuild.getParallelsForBuild>;

export class BuildParallelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildParallelError";
  }
}

export interface BuildParallelInput {
  /** The row the parallels hang off: a Parallel variant type (built from Base) or an insert. */
  sourceId: Id<"selectorOptions">;
  /** The parallel row's exact NB name. */
  name: string;
  rebuild?: boolean;
  expectCards?: number;
  at: string;
}

export type BuildParallelOutcome =
  | { outcome: "skipped"; cards: number; detail: string }
  | { outcome: "built"; built: number; cards: number; result: ParallelBuildResult };

/** What a build of `name` would do, without building (read-only). */
export async function planParallelBuild(
  client: NbClient,
  input: BuildParallelInput,
): Promise<{ status: "done" | "todo" | "blocked"; detail: string; parallelId?: Id<"selectorOptions"> }> {
  const plan = await client.query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: input.sourceId });
  const entry = pickExactlyOne(
    plan.parallels.map((p) => ({ ...p, _id: String(p._id) })),
    input.name,
    "parallel",
    input.at,
  );
  const parallelId = entry._id as Id<"selectorOptions">;
  if (!plan.source) return { status: "blocked", detail: plan.sourceBlocked ?? "no source to build from", parallelId };
  if (entry.hasCards && !input.rebuild) return { status: "done", detail: "already has cards", parallelId };
  const { entries } = planParallelBuildOrder({ parallels: [{ ...entry, _id: parallelId }] });
  const line = entries[0].line;
  if (line.kind === "blocked") return { status: "blocked", detail: line.reason ?? "the server would refuse it", parallelId };
  if (line.kind === "skipped") {
    return { status: "blocked", detail: "the row holds no marketplace id of its own to link cards on", parallelId };
  }
  if (!plan.source.hasCards) return { status: "blocked", detail: `${plan.source.value} has no cards to build from`, parallelId };
  return {
    status: "todo",
    detail: `${entry.hasCards ? "rebuild" : "build"} ${entry.value} from ${plan.source.value}`,
    parallelId,
  };
}

/** Build one parallel's checklist. Writes; the caller has already checked the confirm phrase. */
export async function buildParallelFromBase(client: NbClient, input: BuildParallelInput): Promise<BuildParallelOutcome> {
  const planned = await planParallelBuild(client, input);
  const parallelId = planned.parallelId!;
  if (planned.status === "done") {
    const cards = await cardCount(client, parallelId);
    if (input.expectCards !== undefined && cards !== input.expectCards) {
      throw new BuildParallelError(
        `${input.at}: "${input.name}" already holds ${cards} cards and the spec expects ${input.expectCards}; ` +
          "set buildFromBase.rebuild to rebuild it.",
      );
    }
    return { outcome: "skipped", cards, detail: `already holds ${cards} cards` };
  }
  if (planned.status === "blocked") {
    throw new BuildParallelError(`${input.at}: cannot build "${input.name}": ${planned.detail}.`);
  }
  const result = await client.action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId });
  if (result.status !== "built") {
    throw new BuildParallelError(
      `${input.at}: the build of "${input.name}" was refused: ${result.blockedReason ?? "no reason given"}` +
        (result.deletedCount ? ` (${result.deletedCount} old cards were already removed; build it again)` : "") +
        ".",
    );
  }
  const cards = await cardCount(client, parallelId);
  if (input.expectCards !== undefined && cards !== input.expectCards) {
    throw new BuildParallelError(
      `${input.at}: built ${result.copied} cards onto "${input.name}"; it now holds ${cards}, the spec expects ${input.expectCards}.`,
    );
  }
  return { outcome: "built", built: result.copied, cards, result };
}
