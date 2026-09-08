/**
 * NEO-239 — is a marketplace REACHABLE from this ancestor chain?
 *
 * ## What this replaces
 *
 * `isCustomSubtree` (NEO-22/NEO-47) answered a different question: "did a human
 * type any row on this path?". One `isCustom` boolean gated BOTH marketplaces
 * for the whole subtree, forever — "once custom, always custom".
 *
 * That is the wrong question, and it made a row's behaviour depend on how it
 * came into being rather than on what it carries. NB owns the data; a
 * marketplace id is linkage, and a row either has one on a side or it does
 * not. There is no "custom" kind of row.
 *
 * So the gate becomes PER SIDE and PER PATH: a side is fetched only when every
 * ancestor that side needs an id from actually carries one. A hand-typed sport
 * with no ids skips both sides (exactly the old behaviour, reached by a
 * different route). A hand-typed MANUFACTURER under a BSC-linked year no longer
 * poisons its subtree: BSC has no manufacturer facet at all, so BSC still
 * resolves and the set/variant/card syncs below it run.
 *
 * ## What each side needs
 *
 * BSC filters on `sport`, `year`, `setName` and `variant`; there is NO
 * manufacturer facet (`LEVEL_TO_BSC_FACET` in `bscFacets.ts`). `insert` maps to
 * `variantName` and `parallel` to nothing, and neither is required — a query
 * scoped to the set is still a correct, narrower-is-better query.
 *
 * `variantType` is required but is NOT satisfied by "has a BSC id": it must
 * carry a slot TAGGED `variant` (NEO-189 facet tags). The id in an untagged
 * variantType slot is not self-describing, and one class of them is known to be
 * corrupt — a mis-saved Base mapping once wrote the parent's setName slug into
 * variantType rows. Before this ticket the fetch dodged that by re-deriving the
 * facet from the row's DISPLAY VALUE, which is the reverse dependency the
 * product invariant forbids: an NB name must never build a marketplace query.
 * So an untagged variantType makes BSC unresolvable and BSC is skipped — never
 * guessed. `backfillVariantFacetAndBaseRole` tags the rows that can be tagged
 * and reports the rest.
 *
 * SportLots has one unit of attachment reached through sport + year (its
 * `sprt`/`yr` form fields). `manufacturer` is additionally required on the
 * ATTACH pool, where the whole request is "every SL set under this brand" and
 * an unscoped answer is a different, useless pool rather than a wider one.
 *
 * ## The CHECKLIST asks a different question (NEO-252)
 *
 * Everything above is stated per NB LEVEL, which is the shape a SELECTOR sync
 * request has. A checklist request does not have that shape: it is a bag of
 * BSC FACET filters, bucketed by what each id IS rather than by the level of
 * the row holding it (`resolveBscFacetFilters`). The two only look equivalent
 * while every id sits on the level that names its facet.
 *
 * They stopped being equivalent at NEO-189, which is the whole reason the
 * facet tags exist: an NB Base row may carry the `setName` ids for BSC's
 * Series 1 and Series 2, and then the query IS scoped by a set while the
 * setName ANCESTOR carries nothing. The level walk called that unresolvable
 * and skipped BSC; the adapter, asked, would have answered. Callers gating a
 * checklist fetch therefore pass `bscScope: "checklist"` and are judged on the
 * filters themselves, via the one function `fetchBscChecklist` also refuses
 * on (`missingBscChecklistScope`).
 *
 * ## Levels absent from the chain are not "missing"
 *
 * Syncing `year` under a `sport` parent has no `setName` ancestor to be missing
 * an id. Only levels PRESENT in the chain are checked, which is how the four
 * pre-existing preconditions already behaved.
 */

import type {
  PlatformDataShape,
  PlatformFacetShape,
  PlatformSide,
} from "./platformSlots";
import { slotEntries, slotFacet } from "./platformSlots";
import { platformServesLevel } from "./platformLevels";
import {
  BSC_SOURCE_FACETS,
  LEVEL_TO_BSC_FACET,
  legacyBscFacetForLevel,
  missingBscChecklistScope,
  resolveBscFacetFilters,
} from "./bscFacets";

/** The minimum a chain node must expose to be judged. */
export type ResolvableRow = {
  level: string;
  value?: string;
  platformData: PlatformDataShape;
  platformFacets?: PlatformFacetShape;
};

