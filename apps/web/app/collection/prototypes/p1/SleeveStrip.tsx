import type { Card } from "../_shared/data";

/**
 * A set's progress as a row of sleeves, one per card, in checklist order:
 * filled neon for a card you have, an empty outlined pocket for one you need.
 * The run ledger's sleeve strip (ParallelBuildPanel), pointed at a binder.
 * Decorative: the "Have 12 of 51" beside it is the readable version.
 */
export default function SleeveStrip({
  cards,
  ownedIds,
}: {
  cards: Card[];
  ownedIds: Set<string>;
}) {
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-1">
      {cards.map((c) => (
        <span
          key={c.id}
          className={`h-3.5 w-2.5 rounded-[2px] border ${
            ownedIds.has(c.id) ? "border-neon-blue bg-neon-blue" : "border-control bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}
