import { useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { FOCUS } from "../../prototypes/p3/classes";
import { useLiverySurface } from "../../prototypes/p1/ui";
import { useSearchText } from "../catalog/search";
import { SkeletonBars } from "../catalog/Skeleton";
import Suggestions from "../catalog/Suggestions";
import { playerNames, printRunLabel, setLabel, teamNames, teamTextColor, variantLabel } from "../data/labels";
import { collectionCopiesIn, searchable, useCopiesOf, useReadOnlyAll, useScope, useSearch } from "../data/store";
import type { Card } from "../data/types";
import { useMyCards } from "./context";

/**
 * NEO-350 / NEO-358 — "Find a card": type it the way you'd say it at the
 * table ("96 contenders reggie white"). Players, teams and sets that match
 * come first (picking one takes you to their cards in Checklists); then a
 * few cards whose title holds every word, each a jump to its row in
 * Checklists. Enter (or "See all") takes the whole search to Checklists.
 * Nothing is picked for you. "Add 1" puts a copy in your collection.
 */

const SHOW = 4;

export default function FindCard() {
  const api = useMyCards();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const text = useSearchText(query);
  const result = useSearch(text);
  const hits = result?.cards ?? [];
  const visible = hits.slice(0, SHOW);
  const settled = result !== undefined && text === typed;
  const searching = searchable(typed);

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
          } else if (e.key === "Enter" && typed) {
            e.preventDefault();
            api.goToChecklists({ q: typed });
          }
        }}
      />
      {/* One live status for the whole search, always mounted (a region
          inserted with words in it says nothing): the suggestions and the
          skeleton below stay quiet and let it speak. */}
      <div className={searching ? "mt-2 space-y-2 rounded-xl border border-rule bg-sheet p-2 shadow-offset" : undefined}>
        {searching && (
          <div className="px-2 pt-1">
            <Suggestions text={text} onPick={api.openSuggestion} silent />
          </div>
        )}
        <p role="status" className={searching ? "px-2 py-1 text-sm text-ink-2" : "sr-only"}>
          {!searching
            ? ""
            : !settled
              ? "Flipping through the catalog…"
              : hits.length === 0
                ? `No card matches “${typed}”. It isn't in the catalog yet.`
                : result?.truncated
                  ? `Lots of matches. Enter opens them in Checklists.`
                  : `${hits.length} ${hits.length === 1 ? "card matches" : "cards match"}. Enter opens them all in Checklists.`}
        </p>
        {searching && (
          <>
            {!settled && result === undefined && (
              <div className="px-2">
                <SkeletonBars rows={2} />
              </div>
            )}
            {visible.length > 0 && (
              <ul className="flex flex-col">
                {visible.map((card) => (
                  <Hit key={card.id} card={card} />
                ))}
              </ul>
            )}
            {settled && hits.length > 0 && (
              <button
                type="button"
                onClick={() => api.goToChecklists({ q: typed })}
                className={`m-1 min-h-11 rounded-md px-2 text-sm text-neon-blue-text underline-offset-4 hover:underline sm:min-h-8 ${FOCUS}`}
              >
                {hits.length > visible.length ? `See all ${result?.truncated ? "" : `${hits.length} `}in Checklists` : "Open in Checklists"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Hit({ card }: { card: Card }) {
  const api = useMyCards();
  const sheet = useLiverySurface("sheet");
  const all = useCopiesOf(card.id);
  const scope = useScope();
  const readOnly = useReadOnlyAll();
  // The collection's copies only (never one in a box), narrowed by the page's scope, as everywhere on the tab.
  const copies = collectionCopiesIn(all, scope);
  const n = (copies ?? []).reduce((sum, c) => sum + c.quantity, 0);
  const row = variantLabel(card.variant);
  const variation = card.cardVariation ? `, ${card.cardVariation} variation` : "";
  const players = playerNames(card);
  const short = `${setLabel(card.set)} ${row} #${card.cardNumber}${players ? ` ${players}` : ""}${variation}`;
  const run = printRunLabel(card);
  const team = card.teams[0];
  // The name starts with the words on the button (label in name), then the
  // number, which tells two of one player's cards apart, then what it does.
  const shown = `${players || "Player unknown"}${team ? ` ${teamNames(card)}` : ""}, ${setLabel(card.set)}, ${row}${variation}${
    run ? `, ${run}` : ""
  }`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule px-2 py-2 first:border-t-0">
      <span
        aria-hidden="true"
        className={`grid h-9 min-w-9 shrink-0 place-items-center rounded-md px-1 text-xs font-bold tabular-nums ${
          n > 0 ? "mc-lit bg-neon-blue text-on-neon-blue" : "border-[1.5px] border-dashed border-control text-ink-2"
        }`}
      >
        {card.cardNumber}
      </span>
      <button
        type="button"
        aria-label={`${shown}, #${card.cardNumber}. Show it in Checklists`}
        onClick={() => api.goToChecklists({ card })}
        className={`min-w-0 flex-1 rounded-md text-left hover:text-neon-blue-text ${FOCUS}`}
      >
        <span className="block truncate text-sm font-bold text-ink">
          {players || "Player unknown"}{" "}
          {team && (
            <span className="font-normal" style={{ color: teamTextColor(team, sheet) }}>
              {teamNames(card)}
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-ink-3">
          {setLabel(card.set)}, {row}
          {variation}
          {run ? `, ${run}` : ""}
        </span>
      </button>
      <span className={`text-sm font-bold ${n > 0 ? "text-neon-blue-text" : "text-ink-2"}`}>
        {copies === undefined ? "…" : n > 0 ? `Have ${n}` : "Need"}
      </span>
      <NeonButton
        type="button"
        aria-label={`Add 1: ${short}`}
        // NEO-374 — All is a view: pick a binder (the note under the picker says so).
        disabled={copies === undefined || readOnly}
        onClick={() => api.addOne(card, n)}
        className="min-h-11 sm:min-h-8"
      >
        Add 1
      </NeonButton>
    </li>
  );
}