export type SideResolution = {
  /**
   * Does this marketplace model the level being fetched at all
   * (`platformServesLevel`)? `false` is structural — no retry, no credential
   * and no attached id can change it.
   *
   * Kept separate from `resolvable` because the two failures read completely
   * differently to an operator. A side that does not serve the level was never
   * going to be asked and there is nothing to say about it; a side that COULD
   * have been asked and had no ids is worth a notice, because attaching an id
   * fixes it. Conflating them put "BuySportsCards skipped: no BuySportsCards
   * ids on this path" under every healthy Manufacturers sync — BSC has no
   * manufacturer axis — which is exactly the false-outage noise NEO-216
   * removed, reintroduced in different words.
   *
   * `true` when no level was supplied: with nothing to serve, nothing is
   * unserved.
   */
  served: boolean;
  /** True when every ancestor this side needs an id from carries one. */
  resolvable: boolean;
  /**
   * `${level}=${value}` per ancestor that owes this side an id. LOG ONLY —
   * it names NB rows and must never reach `selectorSyncStatus.message`
   * (NEO-47 security property; see the fixed constants below).
   */
  missing: string[];
};

export type ChainResolution = Record<PlatformSide, SideResolution>;

/**
 * BSC facets that scope a query and have no NB display fallback, expressed as
 * the NB LEVELS a selector sync reads them from.
 *
 * NEO-252: this is the per-LEVEL rule only. The checklist fetch's requirement
 * is `BSC_CHECKLIST_REQUIRED_FACETS` in `bscFacets.ts`, stated over facets, and
 * the two are deliberately not merged — see the header.
 */
export const BSC_REQUIRED_LEVELS: ReadonlySet<string> = new Set([
  "sport",
  "year",
  "setName",
]);

/**
 * SportLots, PER FETCH LEVEL — the ancestor ids the request body actually
 * consumes, and nothing more.
 *
 * A flat `{sport, year}` was too weak, and CI found it: ten flows drill a
 * MIXED chain — a real `Baseball / 2024 / Topps` plus a hand-made set with no
 * ids — where sport and year alone made SportLots look resolvable at the
 * variantType and Inserts columns. SL was then asked at levels it cannot serve
 * or cannot scope, and the refusal surfaced as a hard error with a Retry on a
 * column the operator only wanted to add rows to by hand. Under the retired
 * `isCustom` gate the hand-made set skipped both sides for the whole subtree,
 * which is why this never showed before.
 *
 * The rule is now: the requirement equals what the FORM BODY carries at that
 * level (see `resolveSlScope` and `fetchSetNames` in adapters/sportlots.ts).
 *
 *   sport        → nothing            newinven with no scope; lists sports
 *   year         → sport              `sprt`
 *   manufacturer → sport, year        `sprt`, `yr`
 *   insert       → sport, year, manufacturer   `sprt`, `yr`, `brd`
 *
 * Levels absent from this table are ones SportLots does not answer at all —
 * see `PLATFORM_LEVEL_SUPPORT` in convex/platformLevels.ts.
 */
export const SL_SCOPE_BY_LEVEL: Readonly<Record<string, readonly string[]>> = {
  sport: [],
  year: ["sport"],
  manufacturer: ["sport", "year"],
  insert: ["sport", "year", "manufacturer"],
};

/**
 * NEO-216 owns "does this marketplace have this level at all".
 *
 * That table lives in `convex/platformLevels.ts` — `PLATFORM_LEVEL_SUPPORT`,
 * read off `LEVEL_TO_BSC_FACET` and SportLots' `LEVEL_TO_TARGET_SELECT`,
 * enumerated exhaustively by its own test, and consulted by both adapters as a
 * backstop. NEO-239 arrived at the identical table independently and
 * duplicated it here for a week; the duplicate is gone, because two tables
 * that must agree are a table that will eventually disagree.
 *
 * The two questions remain distinct and BOTH gate a side:
 *
 *   platformServesLevel  — does this marketplace model this level? A property
 *                          of the marketplace's taxonomy; no retry or
 *                          credential can change it.
 *   the tables below     — does THIS CHAIN carry the ids that side's request
 *                          body consumes at this level? A property of the data.
 *
 * A side must pass both to be asked.
 */

