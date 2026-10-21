import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeftIcon, CheckIcon, StarIcon } from "@heroicons/react/24/solid";
import {
  getPlayer,
  getSport,
  getTeam,
  playerNames,
  printRunLabel,
  setLabel,
  getSet,
  teamTextColor,
  type Card,
  type TeamId,
} from "../_shared/data";
import { useP5 } from "./context";
import CardStrip from "./CardStrip";
import CardTile from "./CardTile";
import { CareerList, RibbonBar, TeamBar } from "./CareerRibbon";
import {
  careerOrder,
  countOwned,
  defaultTeamMode,
  groupByYear,
  isSchool,
  pcBinderName,
  pcCards,
  pcRule,
  sameRule,
  stintEnd,
  teamsInYear,
  type PcRef,
  type TeamMode,
} from "./model";

type Show = "all" | "have" | "need";

const PILL =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8";
const PILL_OFF =
  "border-slate-600 text-slate-200 hover:border-slate-400 hover:text-white";
const PILL_ON = "border-neon-blue bg-neon-blue text-black";

function Pill({
  pressed,
  onClick,
  children,
  style,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`${PILL} ${pressed ? PILL_ON : PILL_OFF}`}
      style={pressed ? undefined : style}
    >
      {pressed && <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export default function PcPage({
  pcRef,
  initialMode,
  headingRef,
}: {
  pcRef: PcRef;
  /** From the URL (a binder's "Open as PC"); else the team's default. */
  initialMode?: TeamMode;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  const p5 = useP5();
  const { store, owned } = p5;
  const team = pcRef.kind === "team" ? getTeam(pcRef.id) : null;
  const player = pcRef.kind === "player" ? getPlayer(pcRef.id) : null;

  const [mode, setMode] = useState<TeamMode>(
    initialMode ?? (team ? defaultTeamMode(team) : "onCard"),
  );
  const [show, setShow] = useState<Show>("all");
  const [teamOnCard, setTeamOnCard] = useState<TeamId | null>(null);
  const [numbered, setNumbered] = useState(false);
  const [rc, setRc] = useState(false);
  const [au, setAu] = useState(false);

  const all = pcCards(pcRef, mode);
  const have = countOwned(all, owned);

  const shown = all.filter((c) => {
    const isOwned = owned.has(c.id);
    if (show === "have" && !isOwned) return false;
    if (show === "need" && isOwned) return false;
    if (teamOnCard && !c.teamIds.includes(teamOnCard)) return false;
    if (numbered && c.printRun === null) return false;
    if (rc && !c.features.includes("RC")) return false;
    if (au && !c.features.includes("AU")) return false;
    return true;
  });
  const years = groupByYear(shown);

  const rule = pcRule(pcRef, mode);
  const savedAs = store.state.binders.find(
    (b) => b.kind === "smart" && sameRule(b.rule, rule),
  );
  const followed = p5.isFollowed(pcRef);

  function saveAsBinder() {
    const name = pcBinderName(pcRef, mode);
    store.createBinder({
      kind: "smart",
      name,
      description: "Saved from a PC. Fills itself as the catalog grows.",
      rule,
    });
    p5.announce(`Saved "${name}" to your binders.`);
  }

  return (
    <div>
      <Link
        to="?view=pcs"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm text-slate-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
      >
        <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
        My PCs
      </Link>

      {/* Hero */}
      <section
        aria-labelledby="p5-heading"
        className="mt-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-950"
      >
        {player ? (
          <RibbonBar player={player} height="h-5" />
        ) : (
          team && <TeamBar team={team} height="h-5" />
        )}
        <div className="flex flex-col gap-5 p-5 sm:p-6 md:flex-row md:items-end">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-slate-400">
              {player
                ? `${getSport(player.sport).name}`
                : team && (isSchool(team) ? "School" : `${team.league} team`)}
              {team && `, ${team.location}`}
            </p>
            <h1
              id="p5-heading"
              ref={headingRef}
              tabIndex={-1}
              className="mt-1 text-4xl leading-none text-white focus:outline-none sm:text-5xl"
              style={{
                fontFamily: "'Neon', 'Lexend', sans-serif",
                color: team ? teamTextColor(team) : undefined,
                textShadow: "0 0 18px rgba(0,194,255,0.35)",
              }}
            >
              {player ? player.name : team && team.name}
            </h1>
            {player?.hallOfFame && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#F5D77A] px-3 py-1 text-sm font-bold text-black">
                <StarIcon aria-hidden="true" className="h-4 w-4" />
                Hall of Fame
              </p>
            )}
            <div className="mt-4">
              {player ? (
                <CareerList player={player} />
              ) : (
                team && (
                  <p className="max-w-prose text-sm text-slate-300">
                    {mode === "playedFor"
                      ? isSchool(team)
                        ? `Alma mater mode: every ${team.name.replace(/s$/, "")} who ever suited up there, whatever uniform the card shows.`
                        : `Everyone who ever played for the ${team.name}, whatever uniform the card shows.`
                      : `Only cards with the ${team.name} on the front.`}
                  </p>
                )
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-3 md:w-60">
            <div>
              <p className="flex items-baseline gap-2">
                <span className="text-4xl font-bold tabular-nums text-white">
                  {have}
                </span>
                <span className="text-slate-300">of {all.length} cards</span>
              </p>
              <div
                aria-hidden="true"
                className="mt-2 h-2 rounded-full bg-slate-800"
              >
                <div
                  className="h-full rounded-full bg-neon-blue"
                  style={{
                    width: `${all.length ? (have / all.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
            {savedAs ? (
              <p className="text-sm text-slate-300">
                In your binders as{" "}
                <Link
                  to="?view=binders"
                  className="font-semibold text-neon-blue underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
                >
                  {savedAs.name}
                </Link>
              </p>
            ) : (
              <button
                type="button"
                onClick={saveAsBinder}
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-neon-green px-4 text-sm font-semibold text-black hover:bg-neon-green/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:min-h-9"
              >
                Save as binder
              </button>
            )}
            <button
              type="button"
              onClick={() => (followed ? p5.unfollow(pcRef) : p5.follow(pcRef))}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-600 px-4 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-9"
            >
              {followed ? "Unfollow" : "Follow"}
            </button>
          </div>
        </div>
      </section>

      {/* Team pages: the uniform vs the career. */}
      {team && (
        <div
          role="group"
          aria-label={`Which ${team.name} cards`}
          className="mt-5 inline-flex flex-wrap gap-1 rounded-lg border border-slate-700 bg-slate-950 p-1"
        >
          {(
            [
              ["onCard", `On the card: ${team.name}`],
              ["playedFor", `Played for the ${team.name}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`min-h-11 rounded-md px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-9 ${
                mode === value
                  ? "bg-neon-blue text-black"
                  : "text-slate-200 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="mt-5 flex flex-col gap-3">
        <FilterRow label="Show">
          {(["all", "have", "need"] as const).map((v) => (
            <Pill key={v} pressed={show === v} onClick={() => setShow(v)}>
              {v === "all" ? "All" : v === "have" ? "Have" : "Need"}
            </Pill>
          ))}
        </FilterRow>
        {player && (
          <FilterRow label="Team on the card">
            <Pill
              pressed={teamOnCard === null}
              onClick={() => setTeamOnCard(null)}
            >
              Any team
            </Pill>
            {uniqueStintTeams(player.id).map((id) => {
              const t = getTeam(id);
              const n = all.filter((c) => c.teamIds.includes(id)).length;
              return (
                <Pill
                  key={id}
                  pressed={teamOnCard === id}
                  onClick={() => setTeamOnCard(teamOnCard === id ? null : id)}
                  style={{ color: teamTextColor(t) }}
                >
                  {t.name}
                  <span className="tabular-nums opacity-80">{n}</span>
                </Pill>
              );
            })}
          </FilterRow>
        )}
        <FilterRow label="Only">
          <Pill pressed={numbered} onClick={() => setNumbered(!numbered)}>
            Numbered
          </Pill>
          <Pill pressed={rc} onClick={() => setRc(!rc)}>
            Rookies (RC)
          </Pill>
          <Pill pressed={au} onClick={() => setAu(!au)}>
            Autos (AU)
          </Pill>
        </FilterRow>
      </div>

      {/* Year-by-year timeline */}
      <section aria-labelledby="p5-timeline" className="mt-8">
        <h2 id="p5-timeline" className="text-lg font-bold text-white">
          Year by year{" "}
          <span className="text-sm font-normal text-slate-400">
            {shown.length === all.length
              ? `${all.length} cards`
              : `${shown.length} of ${all.length} cards match`}
          </span>
        </h2>

        {years.length === 0 && (
          <p className="mt-4 rounded-lg border border-dashed border-slate-600 p-6 text-slate-300">
            {all.length === 0
              ? "Nothing in the catalog for this one yet."
              : show === "need" && !teamOnCard && !numbered && !rc && !au
                ? "Need list is empty. You've got 'em all. Totally rad."
                : "Nothing matches those filters. Loosen one up."}
          </p>
        )}

        <ol className="mt-5 flex flex-col gap-8 border-l-2 border-slate-800 pl-4 sm:pl-6">
          {years.map((group) => {
            const yearHave = countOwned(group.cards, owned);
            return (
              <li
                key={group.year}
                className="relative grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-3 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
              >
                <span
                  aria-hidden="true"
                  className="absolute -left-[23px] top-3 h-3 w-3 rounded-full border-2 border-neon-blue bg-black sm:-left-[31px]"
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:flex-col sm:items-start">
                  <h3 className="text-3xl font-bold leading-none tabular-nums text-white">
                    {group.year}
                  </h3>
                  {player && (
                    <YearContext playerId={player.id} year={group.year} />
                  )}
                  <span className="text-sm tabular-nums text-slate-400">
                    {yearHave} of {group.cards.length}
                  </span>
                </div>
                <CardStrip label={String(group.year)}>
                  {group.cards.map((card) => (
                    <CardTile
                      key={card.id}
                      card={card}
                      caption={
                        player ? (
                          <PlayerCaption card={card} />
                        ) : (
                          <TeamCaption card={card} />
                        )
                      }
                    />
                  ))}
                </CardStrip>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
    >
      <span
        aria-hidden="true"
        className="w-full text-sm text-slate-400 sm:w-36"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function uniqueStintTeams(playerId: string): TeamId[] {
  const out: TeamId[] = [];
  for (const st of careerOrder(getPlayer(playerId))) {
    if (!out.includes(st.teamId)) out.push(st.teamId);
  }
  return out;
}

function YearContext({ playerId, year }: { playerId: string; year: number }) {
  const player = getPlayer(playerId);
  const teamsThen = teamsInYear(player, year);
  if (teamsThen.length > 0) {
    return (
      <span className="text-sm text-slate-300">
        with the{" "}
        {teamsThen.map((t, i) => (
          <span key={t.id}>
            {i > 0 && " and "}
            <span className="font-semibold" style={{ color: teamTextColor(t) }}>
              {t.name}
            </span>
          </span>
        ))}
      </span>
    );
  }
  const last = Math.max(...player.stints.map(stintEnd));
  return (
    <span className="text-sm text-slate-300">
      {year > last
        ? "Retro issue, years after he hung 'em up"
        : "Before the pros"}
    </span>
  );
}

function variantLine(card: Card): string | null {
  const parts: string[] = [];
  if (card.variantPath.name) parts.push(card.variantPath.name);
  if (card.variation) parts.push(card.variation);
  const run = printRunLabel(card);
  if (run) parts.push(run);
  return parts.length ? parts.join(" ") : null;
}

function TeamOnCard({ card }: { card: Card }) {
  return (
    <>
      {card.teamIds.map((id, i) => {
        const t = getTeam(id);
        return (
          <span key={id}>
            {i > 0 && " / "}
            <span className="font-semibold" style={{ color: teamTextColor(t) }}>
              {t.name}
            </span>
          </span>
        );
      })}
    </>
  );
}

function PlayerCaption({ card }: { card: Card }) {
  const v = variantLine(card);
  return (
    <>
      <span className="block truncate font-medium text-slate-100">
        {setLabel(getSet(card.setId))} #{card.cardNumber}
      </span>
      {v && <span className="block truncate text-slate-300">{v}</span>}
      <span className="block truncate">
        <TeamOnCard card={card} />
      </span>
    </>
  );
}

function TeamCaption({ card }: { card: Card }) {
  const v = variantLine(card);
  return (
    <>
      <span className="block truncate font-medium text-slate-100">
        {playerNames(card)}
      </span>
      <span className="block truncate text-slate-300">
        {setLabel(getSet(card.setId))} #{card.cardNumber}
      </span>
      <span className="block truncate">
        <TeamOnCard card={card} />
        {v && <span className="text-slate-300">, {v}</span>}
      </span>
    </>
  );
}
