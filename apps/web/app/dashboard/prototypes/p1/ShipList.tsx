import { useState } from "react";
import { CheckCircleIcon, ChevronDownIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { daysAgoLabel, isLate, MARKETPLACES, type SaleLine, type SaleProblem, type SalesData, type UnshippedSale } from "../_shared/data";
import { ANCHOR, count, MarketBadge, orderAnchor, Thumb } from "./bits";

/**
 * NEO-464 prototype 1 — "Out the Door": the packing slip. One row per order,
 * oldest first (the fixture's order), each led by how many days it has sat.
 * From day 2 the row's day block turns the warning colour. A problem line
 * (unmatched, oversold) is always shown on its order, never behind a click.
 *
 * Nothing to ship collapses the whole panel to one line.
 */
export default function ShipList({ sales }: { sales: SalesData }) {
  const orders = sales.unshipped;

  if (orders.length === 0) {
    return (
      <section id={ANCHOR.ship} aria-labelledby="p1-ship-heading" className="scroll-mt-6">
        <h2 id="p1-ship-heading" className="sr-only">
          Out the Door
        </h2>
        <p className="flex items-center gap-2 text-base font-semibold text-neon-green-text">
          <CheckCircleIcon aria-hidden="true" className="size-5 shrink-0" />
          All shipped. Nice.
        </p>
      </section>
    );
  }

  const cards = orders.reduce((n, o) => n + o.cardCount, 0);
  const late = orders.filter(isLate).length;

  return (
    <section
      id={ANCHOR.ship}
      aria-labelledby="p1-ship-heading"
      className="shadow-offset scroll-mt-6 overflow-hidden rounded-2xl border border-rule bg-raised"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-4 border-neon-green px-4 pt-4 pb-3 sm:px-5">
        <h2 id="p1-ship-heading" className="text-2xl font-bold text-ink">
          Out the Door
        </h2>
        <p className="text-sm text-ink-2">
          {count(orders.length, "order")}, {count(cards, "card")}. Oldest first
          {late > 0 ? `, ${late} waiting 2 days or more.` : "."}
        </p>
      </div>
      <ol className="divide-y-2 divide-dashed divide-rule">
        {orders.map((order) => (
          <li key={order.id}>
            <OrderRow order={order} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function OrderRow({ order }: { order: UnshippedSale }) {
  const [open, setOpen] = useState(false);
  const late = isLate(order);
  const market = MARKETPLACES[order.marketplace].name;
  const problems = order.lines.filter((l): l is SaleLine & { problem: SaleProblem } => Boolean(l.problem));
  const more = order.cardCount - 1;
  const linesId = `${orderAnchor(order.id)}-lines`;

  return (
    <article id={orderAnchor(order.id)} aria-labelledby={`${orderAnchor(order.id)}-title`} className="flex scroll-mt-6">
      {/* The day block: how long it has sat. Warning colour from day 2. */}
      <div
        className={`flex w-16 shrink-0 flex-col items-center justify-center px-1 py-3 text-center sm:w-20 ${
          late ? "bg-notice-warn-bg text-notice-warn-ink" : "text-neon-green-text"
        }`}
      >
        <span aria-hidden="true" className="p1-numeral p1-glow text-4xl sm:text-5xl">
          {order.daysSinceSold}
        </span>
        <span aria-hidden="true" className="mt-1 text-[0.6875rem] font-semibold leading-tight">
          {order.daysSinceSold === 0 ? "today" : order.daysSinceSold === 1 ? "day" : "days"}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 gap-3 py-3 pr-3 pl-1 sm:gap-4 sm:pr-5">
        <Thumb card={order.firstCard} className="w-11 sm:w-14" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <MarketBadge marketplace={order.marketplace} />
            <h3 id={`${orderAnchor(order.id)}-title`} className="text-sm font-bold tabular-nums text-ink">
              <span className="sr-only">{market} order </span>#{order.orderNumber}
            </h3>
            <span className="rounded-md border border-control px-1.5 text-xs text-ink-2">
              <span className="sr-only">Marketplace status: </span>
              {order.statusText}
            </span>
          </div>
          <p className="mt-1 text-base font-semibold leading-snug text-ink">
            {order.firstCard.player}
            {more > 0 && <span className="font-normal text-ink-2"> and {count(more, "more card")}</span>}
          </p>
          <p className="text-xs text-ink-3">
            {count(order.cardCount, "card")}. Sold {daysAgoLabel(order.daysSinceSold).toLowerCase()}.
          </p>

          {problems.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {problems.map((line, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-md border border-notice-danger-rule bg-notice-danger-bg px-2 py-1.5 text-sm text-notice-danger-ink"
                >
                  <ExclamationTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{problemText(line)}</span>
                </li>
              ))}
            </ul>
          )}

          {order.lines.length > 1 && (
            <>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={linesId}
                aria-label={`${open ? "Hide" : "Show"} the ${count(order.cardCount, "card")} in ${market} order ${order.orderNumber}`}
                onClick={() => setOpen((o) => !o)}
                className="mt-2 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-sm font-medium text-neon-blue-text hover:underline focus-outline max-sm:min-h-11"
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={`size-4 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                />
                {open ? "Hide the cards" : `Show all ${count(order.cardCount, "card")}`}
              </button>
              <ul id={linesId} hidden={!open} className="mt-1 flex flex-col gap-2">
                {order.lines.map((line, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <LineRow line={line} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function LineRow({ line }: { line: SaleLine }) {
  if (!line.card) {
    return (
      <>
        <div
          aria-hidden="true"
          className="flex aspect-[5/7] w-8 shrink-0 items-center justify-center rounded border-2 border-dashed border-control text-sm font-bold text-ink-3"
        >
          ?
        </div>
        <span className="text-sm text-ink-2">
          Not matched to a card yet
          {line.quantity > 1 && <span className="tabular-nums text-ink-3"> ×{line.quantity}</span>}
        </span>
      </>
    );
  }
  const c = line.card;
  return (
    <>
      <Thumb card={c} className="w-8" />
      <span className="min-w-0 text-sm">
        <span className="font-semibold text-ink">{c.player}</span>
        <span className="text-ink-2">
          {" "}
          {c.setLabel} #{c.cardNumber}
          {c.variantName && `, ${c.variantName}`}
        </span>
        {line.quantity > 1 && <span className="tabular-nums text-ink-3"> ×{line.quantity}</span>}
        {line.problem && <span className="ml-1 font-semibold text-notice-danger-ink">{line.problem.kind === "oversold" ? "Oversold" : "Unmatched"}</span>}
      </span>
    </>
  );
}

/** One sentence per problem line. The listing title is quoted only to say which line it is. */
export function problemText(line: SaleLine & { problem: SaleProblem }): string {
  const p = line.problem;
  if (p.kind === "oversold") {
    const who = line.card ? `${line.card.player} #${line.card.cardNumber}` : "A card";
    return `Oversold: ${who} sold ${p.sold}, your boxes hold ${p.inBoxes}.`;
  }
  return `Not matched to a card of yours: “${p.listingTitle}”.`;
}
