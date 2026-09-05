/**
 * NEO-211 — shared, pure helpers for the two things a re-sync now has to TELL
 * the operator, rather than silently doing.
 *
 * Both live here because `EntityColumn` (levels 1-5, via `selectorSyncStatus`)
 * and `VariantForm` / `ParallelForm` (levels 6-7, via the store mutation's own
 * result) have to say exactly the same words about exactly the same events.
 * When the two surfaces drifted apart before, the same outage read as "nothing
 * happened" in one column and an error in another.
 *
 * ## 1. The partial-failure guard (plan B)
 *
 * `fetchRawOptions` returns `success: true` with a per-platform `errors` array:
 * an adapter outage is a PARTIAL result, not a failure. The forms used to take
 * the "only one platform has data" branch on that partial result and store it —
 * which, under the pre-NEO-211 delete-what-you-did-not-name store, deleted every
 * row the dead side owned and stripped its linkage from the rest. An SL timeout
 * therefore destroyed SL data.
 *
 * So: a side that came back EMPTY is only evidence of "the marketplace no longer
 * lists these" when that side was actually reached. If it errored, we know
 * nothing about it, and the only safe move is to write nothing at all and say
 * which platform failed. That is `planSinglePlatformStore`.
 *
 * ## 2. The "no longer listed" notice (plan D)
 *
 * When a side WAS reached and did not return a row NB holds an id for, the store
 * detaches that marketplace's link — the row, its name and its whole subtree stay
 * (sets are fixed, never deleted). Nothing records the event server-side, so the
 * one chance to tell the admin is the sync result itself. That is
 * `buildUnlinkedNotices`.
 */

import { MAX_RETURNED_IDS } from "../../convex/selectorSyncStore";

export type SyncSide = "bsc" | "sportlots";

export const ALL_SIDES: readonly SyncSide[] = ["bsc", "sportlots"];

/**
 * How each marketplace is named in ordinary UI copy.
 *
 * "BSC" not "BuySportsCards": it is what the rest of this UI already says
 * (`sync-review-modal`'s `SOURCE_LABEL`, `ChecklistSourceFilter`'s row titles)
 * and what sellers call it. SportLots gets its full name because it has no
 * comparable short form. Collector consult, 2026-09-03.
 */
export const SIDE_LABEL: Record<SyncSide, string> = {
  bsc: "BSC",
  sportlots: "SportLots",
};

/**
 * The ONE exception to `SIDE_LABEL`: the partial-failure alert.
 *
 * An outage message is the one place an admin may be about to go look at a
 * marketplace's status page or open a support ticket, so it spells the platform
 * out.
 */
export const PLATFORM_DISPLAY_NAME: Record<string, string> = {
  bsc: "BuySportsCards",
  sportlots: "SportLots",
};

/**
 * What an UNRECOGNISED `platform` key is called.
 *
 * `fetchRawOptions` also emits `"internal"` (a thrown exception or a
 * precondition failure), and its outer catch can attribute a failure to no
 * marketplace at all. Echoing the raw key would leak an implementation detail
 * into the DOM and, worse, make "is this string safe to render" a property of
 * every CALLER rather than of this module. Mirrors the backend's own
 * `partialSyncMessage`, which maps unknown keys the same way.
 */
export const UNKNOWN_PLATFORM_LABEL = "A marketplace";

export type FetchPlatformError = { platform: string; message: string };

/** `errors[].platform` is a free string; only these two map to a side. */
export function toSyncSide(platform: string): SyncSide | null {
  return platform === "bsc" || platform === "sportlots" ? platform : null;
}

/**
 * The sides the fetch never attempted, read off its result (NEO-239).
 *
 * A side is now fetched only when every ancestor it needs carries an id on that
 * side; otherwise it is SKIPPED — no request, no error. That skip is invisible
 * to the error list, and `coveredSides` used to be derived from the error list
 * alone. A skipped side would therefore arrive as "covered" with empty
 * `returnedIds`, and `coveredSides` is exactly the positive evidence that
 * licenses the store to unlink: every child's slot on that side would be
 * detached because a marketplace we never asked did not answer. That is the
 * silent data loss this reader exists to prevent — the same failure the
 * NEO-211 partial-failure guard exists to prevent, arriving through the other
 * door.
 *
 * Read structurally from `unknown` rather than off the generated result type on
 * purpose: this is the ONE place in the client that knows the field's name, so
 * a backend rename is one edit here, and a result that predates the field
 * simply reports nothing skipped instead of failing to compile.
 *
 * Absent field is read as "nothing was skipped", which is the pre-NEO-239
 * behaviour and is NOT the guarantee: an old SPA bundle keeps sending
 * error-derived `coveredSides` for its whole cache lifetime, so the store
 * mutation independently narrows coverage to the sides the parent chain is
 * actually resolvable on. This is the affordance; the server is the guarantee.
 */
