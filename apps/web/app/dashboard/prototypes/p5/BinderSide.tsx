import { useSearchParams } from "react-router";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import type {
  AdditionBatch,
  BuildingSet,
  CompletedSet,
  DashboardData,
  SmartBinderSummary,
  TradePile,
  WantCard,
} from "../_shared/data";
import { Tray } from "./BoxSide";
import { CardTile, FOCUS, SectionHead, Thumb, cards, midSentence } from "./parts";

/**
 * NEO-464 prototype 5, "Split desk": the left half, the binder. Everything
 * the collector keeps: the set just finished, fresh pulls, sets on the
 * bubble, smart binders, the chase and the trade pile. On a page with no box
 * side (the collector never sells) the tray of scans sits here too.
 *
 * The side is a size container, so its grids follow the side's own width,
 * not the screen's: the same markup fills a full-width page or a 60% column.
 */
export function BinderSide({ data, withTray }: { data: DashboardData; withTray: boolean }) {
  return (
    <section aria-labelledby="p5-binder-sign" className="@container min-w-0 space-y-10">
      <header>
        <h2 id="p5-binder-sign" className="p5-sign p5-sign-binder text-4xl sm:text-5xl">
          The Binder
        </h2>
        <p className="mt-2 text-sm text-ink-2">
          Cards you keep. {cards(data.totals.cards)} in {data.totals.binders} binders.
        </p>
      </header>

      {data.justCompleted && <JustCompleted set={data.justCompleted} />}
      {withTray && <Tray intake={data.intake} destination="your binders" />}
      <FreshPulls batches={data.additions} />
      <AlmostThere sets={data.building} />
      <FillingUp binders={data.smartBinders} />
      <TheChase wants={data.wantList} />
      {data.tradePile.count > 0 && <TradeBait pile={data.tradePile} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The set just finished: the page's one celebration, a single sweep of light.
// ---------------------------------------------------------------------------

function JustCompleted({ set }: { set: CompletedSet }) {
  const last = set.lastCard;
  return (
    <section
      aria-labelledby="p5-done"
      data-complete="true"
      className="p5-cheer shadow-offset relative flex items-center gap-4 overflow-hidden rounded-2xl border border-neon-green-text bg-raised p-4"
    >
      <span className="block w-16 shrink-0">
        <CardFace model={last.card} size="fill" />
      </span>
      <div className="min-w-0">
        <h3 id="p5-done" className="text-lg font-bold leading-tight text-neon-green-text">
          Set complete!
        </h3>
        <p className="mt-1 text-ink">
          {set.label}: all {set.total} of {set.total}.
        </p>
        <p className="mt-0.5 text-sm text-ink-2">
          {last.player} #{last.cardNumber} came in {midSentence(set.whenLabel)} and closed it out.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fresh Pulls: newest first, in the batches they came in.
// ---------------------------------------------------------------------------

const PULLS_PARAM = "pulls";
const PREVIEW = 6;

function FreshPulls({ batches }: { batches: AdditionBatch[] }) {
  const [params, setParams] = useSearchParams();
  const open = params.get(PULLS_PARAM);
  const fresh = batches.filter((b) => b.sinceLastVisit).reduce((n, b) => n + b.cards.length, 0);

  // Showing a whole batch is an in-view tweak: it replaces the entry, so Back
  // never steps through it, and leaves `as` (the persona) alone.
  const toggle = (id: string) =>
    setParams(
      (p) => {
        if (p.get(PULLS_PARAM) === id) p.delete(PULLS_PARAM);
        else p.set(PULLS_PARAM, id);
        return p;
      },
      { replace: true },
    );

  return (
    <section aria-labelledby="p5-pulls">
      <SectionHead id="p5-pulls" title="Fresh Pulls" aside={fresh > 0 ? `${cards(fresh)} since your last visit` : undefined} />
      <div className="mt-3 space-y-6">
        {batches.map((batch) => {
          const expanded = open === batch.id;
          const shown = expanded ? batch.cards : batch.cards.slice(0, PREVIEW);
          const gridId = `p5-pulls-${batch.id}`;
          return (
            <section key={batch.id} aria-labelledby={`${gridId}-h`}>
              <h4 id={`${gridId}-h`} className="font-semibold text-ink">
                {batch.whenLabel}: {cards(batch.cards.length)} into{" "}
                {batch.binders.length === 1 ? batch.binders[0].name : `${batch.binders.length} binders`}
              </h4>
              {batch.binders.length > 1 && (
                <p className="text-sm text-ink-3">
                  {batch.binders.map((b) => `${b.count} in ${b.name}`).join(", ")}
                </p>
              )}
              <ul id={gridId} className="mt-2 grid grid-cols-3 gap-3 @lg:grid-cols-6 @4xl:grid-cols-8">
                {shown.map((card) => (
                  <li key={card.id}>
                    <CardTile card={card} />
                  </li>
                ))}
              </ul>
              {batch.cards.length > PREVIEW && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={gridId}
                  onClick={() => toggle(batch.id)}
                  className={`mt-2 min-h-11 rounded-md px-1 text-sm font-semibold text-neon-blue-text underline-offset-4 hover:underline sm:min-h-0 ${FOCUS}`}
                >
                  {expanded
                    ? `Show fewer from ${midSentence(batch.whenLabel)}`
                    : `Show all ${batch.cards.length} from ${midSentence(batch.whenLabel)}`}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Almost There: base sets on the board, fewest cards needed first.
// ---------------------------------------------------------------------------

/** Past this many base cards a bulb strip is noise, not a picture. */
const MAX_BULBS = 120;
const NEED_SHOWN = 6;

function AlmostThere({ sets }: { sets: BuildingSet[] }) {
  if (sets.length === 0) return null;
  return (
    <section aria-labelledby="p5-almost">
      <SectionHead id="p5-almost" title="Almost There" aside="Fewest cards to go first" />
      <ol className="mt-3 grid gap-4 @2xl:grid-cols-2">
        {sets.map((set) => (
          <li key={set.setId}>
            <SetBoard set={set} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function SetBoard({ set }: { set: BuildingSet }) {
  const shown = set.neededNumbers.slice(0, NEED_SHOWN);
  const more = set.neededNumbers.length - shown.length;
  return (
    <article
      aria-labelledby={`p5-board-${set.setId}`}
      className="p5-led shadow-offset flex h-full flex-col gap-3 rounded-2xl border border-rule p-4"
    >
      <h4 id={`p5-board-${set.setId}`} className="font-bold leading-tight text-ink">
        {set.setLabel}
      </h4>
      <div className="flex items-end justify-between gap-3">
        <p>
          <span className="p5-count block text-5xl tabular-nums text-neon-blue-text">{set.need}</span>
          <span className="text-xs text-ink-2">{set.need === 1 ? "card to go" : "cards to go"}</span>
        </p>
        <dl className="flex gap-4 text-right">
          <div>
            <dt className="text-xs text-ink-3">Base set</dt>
            <dd className="text-2xl font-bold tabular-nums text-ink">{set.percent}%</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Have</dt>
            <dd className="text-2xl font-bold tabular-nums text-ink">
              {set.have}
              <span className="text-sm font-normal text-ink-3">/{set.total}</span>
            </dd>
          </div>
        </dl>
      </div>
      {set.total <= MAX_BULBS && (
        <div aria-hidden="true" className="flex flex-wrap gap-1">
          {set.baseBulbs.map((b) => (
            <span key={b.cardNumber} className={`pip ${b.owned ? "pip-owned" : "pip-missing"}`} />
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink">Need:</span> {shown.map((n) => `#${n}`).join(", ")}
          {more > 0 && <span className="text-ink-3"> and {more} more</span>}
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Binders Filling Up: smart binders, what's new in each since the last visit.
// ---------------------------------------------------------------------------

const BINDER_THUMBS = 4;

function FillingUp({ binders }: { binders: SmartBinderSummary[] }) {
  if (binders.length === 0) return null;
  return (
    <section aria-labelledby="p5-filling">
      <SectionHead id="p5-filling" title="Binders Filling Up" />
      <ul className="mt-3 grid gap-3 @2xl:grid-cols-2">
        {binders.map((binder) => {
          const thumbs = binder.newCards.slice(0, BINDER_THUMBS);
          const extra = binder.newCount - thumbs.length;
          return (
            <li key={binder.id} className="flex h-full flex-col gap-2 rounded-xl border border-rule bg-raised p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="font-semibold leading-tight text-ink">{binder.name}</h4>
                  <p className="text-xs text-ink-3">{binder.ruleText}</p>
                </div>
                {binder.checklist && (
                  <p className="shrink-0 text-right">
                    <span className="block text-xl font-bold tabular-nums text-neon-blue-text">
                      {binder.checklist.percent}%
                    </span>
                    <span className="text-xs text-ink-3">
                      {binder.checklist.have} of {binder.checklist.total}
                    </span>
                  </p>
                )}
              </div>
              <p className="text-sm text-ink-2">
                {binder.newCount > 0 ? (
                  <span className="font-semibold text-neon-green-text">{binder.newCount} new since your last visit</span>
                ) : (
                  "Nothing new since your last visit"
                )}
                <span className="text-ink-3">. {cards(binder.cardCount)} in all.</span>
              </p>
              {thumbs.length > 0 && (
                <ul className="flex items-end gap-2">
                  {thumbs.map((c) => (
                    <li key={c.id}>
                      <Thumb card={c} className="w-11" />
                    </li>
                  ))}
                  {extra > 0 && <li className="pb-1 text-sm text-ink-3">+{extra}</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The Chase: the Want List's top cards.
// ---------------------------------------------------------------------------

function TheChase({ wants }: { wants: WantCard[] }) {
  if (wants.length === 0) return null;
  return (
    <section aria-labelledby="p5-chase">
      <SectionHead id="p5-chase" title="The Chase" aside="Top of your Want List" />
      <ul className="mt-3 grid grid-cols-3 gap-3 @md:grid-cols-5 @4xl:grid-cols-7">
        {wants.map((w) => (
          <li key={w.id}>
            <CardTile
              card={w}
              numbered
              extra={w.forBinder && <span className="block truncate text-ink-3">for {w.forBinder}</span>}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Trade Bait: copies flagged up for trade.
// ---------------------------------------------------------------------------

function TradeBait({ pile }: { pile: TradePile }) {
  return (
    <section aria-labelledby="p5-trade">
      <SectionHead id="p5-trade" title="Trade Bait" aside={`${cards(pile.count)} up for trade`} />
      <ul className="mt-3 flex flex-wrap gap-2">
        {pile.cards.slice(0, 8).map((c) => (
          <li key={c.id}>
            <Thumb card={c} className="w-12" />
          </li>
        ))}
      </ul>
    </section>
  );
}
