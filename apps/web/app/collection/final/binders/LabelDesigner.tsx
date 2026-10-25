import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Theme } from "@radix-ui/themes";
import { Autocomplete } from "@/components/primitives/Autocomplete";
import { SpineLabelColors, SpineLabelLettering } from "@/components/modules/SpineLabelFields";
import { spineFontById } from "@/lib/print/spine-fonts";
import { spineLabelPrintHref } from "@/lib/print/spine-label-params";
import { useSearchText } from "../catalog/search";
import { searchable, useSuggestions } from "../data/store";
import type { ContainerLabel, Suggestion } from "../data/types";
import { useCollectionMode } from "../mode";
import { suggestionColors } from "./hooks";
import { shelfColors, smallestLetteringPx, teamColorsOn, validLabel, type TeamColors, type TeamPick } from "./label";
import PrintShopLink from "./PrintShopLink";
import SpineLabel, { SpineFontFaces } from "./SpineLabel";

/**
 * Pick a binder's spine label: the Print Shop's own colour fields, Invert,
 * contrast readout and lettering picker (`SpineLabelFields`), beside a live
 * spine. A team's colours are one pick away: type the team (a type-ahead
 * over the catalog's teams, NB's own livery); for a smart binder, quick
 * picks come first: the team its rule names (if any, marked "the binder's
 * team", even when no card shows it), then the teams on its cards, most
 * cards first.
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
 * is a Radix button that needs the theme's tokens to draw. NEO-356: that
 * Theme no longer pins dark. The controls follow the page's mode like the
 * rest of the dialog; the preview is the spine itself, painted in the
 * label's own colours, so it reads the same on a light or a dark page.
 */

type TeamSuggestion = Extract<Suggestion, { kind: "team" }>;

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
  draft: ContainerLabel;
  onChange: (next: ContainerLabel) => void;
  /** Quick picks: a smart binder's rule's team, then the teams on its cards (`teamPicks`). */
  teamPicks?: TeamPick[];
}) {
  const { mode } = useCollectionMode();
  const picksLabelId = useId();
  const picks = teamPicks.slice(0, MAX_TEAM_PICKS);
  // The rule's own team reads in full (Wisconsin Badgers), and so does a
  // nickname twice over (Cardinals and Cardinals); the rest by nickname.
  const pickName = ({ team, named }: TeamPick) =>
    named || picks.filter((p) => p.team.name === team.name).length > 1
      ? `${team.location} ${team.name}`
      : team.name;
  const shown = name.trim() || "Your binder";
  const valid = validLabel(draft);
  const font = spineFontById(draft.fontId);
  const shelf = valid ? shelfColors(valid, smallestLetteringPx(shown, font, PREVIEW_SPINE)) : null;

  const edit = (patch: Partial<ContainerLabel>) => onChange({ ...draft, ...patch });

  const pickQuick = (team: TeamColors) => onChange(teamColorsOn(draft, team));

  return (
    <Theme
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
        <p className="text-xs text-ink-3">On the shelf</p>
      </div>

      <div className="min-w-0 space-y-4">
        {picks.length > 0 && (
          <div>
            <p id={picksLabelId} className="mb-1 text-sm font-medium text-ink-2">
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
                    className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors focus-outline ${
                      on
                        ? "border-neon-teal-text text-neon-teal-text"
                        : "border-control text-ink-2 hover:border-ink-3 hover:text-ink"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 rounded-sm border border-control"
                      style={{
                        background: `linear-gradient(135deg, ${team.primary} 0 55%, ${team.secondary} 55% 100%)`,
                      }}
                    />
                    <span>{pickName(pick)}</span>
                    <span aria-hidden="true" className="text-ink-3">
                      · {why}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <TeamColorsPicker draft={draft} onChange={onChange} />

        <SpineLabelColors
          background={draft.background}
          text={draft.text}
          onBackgroundChange={(background) => edit({ background })}
          onTextChange={(text) => edit({ text })}
          onInvert={() => edit({ background: draft.text, text: draft.background })}
        />
        <p aria-live="polite" className="-mt-2 text-xs text-notice-warn-ink">
          {shelf?.swapped
            ? `So it stays readable, the shelf letters it in ${
                shelf.text === "#FFFFFF" ? "white" : "black"
              }. The Print Shop still prints your exact colors.`
            : ""}
        </p>

        <SpineLabelLettering fontId={draft.fontId} onFontChange={(fontId) => edit({ fontId })} />

        <p className="text-xs text-ink-3">
          Want it on the real binder?{" "}
          <PrintShopLink
            appHref={spineLabelPrintHref({ name: name.trim(), ...draft })}
            className="rounded-sm text-neon-blue-text underline underline-offset-2 hover:text-ink focus-outline"
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

/**
 * "Start from a team's colors": type a team, pick it, and its colours land
 * on the label. The colours are NB's own, carried on the team suggestion;
 * a team NB has no colours for says so and changes nothing.
 */
function TeamColorsPicker({ draft, onChange }: { draft: ContainerLabel; onChange: (next: ContainerLabel) => void }) {
  const [q, setQ] = useState("");
  const settled = useSearchText(q);
  const suggestions = useSuggestions(settled);
  const teams = (suggestions ?? []).filter((s): s is TeamSuggestion => s.kind === "team");
  const [picked, setPicked] = useState<TeamSuggestion | null>(null);
  const colors = picked ? suggestionColors(picked) : null;

  // Apply the picked team once its colours are in, then never again for it:
  // a later edit of a colour by hand must stick.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  });
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!picked || !colors || applied.current === picked.id) return;
    applied.current = picked.id;
    onChange(teamColorsOn(draftRef.current, colors));
  }, [picked, colors, onChange]);

  const full = (t: TeamSuggestion) => (t.location ? `${t.location} ${t.name}` : t.name);
  return (
    <div>
      <p aria-hidden="true" className="mb-1 block text-sm font-medium text-ink-2">
        Start from a team&apos;s colors
      </p>
      <Autocomplete<TeamSuggestion>
        label="Start from a team's colors"
        placeholder="Type a team: try packers"
        query={q}
        onQueryChange={setQ}
        items={teams}
        getKey={(t) => t.id}
        getLabel={full}
        onSelect={(t) => {
          applied.current = null;
          setPicked(t);
          setQ(full(t));
        }}
        loading={searchable(settled) && suggestions === undefined}
        emptyMessage="No team by that name"
        hideWhenEmpty={!searchable(q)}
        inputGeometryClassName="px-3 py-2 text-sm"
      />
      <p aria-live="polite" className="mt-1 text-xs text-ink-3 empty:hidden">
        {picked && colors === null ? `NB doesn't have colors for the ${picked.name} yet. Pick them below.` : ""}
      </p>
    </div>
  );
}