export function skippedSidesOf(fetchResult: unknown): SyncSide[] {
  if (typeof fetchResult !== "object" || fetchResult === null) return [];
  const raw = (fetchResult as { skippedSides?: unknown }).skippedSides;
  if (!Array.isArray(raw)) return [];
  const sides: SyncSide[] = [];
  for (const entry of raw) {
    const side = typeof entry === "string" ? toSyncSide(entry) : null;
    if (side && !sides.includes(side)) sides.push(side);
  }
  return sides;
}

export type SinglePlatformPlan =
  | {
      /** Safe to write: every side was reached, so an empty side means empty. */
      kind: "store";
      coveredSides: SyncSide[];
    }
  | {
      /** A side we would be writing ABOUT was never reached. Write nothing. */
      kind: "blocked";
      /** Human-readable platform names, for the alert. */
      failedLabels: string[];
    };

/**
 * Decide whether the single-platform branch may store.
 *
 * Fail-closed by construction: ANY error entry blocks. In practice an entry in
 * `errors` always means that adapter returned nothing, so in this branch — where
 * one side is empty by definition — an error is always an error about the side
 * we would otherwise be asserting is empty. An `internal` (unattributable) error
 * blocks for the same reason: we cannot claim a side was covered when we do not
 * know which one broke.
 *
 * When it does store, `coveredSides` is every side that was actually REACHED,
 * and that is the point: the mutation only unlinks on a side it was explicitly
 * told was covered (absent means unlink nothing), so this is the positive
 * evidence that the marketplace was asked and had nothing. A side that reported
 * an error is never in the list — and neither is a side the fetch SKIPPED for
 * lack of ids (NEO-239), which raises no error at all. "We never asked" is not
 * "we asked and it had nothing"; see `skippedSidesOf`.
 */
export function planSinglePlatformStore(
  errors: readonly FetchPlatformError[],
  skippedSides: readonly SyncSide[] = [],
): SinglePlatformPlan {
  if (errors.length === 0) {
    return {
      kind: "store",
      coveredSides: ALL_SIDES.filter((s) => !skippedSides.includes(s)),
    };
  }
  const failedLabels: string[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    const label = PLATFORM_DISPLAY_NAME[e.platform] ?? UNKNOWN_PLATFORM_LABEL;
    if (!seen.has(label)) {
      seen.add(label);
      failedLabels.push(label);
    }
  }
  // Note what is NOT carried out of here: `e.message`. Adapter output is
  // untrusted text from a third-party marketplace response, and the security
  // review's rule is that no user-facing error copy is BUILT from it on the
  // client. The platform name is ours; the detail stays in the logs.
  return { kind: "blocked", failedLabels };
}

/** "SportLots" / "BSC and SportLots" — the subject of the failure sentence. */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The alert text for a refused single-platform store.
 *
 * Keeps the caller's existing `SYNC_FAILED_PREFIX` at the front so the forms'
 * `isError` test (which is a `startsWith` on that prefix) still routes this to
 * the pink alert treatment WITH the Retry button, and so the Maestro flows that
 * assert on the prefix keep matching. "nothing was changed" is the load-bearing
 * half: the operator's actual question on seeing a sync error is whether their
 * data survived it.
 *
 * Entirely composed from our own strings — see `planSinglePlatformStore`.
 */
export function partialFailureMessage(
  prefix: string,
  plan: Extract<SinglePlatformPlan, { kind: "blocked" }>,
): string {
  return `${prefix}. ${joinLabels(plan.failedLabels)} failed, nothing was changed.`;
}