/**
 * At `insert` and `parallel`, SportLots additionally requires the SET to be a
 * MARKETPLACE set at all — linked on at least one side.
 *
 * SL's answer at those levels is every set for the year and brand; it is not
 * "this set's variants" on its own. For a set NeonBinder invented, offering
 * the whole brand-year as its variants is the same fail-open shape the BSC
 * required-facet check exists to prevent — and it is what made ten flows call
 * a marketplace while drilling a hand-made set, then render the failure as a
 * Retry the operator could never satisfy.
 *
 * THE TEST IS "linked on EITHER side", and the first version of this rule got
 * that wrong in a way CI caught immediately. It asked for an SL id beneath the
 * manufacturer — which is circular, because `BaseMappingForm` fetches at
 * exactly this level to POPULATE the Base set picker, and the picker is how a
 * set gets its SL id in the first place. `syncSetsAcrossManufacturers` is
 * BSC-only, so a freshly synced real set has a BSC id and no SL one; requiring
 * SL first meant the picker never had candidates, silently took its
 * "no SL data" branch, and neither "Select Base Set" nor "Re-map Base" ever
 * rendered.
 *
 * A BSC id is sufficient evidence: the set exists on a marketplace, and the
 * operator is here to pick its SportLots counterpart.
 *
 * NEO-252 widened WHERE each side's evidence may sit, without changing what
 * counts as evidence. Both halves used to read the setName row's own slots,
 * which quietly assumed a marketplace files sets the way NeonBinder does. BSC
 * is now read from the facet plan, and SportLots from the setName row
 * downward — SL has no set level at all, so an SL-first build leaves its only
 * set link on the variant or insert row, and the old test called that set
 * unlinked while the operator was looking at its SportLots id.
 */
const SL_LINKED_SET_FETCH_LEVELS: ReadonlySet<string> = new Set([
  "insert",
  "parallel",
]);

/**
 * @deprecated NEO-239 — the flat set that CI proved too weak. Kept only as the
 * default when a caller does not say which level it is fetching; every real
 * caller passes `level` and gets `SL_SCOPE_BY_LEVEL` instead.
 */
export const SL_REQUIRED_LEVELS: ReadonlySet<string> = new Set([
  "sport",
  "year",
]);

/**
 * The attach pool additionally needs `brd`. Browsing "every SL set under this
 * year" unscoped by brand is not a wider version of the pool the operator
 * asked for — it is a different one.
 */
export const SL_ATTACH_REQUIRED_LEVELS: ReadonlySet<string> = new Set([
  "sport",
  "year",
  "manufacturer",
]);

/**
 * What the admin sees when NEITHER side can be asked.
 *
 * FIXED TEXT. `selectorSyncStatus.message` is reactive state served to the
 * browser, so it carries no row values, no marketplace strings and no adapter
 * detail — same rule as `SYNC_ERROR_MESSAGE` and `partialSyncMessage`
 * (NEO-47 / NEO-211 B). The per-row detail goes to `console.log`.
 *
 * The ONE-side case is `skippedSyncMessage` in `selectorSyncStore.ts`, built
 * from the same platform-name mapping `partialSyncMessage` uses — a side that
 * was skipped and a side that failed are different events told in the same
 * vocabulary. It does not live here because this module is deliberately free
 * of Convex imports.
 */
export const NO_MARKETPLACE_IDS_MESSAGE =
  "No marketplace ids on this path — nothing to sync. Add entries by hand, or " +
  "attach a marketplace id to this set to link one.";

/**
 * NEO-252 — what the BSC attach pane says when the path names no BSC set to
 * list variants of.
 *
 * FIXED TEXT, and that is the whole point of it. What stood here interpolated
 * the NB row's own display value — "Missing platformData.bsc on: setName=<the
 * operator's set name>" — which is an NB value in a client-facing string
 * (NEO-47) dressed up as a marketplace fact. It was also reported as a
 * FAILURE, so a perfectly ordinary state (a set NeonBinder built first and has
 * not linked yet) rendered as a red alert on a pane whose set list would have
 * fixed it in two clicks.
 *
 * A skip, therefore, and one that names the way forward. The dialog reads this
 * by EQUALITY against this constant and hops to the set list.
 */
export const BSC_NO_LINKED_SET_MESSAGE =
  "No BuySportsCards set is linked on this path yet. Browse all BSC sets to " +
  "pick one.";

