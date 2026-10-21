import { useCallback, useRef } from "react";
import CardFace from "../_shared/CardFace";
import {
  cardsInSet,
  getBrand,
  getSet,
  getSport,
  playerNames,
  setLabel,
  variantLabel,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import Cascade from "./Cascade";
import { terminalFilter, type Drill } from "./drill";
import { OUTLINE_BUTTON } from "./ui";

/**
 * Checklists: the catalog, read-only. The same cascade as Find Cards, then
 * the set's facts (how many cards, every insert and parallel and its print
 * run) and the cards themselves. Ownership is a quiet line, never the point:
 * this tab is for looking a set up, Find Cards is for tracking it.
 */
export default function Checklists({
  store,
  drill,
  cascadeKey,
  onDrill,
  onTrack,
}: {
  store: PrototypeStore;
  drill: Drill;
  cascadeKey: number;
  onDrill: (next: Drill) => void;
  onTrack: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusChecklist = useCallback(() => headingRef.current?.focus(), []);
  const set = drill.set ? getSet(drill.set) : null;
  const filter = terminalFilter(drill);
  const cards = set && filter ? cardsInSet(set.id, filter) : [];
  const allCards = set ? cardsInSet(set.id) : [];
  const ownedInSet = allCards.filter((c) => store.ownedCount(c.id) > 0).length;

  return (
    <div className="space-y-4">
      <h2 className="sr-only">Checklists</h2>
      <p className="text-sm text-slate-300">Look up any set: every card, insert and parallel we know.</p>
      <Cascade
        key={cascadeKey}
        drill={drill}
        onDrill={onDrill}
        completion={store.completion}
        label="Pick a checklist"
        onReachedChecklist={focusChecklist}
      />

      {set && (
        <section aria-label={`About ${setLabel(set)}`} className="rounded-lg border border-slate-800 p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-semibold text-slate-100">{setLabel(set)}</h3>
            <p className="text-sm text-slate-400">
              {getSport(set.sportId).name} · {getBrand(set.brandId).name}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
            <div>
              <dt className="text-slate-400">Cards in all</dt>
              <dd className="text-xl font-semibold tabular-nums text-slate-100">{allCards.length}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Base</dt>
              <dd className="text-xl font-semibold tabular-nums text-slate-100">
                {cardsInSet(set.id, { type: "Base" }).length}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Inserts</dt>
              <dd className="text-xl font-semibold tabular-nums text-slate-100">
                {set.variants.filter((v) => v.path.type === "Inserts").length}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Parallels</dt>
              <dd className="text-xl font-semibold tabular-nums text-slate-100">
                {set.variants.filter((v) => v.path.type === "Parallels").length}
              </dd>
            </div>
          </dl>
          {set.variants.some((v) => v.path.type !== "Base") && (
            <ul className="flex flex-wrap gap-2">
              {set.variants
                .filter((v) => v.path.type !== "Base")
                .map((v) => {
                  const n = cardsInSet(set.id, { type: v.path.type, name: v.path.name }).length;
                  const run = v.printRun === null ? "" : v.printRun === 1 ? " · 1/1" : ` · /${v.printRun}`;
                  return (
                    <li
                      key={`${v.path.type}-${v.path.name}`}
                      className="rounded-full border border-slate-700 px-2.5 py-1 text-sm text-slate-200"
                    >
                      {variantLabel(v.path)}
                      <span className="text-slate-400">
                        {" "}
                        · {v.path.type === "Inserts" ? "insert" : "parallel"} · {n} cards{run}
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}
          {ownedInSet > 0 && (
            <p className="text-sm text-slate-400">You have {ownedInSet} cards from this set.</p>
          )}
        </section>
      )}

      {set && filter && (
        <section aria-labelledby="p1-catalog-heading" className="bg-gray-800 p-4 sm:p-6 rounded-lg space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3
              id="p1-catalog-heading"
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold text-slate-100 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
            >
              {setLabel(set)} {variantLabel({ type: filter.type, name: filter.name ?? null })}
              <span className="ml-2 text-sm font-normal text-slate-400">{cards.length} cards</span>
            </h3>
            <button type="button" onClick={onTrack} className={OUTLINE_BUTTON}>
              Track this checklist
            </button>
          </div>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]">
            {cards.map((card) => {
              const owned = store.ownedCount(card.id);
              return (
                <li key={card.id} className="flex flex-col gap-1">
                  <CardFace card={card} size="fill" />
                  <span className="text-xs text-slate-200">
                    <span className="font-mono text-slate-400">#{card.cardNumber}</span> {playerNames(card)}
                    {card.variation && <span className="text-slate-400"> ({card.variation})</span>}
                  </span>
                  {owned > 0 && <span className="text-xs text-slate-400">You have {owned}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
