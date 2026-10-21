import { useCallback, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Input } from "@/components/primitives/Input";
import { getSet, searchCards, type Card, type CardId } from "../prototypes/_shared/data";
import Cascade from "../prototypes/p1/Cascade";
import { drillTo, terminalFilter, type Drill } from "../prototypes/p1/drill";
import { FOCUS } from "../prototypes/p1/ui";
import CardRowGroup, { type RowActions } from "./CardRows";
import Checklist from "./Checklist";
import { useSetScope } from "./mode";
import RequestCardDialog from "./RequestCardDialog";
import type { CollectionTabProps } from "./store";

const FIRST_PAGE = 8;

/**
 * Checklists: a free-text search on top ("96 contenders reggie white"), the
 * Set Builder's cascade underneath for browsing the long way, then the
 * checklist. A search result's click opens its checklist with the row ringed;
 * Have on any row adds straight to the "Adding to" binder.
 */
export default function ChecklistsTab({
  store,
  notify,
  actions,
  query,
  onQuery,
  drill,
  cascadeKey,
  onDrill,
  onJump,
  highlightCardId,
  selectedCardId,
}: CollectionTabProps & {
  actions: RowActions;
  query: string;
  onQuery: (q: string) => void;
  drill: Drill;
  /** Bumps when the drill is set from outside the cascade, to rebuild it. */
  cascadeKey: number;
  onDrill: (next: Drill) => void;
  /** Open a card's checklist and ring its row. */
  onJump: (card: Card) => void;
  highlightCardId: CardId | null;
  selectedCardId: CardId | null;
}) {
  const setScope = useSetScope();
  const [showAll, setShowAll] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const hits = query.trim() ? searchCards(query) : [];
  const partial = hits.length > 0 && !hits[0].matchedAll;
  const shown = showAll ? hits : hits.slice(0, FIRST_PAGE);
  const hitCards = hits.map((h) => h.card);

  const checklistHeading = useRef<HTMLHeadingElement>(null);
  const focusChecklist = useCallback(() => {
    checklistHeading.current?.focus();
  }, []);

  const filter = terminalFilter(drill);
  const scoped = store.fileableBinders.find((b) => b.id === store.selectedBinderId);
  const askLink = (text: string) => (
    <button
      type="button"
      onClick={() => setRequesting(true)}
      className={`rounded-sm text-neon-blue underline underline-offset-2 hover:text-white ${FOCUS}`}
    >
      {text}
    </button>
  );

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Checklists</h2>
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
              onQuery(e.target.value);
              setShowAll(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                onQuery("");
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
        {query.trim() && hits.length === 0 ? (
          <div className="max-w-2xl rounded-lg border border-dashed border-neon-blue/50 bg-gray-800 p-4 text-sm text-slate-200">
            <p className="font-semibold text-slate-100">Not in the binder yet.</p>
            <p className="mt-1 text-slate-300">
              {askLink("Ask us to add it")} and an admin will check it out. Only you see it until it&apos;s in.
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-400">{askLink("Can't find it? Ask us to add it")}</p>
        )}
        {shown.length > 0 && (
          <>
            {scoped && (
              <p className="text-xs text-slate-300">
                Have, Want and Trade below are for <span className="text-neon-blue">{scoped.name}</span>.{" "}
                <button
                  type="button"
                  onClick={() => setScope("all")}
                  className={`rounded-sm text-neon-blue underline underline-offset-2 hover:text-white ${FOCUS}`}
                >
                  Show all binders
                </button>
              </p>
            )}
            <ul className="space-y-1.5 rounded-lg bg-gray-800 p-3 sm:p-4">
              {shown.map(({ card }) => (
                <CardRowGroup
                  key={card.id}
                  card={card}
                  store={store}
                  actions={{ ...actions, open: (c, copyId) => actions.open(c, copyId, hitCards) }}
                  isSelected={card.id === selectedCardId}
                  showSet
                  onRowClick={() => onJump(card)}
                  onOpenChecklist={() => onJump(card)}
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
          completion={store.completionInScope}
          label="Sport, year, brand and set"
          onReachedChecklist={focusChecklist}
        />
        {drill.set && filter && (
          <Checklist
            key={`${drill.set}|${filter.type}|${filter.name ?? ""}|${cascadeKey}`}
            ref={checklistHeading}
            setId={drill.set}
            filter={filter}
            store={store}
            actions={actions}
            notify={notify}
            selectedCardId={selectedCardId}
            highlightCardId={highlightCardId}
          />
        )}
      </section>

      {requesting && (
        <RequestCardDialog store={store} searched={query} onClose={() => setRequesting(false)} />
      )}
    </div>
  );
}

/** The drill that opens a card's own checklist. */
export function drillToCard(card: Card): Drill {
  return drillTo(getSet(card.setId), card.variantPath);
}