/** True when the row carries at least one marketplace id on `side`. */
export function rowHasSideId(
  row: Pick<ResolvableRow, "platformData">,
  side: PlatformSide,
): boolean {
  return slotEntries(row, side).length > 0;
}

/**
 * True when the row carries a BSC slot TAGGED with `facet`.
 *
 * An untagged slot is deliberately not counted. `slotFacet` returns `undefined`
 * for a slot written before NEO-189, and that means "inert", never
 * "unknown-so-guess" — see `bscFacets.ts`.
 */
export function rowHasBscFacet(
  row: Pick<ResolvableRow, "platformData" | "platformFacets">,
  facet: string,
): boolean {
  for (const { slot } of slotEntries(row, "bsc")) {
    if (slotFacet(row, "bsc", slot) === facet) return true;
  }
  return false;
}

/**
 * NEO-255 — the NB levels a SportLots SET id can sit on.
 *
 * SportLots has no setName concept: it files a set as one flat radio-button id
 * that NeonBinder attaches to whichever row corresponds to it, which in
 * practice is the variantType / insert / parallel row and occasionally the
 * setName row itself. This list mirrors `fetchSportLotsChecklist`'s own
 * precedence chain (`platformFilters.parallel || .insert || .variantType ||
 * .setName`) exactly, because the question "is SportLots attached to this set"
 * is only worth asking about ids that fetch would actually scope itself with.
 *
 * `sport` and `year` are deliberately absent. Their SL ids are query SCOPE
 * (`sprt`, `yr`) written by the selector sync onto every real chain; counting
 * them would make every set on the platform "SportLots-attached" and delete
 * the distinction.
 */
const SL_SET_LEVELS: ReadonlySet<string> = new Set([
  "setName",
  "variantType",
  "insert",
  "parallel",
]);

/**
 * NEO-255 — which marketplaces are ATTACHED to this set, in the stable
 * `["bsc", "sportlots"]` order.
 *
 * ## Attached, not fetched, and not resolvable
 *
 * This answers one question only: does the operator's mapping name a
 * marketplace set on this side? It reads SLOT DATA and nothing else — never
 * `resolution`, never a returned card count, never a display value. Those are
 * all downstream of it and all of them can be zero on a side that is very much
 * attached: an outage returns no cards (`callSl` catches to `[]`), and an
 * attached-but-unscopable side is skipped by `resolvableSides` while its id
 * sits right there on the row.
 *
 * That distinction is the whole point. NEO-255 skips the Match Cards dialog
 * when there is nothing to line up — exactly one marketplace attached — and
 * keying that on anything downstream would auto-commit a two-marketplace set
 * as one-sided the moment one side had a bad afternoon. Attachment does not
 * move when a marketplace does.
 *
 * ## What counts, per side
 *
 * This is the same answer `MultiSourcePanel` renders as chips, and it is
 * deliberately the same code path rather than a second opinion about it:
 *
 *   BSC — a SOURCE facet in the plan `resolveBscFacetFilters` builds, i.e.
 *         `setName` or `variantName` (`BSC_SOURCE_FACETS`, what a chip IS).
 *         Reading the PLAN rather than one row is what counts both real
 *         shapes: the id on the setName ancestor, and the NEO-189 id attached
 *         to the leaf and tagged `setName`. The `sport`/`year` facets are
 *         scope, and a `variant` slug narrows a source rather than naming one
 *         — none of the three makes BSC attached on its own.
 *   SL  — an id on a row at one of `SL_SET_LEVELS`.
 *
 * There is no "custom" case here and no name-based guess anywhere in it: a row
 * either carries marketplace ids or it does not, and both answers are ordinary.
 */
export function attachedSidesOf(
  chain: readonly ResolvableRow[],
): PlatformSide[] {
  const out: PlatformSide[] = [];
  const filters = resolveBscFacetFilters(chain).filters;
  const bscAttached = [...BSC_SOURCE_FACETS].some(
    (facet) => (filters[facet]?.length ?? 0) > 0,
  );
  if (bscAttached) out.push("bsc");
  const slAttached = chain.some(
    (row) => SL_SET_LEVELS.has(row.level) && rowHasSideId(row, "sportlots"),
  );
  if (slAttached) out.push("sportlots");
  return out;
}

