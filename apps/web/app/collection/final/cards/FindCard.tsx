import { useState } from "react";
import { Input } from "@/components/primitives/Input";
import {
  getSet,
  leadTeam,
  playerNames,
  searchCards,
  setLabel,
  teamNames,
  teamTextColor,
} from "../../prototypes/_shared/data";
import { FOCUS } from "../../prototypes/p3/classes";
import { useMyCards } from "./context";

/**
 * NEO-350 — "Find a card": type it the way you'd say it at the table ("96
 * contenders reggie white"). A few matches show right here, each one a jump
 * to its row in Checklists; Enter (or "See all") takes the whole search to
 * the Checklists tab. Nothing is picked for you. "Add 1" files a copy in the
 * target binder.
 */

const SHOW = 4;

export default function FindCard() {
  const api = useMyCards();
  const { store } = api;
  const [query, setQuery] = useState("");
  const q = query.trim();
  const hits = q.length >= 2 ? searchCards(q) : [];
  const exact = hits.filter((h) => h.matchedAll);
  const list = exact.length > 0 ? exact : hits;
  const visible = list.slice(0, SHOW);

  return (
    <div role="search" className="max-w-3xl">
      <Input
        label="Find a card"
        placeholder="96 contenders reggie white"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          } else if (e.key === "Enter" && q) {
            e.preventDefault();
            api.goToTab("checklists", { q });
          }
        }}
      />
      {q.length >= 2 && (
        <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950 p-2">
          <p role="status" className="px-2 py-1 text-sm text-slate-300">
            {list.length === 0
              ? `Nothing matches “${q}”. Try the year, set or last name.`
              : exact.length === 0
                ? `No exact match. ${list.length} close ones.`
                : `${list.length} ${list.length === 1 ? "card matches" : "cards match"}. Enter opens them all in Checklists.`}
          </p>
          <ul className="flex flex-col">
            {visible.map(({ card }) => {
              const n = store.ownedInScope(card.id);
              const set = getSet(card.setId);
              const row = card.variantPath.name ?? "Base";
              const variation = card.variation ? `, ${card.variation} variation` : "";
              const short = `${setLabel(set)} ${row} #${card.cardNumber} ${playerNames(card)}${variation}`;
              return (
                <li
                  key={card.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-900 px-2 py-2 first:border-t-0"
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-9 min-w-9 shrink-0 place-items-center rounded-md px-1 text-xs font-bold tabular-nums ${
                      n > 0
                        ? "mc-lit bg-neon-blue text-black"
                        : "border-[1.5px] border-dashed border-slate-500 text-slate-300"
                    }`}
                  >
                    {card.cardNumber}
                  </span>
                  <button
                    type="button"
                    aria-label={`Show ${short} in Checklists`}
                    onClick={() => api.goToTab("checklists", { cardId: card.id })}
                    className={`min-w-0 flex-1 rounded-md text-left hover:text-neon-blue ${FOCUS}`}
                  >
                    <span className="block truncate text-sm font-bold text-white">
                      {playerNames(card)}{" "}
                      <span className="font-normal" style={{ color: teamTextColor(leadTeam(card), "#020617") }}>
                        {teamNames(card)}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {setLabel(set)}, {row}
                      {variation}
                      {card.printRun ? `, /${card.printRun}` : ""}
                    </span>
                  </button>
                  <span className={`text-sm font-bold ${n > 0 ? "text-neon-blue" : "text-slate-300"}`}>
                    {n > 0 ? `Have ${n}` : "Need"}
                  </span>
                  <button
                    type="button"
                    aria-label={`Add 1: ${short}`}
                    onClick={() => api.addOne(card)}
                    className={`min-h-11 rounded-md bg-neon-green px-3 text-sm font-bold text-black hover:bg-neon-green/85 sm:min-h-8 ${FOCUS}`}
                  >
                    Add 1
                  </button>
                </li>
              );
            })}
          </ul>
          {list.length > 0 && (
            <button
              type="button"
              onClick={() => api.goToTab("checklists", { q })}
              className={`m-1 min-h-11 rounded-md px-2 text-sm text-neon-blue underline-offset-4 hover:underline sm:min-h-8 ${FOCUS}`}
            >
              {list.length > visible.length ? `See all ${list.length} in Checklists` : "Open in Checklists"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
