import { ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import CardFace, { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import {
  MARKETPLACES,
  daysAgoLabel,
  isLate,
  type IntakeInProgress,
  type SaleLine,
  type SalesData,
  type UnlistedBox,
  type UnshippedSale,
} from "../_shared/data";
import { SectionHead, Thumb, cards, midSentence } from "./parts";

/**
 * NEO-464 prototype 5, "Split desk": the right half, the box. Everything on
 * its way out the door (orders to ship, boxes not listed yet) plus the tray of
 * scans still to sort, since a scan can land in a binder or a box.
 *
 * Drawn only when the collector sells: `sales` is non-null.
 */
export function BoxSide({
  sales,
  boxes,
  intake,
}: {
  sales: SalesData;
  boxes: UnlistedBox[];
  intake: IntakeInProgress;
}) {
  return (
    <section aria-labelledby="p5-box-sign" className="min-w-0 space-y-8">
      <header>
        <h2 id="p5-box-sign" className="p5-sign p5-sign-box text-4xl sm:text-5xl">
          The Box
        </h2>
        <p className="mt-2 text-sm text-ink-2">Cards for sale, on their way out the door.</p>
      </header>

      <ShipList sales={sales} />
      {boxes.length > 0 && <BoxesToList boxes={boxes} />}
      <Tray intake={intake} destination="a binder or a box" />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ship 'Em
// ---------------------------------------------------------------------------

function ShipList({ sales }: { sales: SalesData }) {
  const orders = sales.unshipped;
  if (orders.length === 0) {
    return (
      <section aria-label="Ship 'Em">
        <p className="rounded-xl border border-rule bg-raised px-4 py-3 font-semibold text-neon-green-text">
          All shipped. Nice.
        </p>
      </section>
    );
  }

  const late = orders.filter(isLate).length;
  return (
    <section aria-labelledby="p5-ship">
      <SectionHead
        id="p5-ship"
        title="Ship 'Em"
        aside={`${orders.length} ${orders.length === 1 ? "order" : "orders"}${late ? `, ${late} sitting 2+ days` : ""}`}
      />
      <p className="mt-1 text-xs text-ink-3">Oldest first.</p>
      <ol className="mt-3 space-y-2">
        {orders.map((sale) => (
          <li key={sale.id}>
            <OrderRow sale={sale} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function OrderRow({ sale }: { sale: UnshippedSale }) {
  const late = isLate(sale);
  const market = MARKETPLACES[sale.marketplace];
  const problems = sale.lines.filter((l) => l.problem);
  return (
    <article
      aria-label={`${market.name} order ${sale.orderNumber}`}
      className={`flex gap-3 rounded-xl border border-l-4 bg-raised p-3 ${
        late ? "border-rule border-l-neon-orange" : "border-rule border-l-rule-strong"
      }`}
    >
      <Thumb card={sale.firstCard} className="w-12" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 font-semibold leading-tight text-ink">
            {sale.firstCard.player}
            {sale.lines.length > 1 && <span className="font-normal text-ink-2"> and more</span>}
          </p>
          <span
            title={market.name}
            className="shrink-0 rounded-md border border-neon-purple-text px-1.5 py-0.5 text-xs font-bold text-neon-purple-text"
          >
            {market.short}
          </span>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-ink-2">
          <span className="tabular-nums">#{sale.orderNumber}</span>
          <span>{cards(sale.cardCount)}</span>
          <span className="text-ink-3">{sale.statusText}</span>
        </p>
        <p
          className={`mt-1 flex items-center gap-1 text-sm ${late ? "font-semibold text-neon-orange-text" : "text-ink-3"}`}
        >
          {late && <ClockIcon aria-hidden="true" className="size-4 shrink-0" />}
          Sold {midSentence(daysAgoLabel(sale.daysSinceSold))}
        </p>
        {problems.length > 0 && (
          <ul className="mt-2 space-y-1">
            {problems.map((line, i) => (
              <li key={line.card?.id ?? `unmatched-${i}`} className="flex gap-1.5 text-sm text-neon-pink-text">
                <ExclamationTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{problemText(line)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function problemText(line: SaleLine): string {
  const p = line.problem;
  if (!p) return "";
  if (p.kind === "unmatched") return `Not tied to one of your cards: "${p.listingTitle}"`;
  const which = line.card ? `${line.card.player} #${line.card.cardNumber}` : "A card";
  return `${which}: sold ${p.sold}, your boxes hold ${p.inBoxes}`;
}

// ---------------------------------------------------------------------------
// Boxes to list
// ---------------------------------------------------------------------------

function BoxesToList({ boxes }: { boxes: UnlistedBox[] }) {
  const total = boxes.reduce((n, b) => n + b.unlisted, 0);
  return (
    <section aria-labelledby="p5-boxes">
      <SectionHead id="p5-boxes" title="Boxes to List" aside={`${cards(total)} not listed yet`} />
      <ul className="mt-3 divide-y divide-rule rounded-xl border border-rule bg-raised">
        {boxes.map((box) => (
          <li key={box.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
            <span className="min-w-0 truncate font-semibold text-ink">{box.name}</span>
            <span className="shrink-0 text-sm tabular-nums text-ink-2">{box.unlisted} not listed</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// In the Tray (intake). Shared: the collector's page draws it on the binder side.
// ---------------------------------------------------------------------------

export function Tray({ intake, destination }: { intake: IntakeInProgress; destination: string }) {
  if (intake.total === 0) return null;
  return (
    <section aria-labelledby="p5-tray">
      <SectionHead id="p5-tray" title="In the Tray" aside={`${intake.total} scans to sort`} />
      <p className="mt-1 text-sm text-ink-2">
        {intake.needsYou > 0 && (
          <>
            <span className="font-semibold text-ink">{intake.needsYou} need your yes.</span>{" "}
          </>
        )}
        {intake.waiting} still being identified. Then into {destination} they go.
      </p>
      <ul className="mt-3 flex flex-wrap gap-3">
        {intake.preview.map((scan) => (
          <li key={scan.id} className="w-16">
            {scan.guess ? (
              <figure className="flex flex-col gap-1">
                <CardFace model={scan.guess.card} size="fill" />
                <figcaption className="text-xs font-semibold text-neon-blue-text">Is this it?</figcaption>
              </figure>
            ) : (
              <EmptySleeve size="fill" label="Scan waiting to be identified" ghost="?" />
            )}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-1 text-sm text-ink-2">
        {intake.uploads.map((u) => (
          <li key={u.id} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{u.name}</span>
            <span className="shrink-0 tabular-nums text-ink-3">
              {u.done} of {u.scans} done
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
