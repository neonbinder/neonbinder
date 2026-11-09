import { useState, type ReactNode } from "react";
import { ArchiveBoxIcon, CheckCircleIcon, ChevronDownIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  daysAgoLabel,
  isLate,
  MARKETPLACES,
  type DashboardData,
  type SaleLine,
  type SaleProblem,
  type SalesData,
  type UnshippedSale,
} from "../fake-data";
import { CardTitle, count, MarketBadge, orderAnchor, Thumb } from "./bits";
import Hopper from "./Hopper";

/**
 * NEO-464 combined dashboard, block 2 — the to-do, first after the greeting
 * (from prototype 1). Out the Door (dealer only: every unshipped order,
 * oldest first) beside a column of In the Hopper (scans waiting on a yes and
 * scans still being identified) and Needs a Look (problem lines, boxed cards
 * not listed).
 *
 * Two gates. Out the Door and Needs a Look show only for a collector with
 * sales or saved inventory (`todo`). In the Hopper shows for anyone with
 * scans, gate or no gate (Jason, review item 1); the page puts it here for a
 * dealer and beside the scoreboard for a collector (`withHopper`). Each part
 * draws only when it has something in it; nothing at all draws nothing.
 */
export default function ToDo({
  data,
  todo,
  withHopper,
  wanted,
}: {
  data: DashboardData;
  todo: boolean;
  withHopper: boolean;
  wanted: Set<string>;
}) {
  const ship = todo && data.sales !== null;
  const look = todo && lookItems(data) > 0;
  const hopper = withHopper && data.intake.total > 0;
  if (!ship && !look && !hopper) return null;

  const side = (hopper || look) && (
    <div className="flex min-w-0 flex-col gap-8">
      {hopper && <Hopper intake={data.intake} wanted={wanted} />}
      {look && <NeedsALook data={data} />}
    </div>
  );

  if (!ship) return <div className="max-w-2xl">{side}</div>;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
      {data.sales && <OutTheDoor sales={data.sales} />}
      {side}
    </div>
  );
}

function problemOrders(data: DashboardData): UnshippedSale[] {
  return (data.sales?.unshipped ?? []).filter((o) => o.hasProblem);
}

/** How many Needs a Look items there are: problem orders and boxes to list. Scans live in the hopper. */
function lookItems(data: DashboardData): number {
  const unlisted = data.unlistedBoxes.reduce((n, b) => n + b.unlisted, 0);
  return problemOrders(data).length + (unlisted > 0 ? 1 : 0);
}

// ------------------------------------------------------------- Out the Door

