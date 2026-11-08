import { useState } from "react";
import { Link } from "react-router";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import NeonButton from "@/components/modules/NeonButton";
import type { BuildingSet, ChecklistStrip, CompletedSet, WantCard } from "../_shared/data";
import { useOpen } from "./useOpen";
import "@/app/collection/final/cards/cards.css";

/**
 * NEO-464 prototype 2 — the scoreboard wall: one LED board per set on the
 * board, ranked by fewest base cards needed. The leader gets the jumbotron
 * (full width, its whole need list up front); the rest sit two across.
 *
 * Only the sets on the board are drawn, and only from the fixture's own
 * counts: nothing here reads a whole checklist.
 */

/** The brand's Neon face, as the scoreboard's percent uses it: rank numerals. */
const NEON_NUMERALS = "font-['Neon',_'Lexend',_sans-serif] leading-[0.9] tracking-[0.02em]";

/** How many needed numbers a board names before "+N more". */
const NEED_PREVIEW = { leader: 10, rest: 3 } as const;

export default function Boards({
  building,
  wantList,
  justCompleted,
}: {
  building: BuildingSet[];
  wantList: WantCard[];
  justCompleted: CompletedSet | null;
}) {
  // Base cards on the Want List, by set and number, so a board can star them.
  const wanted = new Set(wantList.filter((w) => w.variantKind === "base").map((w) => `${w.setId}#${w.cardNumber}`));

  return (
    <section aria-labelledby="p2-board-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="p2-board-heading" className="text-2xl font-bold text-ink">
          On the Bubble
        </h2>
        <p className="text-sm text-ink-3">Ranked by fewest cards to go. Base set.</p>
      </div>

      {justCompleted && <Cheer done={justCompleted} />}

      {building.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-control p-6 text-ink-2">
          Nothing on the board yet. Pick a set and light it up.
        </p>
      ) : (
        <ol className="grid gap-5 md:grid-cols-2">
          {building.map((set, i) => (
            <li key={set.setId} className={i === 0 ? "md:col-span-2" : undefined}>
              <Board set={set} rank={i + 1} leader={i === 0} wanted={wanted} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The set's wall in the collection demo: a real page, so a click pushes. */
function wallLink(setId: string): string {
  return `/binder-tracking?${new URLSearchParams({ demo: "on", tab: "cards", set: setId })}`;
}

function Board({ set, rank, leader, wanted }: { set: BuildingSet; rank: number; leader: boolean; wanted: Set<string> }) {
  const [showAll, toggleAll] = useOpen(`need-${set.setId}`);
  const isWanted = (n: string) => wanted.has(`${set.setId}#${n}`);
  const preview = leader ? NEED_PREVIEW.leader : NEED_PREVIEW.rest;
  const shown = showAll ? set.neededNumbers : set.neededNumbers.slice(0, preview);
  const more = set.neededNumbers.length - shown.length;
  const canExpand = set.neededNumbers.length > preview;
  const wantedCount = set.baseBulbs.filter((b) => !b.owned && isWanted(b.cardNumber)).length;

  const score = (
    <div className="flex items-end justify-between gap-4">
      <p>
        <span className={`mc-percent block text-neon-blue-text ${leader ? "text-7xl sm:text-8xl" : "text-6xl"}`}>
          {set.percent}%
        </span>
        <span className="text-xs text-ink-2">of the base set</span>
      </p>
      <dl className="flex gap-5 text-right">
        <div>
          <dt className="text-xs text-ink-3">Have</dt>
          <dd className="text-2xl font-bold tabular-nums text-ink">{set.have}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Need</dt>
          <dd className="text-2xl font-bold tabular-nums text-neon-orange-text">{set.need}</dd>
        </div>
      </dl>
    </div>
  );

  const needList = (
    <div className="space-y-1.5">
      <p className="text-sm leading-relaxed text-ink-2">
        <span className="font-bold text-ink">Need: </span>
        {shown.map((n, i) => (
          <span key={n} className="whitespace-nowrap tabular-nums">
            #{n}
            {isWanted(n) && (
              <>
                <span aria-hidden="true" className="mc-star text-neon-yellow-text">
                  ★
                </span>
                <span className="sr-only"> (on your Want List)</span>
              </>
            )}
            {i < shown.length - 1 ? ", " : ""}
          </span>
        ))}
        {more > 0 && <span className="text-ink-3"> +{more} more</span>}
      </p>
      {canExpand && (
        <button
          type="button"
          aria-expanded={showAll}
          aria-label={`${showAll ? "Show fewer" : `Show all ${set.need}`} cards needed for ${set.setLabel}`}
          onClick={toggleAll}
          className="relative z-10 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-xs text-ink-3 hover:text-neon-blue-text focus-outline"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-3.5 transition-transform motion-reduce:transition-none ${showAll ? "rotate-180" : ""}`}
          />
          {showAll ? "Show fewer" : `Show all ${set.need}`}
        </button>
      )}
    </div>
  );

  const strips = (
    <ul aria-label={`${set.setLabel} by checklist`} className="flex flex-col gap-2.5">
      {set.checklists.map((c) =>
        c.kind === "base" ? (
          <li key={c.name} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2 text-xs">
            <span className="truncate text-ink-2">Base</span>
            <span className="flex flex-wrap gap-[3px]">
              <span className="sr-only">
                {`${set.have} of ${set.total} lit up${wantedCount > 0 ? `, ${wantedCount} on your Want List` : ""}.`}
              </span>
              {set.baseBulbs.map((b) => (
                <span
                  key={b.cardNumber}
                  aria-hidden="true"
                  title={`#${b.cardNumber}`}
                  className={`pip ${b.owned ? "pip-owned" : isWanted(b.cardNumber) ? "pip-want" : "pip-missing"}`}
                />
              ))}
            </span>
            <Count have={c.have} total={c.total} />
          </li>
        ) : (
          <Gauge key={c.name} strip={c} />
        ),
      )}
    </ul>
  );

  return (
    <article
      className={`mc-led shadow-offset relative flex h-full flex-col gap-4 rounded-2xl border border-rule transition-colors hover:border-selection has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-focus ${
        leader ? "p-5 sm:p-6" : "p-4 sm:p-5"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`${NEON_NUMERALS} grid size-11 shrink-0 place-items-center rounded-lg border border-rule-strong text-3xl text-neon-yellow-text`}
        >
          {rank}
        </span>
        <div className="min-w-0">
          <h3 className={`font-bold leading-tight text-ink ${leader ? "text-xl sm:text-2xl" : "text-lg"}`}>
            <Link
              to={wallLink(set.setId)}
              className="after:absolute after:inset-0 after:rounded-2xl hover:text-neon-blue-text focus-visible:outline-none"
            >
              {set.setLabel}
            </Link>
          </h3>
          <p className="text-sm text-ink-3">
            {set.need === 1 ? "One card to go." : `${set.need} cards to go.`}
          </p>
        </div>
      </div>

      {leader ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-8">
          <div className="space-y-4">
            {score}
            {needList}
          </div>
          <div className="lg:border-l lg:border-rule lg:pl-8">{strips}</div>
        </div>
      ) : (
        <>
          {score}
          {needList}
          {strips}
        </>
      )}
    </article>
  );
}

function Count({ have, total }: { have: number; total: number }) {
  return (
    <span className="tabular-nums text-ink-2">
      <span aria-hidden="true">
        {have}
        <span className="text-ink-3">/{total}</span>
      </span>
      <span className="sr-only">{`${have} of ${total}`}</span>
    </span>
  );
}

/**
 * An insert or parallel strip. The fixture has its count, not which cards,
 * so it draws a gauge (lit segments first), never pips that would claim
 * which numbers are owned.
 */
function Gauge({ strip }: { strip: ChecklistStrip }) {
  return (
    <li className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2 text-xs">
      <span className="truncate text-ink-2" title={strip.name}>
        {strip.name}
        <span className="sr-only">{strip.kind === "insert" ? ", insert" : ", parallel"}</span>
      </span>
      <span aria-hidden="true" className="flex gap-[3px]">
        {Array.from({ length: strip.total }, (_, i) => (
          <span
            key={i}
            className={`h-[7px] w-3 rounded-[2px] ${i < strip.have ? "bg-pip-owned shadow-[var(--pip-owned-glow)]" : "border border-pip-missing"}`}
          />
        ))}
      </span>
      <Count have={strip.have} total={strip.total} />
    </li>
  );
}

/** The checklist just finished: said once, at the top of the wall, until waved off. */
function Cheer({ done }: { done: CompletedSet }) {
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const when = done.whenLabel.toLowerCase();
  return (
    <div
      data-complete="true"
      className="shadow-offset flex flex-col gap-4 rounded-2xl border border-notice-success-rule bg-notice-success-bg p-4 sm:flex-row sm:items-center"
    >
      <ul aria-label={`${done.label}, every card`} className="flex shrink-0 gap-2">
        {done.cards.map((c) => (
          <li key={c.id} className="w-14">
            <CardFace model={c.card} size="fill" />
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold text-notice-success-ink">Every bulb lit! {done.label} is done.</h3>
        <p className="text-sm text-ink-2">
          All {done.total} in the binder. {done.lastCard.player} #{done.lastCard.cardNumber} closed it out {when}.
        </p>
      </div>
      <NeonButton
        type="button"
        variant="primary"
        outline
        onClick={() => setGone(true)}
        aria-label={`Nice! Hide the ${done.label} cheer`}
        className="shrink-0 self-start sm:self-center"
      >
        Nice!
      </NeonButton>
    </div>
  );
}
