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
} from "../_shared/data";
import { FOCUS } from "./classes";
import { useP3 } from "./context";

/**
 * NEO-350 prototype 3 — "Find a card": type it the way you'd say it at the
 * table ("96 contenders reggie white"). Every match is listed; nothing is
 * picked for you. Add 1 drops a copy in; Details opens the drawer.
 */

const SHOW = 8;

export default function FindCard() {
  const api = useP3();
  const { store } = api;
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const q = query.trim();
  const hits = q.length >= 2 ? searchCards(q) : [];
  const exact = hits.filter((h) => h.matchedAll);
  const list = exact.length > 0 ? exact : hits;
  const visible = all ? list : list.slice(0, SHOW);

  return (
    <div className="mt-4">
      <Input
        label="Find a card"
        placeholder="96 contenders reggie white"
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAll(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          }
        }}
      />
      {q.length >= 2 && (
        <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950 p-2">
          <p role="status" className="px-2 py-1 text-sm text-slate-300">
            {list.length === 0
              ? `Nothing matches “${q}”. Try the year, set or last name.`
              : exact.length === 0
                ? `No exact match. ${list.length} close ones:`
                : `${list.length} ${list.length === 1 ? "card matches" : "cards match"}.`}
          </p>
          <ul className="flex flex-col">
            {visible.map(({ card }) => {
              const n = store.ownedCount(card.id);
              const set = getSet(card.setId);
              const row = card.variantPath.name ?? "Base";
              const short = `${setLabel(set)} ${row} #${card.cardNumber} ${playerNames(card)}`;
              return (
                <li
                  key={card.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-900 px-2 py-2 first:border-t-0"
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-9 min-w-9 shrink-0 place-items-center rounded-md px-1 text-xs font-bold tabular-nums ${
                      n > 0 ? "p3-lit bg-neon-blue text-black" : "border-[1.5px] border-dashed border-slate-500 text-slate-300"
                    }`}
                  >
                    {card.cardNumber}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-white">
                      {playerNames(card)}{" "}
                      <span className="font-normal" style={{ color: teamTextColor(leadTeam(card), "#020617") }}>
                        {teamNames(card)}
                      </span>
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {setLabel(set)}, {row}
                      {card.variation ? `, ${card.variation} variation` : ""}
                      {card.printRun ? `, /${card.printRun}` : ""}
                    </p>
                  </div>
                  <span className={`text-sm font-bold ${n > 0 ? "text-neon-blue" : "text-slate-300"}`}>
                    {n > 0 ? `Have ${n}` : "Need"}
                  </span>
                  <span className="flex gap-1.5">
                    <button
                      type="button"
                      aria-label={`Add 1: ${short}`}
                      onClick={() => api.addOne(card, "search")}
                      className={`min-h-11 rounded-md bg-neon-green px-3 text-sm font-bold text-black hover:bg-neon-green/85 sm:min-h-8 ${FOCUS}`}
                    >
                      Add 1
                    </button>
                    <button
                      type="button"
                      aria-label={`Details: ${short}`}
                      onClick={() => api.openCard(card)}
                      className={`min-h-11 rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-neon-blue sm:min-h-8 ${FOCUS}`}
                    >
                      Details
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {list.length > visible.length && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className={`m-1 min-h-11 rounded-md px-2 text-sm text-neon-blue underline-offset-4 hover:underline sm:min-h-8 ${FOCUS}`}
            >
              Show all {list.length}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