function OutTheDoor({ sales }: { sales: SalesData }) {
  const orders = sales.unshipped;

  if (orders.length === 0) {
    return (
      <section aria-labelledby="cb-ship-heading">
        <h2 id="cb-ship-heading" className="sr-only">
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
    <section aria-labelledby="cb-ship-heading" className="shadow-offset min-w-0 overflow-hidden rounded-2xl border border-rule bg-raised">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-4 border-neon-green px-4 pt-4 pb-3 sm:px-5">
        <h2 id="cb-ship-heading" className="text-2xl font-bold text-ink">
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
  const anchor = orderAnchor(order.id);
  const linesId = `${anchor}-lines`;

  return (
    <article id={anchor} aria-labelledby={`${anchor}-title`} className="flex scroll-mt-6">
      {/* The day block: how long it has sat. Warning colour from day 2. */}
      <div
        className={`flex w-16 shrink-0 flex-col items-center justify-center px-1 py-3 text-center sm:w-20 ${
          late ? "bg-notice-warn-bg text-notice-warn-ink" : "text-neon-green-text"
        }`}
      >
        <span aria-hidden="true" className="cb-numeral cb-glow text-4xl sm:text-5xl">
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
            <h3 id={`${anchor}-title`} className="text-sm font-bold tabular-nums text-ink">
              <span className="sr-only">{market} order </span>#{order.orderNumber}
            </h3>
            <span className="rounded-md border border-control px-1.5 text-xs text-ink-2">
              <span className="sr-only">Marketplace status: </span>
              {order.statusText}
            </span>
          </div>
          <div className="mt-1 text-sm font-semibold leading-snug text-ink">
            <CardTitle card={order.firstCard} />
            {more > 0 && <span className="block font-normal text-ink-2">and {count(more, "more card")}</span>}
          </div>
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
                onClick={() => setOpen((o) => !o)}
                className="mt-2 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-sm font-medium text-neon-blue-text hover:underline focus-outline max-sm:min-h-11"
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={`size-4 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                />
                {/* Visible words first, then a stable "which order" for a reader; aria-expanded says the state. */}
                {open ? "Hide the cards" : `Show all ${count(order.cardCount, "card")}`}
                <span className="sr-only">
                  {" "}
                  in {market} order {order.orderNumber}
                </span>
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
        <CardTitle card={c} className="text-ink" />
        {line.quantity > 1 && <span className="tabular-nums text-ink-3"> ×{line.quantity}</span>}
        {line.problem && (
          <span className="ml-1 font-semibold text-notice-danger-ink">{line.problem.kind === "oversold" ? "Oversold" : "Unmatched"}</span>
        )}
      </span>
    </>
  );
}

/** One sentence per problem line. The listing title is quoted only to say which line it is. */
function problemText(line: SaleLine & { problem: SaleProblem }): string {
  const p = line.problem;
  if (p.kind === "oversold") {
    const who = line.card ? line.card.title : "A card";
    return `Oversold: ${who} sold ${p.sold}, your boxes hold ${p.inBoxes}.`;
  }
  return `Not matched to a card of yours: “${p.listingTitle}”.`;
}

// ------------------------------------------------------------- Needs a Look

function NeedsALook({ data }: { data: DashboardData }) {
  const orders = problemOrders(data);
  const unlisted = data.unlistedBoxes.reduce((n, b) => n + b.unlisted, 0);

  return (
    <section aria-labelledby="cb-look-heading" className="min-w-0">
      <h2 id="cb-look-heading" className="text-2xl font-bold text-ink">
        Needs a Look
      </h2>
      <ul className="mt-3 flex flex-col gap-3">
        {orders.map((order) => (
          <Snag key={order.id} tone="danger" icon={<ExclamationTriangleIcon className="size-5" />}>
            <p className="font-semibold text-notice-danger-ink">
              {MARKETPLACES[order.marketplace].name} order #{order.orderNumber}
            </p>
            {order.lines
              .filter((l): l is SaleLine & { problem: SaleProblem } => Boolean(l.problem))
              .map((line, i) => (
                <p key={i} className="text-sm text-ink-2">
                  {problemText(line)}
                </p>
              ))}
            <a
              href={`#${orderAnchor(order.id)}`}
              className="mt-1 inline-flex min-h-9 items-center rounded-md text-sm font-medium text-neon-blue-text hover:underline focus-outline max-sm:min-h-11"
            >
              Jump to order #{order.orderNumber}
            </a>
          </Snag>
        ))}

        {unlisted > 0 && (
          <Snag tone="quiet" icon={<ArchiveBoxIcon className="size-5" />}>
            <p className="font-semibold text-ink">{count(unlisted, "boxed card")} not listed yet</p>
            <ul className="text-sm text-ink-2">
              {data.unlistedBoxes.map((b) => (
                <li key={b.id}>
                  {b.name}: {b.unlisted}
                </li>
              ))}
            </ul>
          </Snag>
        )}
      </ul>
    </section>
  );
}

/** The snag's kind rides on the icon's colour (and its words), not a side edge. */
const TONE = {
  danger: "text-notice-danger-ink",
  quiet: "text-ink-3",
} as const;

/** One snag: an icon coloured for its kind, and what to do, in a plain rounded box. */
function Snag({ tone, icon, children }: { tone: keyof typeof TONE; icon: ReactNode; children: ReactNode }) {
  return (
    <li className={`flex gap-3 rounded-lg border border-rule bg-raised p-3 ${TONE[tone]}`}>
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
