import { FEATURE_BADGE } from "../../prototypes/p1/ui";
import type { Card } from "../data/types";

/**
 * RC, AU, RELIC, SP and #'d, as the admin checklist row shows them. Lives
 * here so the inventory's quantity rows and the collection's checklist rows
 * (`../CardRows`, which re-exports it) draw the same badges without the two
 * row modules importing each other.
 */
export function FeatureBadges({ card }: { card: Pick<Card, "features" | "printRun"> }) {
  const tokens = [...card.features, ...(card.printRun !== null ? (["NUM"] as const) : [])];
  if (tokens.length === 0) return null;
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {tokens.map((t) => (
        <span key={t} className={`rounded border px-1 py-0.5 text-xs ${FEATURE_BADGE[t].cls}`}>
          {FEATURE_BADGE[t].label}
        </span>
      ))}
    </span>
  );
}
