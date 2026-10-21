import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Autocomplete } from "@/components/primitives/Autocomplete";
import CardFace from "../_shared/CardFace";
import {
  getPlayer,
  getSport,
  getTeam,
  normalizeSearchText,
  players,
  teams,
  teamTextColor,
  type Card,
} from "../_shared/data";
import { useP5 } from "./context";
import { RibbonBar, TeamBar } from "./CareerRibbon";
import {
  countOwned,
  defaultTeamMode,
  isSchool,
  pcCards,
  pcKey,
  pcTitle,
  type PcRef,
} from "./model";

interface FollowOption {
  ref: PcRef;
  label: string;
  description: string;
}

const ALL_OPTIONS: FollowOption[] = [
  ...players.map((p) => ({
    ref: { kind: "player", id: p.id } as PcRef,
    label: p.name,
    description: `${getSport(p.sport).name} player`,
  })),
  ...teams.map((t) => ({
    ref: { kind: "team", id: t.id } as PcRef,
    label: `${t.location} ${t.name}`,
    description: isSchool(t)
      ? "School, everyone who played there"
      : `${t.league} team`,
  })),
];

export default function PcLanding() {
  const { followed, isFollowed, follow, store, owned } = useP5();
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = normalizeSearchText(query);
    if (!q) return [];
    const words = q.split(/\s+/);
    return ALL_OPTIONS.filter((o) => {
      const hay = normalizeSearchText(`${o.label} ${o.description}`);
      return words.every((w) => hay.includes(w));
    })
      .sort((a, b) => Number(isFollowed(a.ref)) - Number(isFollowed(b.ref)))
      .slice(0, 8);
  }, [query, isFollowed]);

  return (
    <div>
      <p className="max-w-prose text-slate-300">
        Your PCs start with a person, not a set. Pick a player, a team or a
        school and every card they are on shows up, have or need.
      </p>

      <div className="mt-5 max-w-xl">
        {/* The combobox's own name is the same words; this is the visible
            half of it. */}
        <p aria-hidden="true" className="mb-1.5 text-sm font-medium text-slate-300">
          Follow a player, team or school
        </p>
        <Autocomplete<FollowOption>
          label="Follow a player, team or school"
          placeholder="Try Paul Skenes, Packers or Michigan"
          query={query}
          onQueryChange={setQuery}
          items={matches}
          getKey={(o) => pcKey(o.ref)}
          getLabel={(o) => o.label}
          getDescription={(o) =>
            isFollowed(o.ref) ? `${o.description}, already a PC` : o.description
          }
          emptyMessage="Nobody by that name in the catalog yet."
          onSelect={(o) => {
            follow(o.ref);
            setQuery("");
          }}
        />
      </div>

      <ul aria-label="My PCs" className="mt-8 grid gap-5 sm:grid-cols-2">
        {followed.map((ref) => (
          <li key={pcKey(ref)}>
            <PcTile pcRef={ref} owned={owned} ownedCount={store.ownedCount} />
          </li>
        ))}
      </ul>
      {followed.length === 0 && (
        <p className="mt-8 rounded-lg border border-dashed border-slate-600 p-6 text-slate-300">
          No PCs yet. Follow your guy up there and the cards line up behind him.
        </p>
      )}
    </div>
  );
}

function PcTile({
  pcRef,
  owned,
  ownedCount,
}: {
  pcRef: PcRef;
  owned: Set<string>;
  ownedCount: (id: string) => number;
}) {
  const team = pcRef.kind === "team" ? getTeam(pcRef.id) : null;
  const player = pcRef.kind === "player" ? getPlayer(pcRef.id) : null;
  const mode = team ? defaultTeamMode(team) : "onCard";
  const list = pcCards(pcRef, mode);
  const have = countOwned(list, owned);
  const pct = list.length ? Math.round((have / list.length) * 100) : 0;
  // The fan: the three priciest-looking cards they own (numbered first).
  const fan: Card[] = list
    .filter((c) => ownedCount(c.id) > 0)
    .sort((a, b) => (a.printRun ?? 9999) - (b.printRun ?? 9999))
    .slice(0, 3);

  const kind = player
    ? `${getSport(player.sport).name}`
    : team && isSchool(team)
      ? "School, played for"
      : "Team, on the card";
  const nameColor = team ? teamTextColor(team) : "#FFFFFF";

  return (
    <Link
      to={`?pc=${pcKey(pcRef)}`}
      className="relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 transition-colors hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
    >
      {player ? (
        <RibbonBar player={player} height="h-3" />
      ) : (
        team && <TeamBar team={team} height="h-3" />
      )}
      <div className="flex flex-1 items-stretch gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs font-medium text-slate-400">{kind}</span>
          <span
            className="mt-1 text-2xl font-bold leading-tight"
            style={{ color: nameColor }}
          >
            {pcTitle(pcRef)}
          </span>
          <span className="mt-auto pt-4">
            <span className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold tabular-nums text-white">
                {have}
              </span>
              <span className="text-sm text-slate-300">
                of {list.length} cards
              </span>
            </span>
            <span
              aria-hidden="true"
              className="mt-2 block h-1.5 w-full rounded-full bg-slate-800"
            >
              <span
                className="block h-full rounded-full bg-neon-blue"
                style={{ width: `${pct}%` }}
              />
            </span>
          </span>
        </div>
        <span
          aria-hidden="true"
          className="relative w-24 shrink-0 sm:w-28"
        >
          {fan.length === 0 ? (
            <span className="absolute inset-y-2 right-2 flex w-20 items-center justify-center rounded-md border-2 border-dashed border-slate-600 text-center text-xs text-slate-400">
              First one's out there
            </span>
          ) : (
            fan.map((card, i) => (
              <span
                key={card.id}
                className="absolute top-1"
                style={{
                  right: `${i * 14}px`,
                  transform: `rotate(${(i - (fan.length - 1) / 2) * -7}deg)`,
                  zIndex: 3 - i,
                }}
              >
                <CardFace card={card} size="sm" label="" />
              </span>
            ))
          )}
        </span>
      </div>
    </Link>
  );
}
