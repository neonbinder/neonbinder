/**
 * NEO-291 / NEO-334: what a variant-type row IS, and what that makes the rows
 * beneath it.
 *
 * ## A variant type's title is its kind (NEO-334, Jason 2026-10-10)
 *
 * A variant type called "Base" or "Bases" is the set's Base. One called "Insert" or
 * "Inserts" is an Insert type, and one called "Parallel" or "Parallels" is a
 * Parallel type. Every other title ("Promo", "Insert Set", "Base Parallels")
 * has no kind. No flag mirrors the title, and nothing keeps a flag in sync
 * with it, because there is no flag: the retired `metadata.isBase` (NEO-239)
 * and `metadata.variantRole` (NEO-306) were stripped from stored rows and
 * dropped from the schema in NEO-334.
 *
 * Why the title, when product invariant 4 says NB behaviour is never keyed on
 * a marketplace value or name:
 *
 *   - Base, Insert and Parallel are the hobby's own words for these three
 *     things, not one marketplace's labels. They are NB's vocabulary.
 *   - Sync never renames an NB row after creation (invariant 3). A
 *     marketplace's naming therefore matters exactly once, when the row is
 *     created, which is the one direction invariant 2 allows. After that the
 *     title is NB's, and so is the kind it carries.
 *   - A flag beside the title is a second answer to the same question, and
 *     two answers can disagree. Verified on prod 2026-10-10: every one of the
 *     variant types agreed, so dropping the flag changes no row's kind.
 *
 * Invariant 4 is unchanged for everything else: no other NB behaviour may be
 * derived from a display name.
 *
 * ## The word, exactly
 *
 * The title is trimmed, inner whitespace collapsed to one space, and
 * case-folded, then compared WHOLE against base | bases | insert | inserts |
 * parallel | parallels (singular and plural are the same word). No substring
 * matching: "Insert Set", "Inserts & Autographs",
 * "Base Set" and "Base Parallels" have no kind.
 *
 * ## Renames
 *
 * Base, Insert and Parallel keep their special processing (the sub-variant
 * column, Group Parallels, the base checklist, `features.cardType` at
 * creation), so a rename that changes a type's kind would silently change
 * what the rows already beneath it are. `variantTypeRenameOutcome` refuses
 * that while the type has rows beneath it; an empty type renames freely.
 * `features.cardType` is NOT re-derived on rename (Jason: renames are not
 * expected; the refusal is the whole of the handling).
 *
 * ## Pure on purpose
 *
 * No `ctx`, no env, no FE import. The database reads behind a rename refusal
 * live in `assertVariantTypeRenameAllowed` (lib/selectorAncestry.ts); every
 * rule they feed is here so the stores, the rename doors, the set builder and
 * the tests all ask one function.
 */

/** The NB kind a variant-type row is, read from its title. */
export type VariantTypeKind = "base" | "insert" | "parallel";

/** What the kind readers need to see of a variant-type row. */
export type VariantKindRow = { value?: string };

/**
 * A title reduced to the form two titles are compared in: trimmed, every run
 * of whitespace collapsed to one space, lower-cased.
 */
