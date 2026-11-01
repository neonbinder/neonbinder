import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import { FOCUS } from "../../../prototypes/p1/ui";
import { SkeletonBars } from "../../catalog/Skeleton";
import { cardLabel } from "../../data/labels";
import { useCards, useListing, type ListingExtension } from "../../data/store";
import type { Card, CardId, Sale, SaleItem } from "../../data/types";
import { BSC_NAME, BSC_ORDERS_URL, UNMATCHED_CARD, dollars, orderDay, orderStatus, saleItemProblem } from "./copy";

/**
 * NEO-370 — the Sales tab on the inventory (`/inventory?tab=sales`): every
 * order the collector received, newest first, a page at a time ("Show more
 * sales" stays in place: paging is not a Back step). When a page lands, focus
 * moves to its first order and a quiet status says how many show.
 * Read-only: shipping and the pull list come later. Sales come in while the
 * sign-in is saved; removing it stops them (Profile).
 *
 * Each order shows its number, day, BSC's status, its total and its lines
 * (the NB card when NB matched it, how many, the price each). A line NB could
 * not take out of the boxes says why, in plain words. BSC has no link to one
 * order, so the number is shown to search for on BSC's orders page.
 *
 * Hidden in a store with no listing (the demo): the page leaves the tab out.
 */
export default function SalesTab() {
  const listing = useListing();
  if (!listing) return null;
  return <Sales listing={listing} />;
}

function Sales({ listing }: { listing: ListingExtension }) {
  const page = listing.useSales();
  const listHeadingId = useId();
  const cardIds = useMemo(() => {
    const ids = new Set<CardId>();
    for (const sale of page.sales ?? []) for (const item of sale.items) if (item.cardId) ids.add(item.cardId);
    return [...ids];
  }, [page.sales]);
  const cards = useCards(cardIds.length > 0 ? cardIds : null);
  const byId = useMemo(() => {
    const out = new Map<CardId, Card>();
    cards?.forEach((card, i) => {
      if (card) out.set(cardIds[i], card);
    });
    return out;
  }, [cards, cardIds]);

  // "Show more sales": where the new page starts, until it lands; then focus
  // its first order and say how many show. `sawLoading` tells a page that
  // brought nothing apart from a click the store has not answered yet.
  const listRef = useRef<HTMLOListElement>(null);
  const asked = useRef<{ from: number; sawLoading: boolean } | null>(null);
  const [moreNote, setMoreNote] = useState("");
  const shown = page.sales?.length ?? 0;
  useEffect(() => {
    const ask = asked.current;
    if (!ask) return;
    if (page.loadingMore) {
      ask.sawLoading = true;
      return;
    }
    if (shown <= ask.from && !ask.sawLoading) return;
    asked.current = null;
    const heads = listRef.current?.querySelectorAll<HTMLElement>("h3");
    if (heads && heads.length > 0) heads[Math.min(ask.from, heads.length - 1)].focus();
    setMoreNote(page.canLoadMore ? `Showing ${shown} sales.` : `Showing ${shown} sales. That's every sale.`);
  }, [page.loadingMore, page.canLoadMore, shown]);
  const showMore = () => {
    if (page.loadingMore) return;
    asked.current = { from: shown, sawLoading: false };
    page.loadMore();
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby={listHeadingId} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={listHeadingId} className="text-lg font-semibold">
            What sold
          </h2>
          <a
            href={BSC_ORDERS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-6 items-center gap-1 rounded-sm py-0.5 text-sm font-medium text-neon-blue-text underline focus-outline max-sm:min-h-11"
          >
            Open {BSC_NAME} orders
            <ArrowTopRightOnSquareIcon aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        <p className="text-sm text-ink-3">
          {BSC_NAME} has no link to a single order. Search its orders page for the order number.
        </p>

        {page.sales === undefined ? (
          <div aria-busy="true">
            <SkeletonBars rows={4} />
          </div>
        ) : page.sales.length === 0 ? (
          <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
            No sales yet. When a card sells on {BSC_NAME}, the order shows up here within about 15 minutes.
          </p>
        ) : (
          <ol ref={listRef} aria-label="Orders, newest first" className="space-y-3">
            {page.sales.map((sale) => (
              <Order key={sale.id} sale={sale} cards={byId} />
            ))}
          </ol>
        )}

        {page.canLoadMore || page.loadingMore ? (
          <NeonButton
            type="button"
            variant="secondary"
            outline
            aria-disabled={page.loadingMore || undefined}
            aria-busy={page.loadingMore || undefined}
            onClick={showMore}
            className={`${FOCUS} max-sm:min-h-11`}
          >
            Show more sales
          </NeonButton>
        ) : null}
        <p role="status" className="sr-only">
          {moreNote}
        </p>
      </section>
    </div>
  );
}

function Order({ sale, cards }: { sale: Sale; cards: ReadonlyMap<CardId, Card> }) {
  const titleId = useId();
  const total = sale.totals.totalCents ?? sale.totals.subtotalCents;
  const copies = sale.items.reduce((n, item) => n + item.quantity, 0);
  return (
    <li>
      <article aria-labelledby={titleId} className="rounded-lg bg-raised text-ink shadow-offset">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3 pb-2.5">
          <h3 id={titleId} tabIndex={-1} className="rounded-sm text-base font-semibold tabular-nums focus-outline">
            Order {sale.orderNo}
          </h3>
          <span className="rounded-full border border-rule-strong px-2 py-0.5 text-xs font-medium text-ink-2">
            {orderStatus(sale.status)}
          </span>
          <span className="text-sm text-ink-3">{orderDay(sale.orderDate)}</span>
          <span className="ml-auto text-sm text-ink-2">
            {copies} {copies === 1 ? "card" : "cards"}
            {total !== undefined && (
              <>
                {", "}
                <span className="font-semibold tabular-nums text-ink">{dollars(total)}</span>
              </>
            )}
            {sale.totals.netCents !== undefined && (
              <span className="text-ink-3">, you keep {dollars(sale.totals.netCents)}</span>
            )}
          </span>
        </header>
        {/* The tear line of a sales slip. */}
        <ul className="space-y-2 border-t border-dashed border-rule-strong px-4 pt-2.5 pb-3">
          {sale.items.map((item, i) => (
            <Line key={`${item.cardId ?? "unmatched"}-${item.condition}-${i}`} item={item} card={item.cardId ? cards.get(item.cardId) : undefined} />
          ))}
        </ul>
      </article>
    </li>
  );
}

/** "near_mint" → "Near mint": BSC's condition word, tidied for reading. */
function conditionWords(condition: string): string {
  const words = condition.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

function Line({ item, card }: { item: SaleItem; card: Card | undefined }) {
  const problem = saleItemProblem(item);
  const name = card ? cardLabel(card) : item.cardId ? "A card that has left the catalog" : UNMATCHED_CARD;
  const condition = conditionWords(item.condition);
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="min-w-0 flex-1 text-ink">
          <span className="font-semibold tabular-nums">{item.quantity}×</span> {name}
          {condition && <span className="text-ink-3"> ({condition})</span>}
        </span>
        <span className="tabular-nums text-ink-2">{dollars(item.priceCents)} each</span>
      </div>
      {problem && <p className="mt-0.5 text-neon-yellow-text">{problem}</p>}
    </li>
  );
}
