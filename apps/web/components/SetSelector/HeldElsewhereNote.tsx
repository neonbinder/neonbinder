import React, { useId, useState } from "react";
import type { HeldRow } from "./held-elsewhere";

/**
 * NEO-300 — "these came back from the marketplace, and we left them alone".
 *
 * A sync that skips a fetched set because another NB row already holds it must
 * say so: hiding it silently reads as "the marketplace stopped sending it", and
 * that is a different problem with a different fix. So: a count, and a
 * disclosure naming each NB row that holds one, with the insert it sits under.
 *
 * Every name here is OURS — the holding row's NB name and its parent insert's
 * NB name — never the marketplace's label for the set.
 *
 * ## Live regions (a11y audit, NEO-300)
 *
 * Inside a sync panel the summary is part of the result the panel ANNOUNCES,
 * but the toggle and list must not be: a list opened inside a live region
 * reads every row aloud. So a caller that owns a live region renders the
 * summary itself, inside it, passes that element's id as `summaryId`, and
 * renders this component AFTER the region — it then draws only the toggle and
 * the list, labelled by that id. Without `summaryId` (the modal header, which
 * is not live) it draws the summary too.
 *
 * `toggleLabel` is per caller on purpose. Sync Inserts and Sync Sub-Variants
 * can each have a panel up at once, and two disclosures with one accessible
 * name are ambiguous both for a screen reader and for a Maestro text match.
 */
export default function HeldElsewhereNote({
  rows,
  total,
  summary,
  toggleLabel,
  summaryId: externalSummaryId,
  tone = "modal",
}: {
  rows: ReadonlyArray<HeldRow>;
  /**
   * The true count, when it can exceed `rows` (the store's list is a capped
   * sample). The list then ends with how many it is not naming.
   */
  total?: number;
  /** The whole sentence, count included — composed by the caller. */
  summary: string;
  toggleLabel: string;
  /**
   * The id of a summary the CALLER rendered (inside its live region). When
   * set, this component does not render `summary` and labels its list by it.
   */
  summaryId?: string;
  /** "modal" sits on the dark dialog panel; "panel" inside the sync form's status box. */
  tone?: "modal" | "panel";
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const ownSummaryId = useId();
  const summaryId = externalSummaryId ?? ownSummaryId;
  if (rows.length === 0 && !(total !== undefined && total > 0)) return null;

  const text = tone === "modal" ? "text-gray-400" : "";
  const name = tone === "modal" ? "text-gray-200" : "font-medium";
  const arrow = tone === "modal" ? "text-[#00C2FF]" : "";

  return (
    <div className={`text-sm ${text}`}>
      {externalSummaryId === undefined && (
        <>
          <span id={summaryId}>{summary}</span>{" "}
        </>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        // WCAG 2.5.8: padding grows the hit area to 24px+ tall; the negative
        // vertical margin keeps the line from growing with it.
        className="inline-block min-h-6 px-1 py-0.5 -my-0.5 underline underline-offset-2 hover:text-[#00C2FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00C2FF] rounded"
      >
        {toggleLabel}
      </button>
      {/* NEO-300 — `aria-controls` points at this WRAPPER, not at the list:
          the list is focusable, and maestro-web reports a control's
          resource-id as `id || aria-label`, so an id on a focusable element
          hides its name from every flow. Always rendered, so the reference
          resolves whether the list is open or not. */}
      <div id={listId}>
      {open && (
        // Bounded and scrolled: in ReconciliationModal this sits in the
        // header, which does not scroll, and a big set (2026 Bowman) can hold
        // 140+ grouped rows — unbounded, the list pushed the body and the Save
        // footer out of the 90vh panel. A focusable region, named by the
        // summary it expands, so the keyboard can scroll it too. `group`, not
        // `region`: the house role for a focusable scroll container (the
        // print preview's), and the one the lint rule allows a tabIndex on.
        <div
          role="group"
          aria-labelledby={summaryId}
          tabIndex={0}
          className="mt-1 max-h-40 overflow-y-auto overscroll-contain rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00C2FF]"
        >
          <ul className="space-y-0.5 pl-3">
            {rows.map((r) => (
              <li key={r.key}>
                <span className={name}>{r.name}</span>
                {r.parentName !== undefined && (
                  <>
                    <span aria-hidden="true" className={`mx-1.5 ${arrow}`}>
                      →
                    </span>
                    <span className="sr-only">grouped under </span>
                    <span>{r.parentName}</span>
                  </>
                )}
              </li>
            ))}
            {total !== undefined && total > rows.length && (
              <li>+ {total - rows.length} more</li>
            )}
          </ul>
        </div>
      )}
      </div>
    </div>
  );
}

/** "1 already grouped as a parallel." / "4 already grouped as parallels." */
export function groupedAsParallelsSummary(n: number): string {
  return n === 1
    ? "1 already grouped as a parallel. Leaving it be."
    : `${n} already grouped as parallels. Leaving those be.`;
}

/** Sub-Variants: rows held by another insert, or by another insert's parallels. */
export function heldElsewhereSummary(n: number, variantsLabel: string): string {
  return n === 1
    ? `1 already lives elsewhere in ${variantsLabel}. Leaving it be.`
    : `${n} already live elsewhere in ${variantsLabel}. Leaving those be.`;
}

/**
 * The status line after a reconcile Save the store partly declined. Same verb
 * as the modal's "Save N sets" button. "Saved 1 set." / "Saved 3 sets."
 */
export function savedSetsMessage(n: number): string {
  return n === 1 ? "Saved 1 set." : `Saved ${n} sets.`;
}