function label(row: ResolvableRow): string {
  return row.value ? `${row.level}=${row.value}` : row.level;
}

/**
 * Which sides can be queried for this ancestor chain.
 *
 * `slRequired` lets the attach pool ask for its stricter rule without a second
 * near-identical helper — the two callers differ only in whether `manufacturer`
 * is load-bearing.
 *
 * `bscScope` picks WHICH BSC question is being asked, and the two are genuinely
 * different questions rather than a strict/lax pair (NEO-252):
 *
 *   "level"     (default) — per NB LEVEL: every ancestor at a required level
 *                 carries a BSC id, and a variantType row carries a
 *                 `variant`-tagged one. This is the right test for a SELECTOR
 *                 sync, whose request body is built per level, and for the
 *                 store mutations' coverage narrowing, which asks "is this side
 *                 reachable from the parent chain at all" about a chain that
 *                 legitimately stops above the levels a checklist needs.
 *   "checklist" — per BSC FACET, judged on the filters
 *                 `resolveBscFacetFilters` would actually send. This is the
 *                 right test for the CHECKLIST fetch, because that is the
 *                 request it gates.
 *
 * The gap between them is the bug this option closes. The NEO-189 split — one
 * NB Base row drawing from BSC's Series 1 and Series 2 — puts the `setName`
 * facet's ids on the LEAF, where the level walk cannot see them: it looks for
 * an id on the setName ANCESTOR, finds none, and skips a BSC side the adapter
 * would have accepted. Judging the filters instead makes the gate and the
 * request agree by construction, which is what the parity property in
 * `marketplaceResolvability.test.ts` pins.
 */
export function resolvableSides(
  chain: readonly ResolvableRow[],
  opts?: {
    level?: string;
    slRequired?: ReadonlySet<string>;
    bscScope?: "level" | "checklist";
  },
): ChainResolution {
  const level = opts?.level;
  const slRequired =
    opts?.slRequired ??
    (level !== undefined && level in SL_SCOPE_BY_LEVEL
      ? new Set(SL_SCOPE_BY_LEVEL[level])
      : SL_REQUIRED_LEVELS);

  const missingBsc: string[] = [];
  const missingSl: string[] = [];

  // One pass, shared by the checklist gate and the SL "is this set a
  // marketplace set at all" test below, and computed only when one of them
  // asks — `resolvableSides` runs on every selector sync.
  let facetFilters: Record<string, string[]> | undefined;
  const bscFilters = (): Record<string, string[]> => {
    facetFilters ??= resolveBscFacetFilters(chain).filters;
    return facetFilters;
  };

  // A side that cannot answer at this level is unresolvable outright, whatever
  // ids the chain carries. `unsupported_level` is not an empty answer.
  if (level !== undefined && !platformServesLevel("bsc", level)) {
    missingBsc.push(`level=${level}`);
  }
  if (
    level !== undefined &&
    opts?.slRequired === undefined &&
    !platformServesLevel("sportlots", level)
  ) {
    missingSl.push(`level=${level}`);
  }

  // The CHECKLIST gate: judged on the filters the request would carry, so the
  // facet names are what is missing — never a row, and never a row's value.
  if (opts?.bscScope === "checklist") {
    for (const facet of missingBscChecklistScope(bscFilters())) {
      missingBsc.push(`facet=${facet}`);
    }
  }

  for (const row of chain) {
    // The per-LEVEL rule. Skipped wholesale under `bscScope: "checklist"`,
    // where the facet answer above is the complete one: re-applying this on
    // top would restore exactly the leaf-attachment blind spot the option
    // exists to remove.
    if (opts?.bscScope !== "checklist") {
      if (BSC_REQUIRED_LEVELS.has(row.level) && !rowHasSideId(row, "bsc")) {
        missingBsc.push(label(row));
      }
      // A variantType contributes BSC's `variant` facet, and only a TAGGED
      // slot says which facet an id belongs to. No tag → nothing honest to
      // filter on.
      if (row.level === "variantType" && !rowHasBscFacet(row, "variant")) {
        missingBsc.push(label(row));
      }
    }
    if (slRequired.has(row.level) && !rowHasSideId(row, "sportlots")) {
      missingSl.push(label(row));
    }
  }

  // SL's flat list only means "this set's variants" once the set is linked to
  // some marketplace. EITHER side counts — see the note above for why
  // requiring the SportLots one specifically was circular.
  if (
    level !== undefined &&
    opts?.slRequired === undefined &&
    SL_LINKED_SET_FETCH_LEVELS.has(level)
  ) {
    //
    // NEO-252 — NEITHER half reads the setName row's own slots any more, and
    // for the same reason on both sides: a marketplace link to this set does
    // not have to live on the NB row NeonBinder happens to call the set.
    //
    // BSC is read from the FACET PLAN. `resolveBscFacetFilters` already
    // generalises the old row test (a setName row's untagged BSC id resolves to
    // the `setName` facet by the level rule) and additionally counts the
    // NEO-189 shape it missed: a BSC set attached to the LEAF, which is a real
    // link to a real BSC set and is how a hand-built set usually acquires its
    // first one.
    //
    // SportLots is read from the setName row DOWNWARD, because SportLots has
    // no set level at all — its unit of attachment is one flat set id, and NB
    // files that id on the variant or insert row that corresponds to it. So an
    // SL-first build (the operator syncs variant types, matches them to SL
    // sets, and the NB setName row above stays NB's own) put the only SL link
    // on a row the old test never looked at, and every insert/parallel sync
    // under it reported "unlinked set" — the exact failure the rule exists to
    // prevent, aimed at a set that IS linked.
    //
    // The scan starts AT the setName row, not at the root: `sprt`, `yr` and
    // `brd` are query SCOPE, already required by `SL_SCOPE_BY_LEVEL` at these
    // levels, and counting them would make every chain "linked" and delete the
    // rule. A chain with no setName row has no set to call linked, so the SL
    // half stays false there.
    const setRowIndex = chain.findIndex((row) => row.level === "setName");
    const slLinkedAtOrBelowSet =
      setRowIndex !== -1 &&
      chain
        .slice(setRowIndex)
        .some((row) => rowHasSideId(row, "sportlots"));
    const setIsLinked =
      (bscFilters().setName?.length ?? 0) > 0 || slLinkedAtOrBelowSet;
    if (!setIsLinked) missingSl.push("unlinked set");
  }

  return {
    bsc: {
      served: level === undefined || platformServesLevel("bsc", level),
      resolvable: missingBsc.length === 0,
      missing: missingBsc,
    },
    sportlots: {
      served: level === undefined || platformServesLevel("sportlots", level),
      resolvable: missingSl.length === 0,
      missing: missingSl,
    },
  };
}

