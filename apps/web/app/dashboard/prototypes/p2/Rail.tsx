import { ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import CardFace, { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import {
  MARKETPLACES,
  daysAgoLabel,
  isLate,
  type IntakeInProgress,
  type Marketplace,
  type SaleLine,
  type SalesData,
  type SmartBinderSummary,
  type TradePile,
  type UnlistedBox,
  type UnshippedSale,
} from "../_shared/data";

/**
 * NEO-464 prototype 2 — the side rail beside the chase and the pulls: the
 * dealer's ship list, intake still sorting, smart binders, and the odds and
 * ends. Quiet panels; the scoreboard wall is the loud thing on this page.
 */

const PANEL = "rounded-2xl border border-rule bg-raised p-4";

function RailHeading({ id, children, note }: { id: string; children: string; note?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
      <h2 id={id} className="text-lg font-bold text-ink">
        {children}
      </h2>
      {note && <p className="text-xs text-ink-3">{note}</p>}
    </div>
  );
}

/** Where the dealer quick line jumps to. */
export const OUT_THE_DOOR_ID = "p2-out-the-door";

// ------------------------------------------------------------------ sales

const BADGE: Record<Marketplace, string> = {
  bsc: "bg-pick-blue text-pick-blue-ink border-pick-blue-rule",
  sportlots: "bg-pick-orange text-pick-orange-ink border-pick-orange-rule",
  ebay: "bg-pick-purple text-pick-purple-ink border-pick-purple-rule",
};

function MarketBadge({ m }: { m: Marketplace }) {
  const { name, short } = MARKETPLACES[m];
  return (
    <span className={`rounded border px-1.5 py-px text-[11px] font-bold ${BADGE[m]}`}>
      <span aria-hidden={short !== name ? true : undefined}>{short}</span>
      {short !== name && <span className="sr-only">{name}</span>}
    </span>
  );
}

function problemText(line: SaleLine): string | null {
  const p = line.problem;
  if (!p) return null;
  if (p.kind === "unmatched") return `Not matched to your cards: “${p.listingTitle}”`;
  const who = line.card ? `${line.card.player} #${line.card.cardNumber}` : "A card";
  return `Oversold: ${who} sold ${p.sold}, your boxes hold ${p.inBoxes}`;
}

function SaleRow({ sale }: { sale: UnshippedSale }) {
  const late = isLate(sale);
  const problems = sale.lines.map(problemText).filter((t): t is string => t !== null);
  const more = sale.cardCount - 1;
  return (
    <li
      className={`flex gap-3 rounded-xl border p-2.5 ${
        late ? "border-notice-warn-rule bg-notice-warn-bg" : "border-rule bg-surface"
      }`}
    >
      <div className="w-10 shrink-0">
        <CardFace model={sale.firstCard.card} size="fill" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <MarketBadge m={sale.marketplace} />
          <span className="tabular-nums text-ink-2">
            <span className="sr-only">Order </span>
            {sale.orderNumber}
          </span>
          <span className="rounded bg-chip px-1.5 py-px text-ink-2">{sale.statusText}</span>
        </p>
        <p className="truncate text-sm font-semibold text-ink">
          {sale.firstCard.player}
          {more > 0 && <span className="font-normal text-ink-3"> + {more} more</span>}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 text-xs">
          <span className="text-ink-2">{sale.cardCount === 1 ? "1 card" : `${sale.cardCount} cards`}</span>
          <span className={`inline-flex items-center gap-1 ${late ? "font-bold text-notice-warn-ink" : "text-ink-3"}`}>
            {late && <ClockIcon aria-hidden="true" className="size-3.5" />}
            Sold {daysAgoLabel(sale.daysSinceSold).toLowerCase()}
          </span>
        </p>
        {problems.length > 0 && (
          <ul className="space-y-0.5">
            {problems.map((t) => (
              <li key={t} className="flex items-start gap-1 text-xs text-notice-danger-ink">
                <ExclamationTriangleIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function OutTheDoor({ sales }: { sales: SalesData }) {
  const { unshipped } = sales;
  if (unshipped.length === 0) {
    return (
      <section aria-labelledby={OUT_THE_DOOR_ID} className={PANEL}>
        <h2 id={OUT_THE_DOOR_ID} className="text-lg font-bold text-ink">
          All shipped. Nice.
        </h2>
      </section>
    );
  }
  return (
    <section aria-labelledby={OUT_THE_DOOR_ID} className={PANEL}>
      <RailHeading id={OUT_THE_DOOR_ID} note="Oldest first">
        Out the Door
      </RailHeading>
      <ol className="space-y-2">
        {unshipped.map((s) => (
          <SaleRow key={s.id} sale={s} />
        ))}
      </ol>
    </section>
  );
}

// ----------------------------------------------------------------- intake

export function Hopper({ intake }: { intake: IntakeInProgress }) {
  if (intake.total === 0) return null;
  return (
    <section aria-labelledby="p2-hopper-heading" className={PANEL}>
      <RailHeading id="p2-hopper-heading">In the Hopper</RailHeading>
      <p className="text-sm text-ink-2">
        {intake.total} scans still sorting.
        {intake.needsYou > 0 && (
          <span className="font-semibold text-ink">
            {" "}
            {intake.needsYou === 1 ? "1 needs" : `${intake.needsYou} need`} your OK.
          </span>
        )}
      </p>
      <ul aria-label="Scans in intake" className="mt-3 flex gap-2">
        {intake.preview.map((s) => (
          <li key={s.id} className="w-12">
            {s.guess ? (
              <CardFace
                model={s.guess.card}
                size="fill"
                label={`Best guess, waiting for your OK: ${s.guess.player}, ${s.guess.setLabel} #${s.guess.cardNumber}`}
              />
            ) : (
              <EmptySleeve size="fill" label="Scan waiting to be identified" />
            )}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-2">
        {intake.uploads.map((u) => (
          <li key={u.id} className="text-xs">
            <p className="flex justify-between gap-2">
              <span className="truncate text-ink-2">{u.name}</span>
              <span className="shrink-0 tabular-nums text-ink-3">
                {u.done} of {u.scans} done
              </span>
            </p>
            <span aria-hidden="true" className="mt-1 block h-1 overflow-hidden rounded-full bg-chip">
              <span className="block h-full rounded-full bg-neon-blue" style={{ width: `${(u.done / u.scans) * 100}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------- smart binders

export function FillingUp({ binders }: { binders: SmartBinderSummary[] }) {
  if (binders.length === 0) return null;
  return (
    <section aria-labelledby="p2-binders-heading" className={PANEL}>
      <RailHeading id="p2-binders-heading">Binders Filling Up</RailHeading>
      <ul className="divide-y divide-rule">
        {binders.map((b) => (
          <li key={b.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="min-w-0 truncate text-sm font-bold text-ink">{b.name}</h3>
              <span className="shrink-0 text-xs tabular-nums text-ink-3">
                {b.checklist
                  ? `${b.checklist.have} of ${b.checklist.total}, ${b.checklist.percent}%`
                  : b.cardCount === 1
                    ? "1 card"
                    : `${b.cardCount} cards`}
              </span>
            </div>
            <p className="text-xs text-ink-3">{b.ruleText}</p>
            {b.newCount > 0 ? (
              <div className="flex items-center gap-2">
                <ul aria-label={`New in ${b.name}`} className="flex gap-1.5">
                  {b.newCards.slice(0, 4).map((c) => (
                    <li key={c.id} className="w-8">
                      <CardFace model={c.card} size="fill" />
                    </li>
                  ))}
                </ul>
                <p className="text-xs font-semibold text-neon-green-text">
                  {b.newCount} new since your last visit
                </p>
              </div>
            ) : (
              <p className="text-xs text-ink-3">Nothing new since your last visit.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------- odds and ends

export function OddsAndEnds({ boxes, trade }: { boxes: UnlistedBox[]; trade: TradePile }) {
  if (boxes.length === 0 && trade.count === 0) return null;
  return (
    <section aria-labelledby="p2-odds-heading" className={PANEL}>
      <RailHeading id="p2-odds-heading">Odds and Ends</RailHeading>
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
