import { forwardRef, useState } from "react";
import { FOCUS } from "../../prototypes/p1/ui";
import BinderPicker from "../BinderPicker";
import { SearchHitRow, type RowActions } from "../CardRows";
import ChipGroup from "../ChipGroup";
import type { EntityParam } from "../checklistParams";
import { useEntityCards, useReadOnlyAll } from "../data/store";
import type { Card } from "../data/types";
import { cardsCount } from "./format";
import { SkeletonBars } from "./Skeleton";

const FIRST_PAGE = 25;

/**
 * NEO-358 — a picked player's or team's cards: every card the player is on,
 * or every card the team is printed on (just this team by default; its whole
 * franchise when the collector asks and the team has one), in catalog order.
 * Each row has Have and Details, and opens its own checklist.
 *
 * The heading takes the keyboard when the collector picked the suggestion
 * (the ref, `tabIndex={-1}`); the count line is one live region, mounted
 * from the start, whose words change as the cards land.
 */
const EntityResults = forwardRef<
  HTMLHeadingElement,
  {
    entity: EntityParam;
    actions: RowActions;
    selectedCardId: string | null;
    onJump: (card: Card) => void;
    /** Take in the whole franchise, or go back to just this team. */
    onFranchise: (whole: boolean) => void;
    onClear: () => void;
  }
>(function EntityResults({ entity, actions, selectedCardId, onJump, onFranchise, onClear }, headingRef) {
  const readOnly = useReadOnlyAll();
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
        <h3 ref={headingRef} tabIndex={-1} className="rounded-sm text-lg font-semibold text-ink focus-outline">
          {heading}
        </h3>
        <button
          type="button"
          onClick={onClear}
          className={`rounded-sm text-sm text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
        >
          Back to the search
        </button>
      </div>
      {entity.kind === "team" && entity.franchiseId && (
        <ChipGroup
          label="Which teams"
          value={entity.wholeFranchise ? "whole" : "team"}
          options={[
            { value: "team", label: "Just this team" },
            { value: "whole", label: "Include the whole franchise" },
          ]}
          onChange={(v) => onFranchise(v === "whole")}
          className="flex flex-wrap items-center gap-2"
        />
      )}
      {/* NEO-374 — under All the cards' Have is locked: the picker says why and unlocks it. */}
      {readOnly && <BinderPicker />}
      <p role="status" className={cards ? "text-xs text-ink-3" : "sr-only"}>
        {!cards
          ? "Pulling the cards…"
          : cards.length === 0
            ? "No cards in the catalog yet."
            : result?.truncated
              ? `The first ${cardsCount(cards.length)}. Add a word to the search to narrow it down.`
              : cardsCount(cards.length)}
      </p>
      {!cards ? (
        <div aria-busy="true">
          <SkeletonBars rows={5} />
        </div>
      ) : (
        <>
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
});

export default EntityResults;

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
