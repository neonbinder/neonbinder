import { useEffect, useId, useState, type ReactNode } from "react";
import { ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import CardFace, { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import {
  daysAgoLabel,
  isLate,
  MARKETPLACES,
  type AdditionBatch,
  type CompletedSet,
  type DashCard,
  type IntakeInProgress,
  type Marketplace,
  type SaleLine,
  type SalesData,
  type UnshippedSale,
} from "../_shared/data";
import { plural } from "./timeline";

/**
 * NEO-464 prototype 3 ("Feed") — the entries that hang off the spine. Each
 * kind wears its own hue on its bulb: teal for orders (shipping), blue for
 * cards coming in, green for a finished checklist, violet for intake.
 */

export type Hue = "teal" | "blue" | "green" | "purple";

const BULB: Record<Hue, string> = {
  teal: "text-neon-teal",
  blue: "text-neon-blue",
  green: "text-neon-green",
  purple: "text-neon-purple",
};

/**
 * One entry on the spine. The bulb sits on the spine's centre line: the
 * column has a 2px left border and 24px of padding, so -32px puts a 14px
 * bulb's centre on the border's centre.
 */
function Entry({
  hue,
  heading,
  children,
  big = false,
}: {
  hue: Hue;
  heading: (id: string) => ReactNode;
  children?: ReactNode;
  big?: boolean;
}) {
  const id = useId();
  return (
    <article aria-labelledby={id} className="relative">
      <Bulb hue={hue} big={big} />
      {heading(id)}
      {children}
    </article>
  );
}

function Bulb({ hue, big = false }: { hue: Hue; big?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`feed-node absolute -left-8 size-3.5 rounded-full ${big ? "top-2.5" : "top-1"} ${BULB[hue]}`}
    />
  );
}

/** A small card for a row: the face scales to the wrapper. */
export function Thumb({ card, className = "w-11", label }: { card: DashCard; className?: string; label?: string }) {
  return (
    <div className={`shrink-0 ${className}`}>
      <CardFace model={card.card} size="fill" label={label} />
    </div>
  );
}

/** The marketplace's pill on an order. Short on screen, full name to a reader. */
export function MarketBadge({ marketplace }: { marketplace: Marketplace }) {
  const { name, short } = MARKETPLACES[marketplace];
  return (
    <span className="inline-flex items-center rounded border border-control px-1.5 py-px text-[11px] font-bold leading-4 text-ink">
      {short === name ? (
        name
      ) : (
        <>
          <span aria-hidden="true">{short}</span>
          <span className="sr-only">{name}</span>
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Orders to ship (dealer only): pinned at the head of the feed, oldest first.
// ---------------------------------------------------------------------------

function problemText(line: SaleLine): string | null {
  const p = line.problem;
  if (!p) return null;
  if (p.kind === "oversold") {
    const which = line.card ? `${line.card.player} #${line.card.cardNumber}` : "A card";
    return `Oversold: ${which}. Sold ${p.sold}, your boxes hold ${p.inBoxes}.`;
  }
  return `No match in your boxes for “${p.listingTitle}”.`;
}

function OrderRow({ sale }: { sale: UnshippedSale }) {
  const late = isLate(sale);
  const problems = sale.lines.map(problemText).filter((t): t is string => t !== null);
  return (
    <li
      className={`flex gap-3 rounded-xl border p-2.5 ${
        late ? "border-notice-warn-rule bg-notice-warn-bg" : "border-rule-strong bg-raised"
      }`}
    >
      <Thumb card={sale.firstCard} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="min-w-0 truncate text-sm font-bold text-ink">{sale.firstCard.player}</p>
          <p
            className={`flex items-center gap-1 text-xs tabular-nums ${
              late ? "font-bold text-notice-warn-ink" : "text-ink-3"
            }`}
          >
            {late && <ClockIcon aria-hidden="true" className="size-3.5" />}
            Sold {daysAgoLabel(sale.daysSinceSold).toLowerCase()}
          </p>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
          <MarketBadge marketplace={sale.marketplace} />
          <span className="tabular-nums">Order {sale.orderNumber}</span>
          <span className="text-ink-3">{plural(sale.cardCount, "card")}</span>
          <span className="rounded bg-chip px-1.5 py-px text-ink">{sale.statusText}</span>
        </p>
        {problems.length > 0 && (
          <ul className="mt-2 space-y-1">
            {problems.map((text) => (
              <li key={text} className="flex items-start gap-1.5 text-xs font-medium text-notice-danger-ink">
                <ExclamationTriangleIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                {text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function ShipEntry({ sales }: { sales: SalesData }) {
  const orders = sales.unshipped;
  if (orders.length === 0) {
    return (
      <Entry
        hue="teal"
        heading={(id) => (
          <h3 id={id} className="text-base font-bold text-ink">
            All shipped. Nice.
          </h3>
        )}
      />
    );
  }
  const late = orders.filter(isLate).length;
  return (
    <Entry
      hue="teal"
      big
      heading={(id) => (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 id={id} className="text-xl font-bold text-ink">
            Ship &rsquo;Em
          </h3>
          <p className="text-sm text-ink-3">
            {plural(orders.length, "order")} to go out, oldest first
            {late > 0 && <span className="font-medium text-notice-warn-ink">{`, ${late} waiting 2 days or more`}</span>}
          </p>
        </div>
      )}
    >
      <ol className="shadow-offset mt-3 space-y-2 rounded-2xl border border-rule bg-raised-deep p-2 sm:p-3">
        {orders.map((s) => (
          <OrderRow key={s.id} sale={s} />
        ))}
      </ol>
    </Entry>
  );
}

/** A day's note that orders sold then. The full rows live once, up in Ship 'Em, oldest first. */
export function SoldEntry({ sold }: { sold: UnshippedSale[] }) {
  return (
    <Entry
      hue="teal"
      heading={(id) => (
        <h3 id={id} className="text-base font-bold text-ink">
          {plural(sold.length, "order")} sold, still to ship
        </h3>
      )}
    >
      <ul className="mt-2 space-y-2">
        {sold.map((s) => (
          <li key={s.id} className="flex items-center gap-2.5 text-sm text-ink-2">
            <Thumb card={s.firstCard} className="w-8" />
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <MarketBadge marketplace={s.marketplace} />
              <span className="font-medium text-ink">{s.firstCard.player}</span>
              <span className="text-ink-3">{plural(s.cardCount, "card")}</span>
            </span>
          </li>
        ))}
      </ul>
    </Entry>
  );
}

// ---------------------------------------------------------------------------
// Intake: scans uploaded, not in a binder yet.
// ---------------------------------------------------------------------------

export function IntakeEntry({ intake }: { intake: IntakeInProgress }) {
  if (intake.total === 0) return null;
  return (
    <Entry
      hue="purple"
      heading={(id) => (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 id={id} className="text-base font-bold text-ink">
            Still in intake: {plural(intake.total, "scan")}
          </h3>
          <p className="text-sm text-ink-3">
            {intake.needsYou > 0 && <span className="font-medium text-neon-purple-text">{intake.needsYou} need a yes from you</span>}
            {intake.needsYou > 0 && intake.waiting > 0 && ", "}
            {intake.waiting > 0 && `${intake.waiting} waiting to be identified`}
          </p>
        </div>
      )}
    >
      <div className="mt-3 flex flex-col gap-4 rounded-2xl border-2 border-dashed border-control p-3 sm:flex-row sm:items-center">
        <ul className="flex gap-2">
          {intake.preview.map((scan) => (
            <li key={scan.id} className="w-14 sm:w-16">
              {scan.guess ? (
                <CardFace
                  model={scan.guess.card}
                  size="fill"
                  label={`Best guess for a scan: ${scan.guess.setLabel} #${scan.guess.cardNumber} ${scan.guess.player}, waiting on your yes`}
                />
              ) : (
                <div className="w-full">
                  <EmptySleeve size="fill" label="Scan waiting to be identified" ghost="?" />
                </div>
              )}
              <p aria-hidden="true" className="mt-1 truncate text-center text-[11px] text-ink-3">
                {scan.guess ? "Is it?" : "Looking…"}
              </p>
            </li>
          ))}
        </ul>
        <ul className="min-w-0 flex-1 space-y-2 text-sm">
          {intake.uploads.map((u) => (
            <li key={u.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-ink">{u.name}</span>
                <span className="shrink-0 tabular-nums text-xs text-ink-3">
                  {u.done} of {u.scans} done
                </span>
              </div>
              <span aria-hidden="true" className="feed-meter mt-1 block h-1.5 overflow-hidden rounded-full">
                <span className="block h-full rounded-full" style={{ width: `${Math.round((u.done / u.scans) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Entry>
  );
}

// ---------------------------------------------------------------------------
// Cards that came in together.
// ---------------------------------------------------------------------------

/** How many tiles a batch shows before "Show all": two rows on a phone, one on desktop. */
const PREVIEW = 6;

export function CardTile({ card, extra }: { card: DashCard; extra?: string | null }) {
  const variant = card.variantName ? `${card.variantName}${card.printRun ? ` ${card.printRun}` : ""}` : null;
  return (
    <figure className="min-w-0">
      <CardFace model={card.card} size="fill" />
      {/* The face already carries the full name to a reader. */}
      <figcaption aria-hidden="true" className="mt-1.5 min-w-0 leading-tight">
        <span className="block truncate text-[13px] font-semibold text-ink">{card.player}</span>
        <span className="block truncate text-xs text-ink-3">{card.setLabel}</span>
        {variant && <span className="block truncate text-xs font-medium text-neon-blue-text">{variant}</span>}
        {extra && <span className="block truncate text-xs text-ink-3">{extra}</span>}
      </figcaption>
    </figure>
  );
}

export function BatchEntry({ batch }: { batch: AdditionBatch }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const n = batch.cards.length;
  const shown = all ? batch.cards : batch.cards.slice(0, PREVIEW);
  const into = batch.binders.length === 1 ? batch.binders[0].name : plural(batch.binders.length, "binder");

  return (
    <Entry
      hue="blue"
      heading={(id) => (
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={id} className="text-base font-bold text-ink">
              {plural(n, "card")} into {into}
            </h3>
            {batch.sinceLastVisit && (
              <span className="rounded-full bg-neon-green px-2 py-px text-[11px] font-bold text-on-neon-green">
                New since your last visit
              </span>
            )}
          </div>
          {batch.binders.length > 1 && (
            <p className="mt-0.5 text-sm text-ink-3">
              {batch.binders.map((b, i) => (
                <span key={b.name}>
                  {i > 0 && (i === batch.binders.length - 1 ? " and " : ", ")}
                  <span className="text-ink-2">{b.name}</span> got {b.count}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    >
      <ul id={listId} className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6 sm:gap-x-2.5">
        {shown.map((c) => (
          <li key={c.id} className="min-w-0">
            <CardTile card={c} />
          </li>
        ))}
      </ul>
      {n > PREVIEW && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={listId}
          aria-label={all ? `Show fewer cards from ${batch.whenLabel}` : `Show all ${n} cards from ${batch.whenLabel}`}
          onClick={() => setAll((v) => !v)}
          className="mt-3 inline-flex min-h-11 items-center rounded-md border border-control px-3 text-sm font-medium text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
        >
          {all ? "Show fewer" : `Show all ${n} cards`}
        </button>
      )}
    </Entry>
  );
}

// ---------------------------------------------------------------------------
// A finished checklist. Celebrated once: the burst plays on the first visit
// only (remembered on this device by the milestone's id); after that it is a
// quiet win in the feed, with a button to play it again on request.
// ---------------------------------------------------------------------------

const SEEN_PREFIX = "nb-dashboard-feed:celebrated:";

function readSeen(id: string): boolean {
  try {
    return window.localStorage.getItem(SEEN_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

/** Above this many cards, the win shows only the card that finished it. */
const SHOW_ALL_UP_TO = 9;

export function MilestoneEntry({ done }: { done: CompletedSet }) {
  const id = useId();
  // Read once, at mount: a first visit celebrates; later visits offer a replay.
  const [seenBefore] = useState(() => readSeen(done.id));
  const [round, setRound] = useState(0);
  const play = !seenBefore || round > 0;

  useEffect(() => {
    try {
      window.localStorage.setItem(SEEN_PREFIX + done.id, "1");
    } catch {
      // Storage blocked: it celebrates again next time, which is harmless.
    }
  }, [done.id]);

  const others = done.cards.length <= SHOW_ALL_UP_TO ? done.cards.filter((c) => c.id !== done.lastCard.id) : [];

  return (
    <article aria-labelledby={id} className="relative">
      <Bulb hue="green" big />
      <div
        data-complete="true"
        className="feed-win shadow-offset relative overflow-hidden rounded-2xl border-2 border-neon-green bg-wash-green p-4 sm:p-5"
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          {/* Keyed by round: a replay remounts the cards, so the burst plays again. */}
          <div key={round} className="flex items-end gap-2">
            {others.map((c) => (
              <div key={c.id} className="w-16 sm:w-20">
                <CardFace model={c.card} size="fill" />
              </div>
            ))}
            <div className="relative w-24 sm:w-28">
              <span
                aria-hidden="true"
                data-play={play}
                className="feed-burst pointer-events-none absolute -inset-10 rounded-full"
              />
              <div data-play={play} className="feed-pop relative">
                <CardFace model={done.lastCard.card} size="fill" />
              </div>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <h3 id={id}>
              <span className="block text-3xl font-bold leading-none text-neon-green-text sm:text-4xl">Set complete!</span>
              <span className="mt-2 block text-lg font-bold leading-snug text-ink">{done.label}</span>
            </h3>
            <p className="mt-1 text-sm text-ink-2">
              All {done.total} in the binder. {done.lastCard.player} #{done.lastCard.cardNumber} closed it out.
            </p>
            {seenBefore && (
              <button
                type="button"
                onClick={() => setRound((r) => r + 1)}
                className="mt-3 inline-flex min-h-11 items-center rounded-md border border-control px-3 text-sm font-medium text-ink-2 hover:border-neon-green hover:text-ink focus-outline sm:min-h-9"
              >
                Celebrate again
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
