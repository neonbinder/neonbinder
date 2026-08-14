import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Autocomplete, Input } from "@/components/primitives";
// The shared `Button` primitive is a light-surface control (bg-white,
// text-slate-900). These pages are dark, and the rest of the app reaches for
// NeonButton here — see components/SetSelector/AdminTools.tsx.
import NeonButton from "@/components/modules/NeonButton";
import {
  PlayerAutocomplete,
  type PlayerSearchResult,
} from "@/components/PlayerAutocomplete";
import {
  contrastRatio,
  gradeContrast,
  normalizeHexColor,
} from "@/lib/print/contrast";
import { printHtmlDocument } from "@/lib/print/print-html";
import {
  DEFAULT_SPINE_PRESET,
  FULL_BINDER_HEIGHT_IN,
  LETTER_PAGE,
  MAX_LABEL_HEIGHT_IN,
  SPINE_PRESETS,
  clampLabelHeight,
  clampSpineWidth,
  labelsPerSheet,
  packLabelsIntoSheets,
  splitHeightIntoSegments,
} from "@/lib/print/spine-formats";
import {
  spineSheetCss,
  spineSheetHtml,
  type SpineLabel,
} from "@/lib/print/spine-label-html";
import {
  DEFAULT_SPINE_FONT_ID,
  SPINE_FONTS,
  spineFontById,
  spineFontUrl,
} from "@/lib/print/spine-fonts";
import { pickDefaultTeamYear } from "@/lib/players/team-tenure";

/**
 * /print/spine-label — binder spine labels (NEO-147).
 *
 * A collector prints a spine label carrying a player's name in that player's
 * team colors. The three parts that make this more than a text box:
 *
 *  1. **Colors come from data, but manual entry is first class.** Team color
 *     coverage will never be complete — the backfill cannot resolve Estrellas
 *     Orientales and never will. Rather than treating that as an error state,
 *     the hex fields are always present and always editable; the team picker
 *     just fills them in. See `convex/adapters/teamColorCodes.ts`.
 *
 *  2. **The team defaults to longest tenure.** A player with four stints has
 *     no single team, so `pickDefaultTeamYear` picks one and the user can
 *     override it.
 *
 *  3. **Contrast is shown, never enforced.** Some real team pairs are genuinely
 *     low contrast. This is ink on paper and the user is deliberately choosing
 *     their team's livery, so blocking would be wrong — but showing the number
 *     before they spend a sheet is not.
 *
 * The preview and the printed page are the SAME markup (`spine-label-html.ts`),
 * scaled down here. Two renderers for one geometry would drift, and the one
 * that drifts is the one you cannot see.
 */

/** Fallbacks when a player has no resolvable team colors. Neutral, not branded. */
const FALLBACK_BACKGROUND = "#101820";
const FALLBACK_TEXT = "#ffffff";

/**
 * Rows the free-form team picker offers at once. A typeahead list is read, not
 * scrolled: past this, typing another character beats scanning further.
 */
const TEAM_PICKER_RESULTS = 12;

/**
 * Fetch a font and return it as a `data:` URI for the print document.
 *
 * Returns undefined for the system stack (nothing to embed) and, deliberately,
 * on failure: a label printed in the fallback face is a far better outcome
 * than a print button that throws. `font-display: block` in the print CSS
 * means the browser waits for the face it was given rather than flashing.
 */
