import type { GenericId } from "convex/values";

/**
 * NEO-237 (D17) — the client sentinel for the All Brands VIEW.
 *
 * "All Brands" used to be a manufacturer row and the sets whose brand NB
 * could not identify hung off it. It is now a pinned entry at the top of
 * the Manufacturers column that means "show every set in this year, brand
 * alongside" — a lens on the year, not a row under it. It is selected by
 * this value, which is deliberately not a Convex id and can never collide
 * with one, so nothing downstream (the Attributes panel, the ancestor chain,
 * a delete) can be handed the view as if it were a row.
 *
 * A module of its own, with no component in it, so the cascade can import
 * the sentinel without importing the column that renders it.
 */
export const ALL_BRANDS_VIEW = "__all-brands-view__" as const;

/** What the Manufacturers column can hand back: a row, or the view. */
export type ManufacturerSelection =
  | GenericId<"selectorOptions">
  | typeof ALL_BRANDS_VIEW;

export const isAllBrandsView = (
  selection: ManufacturerSelection | null,
): selection is typeof ALL_BRANDS_VIEW => selection === ALL_BRANDS_VIEW;