export function normalizedTitleWord(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const KIND_BY_WORD: Readonly<Record<string, VariantTypeKind>> = {
  base: "base",
  bases: "base",
  insert: "insert",
  inserts: "insert",
  parallel: "parallel",
  parallels: "parallel",
};

/**
 * The kind a variant-type title names, or `undefined` for every other title.
 * Exact word only (see the header): "Inserts" is an Insert type, "Insert Set"
 * is nothing.
 */
export function variantTypeKindFromTitle(
  value: string | undefined,
): VariantTypeKind | undefined {
  if (value === undefined) return undefined;
  const word = normalizedTitleWord(value);
  return Object.prototype.hasOwnProperty.call(KIND_BY_WORD, word)
    ? KIND_BY_WORD[word]
    : undefined;
}

/**
 * The kind of a variant-type row. Callers pass a `variantType`-level row; the
 * level is theirs to check, as it was when this read a flag.
 */
export function variantTypeKind(
  row: VariantKindRow | null | undefined,
): VariantTypeKind | undefined {
  if (!row) return undefined;
  return variantTypeKindFromTitle(row.value);
}

/**
 * Are two titles the same word? Equal after `normalizedTitleWord`, or equal
 * once one of them drops a single trailing "s": "Promo" and "Promos",
 * "Insert" and "Inserts", "Rated Rookie" and "Rated Rookies" are each one
 * word (Jason, 2026-10-10: singular and plural are the same word for every
 * title, so two siblings may not hold both).
 */
export function sameTitleWord(a: string, b: string): boolean {
  const x = normalizedTitleWord(a);
  const y = normalizedTitleWord(b);
  if (x === "" || y === "") return x === y;
  return x === y || `${x}s` === y || `${y}s` === x;
}

/**
 * The flags a fresh row beneath a variant type is born with. Absent means
 * false, so a row that is neither carries nothing and
 * `deriveOwnLevelFeatures` falls back to its level-only reading.
 */
export type DerivedVariantFlags = { isInsert?: true; isParallel?: true };

/**
 * The `isInsert` / `isParallel` reading of a row created at `level` under
 * `parentVariantTypeRow`. TRANSIENT (NEO-334): it feeds
 * `deriveOwnLevelFeatures` at creation and is never persisted on the row.
 *
 *   parallel-level row            → `{ isParallel: true }`, whatever the parent
 *   insert-level under "parallel" → `{ isParallel: true }` (a parallel of base)
 *   insert-level under "insert"   → `{ isInsert: true }`
 *   anything else                 → `undefined`
 *
 * The parent of a `parallel`-level row is an INSERT row, not a variant type,
 * which is why that branch never looks at it.
 */
export function derivedVariantFlags(
  level: string,
  parentVariantTypeRow: VariantKindRow | null | undefined,
): DerivedVariantFlags | undefined {
  if (level === "parallel") return { isParallel: true };
  if (level !== "insert") return undefined;
  const kind = variantTypeKind(parentVariantTypeRow);
  if (kind === "parallel") return { isParallel: true };
  if (kind === "insert") return { isInsert: true };
  return undefined;
}

/**
 * NEO-334: sub-variants (`parallel`-level rows) exist ONLY beneath an insert
 * of an Insert type. Never under the Base, a Parallel type, a Promo type, or
 * a type with no kind: the set builder shows no Sub-Variants column there,
 * so a row created there could never be seen or reached.
 *
 * `variantTypeRow` is the insert's PARENT, the variant type. Every creation
 * site of a `parallel`-level row asks this one rule (through
 * `assertSubVariantParent` in `lib/selectorAncestry.ts`), and the set
 * builder's column gate reads the same `variantTypeKind(...) === "insert"`.
 */
export function subVariantsAllowedUnder(
  variantTypeRow: VariantKindRow | null | undefined,
): boolean {
  return variantTypeKind(variantTypeRow) === "insert";
}

/** The `ConvexError` code a refused sub-variant creation carries. */
export const SUB_VARIANT_INSERT_ONLY = "SUB_VARIANT_INSERT_ONLY";

/** The operator's sentence for that refusal (Jason: keep). */
export const SUB_VARIANT_INSERT_ONLY_MESSAGE =
  "Sub-variants only live under an Insert type.";

/** The one `ConvexError` code the variant-type rename refusals carry. */
export const VARIANT_TYPE_RENAME_REFUSED = "VARIANT_TYPE_RENAME_REFUSED";

/**
 * The operator's sentences for the rename family. NB words only. The first
 * is Jason-approved; the rest are DRAFT copy pending his sign-off (NEO-245:
 * no copywriter).
 */
export const VARIANT_TYPE_RENAME_MESSAGES = {
  /** An Insert type renamed to another kind while sub-variants exist. */
  insertHasSubVariants:
    "Not so fast — some inserts under this type still have sub-variants, and sub-variants only live under an Insert type. Move them out first, then rename.",
  /** A type with rows beneath it renamed "Base". */
  toBaseWithRows:
    "Base is the end of the line — this type still has rows beneath it. Move them first, then make it the Base.",
  /** The Base renamed to another kind while its checklist hangs off it. */
  baseHasCards:
    "This is the set's Base and its checklist hangs right off it. Renaming it would hide those cards — keep it called Base.",
  /** A second type in one set titled "Base". */
  secondBase: "This set already has a Base.",
  /** Any other kind change while rows sit beneath the type. */
  kindChangeWithRows:
    "Whoa — that name changes what this type is, and it still has rows beneath it. Move them out first, then rename.",
} as const;

/**
 * The sentence for a title whose singular or plural a sibling already holds
 * ("Promo" beside "Promos"). DRAFT copy pending Jason's sign-off. For the
 * custom-add and rename doors' sibling guard.
 */
export function sameWordSiblingMessage(existingTitle: string): string {
  return `"${existingTitle}" is already here, and one word gets one row. Use that one instead.`;
}

/** What `variantTypeRenameOutcome` needs to know about the row's world. */
export type VariantTypeRenameFacts = {
  /** Any insert, sub-variant or card beneath the type. */
  hasRowsBeneath: boolean;
  /** Sub-variants found under the type's inserts (0 when none were seen). */
  subVariants: number;
  /** Cards hanging directly off the type (0 when none were seen). */
  cards: number;
  /** Another variant type in the same set is already the Base. */
  siblingBase: boolean;
};

export type VariantTypeRenameOutcome =
  | { ok: true }
  | {
      ok: false;
      code: typeof VARIANT_TYPE_RENAME_REFUSED;
      message: string;
    };

function refused(message: string): VariantTypeRenameOutcome {
  return { ok: false, code: VARIANT_TYPE_RENAME_REFUSED, message };
}

/**
 * May a variant type titled `current` be retitled `next`?
 *
 *   1. Exactly one Base per set: a title of "Base" is refused while another
 *      type in the set is the Base.
 *   2. The kind does not change (including a title with no kind becoming
 *      another title with no kind): allowed.
 *   3. The kind changes and the type is empty: allowed.
 *   4. The kind changes with rows beneath: refused, with the most specific
 *      sentence that applies (sub-variants under an Insert type, then a move
 *      TO Base, then the Base's own cards, then the general one).
 *
 * Pure; `assertVariantTypeRenameAllowed` gathers the facts.
 */
export function variantTypeRenameOutcome(
  current: string,
  next: string,
  facts: VariantTypeRenameFacts,
): VariantTypeRenameOutcome {
  const from = variantTypeKindFromTitle(current);
  const to = variantTypeKindFromTitle(next);
  if (to === "base" && facts.siblingBase) {
    return refused(VARIANT_TYPE_RENAME_MESSAGES.secondBase);
  }
  if (from === to) return { ok: true };
  if (!facts.hasRowsBeneath && facts.subVariants === 0 && facts.cards === 0) {
    return { ok: true };
  }
  if (from === "insert" && facts.subVariants > 0) {
    return refused(VARIANT_TYPE_RENAME_MESSAGES.insertHasSubVariants);
  }
  if (to === "base") {
    return refused(VARIANT_TYPE_RENAME_MESSAGES.toBaseWithRows);
  }
  if (from === "base" && facts.cards > 0) {
    return refused(VARIANT_TYPE_RENAME_MESSAGES.baseHasCards);
  }
  return refused(VARIANT_TYPE_RENAME_MESSAGES.kindChangeWithRows);
}
