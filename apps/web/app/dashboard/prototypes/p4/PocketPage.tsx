import type { RefObject } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import CardFace, { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import { POCKETS_PER_PAGE, pocketsOf, type ShelfBinder } from "./shelf-model";

/**
 * The binder pulled off the shelf, open to one nine-pocket page. A plain
 * binder opens on what came in since the last visit; a binder with pages
 * (the Contenders build) or a checklist keeps its own order, with an empty
 * pocket for every card still needed. New cards wear a green "New" tab.
 *
 * Which binder is open and which page is showing live in the URL (the
 * page's `onPage` replaces the entry: a page turn is an in-view tweak).
 */

interface PocketPageProps {
  binder: ShelfBinder;
  /** 0-based, already clamped. */
  page: number;
  onPage: (page: number) => void;
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

export function pageCount(binder: ShelfBinder): number {
  return Math.max(1, Math.ceil(pocketsOf(binder).length / POCKETS_PER_PAGE));
}

export default function PocketPage({ binder, page, onPage, onClose, headingRef }: PocketPageProps) {
  const pockets = pocketsOf(binder);
  const pages = Math.max(1, Math.ceil(pockets.length / POCKETS_PER_PAGE));
  const shown = pockets.slice(page * POCKETS_PER_PAGE, (page + 1) * POCKETS_PER_PAGE);
  const fresh = binder.newCards.length;

  return (
    <div className="p4-page-in grid gap-5 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0 lg:order-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-ink focus:outline-none">
          {binder.name}
        </h2>
        {binder.ruleText && <p className="mt-1 text-sm text-ink-2">Holds: {binder.ruleText}</p>}
        <p className="mt-3 text-base text-ink">
          {fresh > 0 ? (
            <>
              <strong className="text-neon-green-text">{fresh} new</strong> since your last visit.
            </>
          ) : (
            "Nothing new since your last visit."
          )}{" "}
          <span className="text-ink-2">
            {binder.cardCount} {binder.cardCount === 1 ? "card" : "cards"} in all.
          </span>
        </p>
        {binder.checklist && (
          <div className="mt-3 max-w-xs">
            <p className="text-sm text-ink-2">
              <strong className="text-ink">{binder.checklist.percent}%</strong> of the checklist: {binder.checklist.have} of{" "}
              {binder.checklist.total}
            </p>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
              <div className="h-full rounded-full bg-neon-green" style={{ width: `${binder.checklist.percent}%` }} />
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <NeonButton
            variant="secondary"
            outline
            size="1"
            onClick={() => onPage(page - 1)}
            disabled={page === 0}
          >
            <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
            Previous page
          </NeonButton>
          <p className="min-w-[6.5rem] text-center text-sm tabular-nums text-ink-2" aria-live="polite">
            Page {page + 1} of {pages}
          </p>
          <NeonButton
            variant="secondary"
            outline
            size="1"
            onClick={() => onPage(page + 1)}
            disabled={page >= pages - 1}
          >
            Next page
            <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
          </NeonButton>
        </div>
        <NeonButton variant="secondary" outline size="1" className="mt-3" onClick={onClose}>
          Back on the shelf
        </NeonButton>
      </div>

      <ul className="p4-page lg:order-1" aria-label={`${binder.name}, page ${page + 1} of ${pages}`}>
        {shown.map((p, i) => (
          <li key={p.key} className="p4-pocket">
            {p.kind === "card" ? (
              <>
                <CardFace model={p.card.card} size="fill" />
                {p.isNew && <span className="p4-pocket-new">New</span>}
              </>
            ) : p.card ? (
              <CardFace model={p.card.card} size="fill" empty />
            ) : (
              <EmptySleeve size="fill" label={`Empty pocket ${i + 1} of ${POCKETS_PER_PAGE}`} />
            )}
          </li>
        ))}
        {Array.from({ length: POCKETS_PER_PAGE - shown.length }, (_, i) => (
          <li key={`blank-${i}`} className="p4-pocket">
            <EmptySleeve size="fill" label={`Empty pocket ${shown.length + i + 1} of ${POCKETS_PER_PAGE}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}