async function loadFontDataUrl(font: {
  file: string;
  label: string;
}): Promise<string | undefined> {
  if (!font.file) return undefined;
  try {
    const response = await fetch(`/fonts/${font.file}`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const buffer = await response.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    // Chunked rather than spread: a 20KB font is fine either way, but
    // String.fromCharCode(...bytes) blows the argument limit on larger files
    // and would fail only for whichever font someone adds later.
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:font/woff2;base64,${btoa(binary)}`;
  } catch (error) {
    console.error(`[spine-label] could not embed ${font.label}:`, error);
    return undefined;
  }
}

/**
 * `@font-face` rules for the PREVIEW, by URL.
 *
 * Every face is declared once here rather than only the selected one, so
 * switching fonts does not wait on a fetch mid-interaction. They are
 * `font-display: swap` and only actually downloaded when something on the page
 * is set in them — which, with the picker rendering each option in its own
 * face, is when the picker first renders.
 */
const PREVIEW_FONT_FACES = SPINE_FONTS.filter((f) => f.file)
  .map(
    (f) => `@font-face{font-family:"${f.family}";src:url("${spineFontUrl(f)}") format("woff2");font-weight:400 900;font-display:swap;}`,
  )
  .join("");

/** On-screen preview width. The sheet is 8.5in, so this is ~44% scale. */
const PREVIEW_WIDTH_PX = 380;

export default function SpineLabelPage() {
  const [labels, setLabels] = useState<SpineLabel[]>([]);

  const [player, setPlayer] = useState<PlayerSearchResult | null>(null);
  // Free-form team picker: its own query text and league filter, independent of
  // the player's career teams above.
  const [teamQuery, setTeamQuery] = useState("");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  const [name, setName] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);

  const [background, setBackground] = useState(FALLBACK_BACKGROUND);
  const [text, setText] = useState(FALLBACK_TEXT);

  const [widthIn, setWidthIn] = useState(DEFAULT_SPINE_PRESET.widthIn);
  const [heightIn, setHeightIn] = useState(MAX_LABEL_HEIGHT_IN);
  const [fontId, setFontId] = useState(DEFAULT_SPINE_FONT_ID);
  const [printing, setPrinting] = useState(false);

  const font = spineFontById(fontId);

  const teamIds = useMemo(
    () => (player?.teamYears ?? []).map((entry) => entry.teamId),
    [player],
  );
  const teams = useQuery(
    api.teams.getManyByIds,
    teamIds.length > 0 ? { ids: teamIds } : "skip",
  );

  // Every team we know, for the free-form picker. Filtered on the client the
  // same way Team Management does it — right at today's scale, and the query's
  // own cap is what keeps that honest as the table grows.
  const allTeams = useQuery(api.teams.listForPicker, {});
  const allLeagues = useQuery(api.leagues.list, {});
  const leagueList = useMemo(() => allLeagues ?? [], [allLeagues]);

  const teamMatches = useMemo(() => {
    const needle = teamQuery.trim().toLowerCase();
    if (!needle) return [];
    return (allTeams ?? [])
      .filter((t) => {
        if (leagueFilter !== "all" && t.leagueId !== leagueFilter) return false;
        return t.name.toLowerCase().includes(needle);
      })
      .slice(0, TEAM_PICKER_RESULTS);
  }, [allTeams, teamQuery, leagueFilter]);

  /**
   * Apply a picked team's colors.
   *
   * Marks the colors as touched, unlike the career-team chips: picking a team
   * by hand is an explicit choice and must outrank the player's longest-tenure
   * default, which would otherwise keep winning while a player is also
   * selected. A team with no colors leaves the fields alone — see
   * `applyTeamColors`.
   */
  const applyPickedTeamColors = (team: {
    colors?: { primary?: string; secondary?: string };
  }) => {
    if (!team.colors?.primary) return;
    setColorsTouched(true);
    setBackground(team.colors.primary);
    setText(team.colors.secondary ?? FALLBACK_TEXT);
  };

  /**
   * Apply a team's colors to the fields.
   *
   * A team with no colors deliberately leaves the current values alone rather
   * than blanking them: the user may have typed something they want to keep,
   * and clearing to empty on a miss reads as the app losing their work.
   */
  const applyTeamColors = (teamId: Id<"teams"> | null) => {
    setSelectedTeamId(teamId);
    const team = teams?.find((t) => t._id === teamId);
    if (team?.colors?.primary) {
      setBackground(team.colors.primary);
      setText(team.colors.secondary ?? FALLBACK_TEXT);
    }
  };

  const onSelectPlayer = (selected: PlayerSearchResult) => {
    setPlayer(selected);
    setName(selected.name);
    // Colors are applied once `teams` resolves — see the effect-free handoff
    // in `defaultTeamId` below.
    setSelectedTeamId(null);
    // Drop any team picked by hand for the PREVIOUS player. Without this, the
    // manual pick's `colorsTouched` kept winning, so choosing a new player left
    // the old team's name in the picker and its colours on the label — a
    // baseball player wearing an NFL palette.
    setTeamQuery("");
    setColorsTouched(false);
    setBackground(FALLBACK_BACKGROUND);
    setText(FALLBACK_TEXT);
  };

  /**
   * Which team control to show — never both.
   *
   * A matched player's own career teams are the answer to "whose colours",
   * so putting a general team search beside them is two controls competing to
   * set one value. A hand-typed name has no career teams, and gets the search.
   */
  const showCareerTeams = player !== null && teamIds.length > 0;

  // The longest-tenure default, recomputed when the player's teams arrive.
  const defaultTeamId = useMemo(() => {
    const best = pickDefaultTeamYear(
      player?.teamYears,
      new Date().getFullYear(),
    );
    return (best?.teamId as Id<"teams"> | undefined) ?? null;
  }, [player]);

  // Resolve the effective team without an effect: if the user has not chosen
  // one, the default stands. Deriving it avoids the setState-in-effect pattern
  // that `react-hooks/set-state-in-effect` (rightly) rejects.
  const effectiveTeamId = selectedTeamId ?? defaultTeamId;
  const effectiveTeam = teams?.find((t) => t._id === effectiveTeamId);

  // Colors follow the effective team until the user edits a field, at which
  // point their value wins. `background`/`text` hold the edited value; the
  // team's colors are the baseline shown when nothing has been edited.
  const [colorsTouched, setColorsTouched] = useState(false);
  const activeBackground = colorsTouched
    ? background
    : (effectiveTeam?.colors?.primary ?? background);
  const activeText = colorsTouched
    ? text
    : (effectiveTeam?.colors?.secondary ?? text);

  const normalizedBackground = normalizeHexColor(activeBackground);
  const normalizedText = normalizeHexColor(activeText);
  const colorsValid = normalizedBackground !== null && normalizedText !== null;

  const ratio =
    colorsValid ? contrastRatio(normalizedText!, normalizedBackground!) : null;

  const invert = () => {
    setColorsTouched(true);
    setBackground(activeText);
    setText(activeBackground);
  };

  const canAdd = name.trim().length > 0 && colorsValid;

  // Adding/removing a label doesn't move focus (Add stays put so the user can
  // add several in a row; Remove's own button unmounts, which is handled
  // separately below), so neither outcome is otherwise programmatically
  // announced — WCAG 4.1.3 Status Messages. `addStatus` is a persistent
  // visually-hidden live region rather than a mounted-on-demand node: a
  // dynamically-INSERTED live region is unreliable in Safari/VoiceOver, but
  // one that already exists and only has its text changed is not.
  const [addStatus, setAddStatus] = useState("");

  /**
   * Bumped when the form resets, to remount `PlayerAutocomplete`.
   *
   * That component owns its own query text (it debounces it before querying),
   * so clearing `player` here does not empty its box — the previous player's
   * name would sit there looking selected. A key change is the least
   * surprising way to reset a child that owns state, short of making its text
   * a controlled prop it has no other reason to expose.
   */
  const [formGeneration, setFormGeneration] = useState(0);

  const addLabel = () => {
    if (!canAdd) return;
    // Captured before the update so both the updater below and the status
    // message agree on what "the new label" and "the new count" are.
    // `Date.now()` itself stays inside the setState updater (not hoisted out
    // next to this) — `react-hooks/purity` treats a component-body call as
    // impure-during-render, but a call made from inside the updater function
    // passed to setState is the sanctioned place for it.
    const addedName = name.trim();
    const newCount = labels.length + 1;
    setLabels((current) => [
      ...current,
      {
        // Date.now alone collides when two labels are added in the same tick;
        // the index keeps keys unique without pulling in a uuid dependency.
        id: `${Date.now()}-${current.length}`,
        name: addedName,
        background: normalizedBackground!,
        text: normalizedText!,
        // Ring size and typeface travel WITH the label. Both stay in the form
        // after an add so the next binder starts from the last one used — a run
        // of same-size, same-font binders is one choice — but changing either
        // then affects only the label being designed, never one already queued.
        widthIn,
        font,
      },
    ]);
    setAddStatus(
      `Added ${addedName} to the sheet. ${newCount} label${newCount === 1 ? "" : "s"} queued.`,
    );

    // Clear the designer for the next label. Leaving the previous name and
    // colours in place made a queue of several binders read as though nothing
    // had happened — the form looked identical after the click, and the only
    // evidence was a row appearing in a list on the other side of the page.
    //
    // The SHEET settings (spine width, label height) deliberately survive:
    // they describe the paper, not the label, and every label on one sheet
    // shares them. Re-picking them per label would be busywork.
    setFormGeneration((g) => g + 1);
    setPlayer(null);
    setName("");
    setTeamQuery("");
    setSelectedTeamId(null);
    setColorsTouched(false);
    setBackground(FALLBACK_BACKGROUND);
    setText(FALLBACK_TEXT);
  };

  // Removing a label unmounts that exact li/button — React does not restore
  // focus on unmount, so without this it silently reverts to <body>, which is
  // disorienting for a keyboard/screen-reader user removing several labels in
  // a row. Moving focus to the (now updated) "Sheet" heading both repairs
  // focus and, since its own text already states the new count, doubles as
  // the removal's status announcement without a second live region.
  const sheetHeadingRef = useRef<HTMLHeadingElement>(null);
  const prevLabelCountRef = useRef(labels.length);
  useEffect(() => {
    if (labels.length < prevLabelCountRef.current) {
      sheetHeadingRef.current?.focus();
    }
    prevLabelCountRef.current = labels.length;
  }, [labels.length]);

  const removeLabel = (id: string) => {
    setLabels((current) => current.filter((label) => label.id !== id));
  };

  /**
   * The queued labels PLUS the one being designed.
   *
   * This was `labels.length > 0 ? labels : draft` — an either/or, which meant
   * that the moment a single label was queued the preview stopped reflecting
   * anything typed. You could design a second label and watch the preview sit
   * unchanged on the first, with no way to see what you were making.
   *
   * Showing both is also the honest answer to "what will this sheet look
   * like": the draft is what you get if you press Add, and it occupies the
   * next slot. It leaves the preview the moment it IS added, because adding
   * clears the form.
   */
  const draftLabel: SpineLabel | null = canAdd
    ? {
        id: "preview-draft",
        name: name.trim(),
        background: normalizedBackground!,
        text: normalizedText!,
        widthIn,
        font,
      }
    : null;
  const previewLabels: SpineLabel[] = draftLabel
    ? [...labels, draftLabel]
    : labels;

  const sheetOptions = { labels: previewLabels, heightIn };
  const previewHtml = spineSheetHtml(sheetOptions);
  const previewCss = spineSheetCss(sheetOptions);

  const perSheet = labelsPerSheet(widthIn);
  const pieces = splitHeightIntoSegments(heightIn);
  // Counts what will PRINT, i.e. the queued labels — not the draft, which is
  // in the preview but not on the sheet until Add is pressed. Derived from the
  // real packer rather than a division: with mixed ring sizes on one sheet,
  // "labels ÷ per sheet" is no longer the answer.
  const sheetCount =
    labels.length === 0 ? 0 : packLabelsIntoSheets(labels).length * pieces.length;

  const handlePrint = async () => {
    if (labels.length === 0) return;
    setPrinting(true);
    try {
      // The print iframe is built from `srcdoc` and must depend on nothing —
      // a relative URL would not resolve, and a network fetch at print time
      // could lose the 3s font race and silently print the fallback face. So
      // every font ON THE SHEET is fetched HERE, where a failure is still
      // visible, and inlined as a data URI. Distinct fonts only: five labels
      // in Anton are one download, not five.
      const distinct = new Map(labels.map((l) => [l.font.id, l.font]));
      const fontSrcById: Record<string, string> = {};
      await Promise.all(
        [...distinct.values()].map(async (f) => {
          const src = await loadFontDataUrl(f);
          if (src) fontSrcById[f.id] = src;
        }),
      );
      const options = { labels, heightIn, fontSrcById };
      await printHtmlDocument({
        title: "Binder spine labels",
        bodyHtml: spineSheetHtml(options),
        css: spineSheetCss(options),
        page: LETTER_PAGE,
      });
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="sr-only" role="status" aria-live="polite">
        {addStatus}
      </div>
      <div>
        <h2 className="text-2xl font-semibold mb-1">Spine Labels</h2>
        <p className="text-sm text-slate-400">
          Print a binder spine label with a player&rsquo;s name in their team
          colors. Several labels print on one sheet.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* ---------------------------------------------------------------- */}
        {/* Designer                                                          */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-300">Player</h3>
            <PlayerAutocomplete key={formGeneration} onSelect={onSelectPlayer} />
            <Input
              label="Name on the label"
              value={name}
              onChange={(e) => setName(e.target.value)}
              helperText="Edit freely — the label prints exactly this."
            />
          </section>

          {showCareerTeams && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-300">Team</h3>
              <p className="text-xs text-slate-400">
                Defaults to the team {player?.name} spent longest with.
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Team colors">
                {(teams ?? []).map((team) => {
                  const isActive = team._id === effectiveTeamId;
                  const hasColors = Boolean(team.colors?.primary);
                  return (
                    <button
                      key={team._id}
                      type="button"
                      onClick={() => {
                        setColorsTouched(false);
                        applyTeamColors(team._id);
                      }}
                      aria-pressed={isActive}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 ${
                        isActive
                          ? "border-neon-teal text-neon-teal"
                          : "border-slate-700 text-slate-300 hover:border-slate-500"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="h-3 w-3 rounded-full border border-slate-600"
                        style={{
                          background: team.colors?.primary ?? "transparent",
                        }}
                      />
                      {team.name}
                      {!hasColors && (
                        <span className="text-xs text-slate-400">(no colors)</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Any team, for a name typed by hand.
              Mutually exclusive with the career-team chips above: a matched
              player's own teams ARE the answer, so offering a search for some
              other team beside them is two controls competing to set one
              thing. Typed names get the search, matched players get chips. */}
          {!showCareerTeams && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-300">
              Team colors
            </h3>
            {/* One grid, two equal columns: these are a matched pair of
                filters, and letting the select hug its content while the team
                box stretched made them look unrelated. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
              <div>
                <label
                  htmlFor="spine-league-filter"
                  className="block text-sm font-medium mb-1"
                >
                  League
                </label>
                <select
                  id="spine-league-filter"
                  value={leagueFilter}
                  onChange={(e) => setLeagueFilter(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
                >
                  <option value="all">All leagues</option>
                  {leagueList.map((league) => (
                    <option key={league._id} value={league._id}>
                      {league.abbreviation ?? league.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="block text-sm font-medium mb-1 text-slate-300">Team</span>
                <Autocomplete
                  query={teamQuery}
                  onQueryChange={setTeamQuery}
                  items={teamMatches}
                  getKey={(t) => t._id}
                  getLabel={(t) => t.name}
                  getDescription={(t) =>
                    t.colors?.primary ? undefined : "no colors"
                  }
                  onSelect={(t) => {
                    setTeamQuery(t.name);
                    applyPickedTeamColors(t);
                  }}
                  label="Find a team"
                  placeholder="Start typing a team name…"
                  emptyMessage="No teams match"
                />
              </div>
              {teamQuery.trim().length > 0 && (
                <div className="self-end">
                  {/* Explicit, because the alternative is worse: clearing the
                      team whenever the NAME changes would wipe your colours
                      while you fixed a typo. Selecting a PLAYER does clear it
                      automatically — that genuinely is a new subject. */}
                  <NeonButton
                    type="button"
                    secondary
                    onClick={() => {
                      setTeamQuery("");
                      setColorsTouched(false);
                      setBackground(FALLBACK_BACKGROUND);
                      setText(FALLBACK_TEXT);
                    }}
                  >
                    Clear team
                  </NeonButton>
                </div>
              )}
            </div>
          </section>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-300">Colors</h3>
            <div className="flex flex-wrap items-end gap-3">
              <Input
                label="Background"
                value={activeBackground}
                onChange={(e) => {
                  setColorsTouched(true);
                  setBackground(e.target.value);
                }}
                className="w-32"
              />
              <Input
                label="Lettering"
                value={activeText}
                onChange={(e) => {
                  setColorsTouched(true);
                  setText(e.target.value);
                }}
                className="w-32"
              />
              <NeonButton type="button" secondary onClick={invert}>
                Invert
              </NeonButton>
            </div>

            <p className="text-xs" aria-live="polite">
              {ratio === null ? (
                <span className="text-amber-400">
                  Enter two hex colors (e.g. #01214b) to see contrast.
                </span>
              ) : (
                <span
                  className={
                    gradeContrast(ratio) === "poor"
                      ? "text-amber-400"
                      : "text-slate-400"
                  }
                >
                  Contrast {ratio.toFixed(1)}:1 —{" "}
                  {gradeContrast(ratio) === "poor"
                    ? "hard to read at a distance. Invert may help."
                    : "easy to read on a shelf."}
                </span>
              )}
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-300">Lettering</h3>
            {/* Each option is set in its OWN face, which is the whole point —
                a list of ten names in one font tells you nothing about how a
                spine will look. Rendering them here is also what triggers the
                downloads, so nothing is fetched until this is on screen. */}
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label="Label typeface"
            >
              {SPINE_FONTS.map((option) => {
                const isActive = option.id === fontId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => setFontId(option.id)}
                    title={option.note}
                    className={`rounded-md border px-3 py-1.5 text-lg leading-tight transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 ${
                      isActive
                        ? "border-neon-teal text-neon-teal"
                        : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                    style={{
                      fontFamily:
                        option.id === "system"
                          ? option.family
                          : `"${option.family}", sans-serif`,
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-slate-400">{font.note}</p>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-300">
              Binder size
            </h3>
            <p className="text-xs text-slate-400">
              Ring size belongs to this binder. It carries over to the next
              label so a run of same-size binders is one choice, and changing it
              never touches a label already on the sheet.
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Spine width presets">
              {SPINE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setWidthIn(preset.widthIn)}
                  aria-pressed={widthIn === preset.widthIn}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 ${
                    widthIn === preset.widthIn
                      ? "border-neon-teal text-neon-teal"
                      : "border-slate-700 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {/* items-START, not items-end: only the height field carries
                helperText, and aligning on the bottom pushed the two inputs to
                different heights on the row. Aligning tops lines the labels and
                the fields up, and the helper text hangs below where it
                belongs. */}
            <div className="flex flex-wrap items-start gap-3">
              <Input
                label="Spine width (in)"
                type="number"
                step="0.125"
                value={String(widthIn)}
                onChange={(e) => setWidthIn(clampSpineWidth(Number(e.target.value)))}
                className="w-36"
              />
              <Input
                label="Label height (in)"
                type="number"
                step="0.25"
                value={String(heightIn)}
                onChange={(e) => setHeightIn(clampLabelHeight(Number(e.target.value)))}
                helperText={`Up to ${MAX_LABEL_HEIGHT_IN}" on one sheet.`}
                className="w-36"
              />
            </div>
            <p className="text-xs text-slate-400">
              {perSheet} label{perSheet === 1 ? "" : "s"} per sheet at{" "}
              {widthIn}
              &Prime; wide — a sheet fits any mix that totals 8&Prime;.
              {pieces.length > 1 && (
                <>
                  {" "}
                  A {heightIn}&Prime; label prints in {pieces.length} pieces
                  ({pieces.map((p) => `${p.toFixed(2)}″`).join(" + ")}) to be
                  spliced — a full {FULL_BINDER_HEIGHT_IN}&Prime; binder spine
                  does not fit on one sheet.
                </>
              )}
            </p>
          </section>

          <NeonButton type="button" onClick={addLabel} disabled={!canAdd}>
            Add to sheet
          </NeonButton>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Sheet + preview                                                   */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3
              ref={sheetHeadingRef}
              tabIndex={-1}
              className="text-sm font-semibold text-slate-300 rounded-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              Sheet ({labels.length} label{labels.length === 1 ? "" : "s"},{" "}
              {sheetCount} page{sheetCount === 1 ? "" : "s"})
            </h3>
            <NeonButton
              type="button"
              onClick={handlePrint}
              disabled={labels.length === 0 || printing}
            >
              {printing ? "Printing…" : "Print"}
            </NeonButton>
          </div>

          {labels.length > 0 && (
            <ul className="space-y-1">
              {labels.map((label) => (
                <li
                  key={label.id}
                  className="flex items-center gap-2 rounded-md border border-slate-800 px-3 py-1.5 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-full border border-slate-600"
                    style={{ background: label.background }}
                  />
                  {/* Set in its OWN face, and showing its own ring size: each
                      label keeps what it was added with, so a sheet of mixed
                      sizes and fonts would otherwise read as identical rows. */}
                  <span
                    className="flex-1 truncate"
                    style={{
                      fontFamily:
                        label.font.id === "system"
                          ? label.font.family
                          : `"${label.font.family}", sans-serif`,
                    }}
                  >
                    {label.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    {label.widthIn}&Prime; · {label.font.label}
                  </span>
                  <NeonButton
                    type="button"
                    cancel
                    onClick={() => removeLabel(label.id)}
                    aria-label={`Remove ${label.name}, ${label.widthIn} inch spine in ${label.font.label}, from the sheet`}
                  >
                    Remove
                  </NeonButton>
                </li>
              ))}
            </ul>
          )}

          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-2">Preview</h3>
            {previewLabels.length === 0 ? (
              <p className="text-sm text-slate-400">
                Pick a player, or type a name, to see the label.
              </p>
            ) : (
              <div
                className="overflow-hidden rounded-md border border-slate-800 bg-white"
                style={{
                  width: PREVIEW_WIDTH_PX,
                  // Scale the real 8.5in sheet down to the preview width. The
                  // container height has to follow the scaled content or the
                  // transform leaves a gap below it.
                  height:
                    (PREVIEW_WIDTH_PX / LETTER_PAGE.widthIn) *
                    LETTER_PAGE.heightIn,
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    transform: `scale(${PREVIEW_WIDTH_PX / (LETTER_PAGE.widthIn * 96)})`,
                    transformOrigin: "top left",
                  }}
                >
                  <style>{PREVIEW_FONT_FACES}</style>
                  <style>{previewCss}</style>
                  <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </div>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-400">
              Preview shows the first page, including the label you are
              designing — it joins the sheet when you press Add. Dashed lines
              are cut guides, printed inside the label so cutting removes them.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