/** The Maestro-stable second clause, on its own, for assertions and tests. */
export const NOTHING_CHANGED_CLAUSE = "failed, nothing was changed.";

/**
 * Plan and format in one step, for the callers that only need the sentence.
 *
 * Used by the both-adapters-came-back-empty branch, which has no store decision
 * to make — it already knows it is writing nothing — but must say WHICH platform
 * failed and that nothing changed, in the same words as the partial-failure
 * branch. Returns null when there is no error to report, so a caller cannot
 * accidentally render an empty accusation.
 */
export function blockedMessageFromErrors(
  prefix: string,
  errors: readonly FetchPlatformError[],
): string | null {
  const plan = planSinglePlatformStore(errors);
  return plan.kind === "blocked" ? partialFailureMessage(prefix, plan) : null;
}

/**
 * Which sides were actually REACHED — what the reconciliation path passes as
 * `coveredSides`. Both sides populated the modal, so this is normally both;
 * computing it rather than hardcoding keeps the guarantee true when it is not.
 *
 * Named for the fetch rather than for the errors (it was
 * `coveredSidesFromErrors`) because the error list stopped being the whole
 * story in NEO-239: a side skipped for lack of ids reports no error, and
 * counting it as covered would license unlinking every child's slot on a
 * marketplace nobody asked.
 */
export function coveredSidesFromFetch(
  errors: readonly FetchPlatformError[] | undefined,
  skippedSides: readonly SyncSide[] = [],
): SyncSide[] | undefined {
  // Undefined input is NOT "no errors" — it is "we no longer know what the
  // fetch reported". Returning both sides there would fail OPEN: the store
  // takes `coveredSides` as positive evidence that a marketplace was reached
  // and had nothing, and would unlink on a side we cannot vouch for. Omitting
  // the arg entirely means unlink nothing, which is the safe answer.
  if (!errors) return undefined;
  const uncovered = new Set<SyncSide>(skippedSides);
  for (const e of errors) {
    const side = toSyncSide(e.platform);
    if (side) uncovered.add(side);
  }
  return ALL_SIDES.filter((s) => !uncovered.has(s));
}

// ---------------------------------------------------------------------------
// "No longer listed" notice
// ---------------------------------------------------------------------------

export type UnlinkedEntry = {
  id: string;
  value: string;
  side: SyncSide;
  /**
   * Checklist-bearing levels only: this row has cards under it. That turns an
   * unlink from "a link went stale" into "listing these cards on that
   * marketplace is broken until someone re-links them", which is a different
   * urgency and has to be legible per row, not just in the total.
   */
  hasCards?: boolean;
};

export type SelectorLevel =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

/**
 * The ONE level→noun map for both NEO-211 surfaces.
 *
 * Derived from the PUBLIC labels the column buttons already use ("Sync Sets",
 * "Sync Sub-Variants"), not from `SetAttributesPanel`'s `LEVEL_LABEL`, which
 * says "Parallel" where the columns say "Sub-Variant" and belongs to an older,
 * unrelated panel. Two maps that disagree about what a level is called is worse
 * than either one; this is the one these two new surfaces share, and renaming
 * the other is out of scope for this ticket (collector consult, 2026-09-03).
 */
export const LEVEL_SINGULAR: Record<SelectorLevel, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant Type",
  insert: "Insert",
  parallel: "Sub-Variant",
};

/** Title-case plural, for a heading ("Sets", "Sub-Variants"). */
export function levelLabelPlural(level: SelectorLevel | undefined): string {
  return level ? `${LEVEL_SINGULAR[level]}s` : "Entries";
}

/** Lower-case, count-agreed, for mid-sentence use ("2 sets", "1 sub-variant"). */
export function levelNoun(level: SelectorLevel | undefined, count: number): string {
  if (!level) return count === 1 ? "entry" : "entries";
  const singular = LEVEL_SINGULAR[level].toLowerCase();
  return count === 1 ? singular : `${singular}s`;
}

/**
 * How many names to spell out before collapsing into ", and N more".
 *
 * Two, because this notice renders inside the column, which is
 * `min-w-[260px] max-w-[340px]` — a longer list wraps into a wall of text next
 * to the list it is describing. The toast has more room and passes 3.
 */
