import { CheckIcon } from "@heroicons/react/20/solid";
import { cardLabel, getTeam, playerNames, teamNames, type Card } from "../_shared/data";
import {
  FEATURE_BADGE,
  FOCUS,
  QUIET_BUTTON,
  liveryOn,
  useLiverySurface,
  printRunText,
  setAndVariant,
  shortCardName,
} from "./ui";

/**
 * The Have toggle. A real toggle (aria-pressed) whose name never changes:
 * pressed reads as a filled neon box with a check, unpressed as an empty
 * outlined box, and the word "Have" is on it either way, so have/need never
 * rests on colour. The count of copies sits beside it as its own text.
 */
export function HaveToggle({
  owned,
  name,
  onToggle,
}: {
  owned: number;
  /** "#4 Reggie White": the toggle's name is "Have #4 Reggie White". */
  name: string;
  onToggle: () => void;
}) {
  const have = owned > 0;
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        aria-pressed={have}
        aria-label={`Have ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold transition-colors ${FOCUS} ${
          have
            ? "border-selection bg-neon-blue text-on-neon-blue"
            : "border-control text-ink-2 hover:border-neon-blue hover:text-neon-blue-text"
        }`}
      >
        <span
          aria-hidden="true"
          className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
            have ? "border-on-neon-blue bg-on-neon-blue text-neon-blue" : "border-current"
          }`}
        >
          {have && <CheckIcon className="h-3.5 w-3.5" />}
        </span>
        Have
      </button>
      <span className="w-7 text-xs tabular-nums text-ink-2">{owned > 1 ? `×${owned}` : ""}</span>
    </span>
  );
}

export function FeatureBadges({ card }: { card: Card }) {
  const tokens = [...card.features, ...(card.printRun !== null ? (["NUM"] as const) : [])];
  if (tokens.length === 0) return null;
  return (
    <span className="flex gap-1 shrink-0 flex-wrap justify-end">
      {tokens.map((t) => (
        <span key={t} className={`text-xs px-1 py-0.5 rounded border ${FEATURE_BADGE[t].cls}`}>
          {FEATURE_BADGE[t].label}
        </span>
      ))}
    </span>
  );
}

/**
 * CardChecklistItem, collector edition: the same row (mono number, name over
 * a muted subline, feature badges, quiet actions on the right), with the
 * admin's Edit/Del swapped for Have and Details. The whole row opens the
 * detail drawer; Details is the keyboard opener, as Edit is in the admin.
 */
export default function ChecklistRow({
  card,
  owned,
  isSelected,
  onToggleHave,
  onOpen,
  showSet = false,
  onOpenChecklist,
}: {
  card: Card;
  owned: number;
  isSelected?: boolean;
  onToggleHave: () => void;
  onOpen: () => void;
  /** Search results span sets: show which set and variant on the subline. */
  showSet?: boolean;
  onOpenChecklist?: () => void;
}) {
  const panel = useLiverySurface("raised");
  // Search results span sets, so their controls carry the full label; inside
  // one checklist the number, player and variation already tell rows apart.
  const name = showSet ? cardLabel(card) : shortCardName(card);
  const team = getTeam(card.teamIds[0]);
  const run = printRunText(card);
  const sub: string[] = [];
  if (showSet) sub.push(setAndVariant(card));
  if (run) sub.push(run);
  if (card.variation) sub.push(`${card.variation} variation`);
  return (
    <li
      onClick={onOpen}
      className={`flex items-center gap-x-2 gap-y-1 sm:gap-3 max-sm:flex-wrap max-sm:justify-end p-2.5 border rounded-md border-rule-strong hover:bg-list-hover-raised cursor-pointer ${
        card.variation ? "ml-8 border-l-2 border-l-control" : ""
      } ${isSelected ? "ring-2 ring-selection border-selection bg-pick-blue/10" : ""}`}
    >
      <span className="text-sm font-mono text-ink-3 w-12 text-right shrink-0">
        #{card.cardNumber}
      </span>
      <div className="flex-1 min-w-0 max-sm:basis-[calc(100%-4rem)]">
        <div className="text-sm font-medium text-ink truncate">
          {playerNames(card)}
        </div>
        <div className="text-xs text-ink-3 truncate min-h-[1rem]">
          <span style={{ color: liveryOn(card, panel) }} title={`${team.location} ${team.name}`}>
            {teamNames(card)}
          </span>
          {sub.length > 0 && <span> · {sub.join(" · ")}</span>}
        </div>
      </div>
      <FeatureBadges card={card} />
      <HaveToggle owned={owned} name={name} onToggle={onToggleHave} />
      <span className="flex gap-1 shrink-0">
        {onOpenChecklist && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChecklist();
            }}
            aria-label={`Open the checklist for ${cardLabel(card)}`}
            className={QUIET_BUTTON}
          >
            Checklist
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={`Details for ${name}`}
          className={QUIET_BUTTON}
        >
          Details
        </button>
      </span>
    </li>
  );
}
