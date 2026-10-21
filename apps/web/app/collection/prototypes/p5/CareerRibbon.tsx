import {
  getTeam,
  teamTextColor,
  type Player,
  type Team,
} from "../_shared/data";
import { careerOrder, isSchool, stintEnd, stintYears } from "./model";

/**
 * The career ribbon: one band of livery per stint, college first, each as
 * wide as the years it lasted. It is the prototype's one loud element — the
 * tiles wear a thin version, the player hero a thick one with a legend.
 */
export function RibbonBar({
  player,
  height = "h-2",
  className = "",
}: {
  player: Player;
  height?: string;
  className?: string;
}) {
  const stints = careerOrder(player);
  return (
    <div
      aria-hidden="true"
      className={`flex w-full gap-0.5 overflow-hidden ${height} ${className}`}
    >
      {stints.map((st, i) => {
        const team = getTeam(st.teamId);
        return (
          <span
            key={`${st.teamId}-${i}`}
            className="min-w-2"
            style={{
              flexGrow: stintEnd(st) - st.from + 1,
              backgroundImage: `linear-gradient(${team.primary} 0 72%, ${team.secondary} 72% 100%)`,
            }}
          />
        );
      })}
    </div>
  );
}

/** A team's own two-colour band, for a team or school tile. */
export function TeamBar({
  team,
  height = "h-2",
  className = "",
}: {
  team: Team;
  height?: string;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`w-full ${height} ${className}`}
      style={{
        backgroundImage: `repeating-linear-gradient(90deg, ${team.primary} 0 46px, ${team.secondary} 46px 52px)`,
      }}
    />
  );
}

/** The ribbon's legend: the career as a list, readable without the colours. */
export function CareerList({ player }: { player: Player }) {
  return (
    <ol aria-label="Career" className="flex flex-wrap gap-x-5 gap-y-2">
      {careerOrder(player).map((st, i) => {
        const team = getTeam(st.teamId);
        return (
          <li
            key={`${st.teamId}-${i}`}
            className="flex items-center gap-2 text-sm"
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{
                background: team.primary,
                boxShadow: `inset 0 -3px 0 ${team.secondary}`,
              }}
            />
            <span
              className="font-semibold"
              style={{ color: teamTextColor(team) }}
            >
              {team.name}
            </span>
            <span className="tabular-nums text-slate-400">
              {stintYears(st)}
              {isSchool(team) ? ", college" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
