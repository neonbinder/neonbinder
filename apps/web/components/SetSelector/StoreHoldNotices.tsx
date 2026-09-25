import React, { useId } from "react";
import type { HeldElsewhereEntry } from "../../convex/selectorSyncStore";
import type { StoreHolds } from "./held-elsewhere";

/**
 * NEO-300 — the two things a finished sync store can still need the operator
 * to act on. Both come from the store's own transaction, so the client cannot
 * have filtered them; both hold the sync panel open until read.
 *
 *  - WITHHELD: items not added, because their marketplace id is already on
 *    two or more rows here, or because the row they point at is linked to a
 *    different set. The store will not guess which row is right, so the fix is
 *    the operator's: delete or ungroup the extra row, then sync again. Each
 *    item is named with the rows it clashes with, by NB's names only.
 *  - SKIPPED WALK: the variant type was too big for the store to look for
 *    grouped parallels, so this sync may have re-added some.
 *
 * AMBER, like `SyncDoneNotice`: an unanswered question, nothing destroyed.
 * `role="status"` — announced when it appears, never interrupting — on the
 * sentences only; the withheld list sits beside the live region, not in it.
 *
 * All copy here is DRAFT pending Jason's sign-off (NEO-300).
 */
export default function StoreHoldNotices({
  holds,
  variantsLabel,
}: {
  holds: StoreHolds;
  /** The column's plural noun, e.g. "Inserts". */
  variantsLabel: string;
}) {
  const summaryId = useId();
  const { withheld, withheldTotal, subtreeWalkSkipped } = holds;
  const box =
    "p-3 mb-4 bg-amber-400/10 border border-amber-700 dark:border-amber-400/70 rounded-md text-amber-800 dark:text-amber-300 text-sm";

  return (
    <>
      {withheldTotal > 0 && (
        // a11y audit (NEO-300): only the summary and the fix are live. The
        // list is a SIBLING of the status region, not inside it — a live
        // region holding 50 items of up to 10 rows each would read them all.
        <div className={box}>
          <div role="status">
            <p id={summaryId} className="font-medium">
              {withheldSummary(withheldTotal, variantsLabel)}
            </p>
            <p>Delete or ungroup the extra row, then sync again.</p>
          </div>
          {withheld.length > 0 && (
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
                      {w.reason === "heldByMany"
                        ? "Already on more than one row:"
                        : "Points at a row linked to a different set:"}
                    </span>
                    <ul className="pl-3 text-xs">
                      {w.holders.map((h) => (
                        <li key={String(h.id)}>{holderLine(h)}</li>
                      ))}
                    </ul>
                  </li>
                ))}
                {withheldTotal > withheld.length && (
                  <li>+ {withheldTotal - withheld.length} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
      {subtreeWalkSkipped && (
        <div role="status" className={box}>
          {subtreeSkippedMessage(variantsLabel)}
        </div>
      )}
    </>
  );
}

/** "Anime Kanji → Anime" for a parallel; an insert is named on its own. */
function holderLine(h: HeldElsewhereEntry): React.ReactNode {
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

/** DRAFT (NEO-300). */
export function withheldSummary(n: number, variantsLabel: string): string {
  return n === 1
    ? `Hold up: 1 not added. It clashes with rows already in ${variantsLabel}.`
    : `Hold up: ${n} not added. They clash with rows already in ${variantsLabel}.`;
}

/** DRAFT (NEO-300). */
export function subtreeSkippedMessage(variantsLabel: string): string {
  return `Heads up: ${variantsLabel} is too big to check for grouped parallels, so this sync may have re-added some. Look for doubles.`;
}
