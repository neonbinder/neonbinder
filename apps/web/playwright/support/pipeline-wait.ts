import { test } from "./fixtures";

/**
 * The ceiling of a wait on the preprocess pipeline's fast path (upload, extract,
 * read, pair) in the Add cards specs: the 180 s `pipeline-pairs-uploaded-scans`
 * uses. It is not one of hard rule 3's named exceptions, so it carries the
 * owner's decision (NEO-446): each wait is measured with `measuredWait`, and the
 * numbers go to the owner before the ceiling is settled.
 */
export const PIPELINE = 180_000;

/**
 * Record how long a PIPELINE wait took, as a report annotation (type "pipeline
 * wait") and a line in the run's output, so the ceiling is argued from real
 * numbers. `since` is a `Date.now()` taken just before the action that started it.
 */
export function measuredWait(wait: string, since: number): number {
  const ms = Date.now() - since;
  test.info().annotations.push({ type: "pipeline wait", description: `${wait}: ${ms} ms` });
  console.log(`pipeline wait [${test.info().project.name}] ${wait}: ${ms} ms`);
  return ms;
}