/**
 * NEO-252 — a LOG-SAFE rendering of `SideResolution.missing`.
 *
 * ## Why `missing` cannot simply be logged
 *
 * `missing` mixes three vocabularies, and only two of them are safe to write
 * down anywhere:
 *
 *   `facet=variant`   a BSC facet name          — marketplace vocabulary, safe
 *   `level=insert`    the level being fetched   — NB taxonomy name, safe
 *   `unlinked set`    a fixed sentinel          — safe
 *   `setName=<value>` an NB ROW                 — the row's DISPLAY VALUE
 *
 * The last one is `label()`, and it is the operator's own text: a set they
 * named, a sport they typed. NEO-47's rule keeps it out of
 * `selectorSyncStatus.message` because that is reactive state served to the
 * browser — and the reason it holds there holds here too. A Convex log is
 * retained, searchable, and read by people who are not the operator, so
 * "it's only a log line" is a weaker claim than it sounds: the value is the
 * same value, and shipping it to a different audience is still shipping it.
 *
 * ## What this keeps
 *
 * The COUNT and the NAMES — which is the whole diagnostic payload. "BSC is
 * missing 2: setName, variantType" tells you which rungs of the chain owe an
 * id, which is what you act on; the operator's word for those rows adds
 * nothing you could not get from the row id already in the log line.
 *
 * `missing` itself is deliberately unchanged. It is the structured value the
 * tests assert on and the only place the row is identified at all, so the fix
 * is at the point of RENDERING rather than at the point of construction —
 * a future caller that needs the row still has it, and a future caller that
 * just wants to log reaches for this and cannot get it wrong.
 */
export function missingSummary(resolution: SideResolution): string {
  const names = resolution.missing.map(missingName);
  return names.length === 0
    ? "0"
    : `${names.length} (${names.join(",")})`;
}