export const UNLINKED_NAME_LIMIT = 2;
export const UNLINKED_NAME_LIMIT_TOAST = 3;

export type UnlinkedNotice = {
  side: SyncSide;
  /** Total rows unlinked on this side, which may exceed `names.length`. */
  count: number;
  /** The names spelled out, each already carrying its own has-cards warning. */
  names: string[];
  /** How many rows are represented by the trailing ", and N more". */
  hidden: number;
  text: string;
};

/**
 * How a single row reads inside the notice.
 *
 * The has-cards warning is appended as plain words rather than an icon or a
 * colour: this is the difference between "a link went stale" and "your listings
 * for these cards are broken", and that must survive a screen reader, a
 * greyscale screen and a Maestro text assertion alike. (Security review,
 * 2026-09-03.)
 */
export function unlinkedEntryText(
  entry: Pick<UnlinkedEntry, "value" | "hasCards" | "side">,
): string {
  if (!entry.hasCards) return entry.value;
  return `${entry.value} (has cards — listing on ${SIDE_LABEL[entry.side]} will fail until re-linked)`;
}

/**
 * One notice per side, in a stable order (BSC first), each already rendered to
 * its final sentence.
 *
 * `totalsBySide` lets the server report a count larger than the sample it sent
 * (`unlinkedTotal`), so a 400-row unlink says "400 sets" and names two of them
 * rather than claiming there were two.
 *
 * Rows that have cards are hoisted to the front of the named sample: when only
 * two names fit, the two worth naming are the ones with broken listings behind
 * them, not whichever two the server happened to return first.
 */
export function buildUnlinkedNotices(
  unlinked: readonly UnlinkedEntry[],
  level: SelectorLevel | undefined,
  options?: {
    totalsBySide?: Partial<Record<SyncSide, number>>;
    maxNames?: number;
  },
): UnlinkedNotice[] {
  const maxNames = options?.maxNames ?? UNLINKED_NAME_LIMIT;
  const notices: UnlinkedNotice[] = [];
  for (const side of ALL_SIDES) {
    const forSide = unlinked.filter((u) => u.side === side);
    if (forSide.length === 0) continue;
    const count = Math.max(options?.totalsBySide?.[side] ?? 0, forSide.length);
    const ordered = [
      ...forSide.filter((u) => u.hasCards),
      ...forSide.filter((u) => !u.hasCards),
    ];
    const names = ordered.slice(0, maxNames).map(unlinkedEntryText);
    const hidden = Math.max(count - names.length, 0);
    const nameList =
      hidden > 0 ? `${names.join(", ")}, and ${hidden} more` : names.join(", ");
    notices.push({
      side,
      count,
      names,
      hidden,
      text: `No longer listed on ${SIDE_LABEL[side]}: ${count} ${levelNoun(
        level,
        count,
      )} — ${nameList}`,
    });
  }
  return notices;
}

/**
 * The whole notice as one string — both sides joined with " · ".
 *
 * Used by the toast, which has no room for a stacked layout, and available to
 * any caller that wants the sentence rather than the parts.
 */
