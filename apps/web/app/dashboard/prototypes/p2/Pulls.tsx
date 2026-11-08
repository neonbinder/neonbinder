import { ChevronDownIcon } from "@heroicons/react/24/outline";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import type { AdditionBatch, DashCard, WantCard } from "../_shared/data";
import { useOpen } from "./useOpen";

/**
 * NEO-464 prototype 2 — under the wall: the chase (the Want List's top
 * cards), then fresh pulls in the batches they came in, newest first.
 */

/** How many cards a batch shows before "Show all". */
const BATCH_PREVIEW = 6;

function variantLine(c: DashCard): string {
  if (!c.variantName) return "Base";
  return c.printRun ? `${c.variantName} ${c.printRun}` : c.variantName;
}

/** A card with its caption: player, year and set, parallel. */
function Tile({ card, extra }: { card: DashCard; extra?: string }) {
  return (
    <figure className="min-w-0">
      <CardFace model={card.card} size="fill" />
      <figcaption className="mt-1.5 space-y-0.5 text-xs leading-snug">
        <span className="block truncate font-semibold text-ink">{card.player}</span>
        <span className="block truncate text-ink-3">
          {card.setLabel} #{card.cardNumber}
        </span>
        <span className={`block truncate ${card.variantName ? "text-neon-blue-text" : "text-ink-3"}`}>
          {variantLine(card)}
        </span>
        {extra && <span className="block truncate text-ink-3">{extra}</span>}
      </figcaption>
    </figure>
  );
}

export function Chase({ wants }: { wants: WantCard[] }) {
  return (
    <section aria-labelledby="p2-chase-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="p2-chase-heading" className="text-2xl font-bold text-ink">
          The Chase
        </h2>
        <p className="text-sm text-ink-3">Top of your Want List.</p>
      </div>
      {wants.length === 0 ? (
        <p className="text-ink-2">Your Want List is empty. Star a card on any checklist to start the hunt.</p>
      ) : (
        <ol className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-5">
          {wants.map((w, i) => (
            <li key={w.id} className={i === 0 ? "relative" : undefined}>
              {i === 0 && (
                <span className="mb-1.5 block text-xs font-bold text-neon-yellow-text">
                  <span aria-hidden="true" className="mc-star">
                    ★{" "}
                  </span>
                  Top chase
                </span>
              )}
              <div className={i === 0 ? "rounded-[6%] outline-2 outline-offset-2 outline-neon-yellow" : undefined}>
                <Tile card={w} extra={w.forBinder ? `For ${w.forBinder}` : undefined} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function FreshPulls({ batches }: { batches: AdditionBatch[] }) {
  const firstOld = batches.findIndex((b) => !b.sinceLastVisit);
  return (
    <section aria-labelledby="p2-pulls-heading" className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="p2-pulls-heading" className="text-2xl font-bold text-ink">
          Fresh Pulls
        </h2>
        <p className="text-sm text-ink-3">Newest first.</p>
      </div>
      {batches.length === 0 ? (
        <p className="text-ink-2">No new cards yet. Scan a stack and they land here.</p>
      ) : (
        batches.map((b, i) => (
          <div key={b.id} className="space-y-5">
            {i === firstOld && i > 0 && (
              <p className="flex items-center gap-3 text-xs text-ink-3">
                <span aria-hidden="true" className="h-px flex-1 bg-rule" />
                Before your last visit
                <span aria-hidden="true" className="h-px flex-1 bg-rule" />
              </p>
            )}
            <Batch batch={b} />
          </div>
        ))
      )}
    </section>
  );
}

function batchTitle(b: AdditionBatch): string {
  const n = b.cards.length;
  const cards = n === 1 ? "1 card" : `${n} cards`;
  const into = b.binders.length === 1 ? b.binders[0].name : `${b.binders.length} binders`;
  return `${b.whenLabel}: ${cards} into ${into}`;
}

function Batch({ batch }: { batch: AdditionBatch }) {
  const [all, toggle] = useOpen(batch.id);
  const shown = all ? batch.cards : batch.cards.slice(0, BATCH_PREVIEW);
  const hidden = batch.cards.length - BATCH_PREVIEW;
  const headingId = `p2-batch-${batch.id}`;

  return (
    <article aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="text-base font-bold text-ink">
          {batchTitle(batch)}
        </h3>
        {batch.binders.length > 1 && (
          <p className="text-xs text-ink-3">{batch.binders.map((x) => `${x.name} ${x.count}`).join(", ")}</p>
        )}
      </div>
      <ul className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
        {shown.map((c) => (
          <li key={`${c.id}@${c.binderName}`}>
            <Tile card={c} />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          aria-label={`${all ? "Show fewer" : `Show all ${batch.cards.length}`} cards from ${batch.whenLabel}`}
          onClick={toggle}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 transition-transform motion-reduce:transition-none ${all ? "rotate-180" : ""}`}
          />
          {all ? "Show fewer" : `Show all ${batch.cards.length}`}
          {!all && <span className="text-ink-3">(+{hidden})</span>}
        </button>
      )}
    </article>
  );
}
