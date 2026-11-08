import type { TradePile, UnlistedBox } from "../_shared/data";
import { CardLine, RAIL_PANEL, RailHeading } from "./bits";
import { SHELF_CAP } from "./Shelf";
import type { ShelfBinder } from "./shelf-model";

/**
 * NEO-464 combined dashboard, block 6 right rail (from prototype 2): Binders
 * Filling Up (the binders cards were filed in since the last visit), then
 * Odds and Ends (unlisted boxes, dealer only, and the trade pile). Quiet
 * panels. In the Hopper moved to the top of the page (review item 1); Out
 * the Door lives only in the to-do.
 */

/** Cards named per binder before "+N more". */
const PER_BINDER = 3;

export function FillingUp({
  binders,
  wanted,
  onOpen,
}: {
  /** In shelf order. */
  binders: ShelfBinder[];
  wanted: Set<string>;
  onOpen: (id: string) => void;
}) {
  const filling = binders.filter((b) => b.newCards.length > 0);
  if (filling.length === 0) return null;
  const shown = filling.slice(0, SHELF_CAP);
  const left = filling.length - shown.length;

  return (
    <section aria-labelledby="cb-filling-heading" className={RAIL_PANEL}>
      <RailHeading id="cb-filling-heading" note="Since your last visit">
        Binders Filling Up
      </RailHeading>
      <ul className="divide-y divide-rule">
        {shown.map((b) => {
          const cards = b.newCards.slice(0, PER_BINDER);
          const more = b.newCards.length - cards.length;
          return (
            <li key={b.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="min-w-0 text-sm font-bold text-ink">
                  <button
                    type="button"
                    onClick={() => onOpen(b.id)}
                    aria-label={`Open ${b.name}`}
                    className="max-w-full truncate rounded-sm text-left hover:text-neon-blue-text hover:underline focus-outline max-sm:-my-3 max-sm:min-h-11 max-sm:min-w-11"
                  >
                    {b.name}
                  </button>
                </h3>
                <span className="shrink-0 text-xs font-semibold text-neon-green-text">{b.newCards.length} new</span>
              </div>
              <ul aria-label={`New in ${b.name}`} className="flex flex-col gap-2">
                {cards.map((c) => (
                  <li key={c.id}>
                    <CardLine card={c} thumb="w-8" wanted={wanted.has(c.id)} />
                  </li>
                ))}
              </ul>
              {more > 0 && <p className="text-xs text-ink-3">+{more} more</p>}
            </li>
          );
        })}
      </ul>
      {left > 0 && <p className="mt-3 text-xs text-ink-3">And {left} more binders on the shelf.</p>}
    </section>
  );
}

export function OddsAndEnds({ boxes, trade }: { boxes: UnlistedBox[]; trade: TradePile }) {
  if (boxes.length === 0 && trade.count === 0) return null;
  return (
    <section aria-labelledby="cb-odds-heading" className={RAIL_PANEL}>
      <RailHeading id="cb-odds-heading">Odds and Ends</RailHeading>
      <ul className="space-y-2 text-sm">
        {boxes.map((b) => (
          <li key={b.id} className="flex justify-between gap-2">
            <span className="truncate text-ink-2">{b.name}</span>
            <span className="shrink-0 tabular-nums text-ink">
              {b.unlisted === 1 ? "1 card not listed" : `${b.unlisted} cards not listed`}
            </span>
          </li>
        ))}
        {trade.count > 0 && (
          <li className="flex justify-between gap-2">
            <span className="truncate text-ink-2">Trade pile</span>
            <span className="shrink-0 tabular-nums text-ink">
              {trade.count === 1 ? "1 card up for trade" : `${trade.count} cards up for trade`}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
