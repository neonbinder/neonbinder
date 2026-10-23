import { RectangleStackIcon, ShieldCheckIcon, UserIcon } from "@heroicons/react/20/solid";
import { FOCUS } from "../../prototypes/p1/ui";
import { searchable, useSuggestions } from "../data/store";
import type { Suggestion } from "../data/types";
import { LoadingNote } from "./Skeleton";

/**
 * NEO-358 — what the search box offers before any card: the players (by name
 * or nickname: "Doc Gooden" offers Dwight Gooden), the teams printed on
 * cards, and the sets that match what was typed. Picking a player or a team
 * lists their cards; picking a set opens its checklist.
 *
 * One row of chips per kind, each named for what it does, so a reader hears
 * "Every Dwight Gooden card, as Doc Gooden" rather than a bare name.
 */

const KIND = {
  player: { heading: "Players", icon: UserIcon, tone: "text-pick-pink-ink bg-pick-pink border-pick-pink-rule" },
  team: { heading: "Teams", icon: ShieldCheckIcon, tone: "text-pick-green-ink bg-pick-green border-pick-green-rule" },
  set: { heading: "Sets", icon: RectangleStackIcon, tone: "text-pick-purple-ink bg-pick-purple border-pick-purple-rule" },
} as const;

/** What a suggestion's control is called: what pressing it does. */
export function suggestionLabel(s: Suggestion): string {
  if (s.kind === "player") return `Every ${s.name} card${s.matchedAlias ? `, as ${s.matchedAlias}` : ""}`;
  if (s.kind === "team") return `Every ${teamName(s)} card`;
  return `Open the ${s.label} checklist`;
}

function teamName(s: Extract<Suggestion, { kind: "team" }>): string {
  return s.location ? `${s.location} ${s.name}` : s.name;
}

function line(s: Suggestion): { main: string; sub: string | null } {
  if (s.kind === "player") return { main: s.name, sub: s.matchedAlias ? `as ${s.matchedAlias}` : (s.sport ?? null) };
  if (s.kind === "team") return { main: teamName(s), sub: s.franchise ? s.franchise.name : null };
  return { main: s.label, sub: s.sport };
}

export default function Suggestions({
  text,
  onPick,
  only,
  silent = false,
}: {
  /** Already paused on (`useSearchText`). */
  text: string;
  onPick: (s: Suggestion) => void;
  /** Offer one kind only (the set picker offers sets). */
  only?: Suggestion["kind"];
  /** The host search has its own status line: say nothing while loading, so it speaks once. */
  silent?: boolean;
}) {
  const all = useSuggestions(text);
  if (!searchable(text)) return null;
  if (all === undefined) {
    return (
      <div aria-busy="true" className="flex flex-wrap gap-2">
        {[7, 10, 6].map((w) => (
          <span key={w} aria-hidden="true" className="h-9 rounded-full bg-rule motion-safe:animate-pulse" style={{ width: `${w}rem` }} />
        ))}
        <LoadingNote silent={silent}>Looking for players, teams and sets…</LoadingNote>
      </div>
    );
  }
  const list = only ? all.filter((s) => s.kind === only) : all;
  if (list.length === 0) return null;

  const groups = (["player", "team", "set"] as const)
    .map((kind) => ({ kind, items: list.filter((s) => s.kind === kind) }))
    .filter((g) => g.items.length > 0);

  return (
    <section aria-label="Suggestions" className="space-y-2">
      {groups.map(({ kind, items }) => {
        const { heading, icon: Icon, tone } = KIND[kind];
        return (
          <div key={kind} className="flex flex-wrap items-center gap-2">
            <h3 className="w-14 shrink-0 text-xs font-semibold text-ink-3">{heading}</h3>
            <ul className="flex min-w-0 flex-1 flex-wrap gap-2">
              {items.map((s) => {
                const { main, sub } = line(s);
                return (
                  <li key={`${s.kind}-${s.id}`}>
                    <button
                      type="button"
                      aria-label={suggestionLabel(s)}
                      onClick={() => onPick(s)}
                      className={`inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-control bg-sheet py-1 pl-1 pr-3 text-left text-sm text-ink hover:border-neon-blue sm:min-h-9 ${FOCUS}`}
                    >
                      <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-full border ${tone}`}>
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 truncate font-medium">{main}</span>
                      {sub && <span className="shrink-0 text-xs text-ink-3">{sub}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
