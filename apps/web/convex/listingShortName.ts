/**
 * NEO-335 — the ONE rule for `selectorOptions.metadata.listingShortName`, and
 * the ONE reading of a set chain's title facts.
 *
 * Two doors write the short name — the attributes panel's
 * `setSelectorOptionListingShortName` and the card-checklist commit's
 * batch-level `listingShortName` (the wizard's Card titles step) — and both
 * call `normalizeListingShortName`, so they cannot apply two rules (the
 * NEO-291 finding `cardNumberPrefix.ts` exists for).
 *
 * Four walks read a chain for a new card's title — the commit prelude,
 * `findAncestorLabels` (hand-added cards and Regenerate), `titleSetFacts` (the
 * pre-save Card titles step) and the parallel build — and all four hand the
 * rows they walked to `titleChainFacts`, so the title shown before save, the
 * one written at insert and the one Regenerate offers read the same rows the
 * same way.
 *
 * Pure and dependency-light on purpose (`convex/values` only), so the SPA may
 * import the cap and the rule (see reference memory: client imports from
 * convex only pure modules).
 */

import { ConvexError, v } from "convex/values";

/**
 * Ceiling on a short name. A title is 80 characters and the short name stands
 * in for the set and insert words of its core; anything near 60 is not short.
 */
export const MAX_LISTING_SHORT_NAME_LENGTH = 60;

/** The levels a short name may live on: the set and everything under it. */
export const LISTING_SHORT_NAME_LEVELS: ReadonlySet<string> = new Set([
  "setName",
  "variantType",
  "insert",
  "parallel",
]);

/**
 * Trim `raw` and return the short name to store, or `undefined` when it is
 * blank — `""` is never stored (the NEO-217 spelling).
 *
 * Throws a STRING `ConvexError` — the shape `userFacingMessage` shows
 * verbatim — for a line break, a control character or an invisible character
 * (a title nobody can see the fault in), or for one over the ceiling.
 */
export function normalizeListingShortName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // One Unicode-property test (NEO-335 security re-audit), not hand-listed
  // ranges: Cc covers C0 and C1 controls (incl. NEL U+0085), Zl/Zp the line
  // and paragraph separators, Cf every format character (zero-widths, bidi
  // overrides and isolates, LRM/RLM, the soft hyphen, U+061C, tag characters,
  // the BOM). No literal invisible character appears in this source.
  const forbidden = trimmed.match(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  if (forbidden) {
    throw new ConvexError(
      /\p{Cf}/u.test(forbidden[0])
        ? "A short name cannot contain zero-width or invisible characters."
        : "A short name cannot contain line breaks or control characters.",
    );
  }
  if (trimmed.length > MAX_LISTING_SHORT_NAME_LENGTH) {
    throw new ConvexError(
      `A short name is at most ${MAX_LISTING_SHORT_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/** The fields of a chain row `titleChainFacts` reads. */
export type TitleChainRow = {
  level: string;
  value: string;
  metadata?: {
    isInsert?: boolean;
    isParallel?: boolean;
    listingShortName?: string;
  };
};

/**
 * The chain's title facts: the four `ListingSetContext` fields NEO-335 adds.
 * Every key is omitted when it has nothing to say, so a set with no insert
 * role, no parallel leaf and no short name hands its chunks exactly the
 * context it did before.
 */
export type TitleChainFacts = {
  /** The insert-level row's value — only when that row carries `isInsert`. */
  insertNameValue?: string;
  /** Always `true` when present; absent means "no insert in the core". */
  insertIsRole?: boolean;
  /** The LEAF's own value — only when the leaf carries `isParallel`. */
  parallelLeafValue?: string;
  /** The nearest self-or-ancestor short name, up to the setName row. */
  listingShortName?: string;
};

/**
 * The validator fields for `TitleChainFacts`, spread into every hand-kept
 * validator that carries a set context (the prelude's returns, the chunk's
 * args, `titleContextValidator`), so a fifth field is added in one place.
 */
export const titleChainFactsFields = {
  insertNameValue: v.optional(v.string()),
  insertIsRole: v.optional(v.boolean()),
  parallelLeafValue: v.optional(v.string()),
  listingShortName: v.optional(v.string()),
};

/**
 * Read the title facts off a chain, LEAF FIRST. Rows past the first `setName`
 * row are ignored, so a caller may pass the whole chain up to the sport.
 *
 * Roles only, never names or levels alone (product invariant 4): the insert
 * name enters on the insert-level row's `isInsert` (an insert-level row under
 * a parallels-type variant carries `isParallel` instead and is not an
 * insert); the leaf's value is a parallel name only on its `isParallel`.
 */
export function titleChainFacts(
  leafFirst: ReadonlyArray<TitleChainRow | null | undefined>,
): TitleChainFacts {
  const facts: TitleChainFacts = {};
  let insertSeen = false;
  for (const [index, row] of leafFirst.entries()) {
    if (!row) break;
    if (index === 0 && row.metadata?.isParallel === true) {
      facts.parallelLeafValue = row.value;
    }
    if (row.level === "insert" && !insertSeen) {
      insertSeen = true;
      if (row.metadata?.isInsert === true) {
        facts.insertNameValue = row.value;
        facts.insertIsRole = true;
      }
    }
    const short = row.metadata?.listingShortName?.trim();
    if (short && facts.listingShortName === undefined) {
      facts.listingShortName = short;
    }
    if (row.level === "setName") break;
  }
  return facts;
}
