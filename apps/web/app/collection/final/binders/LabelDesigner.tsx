import { useId, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { Theme } from "@radix-ui/themes";
import { SpineLabelColors, SpineLabelLettering } from "@/components/modules/SpineLabelFields";
import { spineFontById } from "@/lib/print/spine-fonts";
import { teams, type Team } from "../../prototypes/_shared/data";
import { shelfColors, smallestLetteringPx, validLabel, type BinderLabel } from "./label";
import SpineLabel, { SpineFontFaces } from "./SpineLabel";

/**
 * Pick a binder's spine label: the Print Shop's own colour fields, Invert,
 * contrast readout and lettering picker (`SpineLabelFields`), beside a live
 * spine. A team's colours are one pick away, as in the Print Shop.
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

export default function LabelDesigner({
  name,
  draft,
  onChange,
}: {
  /** The name on the spine (the binder's, or what is typed so far). */
  name: string;
  /** The label being designed; colours may be mid-edit. */
  draft: BinderLabel;
  onChange: (next: BinderLabel) => void;
}) {
  const teamSelectId = useId();
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
    if (team) onChange({ ...draft, background: team.primary, text: team.secondary });
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
            ? `Too faint to read on the shelf, so it'll letter in ${
                shelf.text === "#FFFFFF" ? "white" : "black"
              } there. The Print Shop still prints your exact colors.`
            : ""}
        </p>

        <SpineLabelLettering fontId={draft.fontId} onFontChange={(fontId) => edit({ fontId })} />

        <p className="text-xs text-slate-400">
          Want it on the real binder?{" "}
          <Link
            to="/print/spine-label"
            className="rounded-sm text-neon-blue underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Print a spine label
          </Link>{" "}
          in the Print Shop.
        </p>
      </div>
    </Theme>
  );
}
