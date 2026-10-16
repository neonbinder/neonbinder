/**
 * NEO-224 — the set builder's drill as a query string, with nothing else in
 * the module.
 *
 * `useDrillUrlState` reads and writes the drill through these; the set-build
 * tool (NEO-339, a Node process) builds its Set Builder deep links through
 * the same ones. That is why they live apart from the hook: the hook pulls in
 * React, React Router and the Convex client, and a link needs none of them.
 * Pure on purpose — no imports beyond types.
 */
import type { SelectorLevel } from "./selector-sync-feedback";

/**
 * The cascade's levels, root first. Keep in step with `DRILL_LEVELS` in
 * `convex/drillPath.ts`: the resolver checks position n against level n, so
 * the two lists must agree.
 */
export const DRILL_LEVELS: readonly SelectorLevel[] = [
  "sport",
  "year",
  "manufacturer",
  "setName",
  "variantType",
  "insert",
  "parallel",
];

/** The query-string key for each level. Short, because people read URLs. */
export const DRILL_PARAMS: Readonly<Record<SelectorLevel, string>> = {
  sport: "sport",
  year: "year",
  manufacturer: "brand",
  setName: "set",
  variantType: "type",
  insert: "insert",
  parallel: "parallel",
};

/**
 * The params for `path`, in canonical order. Params that are not the drill's
 * (anything else a link carries) are kept as they were; the drill's own keys
 * are rewritten from scratch, so a stale deeper level can never survive.
 */
export function serializeDrillPath(
  path: readonly string[],
  base?: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const level of DRILL_LEVELS) next.delete(DRILL_PARAMS[level]);
  path.forEach((value, i) => {
    if (i < DRILL_LEVELS.length) next.append(DRILL_PARAMS[DRILL_LEVELS[i]], value);
  });
  return next;
}
