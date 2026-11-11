import type { RefObject } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import CardFace, { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import { count } from "./bits";
import { PanelLink } from "./panelLink";
import { POCKETS_PER_PAGE, pocketsOf, type ShelfBinder } from "./shelf-model";

/**
 * NEO-464 combined dashboard — the binder pulled off the shelf, open to one
 * nine-pocket page, in place beside the shelf (below it on a phone). A plain
 * binder opens on what came in since the last visit; a binder with pages
 * (the Contenders build) or a checklist keeps its own order, with an empty
 * pocket for every card still needed. New cards wear a green "New" tab.
 * Every pocket is captioned with its card's full listing title, and opens
 * that card's panel over the dashboard (a needed one too: it is wanted or
 * added from there).
 *
 * The screen places the title and the page in separate grid cells (see
 * DashboardScreen): the title sits level with "Your binders" and the page
 * stops at the bottom of the shelves. Which binder is open lives in the URL
 * (pushed); the page turn replaces the entry (an in-view tweak).
 */

/** A pocket's card as a link: the whole sleeve's contents, lifting a touch under the pointer. */
const POCKET_LINK =
  "group block h-full rounded-[4px] focus-outline [&>div]:transition-transform [&>div]:motion-reduce:transition-none hover:[&>div]:-translate-y-0.5";

interface PocketTitleProps {
  binder: ShelfBinder;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

/** The open binder's name and what has changed in it. */
export function PocketTitle({ binder, headingRef }: PocketTitleProps) {
  const fresh = binder.newCards.length;
  return (
    <div>
      <h3 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-ink focus:outline-none">
        {binder.name}
      </h3>
      {binder.ruleText && <p className="mt-0.5 text-sm text-ink-2">Holds: {binder.ruleText}</p>}
      <p className="mt-2 text-sm text-ink">
        {fresh > 0 ? (
          <>
            <strong className="text-neon-green-text">{fresh} new</strong> since your last visit.
          </>
        ) : (
          "Nothing new since your last visit."
        )}{" "}
        <span className="text-ink-2">{count(binder.cardCount, "card")} in all.</span>
        {binder.checklist && (
          <span className="text-ink-2">
            {" "}
            <strong className="text-ink">{binder.checklist.percent}%</strong> of the checklist.
          </span>
        )}
      </p>
    </div>
  );
}

interface PocketPageProps {
  binder: ShelfBinder;
  /** 0-based, already clamped. */
  page: number;
  onPage: (page: number) => void;
}

export default function PocketPage({ binder, page, onPage }: PocketPageProps) {
  const pockets = pocketsOf(binder);
  const listIds = pockets.flatMap((p) => (p.card ? [p.card.id] : []));
  const pages = Math.max(1, Math.ceil(pockets.length / POCKETS_PER_PAGE));
  const shown = pockets.slice(page * POCKETS_PER_PAGE, (page + 1) * POCKETS_PER_PAGE);
  const atFirst = page === 0;
  const atLast = page >= pages - 1;

  return (
    <div className="cb-page-in flex h-full min-w-0 flex-col gap-3">
      {/* aria-disabled, never native `disabled`: turning to the last page must not drop focus to the body. */}
      <div className="flex flex-wrap items-center gap-2">
        <NeonButton
          variant="secondary"
          outline
          size="1"
          aria-disabled={atFirst || undefined}
          onClick={() => {
            if (!atFirst) onPage(page - 1);
          }}
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
          aria-disabled={atLast || undefined}
          onClick={() => {
            if (!atLast) onPage(page + 1);
          }}
        >
          Next page
          <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
        </NeonButton>
      </div>

      <ul className="cb-page cb-page--fill" aria-label={`${binder.name}, page ${page + 1} of ${pages}`}>
        {shown.map((p, i) => (
          <li key={p.key} className="cb-pocket">
            {/* The caption names the card, so the picture is not named again. */}
            {/* A pocket's card opens its panel, ↑ ↓ walking the binder's cards; its title leads the link's name. */}
            {p.kind === "card" ? (
              <PanelLink cardId={p.card.id} side="collection" list={listIds} className={POCKET_LINK}>
                <div aria-hidden="true">
                  <CardFace model={p.card.card} size="fill" />
                </div>
                <PocketCaption title={p.card.title} />
                {p.isNew && <span className="cb-pocket-new">New</span>}
              </PanelLink>
            ) : p.card ? (
              <PanelLink cardId={p.card.id} side="collection" list={listIds} className={POCKET_LINK}>
                <div aria-hidden="true">
                  <CardFace model={p.card.card} size="fill" empty />
                </div>
                <PocketCaption title={p.card.title} need />
              </PanelLink>
            ) : (
              <EmptySleeve size="fill" label={`Empty pocket ${i + 1} of ${POCKETS_PER_PAGE}`} />
            )}
          </li>
        ))}
        {Array.from({ length: POCKETS_PER_PAGE - shown.length }, (_, i) => (
          <li key={`blank-${i}`} className="cb-pocket">
            <EmptySleeve size="fill" label={`Empty pocket ${shown.length + i + 1} of ${POCKETS_PER_PAGE}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A pocket's caption: the full title, three lines on screen, all of it for a reader. */
function PocketCaption({ title, need = false }: { title: string; need?: boolean }) {
  return (
    <span title={title} className={`mt-1 line-clamp-3 break-words text-xs leading-tight ${need ? "text-ink-3" : "text-ink-2"}`}>
      {need && <span className="font-semibold">Need: </span>}
      {title}
    </span>
  );
}

/** No binder open: the line that says how to start. */
export function WaitingTitle() {
  return <p className="text-sm text-ink-3">Pull a binder off the shelf and it opens right here.</p>;
}
