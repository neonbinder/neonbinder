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
 * ## Where the parent's role comes from
 *
 * The invariant (CLAUDE.md, "Product invariant") allows exactly one
 * direction: a row may be derived from marketplace data when it is CREATED.
 * `metadata.isBase` (NEO-239) and, since NEO-306, `metadata.variantRole` are
 * conferred that way: the sync that writes a variantType row reads BSC's own
 * id out of the row's `variant`-tagged BSC slot ONCE (`bscVariantEvidence`,
 * with the token rule of `isBscInsertVariantId` / `isBscParallelVariantId` /
 * `isBscBaseVariantId` in bscFacets.ts) and records the answer as an NB flag;
 * the armed `backfillVariantTypeRole` does the same for older rows. From then
 * on `variantTypeRole` reads the flag and nothing else: until NEO-306 it
 * re-read the BSC slot at runtime, which keyed NB behaviour on a marketplace
 * value every time a child was created. It never reads `row.value`: a variant
 * type called "Parallel" by an operator is a row called "Parallel", and its
 * children get no flag.
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
export type VariantRoleRow = {
  metadata?:
    | { isBase?: boolean; variantRole?: "insert" | "parallel" }
    | undefined;
};

/**
 * What `bscVariantEvidence` reads: the row's BSC slots and their facet tags.
 * Structurally a subset of `Doc<"selectorOptions">`, or of the row a store is
 * about to insert (its allocated `platformData` plus the tagged facets).
 */
export type VariantEvidenceRow = Pick<SlotBearingRow, "platformData" | "platformFacets">;

/**
 * What the ids in a row's `variant`-tagged BSC slots say it is: `"insert"`,
 * `"parallel"`, `"ambiguous"` (an id carrying both tokens, or two tagged
 * slots that disagree) or `undefined` (no tagged slot, or tagged ids that
 * name neither role, e.g. BSC's `base` or `promo`).
 *
 * WRITE TIME ONLY (NEO-306). The conferral in both stores and the backfill
 * call it to decide `metadata.variantRole` once; no runtime reader may, which
 * is why `variantTypeRole` below does not. Fail-closed: `"ambiguous"` and
 * `undefined` write nothing. An untagged legacy slot or a `setName`-tagged
 * extra is no evidence, so a row whose slots were never tagged `variant`
 * needs `backfillVariantFacetAndBaseRole` first.
 */
export function bscVariantEvidence(
  row: VariantEvidenceRow | null | undefined,
): "insert" | "parallel" | "ambiguous" | undefined {
  if (!row) return undefined;
  let sawInsert = false;
  let sawParallel = false;
  for (const { slot, id } of slotEntries(row, "bsc")) {
    if (slotFacet(row, "bsc", slot) !== "variant") continue;
    if (isBscInsertVariantId(id)) sawInsert = true;
    if (isBscParallelVariantId(id)) sawParallel = true;
  }
  if (sawInsert && sawParallel) return "ambiguous";
  if (sawInsert) return "insert";
  if (sawParallel) return "parallel";
  return undefined;
}

/**
 * The `variantRole` a sync may ADD to a variantType row's metadata, or
 * `undefined` when it must add nothing: the row already carries a role, is
 * the Base, or its tagged BSC slots give no single answer. The one guard both
 * stores' patch and insert sites and the backfill share, so they cannot
 * decide differently.
 */
export function conferredVariantRole(
  metadata: { isBase?: boolean; variantRole?: string } | undefined,
  evidenceRow: VariantEvidenceRow | null | undefined,
): "insert" | "parallel" | undefined {
  if (metadata?.variantRole !== undefined) return undefined;
  if (metadata?.isBase === true) return undefined;
  const evidence = bscVariantEvidence(evidenceRow);
  return evidence === "insert" || evidence === "parallel" ? evidence : undefined;
}

/**
 * The flags a fresh row beneath a variant type is born with. Absent means
 * false — the `isBase` convention — so a row that is neither carries nothing
 * and `deriveOwnLevelFeatures` falls back to its level-only reading.
 */
export type DerivedVariantFlags = { isInsert?: true; isParallel?: true };

/**
 * The role of a variant-type row: `"base"` when NB has said so
 * (`metadata.isBase`), else NB's `metadata.variantRole`, else `undefined`.
 *
 * Flags only (NEO-306). No marketplace id is read here: the BSC slot was read
 * once, when the flag was conferred. A row with no flag has no role and the
 * rows beneath it get no insert/parallel flag, which is the fail-closed
 * answer — a guess would put the wrong `cardType` on every card created
 * under the row, silently.
 */
export function variantTypeRole(
  row: VariantRoleRow | null | undefined,
): VariantTypeRole | undefined {
  if (!row) return undefined;
  if (row.metadata?.isBase === true) return "base";
  return row.metadata?.variantRole;
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
