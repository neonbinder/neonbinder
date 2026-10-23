import { useState } from "react";
import { FOCUS } from "../../prototypes/p1/ui";
import Chip from "../../prototypes/p3/Chip";
import { SearchHitRow, type RowActions } from "../CardRows";
import type { EntityParam } from "../checklistParams";
import { useEntityCards } from "../data/store";
import type { Card } from "../data/types";
import { cardsCount } from "./format";
import { LoadingNote, SkeletonBars } from "./Skeleton";

const FIRST_PAGE = 25;

/**
 * NEO-358 — a picked player's or team's cards: every card the player is on,
 * or every card the team is printed on (just this team by default; its whole
 * franchise when the collector asks and the team has one), in catalog order.
 * Each row has Have and Details, and opens its own checklist.
 */
export default function EntityResults({
  entity,
  actions,
  selectedCardId,
  onJump,
  onFranchise,
  onClear,
}: {
  entity: EntityParam;
  actions: RowActions;
  selectedCardId: string | null;
  onJump: (card: Card) => void;
  /** Take in the whole franchise, or go back to just this team. */
  onFranchise: (whole: boolean) => void;
  onClear: () => void;
}) {
  const result = useEntityCards(
    entity.kind === "player"
      ? { kind: "player", id: entity.id }
      : { kind: "team", id: entity.id, wholeFranchise: entity.wholeFranchise },
  );
  const [showAll, setShowAll] = useState(false);
  const cards = result?.cards;
  const name = cards ? nameIn(entity, cards) : null;
  const heading =
    entity.kind === "player"
      ? name
        ? `Every ${name} card`
        : "Every card of this player"
      : name
        ? `Every ${name} card`
        : "Every card of this team";
  const shown = cards ? (showAll ? cards : cards.slice(0, FIRST_PAGE)) : [];

  return (
    <section aria-label={heading} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-ink">{heading}</h3>
        <button
          type="button"
          onClick={onClear}
          className={`rounded-sm text-sm text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
        >
          Back to the search
        </button>
      </div>
      {entity.kind === "team" && entity.franchiseId && (
        <div role="group" aria-label="Which teams" className="flex flex-wrap items-center gap-2">
          <Chip pressed={!entity.wholeFranchise} onClick={() => onFranchise(false)}>
            Just this team
          </Chip>
          <Chip pressed={entity.wholeFranchise} onClick={() => onFranchise(true)}>
            Include the whole franchise
          </Chip>
        </div>
      )}
      {!cards ? (
        <div aria-busy="true">
          <SkeletonBars rows={5} />
          <LoadingNote>Pulling the cards…</LoadingNote>
        </div>
      ) : (
        <>
          <p role="status" className="text-xs text-ink-3">
            {cards.length === 0
              ? "No cards in the catalog yet."
              : result.truncated
                ? `The first ${cardsCount(cards.length)}. Add a word to the search to narrow it down.`
                : cardsCount(cards.length)}
          </p>
          {shown.length > 0 && (
            <ul className="space-y-1.5 rounded-lg bg-raised p-3 shadow-offset sm:p-4">
              {shown.map((card) => (
                <SearchHitRow
                  key={card.id}
                  card={card}
                  actions={{ ...actions, open: (c, copyId) => actions.open(c, copyId, cards) }}
                  isSelected={card.id === selectedCardId}
                  showSet
                  onRowClick={() => onJump(card)}
                  onOpenChecklist={() => onJump(card)}
                />
              ))}
            </ul>
          )}
          {cards.length > shown.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={`rounded px-2 py-1 text-sm text-neon-blue-text underline underline-offset-2 ${FOCUS}`}
            >
              Show all {cards.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** The picked player's or team's name, as the cards print it. */
function nameIn(entity: EntityParam, cards: Card[]): string | null {
  for (const card of cards) {
    if (entity.kind === "player") {
      const p = card.players.find((x) => x.id === entity.id);
      if (p) return p.name;
    } else {
      const t = card.teams.find((x) => x.id === entity.id);
      if (t) return t.location ? `${t.location} ${t.name}` : t.name;
    }
  }
  return null;
}
