/**
 * NEO-239 — "is this variantType row the Base set?" as an NB ROLE, read off
 * the row, never inferred from its name.
 *
 * Base used to be detected by matching the display value against the literal
 * `"base"`, in five places across the client and the server. That made a row's
 * NAME load-bearing code: renaming "Base" broke terminal detection, column
 * hiding and the Base mapping panel, which is why variantType rows were
 * refused a rename at all. It also pointed the wrong way — the literal came
 * from BuySportsCards' `base` variant facet, so NB behaviour was keyed on a
 * marketplace value.
 *
 * The role now lives on the row as `metadata.isBase`, written once when the
 * row is created (from a BSC `base` slot, or by the operator picking it) and
 * never derived at read time. There is deliberately NO name fallback: a row
 * either carries the flag or it does not, and a row that does not is simply
 * not the base set. Adding "…or the value says base" would reintroduce exactly
 * the coupling this replaced, and would make renaming unsafe again.
 *
 * `metadata` is typed `unknown` here rather than as the row's own metadata
 * object so the single read works for both callers: the typed Convex document
 * in `modules/SetSelector`, and `EntitySelector`'s deliberately loose
 * `SelectorItem` index signature.
 */
export function isBaseRole(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { isBase?: unknown }).isBase === true
  );
}