/**
 * Prefixes whose right-hand side is marketplace or taxonomy vocabulary rather
 * than an NB row's display value, and so survives whole.
 */
const SAFE_MISSING_PREFIXES: ReadonlySet<string> = new Set(["facet", "level"]);

/** One `missing` entry, stripped to its name. */
function missingName(entry: string): string {
  const eq = entry.indexOf("=");
  if (eq === -1) return entry; // `unlinked set`, or a bare level from label()
  const prefix = entry.slice(0, eq);
  return SAFE_MISSING_PREFIXES.has(prefix) ? entry : prefix;
}

/**
 * The skipped sides an operator should be TOLD about: ones this marketplace
 * models at this level, that were skipped only because the chain carries none
 * of the ids they need.
 *
 * A strict subset of `skippedSideList`, which stays complete — the FE's
 * coverage logic must subtract every skipped side, whatever the reason, or a
 * side nobody asked authorises an unlink. Only the NOTICE narrows.
 */
export function notifiableSkippedSides(
  resolution: ChainResolution,
): PlatformSide[] {
  return skippedSideList(resolution).filter(
    (side) => resolution[side].served,
  );
}

/** The sides worth calling, in a stable order. */
export function resolvedSideList(
  resolution: ChainResolution,
): PlatformSide[] {
  const out: PlatformSide[] = [];
  if (resolution.bsc.resolvable) out.push("bsc");
  if (resolution.sportlots.resolvable) out.push("sportlots");
  return out;
}

/**
 * The sides this run did NOT ask, in the stable order every caller reports and
 * subtracts from `coveredSides`.
 *
 * The inverse of `resolvedSideList`, and the value that rides back to the
 * client as `skippedSides`.
 */
export function skippedSideList(
  resolution: ChainResolution,
): PlatformSide[] {
  const out: PlatformSide[] = [];
  if (!resolution.bsc.resolvable) out.push("bsc");
  if (!resolution.sportlots.resolvable) out.push("sportlots");
  return out;
}


/**
 * NEO-239 — may this slot's LABEL be offered as a name for the row it sits on?
 *
 * ## The bug
 *
 * NEO-211's suggestions modal offered to rename 2024 Topps Chrome's **Base**
 * variant type to "Chrome". Nothing was corrupt: SportLots has no variant-type
 * level, so the SL id on a Base row is the SL SET that holds the base cards,
 * and its label is therefore the set's name — which the brand-prefix strip had
 * tidied from "Topps Chrome" to "Chrome". A perfectly correct set label,
 * offered as a variant-type name.
 *
 * ## The rule
 *
 * A label names a row only if the slot it came from is the row's OWN LEVEL on
 * that marketplace. Two independent conditions, and the first is what catches
 * the case above:
 *
 *   1. the marketplace must model this level at all — SportLots does not model
 *      `variantType`, `setName` or `parallel`, so an SL slot on any of those
 *      rows is a set id wearing the row's clothes and can never name it;
 *   2. for BSC, whose slots are facet-tagged, the slot's facet must be the
 *      facet this level IS. A `setName`-tagged slot on a Base row is NEO-189's
 *      legitimate "this Base draws from two BSC sets" mapping — a real id, and
 *      still not a name for the row. An UNTAGGED slot resolves through
 *      `legacyBscFacetForLevel`, which answers `undefined` at variantType and
 *      parallel — so the untrustworthy slugs stay silent here too.
 *
 * SportLots has one unit of attachment and no facets, so condition 1 is the
 * whole test for it.
 *
 * Shared by every door that can write a name from a label
 * (`getSelectorSyncSuggestions` offers, `applySelectorSyncSuggestions`
 * applies), because a guard on one of two doors is not a guard.
 */
export function slotLabelCanNameRow(
  row: Pick<ResolvableRow, "level" | "platformData" | "platformFacets">,
  side: PlatformSide,
  slot: string,
): boolean {
  if (!platformServesLevel(side, row.level)) return false;
  if (side === "sportlots") return true;

  const levelFacet = LEVEL_TO_BSC_FACET[row.level];
  if (!levelFacet) return false;
  const effective =
    slotFacet(row, "bsc", slot) ?? legacyBscFacetForLevel(row.level);
  return effective === levelFacet;
}
