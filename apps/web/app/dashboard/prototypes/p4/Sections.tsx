import { useState, type ReactNode } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import CardFace, { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import {
  MARKETPLACES,
  daysAgoLabel,
  isLate,
  type AdditionBatch,
  type BuildingSet,
  type CompletedSet,
  type DashCard,
  type IntakeInProgress,
  type SalesData,
  type TradePile,
  type UnlistedBox,
  type WantCard,
} from "../_shared/data";
import type { ShelfBinder } from "./shelf-model";

/**
 * Prototype 4's supporting sections, under the shelf: the smart binders'
 * news, the ship list (dealer only), fresh pulls, sets on the bubble, the
 * chase, intake, the trade pile and unlisted boxes. Quiet on purpose: the
 * shelf is the loud thing on this page.
 */

/** A section heading with an optional one-line note beside it. */
function Head({ id, title, note }: { id: string; title: string; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 id={id} className="text-lg font-bold text-ink">
        {title}
      </h2>
      {note && <p className="text-sm text-ink-3">{note}</p>}
    </div>
  );
}

/** "Gold Refractor /50", or null on a plain base card. */
function variantLine(c: DashCard): string | null {
  const bits = [c.variantName, c.printRun, c.variation].filter(Boolean);
  return bits.length ? bits.join(" ") : null;
}

/** A small card in a fixed-width box: CardFace fills it. */
function Thumb({ card, width = "w-14", label }: { card: DashCard; width?: string; label?: string }) {
  return (
    <div className={`${width} shrink-0`}>
      <CardFace model={card.card} size="fill" label={label} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Celebrate once
// ---------------------------------------------------------------------------

const CELEBRATED_KEY = "nb-dash-p4-celebrated";

function readCelebrated(id: string): boolean {
  try {
    return window.localStorage.getItem(CELEBRATED_KEY) === id;
  } catch {
    return false;
  }
}

/** The checklist just finished: shown until the collector says "Nice!", then never again. */
export function Celebration({ done }: { done: CompletedSet }) {
  const [gone, setGone] = useState(() => readCelebrated(done.id));
  if (gone) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(CELEBRATED_KEY, done.id);
    } catch {
      // Private window: it just shows again next time.
    }
    setGone(true);
  };
  return (
    <section
      aria-labelledby="p4-done"
      data-complete="true"
      className="flex items-center gap-4 rounded-lg border border-notice-success-rule bg-notice-success-bg p-3 shadow-offset sm:p-4"
    >
      <Thumb card={done.lastCard} width="w-12 sm:w-14" />
      <div className="min-w-0 flex-1">
        <h2 id="p4-done" className="font-bold text-notice-success-ink">
          {done.label}: complete!
        </h2>
        <p className="text-sm text-ink-2">
          {done.lastCard.player} #{done.lastCard.cardNumber} closed it out {done.whenLabel.toLowerCase()}. All{" "}
          {done.total} in the binder.
        </p>
      </div>
      <NeonButton variant="primary" size="1" onClick={dismiss} aria-label={`Nice! Hide the ${done.label} celebration`}>
        Nice!
      </NeonButton>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Smart binders: what filed itself
// ---------------------------------------------------------------------------

export function SmartNews({ binders, onOpen }: { binders: ShelfBinder[]; onOpen: (id: string) => void }) {
  return (
    <section aria-labelledby="p4-smart-news">
      <Head id="p4-smart-news" title="Filed themselves" note="New in your smart binders since your last visit." />
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {binders.map((b) => {
          const fresh = b.newCards.length;
          const thumbs = b.newCards.slice(0, 3);
          return (
            <li key={b.id} className="flex flex-col gap-2 rounded-lg border border-rule bg-raised p-3 shadow-offset">
              <div>
                <h3 className="font-bold leading-tight text-ink">{b.name}</h3>
                <p className="text-xs text-ink-3">{b.ruleText}</p>
              </div>
              <p className="text-sm text-ink">
                {fresh > 0 ? (
                  <>
                    <strong className="text-neon-green-text">{fresh} new</strong> since your last visit
                  </>
                ) : (
                  <span className="text-ink-2">Nothing new since your last visit</span>
                )}
              </p>
              {thumbs.length > 0 && (
                <div className="flex flex-wrap items-end gap-1.5">
                  {thumbs.map((c) => (
                    <Thumb key={c.id} card={c} width="w-11" />
                  ))}
                  {fresh > thumbs.length && (
                    <span className="pb-1 text-xs font-bold text-ink-2">+{fresh - thumbs.length}</span>
                  )}
                </div>
              )}
              {b.checklist && (
                <div>
                  <p className="text-sm text-ink-2">
                    <strong className="text-ink">{b.checklist.percent}%</strong> of the checklist
                  </p>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-field" aria-hidden="true">
                    <div className="h-full rounded-full bg-neon-green" style={{ width: `${b.checklist.percent}%` }} />
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => onOpen(b.id)}
                className="mt-auto self-start rounded-md text-sm font-bold text-neon-blue-text underline-offset-4 hover:underline focus-outline"
                aria-label={fresh > 0 ? `See the ${fresh} new in ${b.name}` : `Flip through ${b.name}`}
              >
                {fresh > 0 ? `See the ${fresh} new` : "Flip through it"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Out the Door (dealer only)
// ---------------------------------------------------------------------------

export function OutTheDoor({ sales }: { sales: SalesData }) {
  const orders = sales.unshipped;
  if (orders.length === 0) {
    return (
      <section aria-labelledby="p4-ship" className="flex items-baseline gap-3">
        <h2 id="p4-ship" className="text-lg font-bold text-ink">
          Out the Door
        </h2>
        <p className="text-sm text-ink-2">All shipped. Nice.</p>
      </section>
    );
  }
  const late = orders.filter(isLate).length;
  return (
    <section aria-labelledby="p4-ship">
      <Head
        id="p4-ship"
        title="Out the Door"
        note={`${orders.length} ${orders.length === 1 ? "order" : "orders"} to ship, oldest first${late ? `. ${late} waiting 2 days or more.` : "."}`}
      />
      <ol className="mt-3 divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-raised shadow-offset">
        {orders.map((o) => {
          const lateRow = isLate(o);
          const more = o.lines.length - 1;
          return (
            <li
              key={o.id}
              className={`grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center ${
                lateRow ? "border-l-4 border-l-notice-warn-rule bg-notice-warn-bg" : "border-l-4 border-l-transparent"
              }`}
            >
              <div className="row-span-2 sm:row-span-1">
                <Thumb card={o.firstCard} width="w-10" />
              </div>
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">
                  {o.firstCard.player}
                  {more > 0 && <span className="font-normal text-ink-2"> + {more} more</span>}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
                  <span
                    className="rounded bg-chip px-1.5 py-0.5 text-xs font-bold text-ink"
                    title={MARKETPLACES[o.marketplace].name}
                  >
                    <span aria-hidden="true">{MARKETPLACES[o.marketplace].short}</span>
                    <span className="sr-only">{MARKETPLACES[o.marketplace].name}</span>
                  </span>
                  <span className="tabular-nums">#{o.orderNumber}</span>
                  <span>
                    {o.cardCount} {o.cardCount === 1 ? "card" : "cards"}
                  </span>
                </p>
              </div>
              <p className="col-start-2 flex flex-wrap items-center gap-x-2 text-sm sm:col-start-auto">
                <span className={lateRow ? "flex items-center gap-1 font-bold text-notice-warn-ink" : "text-ink-2"}>
                  {lateRow && <ExclamationTriangleIcon aria-hidden="true" className="h-4 w-4" />}
                  Sold {daysAgoLabel(o.daysSinceSold).toLowerCase()}
                </span>
                <span className="text-ink-3">{o.statusText}</span>
              </p>
              {o.hasProblem && (
                <ul className="col-span-2 col-start-1 space-y-0.5 sm:col-span-4">
                  {o.lines.map((l, i) =>
                    l.problem ? (
                      <li
                        key={i}
                        className="rounded-md border border-notice-danger-rule bg-notice-danger-bg px-2 py-1 text-sm text-notice-danger-ink"
                      >
                        {l.problem.kind === "unmatched" ? (
                          <>
                            <strong>Not matched to a card:</strong> “{l.problem.listingTitle}”. Pick the card before it ships.
                          </>
                        ) : (
                          <>
                            <strong>Oversold:</strong> sold {l.problem.sold} of {l.card?.player} #{l.card?.cardNumber}, your
                            boxes hold {l.problem.inBoxes}.
                          </>
                        )}
                      </li>
                    ) : null,
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fresh Pulls
// ---------------------------------------------------------------------------

const TILES_PER_BATCH = 6;

function batchTitle(b: AdditionBatch): string {
  const n = b.cards.length;
  const binders = b.binders.length;
  return `${b.whenLabel}: ${n} ${n === 1 ? "card" : "cards"} into ${binders} ${binders === 1 ? "binder" : "binders"}`;
}

export function FreshPulls({ batches }: { batches: AdditionBatch[] }) {
  const firstOld = batches.findIndex((b) => !b.sinceLastVisit);
  return (
    <section aria-labelledby="p4-fresh">
      <Head id="p4-fresh" title="Fresh Pulls" note="Newest first." />
      <div className="mt-3 space-y-6">
        {batches.map((b, bi) => {
          const shown = b.cards.slice(0, TILES_PER_BATCH);
          const rest = b.cards.length - shown.length;
          return (
            <div key={b.id}>
              {bi === firstOld && bi > 0 && (
                <p className="mb-4 flex items-center gap-3 text-xs font-medium text-ink-3">
                  <span className="h-px flex-1 bg-rule" aria-hidden="true" />
                  Before your last visit
                  <span className="h-px flex-1 bg-rule" aria-hidden="true" />
                </p>
              )}
              <h3 className="font-bold text-ink">{batchTitle(b)}</h3>
              <p className="text-sm text-ink-3">{b.binders.map((x) => `${x.name} ${x.count}`).join(", ")}</p>
              <ul className="mt-2 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
                {shown.map((c) => {
                  const v = variantLine(c);
                  return (
                    <li key={c.id} className="min-w-0">
                      <CardFace model={c.card} size="fill" />
                      <p className="mt-1.5 truncate text-sm font-bold leading-tight text-ink">{c.player}</p>
                      <p className="truncate text-xs text-ink-2">{c.setLabel}</p>
                      {v && <p className="truncate text-xs font-medium text-neon-purple-text">{v}</p>}
                    </li>
                  );
                })}
              </ul>
              {rest > 0 && <p className="mt-2 text-sm text-ink-2">+{rest} more from this batch.</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Almost There
// ---------------------------------------------------------------------------

const NEED_SHOWN = 4;

export function AlmostThere({ sets }: { sets: BuildingSet[] }) {
  return (
    <section aria-labelledby="p4-bubble">
      <Head id="p4-bubble" title="Almost There" note="Fewest cards to go." />
      <ul className="mt-3 space-y-3">
        {sets.map((s) => {
          const need = s.neededNumbers.slice(0, NEED_SHOWN);
          const more = s.neededNumbers.length - need.length;
          return (
            <li key={s.setId} className="rounded-lg border border-rule bg-raised p-3 shadow-offset">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="min-w-0 font-bold leading-tight text-ink">{s.setLabel}</h3>
                <p className="shrink-0 text-sm tabular-nums text-ink-2">
                  <strong className="text-base text-ink">{s.need} to go</strong>
                  <span className="ml-2">{s.percent}%</span>
                </p>
              </div>
              <div className="mt-2 flex flex-wrap gap-[3px]" aria-hidden="true">
                {s.baseBulbs.map((b) => (
                  <span key={b.cardNumber} className={`pip ${b.owned ? "pip-owned" : "pip-missing"}`} />
                ))}
              </div>
              <p className="mt-2 text-sm text-ink-2">
                Need: {need.map((n) => `#${n}`).join(", ")}
                {more > 0 && `, +${more} more`}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The Chase
// ---------------------------------------------------------------------------

export function Chase({ wants }: { wants: WantCard[] }) {
  return (
    <section aria-labelledby="p4-chase">
      <Head id="p4-chase" title="The Chase" note="Top of the Want List." />
      <ul className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-5 lg:grid-cols-3">
        {wants.map((w) => (
          <li key={w.id} className="min-w-0">
            <CardFace model={w.card} size="fill" state="need" />
            <p className="mt-1.5 truncate text-sm font-bold leading-tight text-ink">{w.player}</p>
            <p className="text-xs leading-snug text-ink-2">
              {w.setLabel}
              {w.variantName ? ` ${w.variantName}` : ""} #{w.cardNumber}
              {w.printRun ? ` ${w.printRun}` : ""}
            </p>
            {w.forBinder && <p className="truncate text-xs text-ink-3">For {w.forBinder}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Intake, trade pile, unlisted boxes
// ---------------------------------------------------------------------------

export function Intake({ intake }: { intake: IntakeInProgress }) {
  return (
    <section aria-labelledby="p4-intake" className="rounded-lg border border-rule bg-raised p-3 shadow-offset">
      <h2 id="p4-intake" className="font-bold text-ink">
        Still in intake
      </h2>
      <p className="text-sm text-ink-2">
        {intake.total} scans. <strong className="text-ink">{intake.needsYou} need a yes from you</strong>,{" "}
        {intake.waiting} still being identified.
      </p>
      <ul className="mt-3 flex gap-2">
        {intake.preview.map((s) => (
          <li key={s.id} className="w-12 shrink-0">
            {s.guess ? (
              <CardFace
                model={s.guess.card}
                size="fill"
                label={`Best guess, waiting on you: ${s.guess.player}, ${s.guess.setLabel} #${s.guess.cardNumber}`}
              />
            ) : (
              <EmptySleeve size="fill" label="Scan waiting to be identified" />
            )}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-0.5 text-sm text-ink-2">
        {intake.uploads.map((u) => (
          <li key={u.id}>
            {u.name}: {u.done} of {u.scans} done
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TradePileCard({ pile }: { pile: TradePile }) {
  return (
    <section aria-labelledby="p4-trade" className="rounded-lg border border-rule bg-raised p-3 shadow-offset">
      <h2 id="p4-trade" className="font-bold text-ink">
        Up for Trade
      </h2>
      <p className="text-sm text-ink-2">
        {pile.count} {pile.count === 1 ? "card" : "cards"} in the trade pile.
      </p>
      {pile.cards.length > 0 && (
        <ul className="mt-3 flex gap-2">
          {pile.cards.slice(0, 4).map((c) => (
            <li key={c.id}>
              <Thumb card={c} width="w-12" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function UnlistedBoxes({ boxes }: { boxes: UnlistedBox[] }) {
  const total = boxes.reduce((n, b) => n + b.unlisted, 0);
  return (
    <section aria-labelledby="p4-boxes" className="rounded-lg border border-rule bg-raised p-3 shadow-offset">
      <h2 id="p4-boxes" className="font-bold text-ink">
        Not listed yet
      </h2>
      <p className="text-sm text-ink-2">
        {total} {total === 1 ? "card" : "cards"} in your boxes aren&apos;t on any marketplace.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {boxes.map((b) => (
          <li key={b.id} className="flex justify-between gap-3">
            <span className="text-ink">{b.name}</span>
            <span className="tabular-nums text-ink-2">{b.unlisted}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
