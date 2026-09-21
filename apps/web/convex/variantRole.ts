/**
 * NEO-291 — what a variant-type row IS, and what that makes the rows beneath
 * it.
 *
 * ## The problem this exists to solve
 *
 * `metadata.isInsert` / `metadata.isParallel` on an `insert`-level row used
 * to be operator checkboxes in a "metadata box", defaulting to nothing. So a
 * parallel of the base set — an `insert`-level row that sits under the
 * PARALLEL variant type — carried no flag unless someone remembered to tick
 * one, and `deriveOwnLevelFeatures` then called its cards "Insert" at birth
 * (`features.cardType`), which is a listing-facing fact.
 *
 * Which of insert/parallel a row is was never a decision. It is a fact of
 * where the row sits: every `parallel`-level row is a parallel, and an
 * `insert`-level row is whatever its variant-type parent says the rows under
 * it are. So the flags are DERIVED here, once, at creation, and the box is
 * gone.
 *
 * ## Why the parent's role comes from a marketplace ID and never its name
 *
 * The invariant (CLAUDE.md, "Product invariant") allows exactly one
 * direction: a row may be derived from marketplace data when it is CREATED.
 * `metadata.isBase` is conferred that way — from BSC's own `base` variant id,
 * read out of the row's `variant`-tagged BSC slot by the sync that wrote it
 * (`syncWrittenBscFacet`, and the NEO-239 backfill for older rows). This
 * module reads the same slot for the other two roles, with the same token
 * rule (`isBscInsertVariantId` / `isBscParallelVariantId` beside
 * `isBscBaseVariantId` in bscFacets.ts). It never reads `row.value`: a
 * variant type called "Parallel" by an operator with no marketplace ids is a
 * row called "Parallel", and its children get no flag. That is the
 * fail-closed answer the invariant asks for, and the operator's per-row
 * attributes panel still shows what the derivation produced.
 *
 * ## Pure on purpose
 *
 * No `ctx`, no env, no FE import. The two functions take rows and return
 * flags so every creation site (`addCustomSelectorOption`, the two stores,
 * and the level moves in `applyParallelGroupings`) calls the one rule and
 * the unit tests can pin it without a database.
 */

import { isBscInsertVariantId, isBscParallelVariantId } from "./bscFacets";
import { slotEntries, slotFacet, type SlotBearingRow } from "./platformSlots";

/** The NB role a variant-type row plays, when it is known. */
export type VariantTypeRole = "base" | "insert" | "parallel";

/**
 * What `variantTypeRole` needs to see of a variant-type row. Structurally a
 * subset of `Doc<"selectorOptions">`, so a fetched row passes as-is; typed
 * loosely so the tests can hand it a literal.
 */
export type VariantRoleRow = Pick<SlotBearingRow, "platformData" | "platformFacets"> & {
  metadata?: { isBase?: boolean } | undefined;
};

/**
 * The flags a fresh row beneath a variant type is born with. Absent means
 * false — the `isBase` convention — so a row that is neither carries nothing
 * and `deriveOwnLevelFeatures` falls back to its level-only reading.
 */
export type DerivedVariantFlags = { isInsert?: true; isParallel?: true };

/**
 * The role of a variant-type row: `"base"` when NB has said so
 * (`metadata.isBase`), else whatever the id in the row's `variant`-tagged
 * BSC slot says, else `undefined`.
 *
 * Fail-closed at every step. No tagged slot — an untagged legacy slot, a row
 * with no BSC ids, or a `setName`-tagged extra — is no evidence. An id that
 * carries both the `insert` and `parallel` tokens, or two tagged slots that
 * disagree, is no evidence either: a guess here would put the wrong
 * `cardType` on every card created under the row, silently.
 */
export function variantTypeRole(
  row: VariantRoleRow | null | undefined,
): VariantTypeRole | undefined {
  if (!row) return undefined;
  if (row.metadata?.isBase === true) return "base";

  let sawInsert = false;
  let sawParallel = false;
  let sawTagged = false;
  for (const { slot, id } of slotEntries(row, "bsc")) {
    if (slotFacet(row, "bsc", slot) !== "variant") continue;
    sawTagged = true;
    if (isBscInsertVariantId(id)) sawInsert = true;
    if (isBscParallelVariantId(id)) sawParallel = true;
  }
  if (!sawTagged) return undefined;
  if (sawInsert && !sawParallel) return "insert";
  if (sawParallel && !sawInsert) return "parallel";
  return undefined;
}

/**
 * The `isInsert` / `isParallel` flags a row created at `level` under
 * `parentVariantTypeRow` is born with.
 *
 *   parallel-level row            → `{ isParallel: true }`, whatever the parent
 *   insert-level under "parallel" → `{ isParallel: true }` (a parallel of base)
 *   insert-level under "insert"   → `{ isInsert: true }`
 *   anything else                 → `undefined` (no flag written)
 *
 * The parent of a `parallel`-level row is an INSERT row, not a variant type,
 * which is why that branch never looks at it. The parent of an `insert`-level
 * row is the variant type; callers pass the row they already fetched for the
 * features copy-down. A `variantType`-level row or higher gets nothing: those
 * roles are `isBase` (NEO-239) and `isUnknownBrand` (NEO-272), decided
 * elsewhere.
 */
export function derivedVariantFlags(
  level: string,
  parentVariantTypeRow: VariantRoleRow | null | undefined,
): DerivedVariantFlags | undefined {
  if (level === "parallel") return { isParallel: true };
  if (level !== "insert") return undefined;
  const role = variantTypeRole(parentVariantTypeRow);
  if (role === "parallel") return { isParallel: true };
  if (role === "insert") return { isInsert: true };
  return undefined;
}

/**
 * `metadata` with its `isInsert` / `isParallel` REPLACED by `flags`, every
 * other key untouched. `undefined` when nothing is left, so a caller can
 * patch it straight onto the row and the field disappears rather than
 * persisting as `{}`.
 *
 * For the level moves in `applyParallelGroupings`: a row that changes level
 * changes what it is, so the old flags go with the old level — they are not
 * merged, because `{ isInsert: true, isParallel: true }` is not a row.
 */
export function withVariantFlags<M extends { isInsert?: boolean; isParallel?: boolean }>(
  metadata: M | undefined,
  flags: DerivedVariantFlags | undefined,
): (Omit<M, "isInsert" | "isParallel"> & DerivedVariantFlags) | undefined {
  const rest: Record<string, unknown> = { ...(metadata ?? {}) };
  delete rest.isInsert;
  delete rest.isParallel;
  const next = { ...rest, ...(flags ?? {}) } as Omit<M, "isInsert" | "isParallel"> &
    DerivedVariantFlags;
  return Object.keys(next).length > 0 ? next : undefined;
}
