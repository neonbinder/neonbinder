import { useCallback, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import { getSet, searchCards, type Card } from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import Cascade from "./Cascade";
import Checklist from "./Checklist";
import ChecklistRow from "./ChecklistRow";
import { drillTo, terminalFilter, type Drill } from "./drill";
import type { Notify } from "./notice";
import { FOCUS } from "./ui";

const FIRST_PAGE = 8;

/**
 * Find Cards: a free-text shortcut on top ("96 contenders reggie white"),
 * then the admin cascade underneath for browsing a set the long way, then the
 * checklist. Every path ends at the same rows and the same detail drawer.
 */
export default function FindCards({
  store,
  notify,
  drill,
  cascadeKey,
  onDrill,
  onJump,
  selectedCardId,
  onOpen,
  onToggleHave,
}: {
  store: PrototypeStore;
  notify: Notify;
  drill: Drill;
  /** Bumps when the drill is set from outside the cascade, to rebuild it. */
  cascadeKey: number;
  onDrill: (next: Drill) => void;
  onJump: (next: Drill) => void;
  selectedCardId: string | null;
  onOpen: (card: Card, list: Card[]) => void;
  onToggleHave: (card: Card) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const hits = query.trim() ? searchCards(query) : [];
  const partial = hits.length > 0 && !hits[0].matchedAll;
  const shown = showAll ? hits : hits.slice(0, FIRST_PAGE);
  const hitCards = hits.map((h) => h.card);

  const checklistHeading = useRef<HTMLHeadingElement>(null);
  const focusChecklist = useCallback(() => {
    checklistHeading.current?.focus();
  }, []);

  const filter = terminalFilter(drill);

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Find cards</h2>
      <section aria-label="Quick search" className="space-y-3">
        <div role="search" className="relative max-w-2xl">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-[2.65rem] h-5 w-5 text-slate-400"
          />
          <Input
            surface="dark"
            type="search"
            label="Search every card"
            placeholder="Try “96 contenders reggie white”"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowAll(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            autoComplete="off"
            spellCheck={false}
            className="pl-10"
          />
        </div>
        <p role="status" className="text-xs text-slate-400">
          {!query.trim()
            ? ""
            : hits.length === 0
              ? `Nothing matches “${query.trim()}”. Try a year, a set or a last name.`
              : partial
                ? `No card matches every word. Here are the ${hits.length} closest.`
                : `${hits.length} ${hits.length === 1 ? "card matches" : "cards match"}. Pick yours.`}
        </p>
        {shown.length > 0 && (
          <>
            <ul className="space-y-1.5 rounded-lg bg-gray-800 p-3 sm:p-4">
              {shown.map(({ card }) => (
                <ChecklistRow
                  key={card.id}
                  card={card}
                  owned={store.ownedCount(card.id)}
                  isSelected={card.id === selectedCardId}
                  showSet
                  onToggleHave={() => onToggleHave(card)}
                  onOpen={() => onOpen(card, hitCards)}
                  onOpenChecklist={() => {
                    onJump(drillTo(getSet(card.setId), card.variantPath));
                    setQuery("");
                  }}
                />
              ))}
            </ul>
            {hits.length > FIRST_PAGE && !showAll && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className={`rounded px-2 py-1 text-sm text-neon-blue underline underline-offset-2 ${FOCUS}`}
              >
                Show all {hits.length} matches
              </button>
            )}
          </>
        )}
      </section>

      <section aria-label="Browse sets" className="space-y-4">
        <p className="text-sm text-slate-300">
          Or drill down: sport, year, brand, set, then base, an insert or a parallel.
        </p>
        <Cascade
          key={cascadeKey}
          drill={drill}
          onDrill={onDrill}
          completion={store.completion}
          label="Sport, year, brand and set"
          onReachedChecklist={focusChecklist}
        />
        {drill.set && filter && (
          <Checklist
            key={`${drill.set}|${filter.type}|${filter.name ?? ""}`}
            ref={checklistHeading}
            setId={drill.set}
            filter={filter}
            store={store}
            notify={notify}
            selectedCardId={selectedCardId}
            onOpen={onOpen}
            onToggleHave={onToggleHave}
          />
        )}
      </section>
    </div>
  );
}
