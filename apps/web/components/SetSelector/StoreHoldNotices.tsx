import React, { useId } from "react";
import type {
  HeldElsewhereEntry,
  WithheldElsewhereEntry,
} from "../../convex/selectorSyncStore";
import type { SiblingWithholdReason } from "../../convex/selectorSyncMatch";
import {
  HOLDER_PATH_SEPARATOR,
  holderPathOf,
  type RefusedRename,
  type SiblingHold,
  type StoreHolds,
} from "./held-elsewhere";
import {
  ATTACH_MORE_LABEL,
  CUSTOM_BUTTON_LABEL,
  MULTI_SOURCE_HEADING,
} from "./control-labels";

/**
 * NEO-300 — the two things a finished sync store can still need the operator
 * to act on. Both come from the store's own transaction, so the client cannot
 * have filtered them; both hold the sync panel open until read.
 *
 *  - WITHHELD: items not added, because their marketplace id is already on
 *    two or more rows, or because the row they point at is linked to a
 *    different set. The store will not guess which row is right, so the fix is
 *    the operator's: delete or ungroup the extra row, then sync again. Each
 *    item is named with the rows it clashes with, by NB's names only, each
 *    with its NB path (set › type › insert) since NEO-312 — a holder can be
 *    in another variant type or another set. Or (NEO-312, `notChecked`) the
 *    store could not check the item against the rest of the set, and held it
 *    back rather than risk a second row on one link: no holders, and the fix
 *    is to try again. Or (NEO-312, `linkHeldElsewhere`) the item matched one
 *    of this column's rows, but one of its links is already on another row,
 *    so that link was left there: the row it names is where it lives.
 *  - SKIPPED WALK: the set was too big for the store to check new links
 *    against, so it held them back (NEO-312; it used to re-add rows instead).
 *
 * AMBER, like `SyncDoneNotice`: an unanswered question, nothing destroyed.
 * `role="status"` — announced when it appears, never interrupting — on the
 * sentences only; the withheld list sits beside the live region, not in it.
 *
 * NEO-325 (a11y re-audit N1): every status region here is mounted EMPTY for
 * as long as the component is, and filled when the store answers. A region
 * that arrives already holding its text is often not announced at all. So
 * callers mount this for the whole sync and pass `holds={null}` until there
 * is something to say; an empty box carries no classes and takes no room.
 *
 * All copy here is DRAFT pending Jason's sign-off (NEO-300).
 */