export function unlinkNoticeText(
  unlinked: readonly UnlinkedEntry[],
  level: SelectorLevel | undefined,
  options?: {
    totalsBySide?: Partial<Record<SyncSide, number>>;
    maxNames?: number;
  },
): string {
  return buildUnlinkedNotices(unlinked, level, options)
    .map((n) => n.text)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// What the marketplace actually returned
// ---------------------------------------------------------------------------

/**
 * The shape `returnedIdsFromFetch` reads. Declared structurally rather than
 * importing `ReconciliationModal`'s types, so this module stays free of
 * component imports and a test can hand it a literal.
 */
export type FetchedOptionUniverse = {
  bscOptions?: ReadonlyArray<{ platformValue: string }>;
  slOptions?: ReadonlyArray<{ platformValue: string }>;
  unmatchedBsc?: ReadonlyArray<{ platformValue: string }>;
  unmatchedSl?: ReadonlyArray<{ platformValue: string }>;
  autoMatched?: ReadonlyArray<{
    bsc: { platformValue: string };
    sl: { platformValue: string };
  }>;
};

/**
 * Every marketplace id the FETCH returned, per side.
 *
 * ## Why the store cannot infer this from the items it is sent
 *
 * The store's job on an id-keyed re-sync is to answer "which of NB's links did
 * this marketplace stop listing" — and it was answering it from the
 * `reconciledItems` the form sends. On the reconciliation path those items are
 * not what the marketplace returned; they are **what the operator confirmed**,
 * and the two differ in both directions:
 *
 *   - A restored row is always present in the modal's output whether or not the
 *     marketplace still lists it, so a genuinely delisted set could never be
 *     unlinked. The feature silently did nothing.
 *   - A row the operator DISBANDED or detached vanishes from the output while
 *     the marketplace is still listing it happily — so the store unlinked it and
 *     told the admin "No longer listed on BSC", which is simply false.
 *
 * The fetch result is the only honest source for that question, so it is sent
 * separately. Derive this from the fetch, NEVER from the modal's output.
 *
 * The union across `*Options`, `unmatched*` and `autoMatched` is defensive:
 * `bscOptions` is already the full list today and the other two are partitions
 * of it, but that is a property of `computeMatches` rather than a promise, and
 * an id missing from this set is a false "no longer listed" notice.
 */
export function returnedIdsFromFetch(result: FetchedOptionUniverse): {
  bsc?: string[];
  sportlots?: string[];
} {
  const bsc = new Set<string>();
  const sportlots = new Set<string>();
  for (const o of result.bscOptions ?? []) bsc.add(o.platformValue);
  for (const o of result.unmatchedBsc ?? []) bsc.add(o.platformValue);
  for (const o of result.slOptions ?? []) sportlots.add(o.platformValue);
  for (const o of result.unmatchedSl ?? []) sportlots.add(o.platformValue);
  for (const m of result.autoMatched ?? []) {
    bsc.add(m.bsc.platformValue);
    sportlots.add(m.sl.platformValue);
  }

  // A side over the store's per-side cap is OMITTED rather than sent.
  //
  // The cap is enforced server-side and used to THROW, which surfaced as a
  // reconcile dialog that stayed open after "Save 76 sets" with no visible
  // error at all — SportLots returns 2,563 sets for a single year, so this is
  // an ordinary Tuesday, not an edge case. Omitting is the honest degrade: an
  // absent key means "no information about this side", so the store leaves that
  // side's links alone (it only unlinks on a side it was positively told about)
  // and the save still succeeds. The alternative — truncating to the first N —
  // would be far worse, because every id past the cut would look DELISTED and
  // get silently unlinked.
  //
  // Belt and braces with the backend raising the cap: this makes an oversized
  // universe unable to fail the save regardless of which backend version is
  // deployed, which matters because the FE and Convex deploy separately.
  const ids: { bsc?: string[]; sportlots?: string[] } = {};
  // Both keys are otherwise ALWAYS present, `[]` included: `[]` is the
  // meaningful statement "this side was asked and returned nothing", which is
  // what licenses an unlink.
  if (bsc.size <= MAX_RETURNED_IDS) ids.bsc = [...bsc];
  if (sportlots.size <= MAX_RETURNED_IDS) ids.sportlots = [...sportlots];
  return ids;
}

/**
 * Attribute the server's scalar `unlinkedTotal` to a side, when it can be.
 *
 * The store truncates `unlinked` to `UNLINK_NOTICE_LIMIT` (50) because that list
 * is shipped to every subscribed column, and reports the true count separately.
 * Without this a 312-row unlink renders as "50 sets", which is not a smaller
 * truth — it is a wrong one, and it under-reports exactly the case the operator
 * most needs to see.
 *
 * The total is ONE number across both sides, so it can only be attributed when
 * a single side is involved — the common case, one marketplace dropping a batch.
 * With both sides present we fall back to counting the sample rather than
 * inventing a split.
 */
export function totalsBySideFor(
  unlinked: readonly UnlinkedEntry[],
  unlinkedTotal: number | undefined,
): Partial<Record<SyncSide, number>> | undefined {
  if (typeof unlinkedTotal !== "number" || unlinked.length === 0) return undefined;
  const sides = new Set(unlinked.map((u) => u.side));
  if (sides.size !== 1) return undefined;
  const [only] = [...sides];
  return { [only]: unlinkedTotal } as Partial<Record<SyncSide, number>>;
}
