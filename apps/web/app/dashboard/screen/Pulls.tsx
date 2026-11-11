import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/24/solid";
import { Link, useLocation } from "react-router";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import type { AdditionBatch, DashCard, WantCard } from "../fake-data";
import { CardTitle, sideHref, WANT_RING, WantFlag } from "./bits";
import { PanelLink } from "./panelLink";
import { useOpen } from "./useOpen";

/**
 * NEO-464 combined dashboard, block 6 left column (from prototype 2): the
 * chase (the Want List's top cards, top chase first), then fresh pulls in the
 * batches they came in, newest first (any card filed into a binder in the
 * last 14 days, however it got there; none and the section is not drawn). Every card is captioned with its full
 * listing title; a pull that is on the Want List wears a dashed yellow
 * border and says so (Jason, review item 5). A pull, and a card of the
 * chase, opens its card panel over the dashboard (`./panelLink`), as a card
 * in the collection, its ↑ ↓ stepping through the batch or the chase.
 */

/** How many cards a batch shows before "Show all". */
const BATCH_PREVIEW = 6;

/**
 * A card tile: its picture and caption (the full listing title, then a note,
 * then the Want List mark) as one link that opens the card's panel on the
 * collection side, ↑ ↓ stepping through `list`. Named by its words, the full
 * listing title first.
 */
function CardTile({
  card,
  list,
  extra,
  wanted = false,
}: {
  card: DashCard;
  list: readonly string[];
  extra?: string;
  wanted?: boolean;
}) {
  return (
    <PanelLink cardId={card.id} side="collection" list={list} className="group block rounded-md focus-outline">
      <span
        aria-hidden="true"
        className={`block transition-transform group-hover:-translate-y-1 motion-reduce:transition-none ${wanted ? WANT_RING : ""}`}
      >
        <CardFace model={card.card} size="fill" />
      </span>
      <span className="mt-1.5 block space-y-0.5 text-xs leading-snug">
        <CardTitle card={card} lines={3} className="text-ink" />
        {extra && <span className="block truncate text-ink-3">{extra}</span>}
        {wanted && (
          <>
            {" "}
            <WantFlag />
          </>
        )}
      </span>
    </PanelLink>
  );
}

export function Chase({ wants }: { wants: WantCard[] }) {
  return (
    <section aria-labelledby="cb-chase-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cb-chase-heading" tabIndex={-1} className="rounded-sm text-2xl font-bold text-ink focus-outline">
          The Chase
        </h2>
        <p className="text-sm text-ink-3">Top of your Want List.</p>
      </div>
      {wants.length === 0 ? (
        <ChaseEmpty />
      ) : (
        <ol className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-5">
          {wants.map((w, i, all) => (
            <li key={w.id} className={i === 0 ? "relative" : undefined}>
              {i === 0 && (
                <span className="mb-1.5 block text-xs font-bold text-neon-yellow-text">
                  <span aria-hidden="true" className="mc-star">
                    ★{" "}
                  </span>
                  Top chase
                </span>
              )}
              <div className={i === 0 ? "rounded-[6%] outline-2 outline-offset-2 outline-neon-yellow-text" : undefined}>
                <CardTile card={w} list={all.map((x) => x.id)} extra={w.forBinder ? `For ${w.forBinder}` : undefined} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * No wants yet: three empty sleeves waiting, the front one carrying the Want
 * List's star, and the way to fill them.
 */
function ChaseEmpty() {
  const { pathname } = useLocation();
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
      <div aria-hidden="true" className="cb-chase-empty">
        <span className="cb-chase-ghost" />
        <span className="cb-chase-ghost" />
        <span className="cb-chase-ghost">
          <StarIcon className="cb-chase-star" />
        </span>
      </div>
      <p className="max-w-[26rem] text-ink-2">
        Your Want List is empty. Star a card on{" "}
        <Link
          to={sideHref(pathname, "collection", { tab: "checklists" })}
          className="rounded-sm font-semibold text-neon-blue-text underline underline-offset-2 focus-outline"
        >
          any checklist
        </Link>{" "}
        to start the hunt.
      </p>
    </div>
  );
}

/** What came in lately, newest batch first. Nothing new: no section at all. */
export function FreshPulls({ batches, wanted }: { batches: AdditionBatch[]; wanted: Set<string> }) {
  if (batches.length === 0) return null;
  const firstOld = batches.findIndex((b) => !b.sinceLastVisit);
  return (
    <section aria-labelledby="cb-pulls-heading" className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cb-pulls-heading" tabIndex={-1} className="rounded-sm text-2xl font-bold text-ink focus-outline">
          Fresh Pulls
        </h2>
        <p className="text-sm text-ink-3">Newest first.</p>
      </div>
      {batches.map((b, i) => (
        <div key={b.id} className="space-y-5">
          {i === firstOld && i > 0 && (
            <p className="flex items-center gap-3 text-xs text-ink-3">
              <span aria-hidden="true" className="h-px flex-1 bg-rule" />
              Before your last visit
              <span aria-hidden="true" className="h-px flex-1 bg-rule" />
            </p>
          )}
          <Batch batch={b} wanted={wanted} />
        </div>
      ))}
    </section>
  );
}

function batchTitle(b: AdditionBatch): string {
  const n = b.cards.length;
  const cards = n === 1 ? "1 card" : `${n} cards`;
  const into = b.binders.length === 1 ? b.binders[0].name : `${b.binders.length} binders`;
  return `${b.whenLabel}: ${cards} into ${into}`;
}

function Batch({ batch, wanted }: { batch: AdditionBatch; wanted: Set<string> }) {
  const [all, toggle] = useOpen(batch.id);
  const shown = all ? batch.cards : batch.cards.slice(0, BATCH_PREVIEW);
  const hidden = batch.cards.length - BATCH_PREVIEW;
  const headingId = `cb-batch-${batch.id}`;
  // ↑ ↓ in a pull's panel walk the whole batch, the cards behind Show all too.
  const batchIds = batch.cards.map((c) => c.id);

  return (
    <article aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} tabIndex={-1} className="rounded-sm text-base font-bold text-ink focus-outline">
          {batchTitle(batch)}
        </h3>
        {batch.binders.length > 1 && (
          <p className="text-xs text-ink-3">{batch.binders.map((x) => `${x.name} ${x.count}`).join(", ")}</p>
        )}
      </div>
      <ul className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
        {shown.map((c) => (
          <li key={`${c.id}@${c.binderName}`} className="min-w-0">
            <CardTile card={c} list={batchIds} wanted={wanted.has(c.id)} />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          onClick={toggle}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 transition-transform motion-reduce:transition-none ${all ? "rotate-180" : ""}`}
          />
          {/* The name is the visible words plus a stable "which batch" for a reader; aria-expanded says the state. */}
          {all ? "Show fewer" : `Show all ${batch.cards.length}`}
          {/* The count it adds is seen, not read: the words on it lead its name (WCAG 2.5.3). */}
          {!all && (
            <span aria-hidden="true" className="text-ink-3">
              {" "}
              (+{hidden})
            </span>
          )}
          <span className="sr-only"> cards from {batch.whenLabel}</span>
        </button>
      )}
    </article>
  );
}