export default function StoreHoldNotices({ holds }: { holds: StoreHolds | null }) {
  const summaryId = useId();
  const siblingSummaryId = useId();
  const renameSummaryId = useId();
  const withheld = holds?.withheld ?? [];
  const withheldTotal = holds?.withheldTotal ?? 0;
  const subtreeWalkSkipped = holds?.subtreeWalkSkipped ?? false;
  const kinds = withheldKinds(withheld);
  const box =
    "p-3 mb-4 bg-amber-400/10 border border-amber-700 dark:border-amber-400/70 rounded-md text-amber-800 dark:text-amber-300 text-sm";
  const showWithheld = withheldTotal > 0;
  // N2: when the withheld box already lists the unchecked items, it has said
  // this and what to do; a second box would only repeat it.
  const showSkipped = subtreeWalkSkipped && !(showWithheld && kinds.unchecked);

  return (
    <>
      {/* a11y audit (NEO-300): only the summary and the fix are live. The
          list is a SIBLING of the status region, not inside it — a live
          region holding 50 items of up to 10 rows each would read them all. */}
      <div className={showWithheld ? box : undefined}>
        <div role="status">
          {showWithheld && (
            <>
              <p id={summaryId} className="font-medium">
                {withheldSummary(withheldTotal, kinds)}
              </p>
              {kinds.clash && <p>{CLASH_FIX}</p>}
              {kinds.linked && <p>{LINKED_FIX}</p>}
              {kinds.unchecked && <p>{UNCHECKED_FIX}</p>}
            </>
          )}
        </div>
        {showWithheld && withheld.length > 0 && (
          // Bounded for the same reason as HeldElsewhereNote's list: up to
          // 50 items with up to 10 rows each. Focusable so the keyboard can
          // scroll it; `group` is the house role for that.
          <div
            role="group"
            aria-labelledby={summaryId}
            tabIndex={0}
            className="mt-2 max-h-48 overflow-y-auto overscroll-contain rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00C2FF]"
          >
            <ul className="space-y-2">
              {withheld.map((w, i) => (
                <li key={`${i}-${w.label}`}>
                  <span className="font-medium">{w.label}</span>
                  <span className="block text-xs opacity-90">
                    {reasonLine(w.reason)}
                  </span>
                  {w.holders.length > 0 && (
                    <ul className="pl-3 text-xs">
                      {w.holders.map((h) => (
                        <li key={String(h.id)}>{holderLine(h)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {withheldTotal > withheld.length && (
                <li>+ {withheldTotal - withheld.length} more</li>
              )}
            </ul>
          </div>
        )}
      </div>
      <div role="status" className={showSkipped ? box : undefined}>
        {showSkipped && SUBTREE_SKIPPED_MESSAGE}
      </div>
      <SiblingHoldsBox
        box={box}
        summaryId={siblingSummaryId}
        siblings={holds?.siblings ?? []}
        total={holds?.siblingsTotal ?? 0}
      />
      <RefusedRenamesBox
        box={box}
        summaryId={renameSummaryId}
        renames={holds?.renames ?? []}
        total={holds?.renamesTotal ?? 0}
      />
    </>
  );
}

/**
 * NEO-325 — the lines the store did not save because of what is ALREADY
 * under this parent. Same shape as the withheld box above (the a11y audit's
 * NEO-300 rule: only the summary and the fixes are live; the list sits beside
 * the region), but the list grows with its content and the page scrolls — the
 * store sends at most `UNLINK_NOTICE_LIMIT` (50), which no inner scroller is
 * needed for (NEO-321).
 */
function SiblingHoldsBox({
  box,
  summaryId,
  siblings,
  total,
}: {
  box: string;
  summaryId: string;
  siblings: ReadonlyArray<SiblingHold>;
  total: number;
}) {
  const show = total > 0;
  const families = siblingFamiliesIn(siblings);
  // Always mounted, empty while there is nothing to say (see the default
  // export): the status region must exist before it fills.
  return (
    <div className={show ? box : undefined}>
      <div role="status">
        {show && (
          <>
            <p id={summaryId} className="font-medium">
              {siblingHoldSummary(total)}
            </p>
            {SIBLING_FAMILY_ORDER.filter((f) => families.has(f)).map((f) => (
              <p key={f}>{SIBLING_FIX[f]}</p>
            ))}
          </>
        )}
      </div>
      {show && siblings.length > 0 && (
        <ul aria-labelledby={summaryId} className="mt-2 space-y-2">
          {siblings.map((w, i) => (
            <li key={`${i}-${w.label}`}>
              <span className="font-medium">{w.label}</span>
              <span className="block text-xs opacity-90">
                {SIBLING_REASON_LINE[siblingFamily(w.reason)]}
              </span>
              {w.rows.length > 0 && (
                <ul className="pl-3 text-xs">
                  {w.rows.map((r) => (
                    <li key={r.id}>{r.value}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
          {total > siblings.length && <li>+ {total - siblings.length} more</li>}
        </ul>
      )}
    </div>
  );
}

/** NEO-325 — the title edits the store refused; the sets themselves saved. */
function RefusedRenamesBox({
  box,
  summaryId,
  renames,
  total,
}: {
  box: string;
  summaryId: string;
  renames: ReadonlyArray<RefusedRename>;
  total: number;
}) {
  const show = total > 0;
  const clash = renames.some((r) => r.reason === "clash") || renames.length === 0;
  const invalid = renames.some((r) => r.reason === "invalid");
  // Always mounted, empty while there is nothing to say (see the default
  // export): the status region must exist before it fills.
  return (
    <div className={show ? box : undefined}>
      <div role="status">
        {show && (
          <>
            <p id={summaryId} className="font-medium">
              {refusedRenameSummary(total)}
            </p>
            {clash && <p>{RENAME_CLASH_FIX}</p>}
            {invalid && <p>{RENAME_INVALID_FIX}</p>}
          </>
        )}
      </div>
      {show && renames.length > 0 && (
        <ul aria-labelledby={summaryId} className="mt-2 space-y-2">
          {renames.map((r, i) => (
            <li key={`${i}-${r.label}`}>
              <span className="font-medium">{r.label}</span>
              <span className="block text-xs opacity-90">
                {refusedRenameLine(r)}
              </span>
            </li>
          ))}
          {total > renames.length && <li>+ {total - renames.length} more</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * NEO-325 — the store's nine sibling-withhold reasons, in the four families
 * an operator can act on. Each family has ONE fix line, shown once however
 * many lines it covers.
 *
 *  - `name`  — a row here already goes by the title (it holds another set's
 *    link, several rows share it, or there was no link to add).
 *  - `twice` — two lines in this save pointed at one row (by `existingId`, by
 *    marketplace id, or by name).
 *  - `link`  — the line's link is already on more than one row here.
 *  - `split` — its BSC link names one row and its SportLots link another.
 */
export type SiblingFamily = "name" | "twice" | "link" | "split";

const SIBLING_FAMILY_ORDER: readonly SiblingFamily[] = [
  "name",
  "twice",
  "link",
  "split",
];

export function siblingFamily(reason: SiblingWithholdReason): SiblingFamily {
  switch (reason) {
    case "existingIdClaimed":
    case "idClaimedTwice":
    case "nameClaimedTwice":
    case "rowClaimedInBatch":
      return "twice";
    case "idOnManySiblings":
      return "link";
    case "idsPointAtDifferentRows":
      return "split";
    case "nameSharedBySiblings":
    case "nameLinkedToOtherSet":
    case "noIdToAttach":
    default:
      return "name";
  }
}

function siblingFamiliesIn(
  siblings: ReadonlyArray<Pick<SiblingHold, "reason">>,
): Set<SiblingFamily> {
  const families = new Set(siblings.map((s) => siblingFamily(s.reason)));
  // A store that sent only a count: the commonest case, a name already taken.
  if (families.size === 0) families.add("name");
  return families;
}

/** DRAFT (NEO-325). */
export function siblingHoldSummary(n: number): string {
  return n === 1
    ? "Hold up: 1 set wasn't saved, so nothing was attached to it."
    : `Hold up: ${n} sets weren't saved, so nothing was attached to them.`;
}

/**
 * DRAFT (NEO-325). What to do, one line per family present. The verbs are the
 * controls' own: "Detach" (MultiSourcePanel's detach confirm) and "Attach"
 * (its `ATTACH_MORE_LABEL` button). Never "link", "take off" or "move".
 */
export const SIBLING_FIX: Record<SiblingFamily, string> = {
  name: "Name taken? Sync again and give it a name of its own.",
  twice:
    "Doubled up? Sync again: pair just one with that set and give the other a name of its own.",
  link: "On two sets? Detach it from the extra one, then sync again.",
  split:
    "Split across two sets? Detach one and Attach it on the other set, then sync again.",
};

/** DRAFT (NEO-325). The line under each item, before the rows it names. */
export const SIBLING_REASON_LINE: Record<SiblingFamily, string> = {
  name: "A set here already goes by that name:",
  twice: "Points at the same set as another one in this save:",
  link: "Its link is already on more than one set:",
  split: "Its BSC and SportLots links point at different sets:",
};

/** DRAFT (NEO-325). */
export function refusedRenameSummary(n: number): string {
  return n === 1
    ? "Heads up: 1 rename didn't stick. The set and its links were saved."
    : `Heads up: ${n} renames didn't stick. The sets and their links were saved.`;
}

/** DRAFT (NEO-325). */
export const RENAME_CLASH_FIX =
  "Another set here already has that name. Pick a different one and rename it again.";
/** DRAFT (NEO-325). */
export const RENAME_INVALID_FIX =
  "That name can't be used. Pick a different one and rename it again.";

/** DRAFT (NEO-325). The line under each set that kept its name. */
export function refusedRenameLine(r: RefusedRename): string {
  if (r.reason === "invalid") {
    return `Not renamed to “${r.requested}”: that name can't be used.`;
  }
  return `Not renamed to “${r.requested}”: ${r.clashWith ?? "another set"} already has that name.`;
}

/**
 * NEO-312: "Bowman › Insert › All-America Game Autos › Red Ink" — the NB path
 * the store sent, ending in the holder. With no path (an older result, or a
 * holder that is itself a set): "Anime Kanji → Anime" for a parallel, and
 * anything else on its own.
 */
export function holderLine(h: HeldElsewhereEntry): React.ReactNode {
  const path = holderPathOf(h);
  if (path) return [...path, h.value].join(HOLDER_PATH_SEPARATOR);
  if (h.level !== "parallel") return h.value;
  return (
    <>
      {h.value}
      <span aria-hidden="true" className="mx-1.5">
        →
      </span>
      <span className="sr-only">grouped under </span>
      {h.parentValue}
    </>
  );
}

/**
 * Which kinds of withhold the listed sample holds. Each kind has its own fix
 * line, so the operator is told what to do about every kind present and
 * nothing else:
 *  - `clash`: `heldByMany` / `idsDisagree` — nothing was written.
 *  - `linked` (NEO-312): `linkHeldElsewhere` — the row was refreshed, one link
 *    stayed on the row that already had it.
 *  - `unchecked` (NEO-312): `notChecked` — nothing was written.
 * An empty sample (a store that sent only a count) reads as a clash, the only
 * kind there was before NEO-312.
 */
export type WithheldKinds = { clash: boolean; linked: boolean; unchecked: boolean };

export function withheldKinds(
  withheld: ReadonlyArray<Pick<WithheldElsewhereEntry, "reason">>,
): WithheldKinds {
  const kinds = { clash: false, linked: false, unchecked: false };
  for (const w of withheld) {
    if (w.reason === "notChecked") kinds.unchecked = true;
    else if (w.reason === "linkHeldElsewhere") kinds.linked = true;
    else kinds.clash = true;
  }
  if (withheld.length === 0) kinds.clash = true;
  return kinds;
}

/**
 * DRAFT (NEO-300; NEO-312 dropped "in Inserts" — a holder can be anywhere —
 * and added the unchecked and linked kinds). One kind: the count and why.
 * Several: the count alone, and the fix lines say the rest.
 */
export function withheldSummary(n: number, kinds: WithheldKinds): string {
  const one = n === 1;
  const only = [kinds.clash, kinds.linked, kinds.unchecked].filter(Boolean).length === 1;
  if (only && kinds.linked) {
    return one
      ? "Hold up: 1 link not added. It's already on another row."
      : `Hold up: ${n} links not added. They're already on other rows.`;
  }
  const head = `Hold up: ${n} not added.`;
  if (!only) return head;
  if (kinds.unchecked) {
    // N2 (security audit): past the set bound this is deterministic — a retry
    // hits the same bound — so the sentence says why, and the fix line says
    // what still works.
    return `${head} This set is too big to check new links automatically.`;
  }
  return one
    ? `${head} It clashes with existing rows.`
    : `${head} They clash with existing rows.`;
}

/** DRAFT (NEO-300). What to do about a clash. */
export const CLASH_FIX = "Delete or ungroup the extra row, then sync again.";
/** DRAFT (NEO-312). What to do about a link left on the row that had it. */
export const LINKED_FIX =
  "If a link belongs here instead, take it off the other row, then sync again.";
/**
 * DRAFT (NEO-312, N2). What to do about an item the store could not check.
 * A retry hits the same bound, so the fix is the manual attach, named by its
 * visible labels: the column's "+ Custom" (EntityColumn) makes the row, and
 * the selected row's "Multi-source sets" panel has "Attach more…"
 * (MultiSourcePanel). The labels come from `control-labels`, the same
 * constants those components render, so a rename cannot leave this stale.
 * `attachPlatformIds` does not walk the set, so it works on a set past the
 * bound.
 */
export const UNCHECKED_FIX = `You can still add it by hand: pick its row, or make one with ${CUSTOM_BUTTON_LABEL}, then use ${ATTACH_MORE_LABEL} under ${MULTI_SOURCE_HEADING}.`;

/** DRAFT. The line under each withheld item, before the rows it names. */
export function reasonLine(reason: WithheldElsewhereEntry["reason"]): string {
  if (reason === "heldByMany") return "Already on more than one row:";
  // NEO-312 — the holder below is where the link lives now.
  if (reason === "linkHeldElsewhere") return "Its link is already on this row, so it stayed there:";
  if (reason === "notChecked") {
    // NEO-312 — no rows follow: there is nothing it clashes with, only a
    // check that could not run.
    return "Not added: this set is too big to check new links automatically.";
  }
  return "Points at a row linked to a different set:";
}

/**
 * DRAFT (NEO-312). The set walk stopped on a bound, so the store held back
 * every new link it could not clear. It used to fall back to siblings only and
 * could re-add rows, which is what the old "may have re-added some. Look for
 * doubles." said; that no longer happens.
 */
export const SUBTREE_SKIPPED_MESSAGE =
  "Heads up: this set is too big to check new links automatically, so new ones weren't added.";
