import { useId, useState, type CSSProperties } from "react";
import { Theme } from "@radix-ui/themes";
import { SpineLabelColors, SpineLabelLettering } from "@/components/modules/SpineLabelFields";
import { spineFontById } from "@/lib/print/spine-fonts";
import { spineLabelPrintHref } from "@/lib/print/spine-label-params";
import { teams, type Team } from "../../prototypes/_shared/data";
import { useCollectionMode } from "../mode";
import {
  shelfColors,
  smallestLetteringPx,
  teamColorsOn,
  validLabel,
  type BinderLabel,
  type TeamPick,
} from "./label";
import PrintShopLink from "./PrintShopLink";
import SpineLabel, { SpineFontFaces } from "./SpineLabel";

/**
 * Pick a binder's spine label: the Print Shop's own colour fields, Invert,
 * contrast readout and lettering picker (`SpineLabelFields`), beside a live
 * spine. A team's colours are one pick away, as in the Print Shop; for a
 * smart binder, quick picks come first: the team its rule names (if any,
 * marked "the binder's team", even when no card shows it), then the teams
 * on its cards, most cards first.
 *
 * "Print this label" opens the Print Shop with this label filled in: the
 * name, both colours and the face, exactly as they stand here. In the app it
 * opens a new tab (`PrintShopLink`), so the edits here are not lost.
 *
 * When the pair falls short of AA for the size the shelf draws it at, the
 * Print Shop's warning shows, and a line says what the shelf will do about
 * it (letter it in black or white); the pick itself is kept, for printing.
 *
 * Wrapped in its own Radix `Theme`: it lives in the prototype's modal, which
 * portals to <body>, outside the app's Theme, and the shared fields' Invert
 * is a Radix button that needs the theme's tokens to draw.
 */

const LEAGUES: Team["league"][] = ["MLB", "NFL", "NHL", "NCAA", "NPB"];
const SELECT =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";

export const PREVIEW_SPINE = 76;

/** Quick picks shown at most; every other team is in the list below them. */
export const MAX_TEAM_PICKS = 6;

/** What marks the quick pick for the team a binder's rule names. */
export const NAMED_TEAM_NOTE = "the binder's team";

const sameHex = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export default function LabelDesigner({
  name,
  draft,
  onChange,
  teamPicks = [],
}: {
  /** The name on the spine (the binder's, or what is typed so far). */
  name: string;
  /** The label being designed; colours may be mid-edit. */
  draft: BinderLabel;
  onChange: (next: BinderLabel) => void;
  /** A smart binder's quick picks: its rule's team, then its cards' teams (`binderTeamPicks`). */
  teamPicks?: TeamPick[];
}) {
  const { mode } = useCollectionMode();
  const teamSelectId = useId();
  const picksLabelId = useId();
  const picks = teamPicks.slice(0, MAX_TEAM_PICKS);
  // The rule's own team reads in full (Wisconsin Badgers), and so does a
  // nickname twice over (Cardinals and Cardinals); the rest by nickname.
  const pickName = ({ team, named }: TeamPick) =>
    named || picks.filter((p) => p.team.name === team.name).length > 1
      ? `${team.location} ${team.name}`
      : team.name;
  const [teamId, setTeamId] = useState("");
  const shown = name.trim() || "Your binder";
  const valid = validLabel(draft);
  const font = spineFontById(draft.fontId);
  const shelf = valid ? shelfColors(valid, smallestLetteringPx(shown, font, PREVIEW_SPINE)) : null;

  const edit = (patch: Partial<BinderLabel>) => {
    if (patch.background !== undefined || patch.text !== undefined) setTeamId("");
    onChange({ ...draft, ...patch });
  };

  const pickTeam = (id: string) => {
    setTeamId(id);
    const team = teams.find((t) => t.id === id);
    if (team) onChange(teamColorsOn(draft, team));
  };

  const pickQuick = (team: Team) => {
    setTeamId("");
    onChange(teamColorsOn(draft, team));
  };

  return (
    <Theme
      appearance="dark"
      accentColor="green"
      grayColor="sage"
      radius="large"
      hasBackground={false}
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-4"
    >
      <SpineFontFaces />
      <div className="flex flex-col items-center gap-2">
        <div
          aria-hidden="true"
          className="nb-label-preview h-[236px]"
          style={{ width: PREVIEW_SPINE, background: valid?.background ?? "#101820" } as CSSProperties}
        >
          <SpineLabel name={shown} label={valid ?? draft} spineWidth={PREVIEW_SPINE} count={0} />
        </div>
        <p className="text-xs text-slate-400">On the shelf</p>
      </div>

      <div className="min-w-0 space-y-4">
        {picks.length > 0 && (
          <div>
            <p id={picksLabelId} className="mb-1 text-sm font-medium text-slate-300">
              Teams on its cards
            </p>
            <div role="group" aria-labelledby={picksLabelId} className="flex flex-wrap gap-2">
              {picks.map((pick) => {
                const { team, cards, named } = pick;
                const on = sameHex(draft.background, team.primary) && sameHex(draft.text, team.secondary);
                const why = named ? NAMED_TEAM_NOTE : `${cards} card${cards === 1 ? "" : "s"}`;
                return (
                  <button
                    key={team.id}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${pickName(pick)}, ${why}`}
                    onClick={() => pickQuick(team)}
                    className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
                      on
                        ? "border-neon-teal text-neon-teal"
                        : "border-slate-600 text-slate-200 hover:border-slate-400 hover:text-white"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 rounded-sm border border-slate-500"
                      style={{
                        background: `linear-gradient(135deg, ${team.primary} 0 55%, ${team.secondary} 55% 100%)`,
                      }}
                    />
                    <span>{pickName(pick)}</span>
                    <span aria-hidden="true" className="text-slate-400">
                      · {why}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <label htmlFor={teamSelectId} className="mb-1 block text-sm font-medium text-slate-300">
            Start from a team&apos;s colors
          </label>
          <select id={teamSelectId} className={SELECT} value={teamId} onChange={(e) => pickTeam(e.target.value)}>
            <option value="">Pick a team</option>
            {LEAGUES.map((league) => (
              <optgroup key={league} label={league}>
                {teams
                  .filter((t) => t.league === league)
                  .sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.location} {t.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>

        <SpineLabelColors
          background={draft.background}
          text={draft.text}
          onBackgroundChange={(background) => edit({ background })}
          onTextChange={(text) => edit({ text })}
          onInvert={() => edit({ background: draft.text, text: draft.background })}
        />
        <p aria-live="polite" className="-mt-2 text-xs text-amber-300">
          {shelf?.swapped
            ? `So it stays readable, the shelf letters it in ${
                shelf.text === "#FFFFFF" ? "white" : "black"
              }. The Print Shop still prints your exact colors.`
            : ""}
        </p>

        <SpineLabelLettering fontId={draft.fontId} onFontChange={(fontId) => edit({ fontId })} />

        <p className="text-xs text-slate-400">
          Want it on the real binder?{" "}
          <PrintShopLink
            appHref={spineLabelPrintHref({ name: name.trim(), ...draft })}
            className="rounded-sm text-neon-blue underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Print this label
          </PrintShopLink>{" "}
          {mode === "public"
            ? "in the Print Shop once you've signed up."
            : "in the Print Shop. Its name, colors and lettering come along."}
        </p>
      </div>
    </Theme>
  );
}
