import { useState } from "react";
import { SparklesIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import type { AdditionBatch, BuildingSet, CompletedSet, DashCard, DashboardData, SmartBinderSummary, WantCard } from "../_shared/data";
import { ANCHOR, count, Thumb } from "./bits";

/**
 * NEO-464 prototype 1 — everything after the work: a set just finished
 * (celebrated once), Fresh Pulls, Almost There, Most Wanted, Binders Filling
 * Up and the trade pile. Quieter than the ship list on purpose: no sheets,
 * just headed sections.
 */
export default function FunStuff({ data }: { data: DashboardData }) {
  return (
    <div className="flex flex-col gap-10">
      {data.justCompleted && <Completed set={data.justCompleted} />}

      <div className="grid gap-10 lg:grid-cols-[3fr_2fr] lg:gap-8">
        <FreshPulls batches={data.additions} />
        <AlmostThere sets={data.building} />
      </div>

      <div className="grid gap-10 lg:grid-cols-[3fr_2fr] lg:gap-8">
        <MostWanted cards={data.wantList} />
        <BindersFillingUp binders={data.smartBinders} trade={data.tradePile} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- completed

const CELEBRATED_KEY = "nb-dashboard-p1-celebrated";

function readCelebrated(): string | null {
  try {
    return window.localStorage.getItem(CELEBRATED_KEY);
  } catch {
    return null;
  }
}

/** Shown until the collector says "Nice!", then never again for that set. */
function Completed({ set }: { set: CompletedSet }) {
  const [gone, setGone] = useState(() => readCelebrated() === set.id);
  if (gone) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(CELEBRATED_KEY, set.id);
    } catch {
      // Private window: it just shows again next time.
    }
    setGone(true);
  };

  return (
    <section
      aria-labelledby="p1-done-heading"
      data-complete="true"
      className="shadow-offset flex flex-col gap-4 rounded-2xl border border-neon-green bg-raised p-4 sm:flex-row sm:items-center sm:p-5"
    >
      <div className="flex shrink-0 gap-2" aria-hidden="true">
        {set.cards.map((c) => (
          <Thumb key={c.id} card={c} className="w-12 sm:w-14" />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <h2 id="p1-done-heading" className="flex items-center gap-2 text-xl font-bold text-neon-green-text">
          <SparklesIcon aria-hidden="true" className="size-6 shrink-0" />
          Set complete!
        </h2>
        <p className="mt-1 text-ink">
          {set.label}, all {set.total}. {set.lastCard.player} #{set.lastCard.cardNumber} closed it out{" "}
          {set.whenLabel.toLowerCase()}.
        </p>
      </div>
      <NeonButton onClick={dismiss} className="shrink-0 self-start sm:self-center" aria-label={`Nice! Hide the ${set.label} celebration`}>
        Nice!
      </NeonButton>
    </section>
  );
}

// ---------------------------------------------------------------- fresh pulls

const PULL_PREVIEW = 6;

function FreshPulls({ batches }: { batches: AdditionBatch[] }) {
  return (
    <section id={ANCHOR.pulls} aria-labelledby="p1-pulls-heading" className="min-w-0 scroll-mt-6">
      <h2 id="p1-pulls-heading" className="text-2xl font-bold text-ink">
        Fresh Pulls
      </h2>
      <ul className="mt-3 flex flex-col gap-6">
        {batches.map((b) => (
          <li key={b.id}>
            <Batch batch={b} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Batch({ batch }: { batch: AdditionBatch }) {
  const shown = batch.cards.slice(0, PULL_PREVIEW);
  const rest = batch.cards.length - shown.length;
  return (
    <article aria-labelledby={`p1-batch-${batch.id}`}>
      <h3 id={`p1-batch-${batch.id}`} className="text-base font-bold text-ink">
        {batch.whenLabel}: {count(batch.cards.length, "card")} into {count(batch.binders.length, "binder")}
      </h3>
      <p className="text-sm text-ink-3">
        {batch.binders.map((b) => `${b.name} (${b.count})`).join(", ")}
        {batch.sinceLastVisit && <span className="font-semibold text-neon-blue-text">. New since your last visit</span>}
      </p>
      <ul className="mt-2 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
        {shown.map((c) => (
          <li key={c.id}>
            <Tile card={c} />
          </li>
        ))}
      </ul>
      {rest > 0 && <p className="mt-2 text-sm text-ink-2">And {count(rest, "more card")} in this batch.</p>}
    </article>
  );
}

/** A card with its caption: player, year and set, then the parallel or insert. */
function Tile({ card, extra }: { card: DashCard; extra?: string }) {
  const variant = [card.variantName, card.printRun].filter(Boolean).join(" ");
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <Thumb card={card} className="w-full" />
      <figcaption aria-hidden="true" className="min-w-0 text-xs leading-snug">
        <span className="block truncate font-semibold text-ink">{card.player}</span>
        <span className="block truncate text-ink-3">
          {card.setLabel}
          {extra}
        </span>
        {variant && <span className="block truncate text-neon-purple-text">{variant}</span>}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- almost there

const NEED_PREVIEW = 4;

function AlmostThere({ sets }: { sets: BuildingSet[] }) {
  return (
    <section aria-labelledby="p1-almost-heading" className="min-w-0">
      <h2 id="p1-almost-heading" className="text-2xl font-bold text-ink">
        Almost There
      </h2>
      <p className="text-sm text-ink-3">Base sets on your board, fewest cards to go first.</p>
      <ol className="mt-3 flex flex-col gap-3">
        {sets.map((s) => (
          <li key={s.setId}>
            <SetRow set={s} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function SetRow({ set }: { set: BuildingSet }) {
  const shown = set.neededNumbers.slice(0, NEED_PREVIEW);
  const rest = set.neededNumbers.length - shown.length;
  const owned = set.baseBulbs.filter((b) => b.owned).length;
  return (
    <article aria-labelledby={`p1-set-${set.setId}`} className="rounded-xl border border-rule bg-raised p-3">
      <div className="flex items-start justify-between gap-3">
        <h3 id={`p1-set-${set.setId}`} className="text-base font-bold leading-tight text-ink">
          {set.setLabel}
        </h3>
        <p className="shrink-0 text-right">
          <span className="p1-numeral p1-glow text-3xl text-neon-blue-text">{set.need}</span>
          <span className="ml-1 text-xs text-ink-2">to go</span>
        </p>
      </div>
      <p className="mt-1 text-sm text-ink-2">
        <span className="font-semibold tabular-nums text-ink">{set.percent}%</span> done, {set.have} of {set.total}
      </p>
      <div className="mt-2 flex flex-wrap gap-[3px]">
        <span className="sr-only">{`${owned} of ${set.baseBulbs.length} base cards lit up.`}</span>
        {set.baseBulbs.map((b) => (
          <span key={b.cardNumber} aria-hidden="true" className={`pip ${b.owned ? "pip-owned" : "pip-missing"}`} />
        ))}
      </div>
      <p className="mt-2 text-sm text-ink">
        Need: {shown.map((n) => `#${n}`).join(", ")}
        {rest > 0 && <span className="text-ink-3"> and {rest} more</span>}
      </p>
    </article>
  );
}

// ---------------------------------------------------------------- most wanted

function MostWanted({ cards }: { cards: WantCard[] }) {
  return (
    <section aria-labelledby="p1-chase-heading" className="min-w-0">
      <h2 id="p1-chase-heading" className="text-2xl font-bold text-ink">
        Most Wanted
      </h2>
      <p className="text-sm text-ink-3">Top of your Want List.</p>
      <ol className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-5">
        {cards.map((c) => (
          <li key={c.id}>
            <Tile card={c} extra={` #${c.cardNumber}`} />
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- smart binders

function BindersFillingUp({ binders, trade }: { binders: SmartBinderSummary[]; trade: DashboardData["tradePile"] }) {
  return (
    <section aria-labelledby="p1-binders-heading" className="min-w-0">
      <h2 id="p1-binders-heading" className="text-2xl font-bold text-ink">
        Binders Filling Up
      </h2>
      <ul className="mt-3 flex flex-col divide-y divide-rule">
        {binders.map((b) => (
          <li key={b.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-bold text-ink">{b.name}</h3>
              <p className="text-sm text-ink-2">
                {b.newCount > 0 ? (
                  <span className="font-semibold text-neon-green-text">{b.newCount} new since your last visit</span>
                ) : (
                  "Nothing new since your last visit"
                )}
                {b.checklist && (
                  <span className="text-ink-3">
                    . {b.checklist.percent}% of the checklist
                  </span>
                )}
              </p>
            </div>
            {b.newCards.length > 0 && (
              <div className="flex shrink-0 -space-x-4" aria-hidden="true">
                {b.newCards.slice(0, 3).map((c) => (
                  <Thumb key={c.id} card={c} className="w-9" />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {trade.count > 0 && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-control p-2.5 text-sm text-ink-2">
          {trade.cards[0] && <Thumb card={trade.cards[0]} className="w-8" />}
          <span>
            <span className="font-semibold text-ink">{count(trade.count, "card")}</span> in the trade pile, ready to swap.
          </span>
        </div>
      )}
    </section>
  );
}
