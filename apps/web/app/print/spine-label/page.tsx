import React, { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button, Input } from "@/components/primitives";
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
  splitHeightIntoSegments,
} from "@/lib/print/spine-formats";
import {
  spineSheetCss,
  spineSheetHtml,
  type SpineLabel,
} from "@/lib/print/spine-label-html";
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

/** On-screen preview width. The sheet is 8.5in, so this is ~44% scale. */
const PREVIEW_WIDTH_PX = 380;

export default function SpineLabelPage() {
  const [labels, setLabels] = useState<SpineLabel[]>([]);

  const [player, setPlayer] = useState<PlayerSearchResult | null>(null);
  const [name, setName] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);

  const [background, setBackground] = useState(FALLBACK_BACKGROUND);
  const [text, setText] = useState(FALLBACK_TEXT);

  const [widthIn, setWidthIn] = useState(DEFAULT_SPINE_PRESET.widthIn);
  const [heightIn, setHeightIn] = useState(MAX_LABEL_HEIGHT_IN);
  const [printing, setPrinting] = useState(false);

  const teamIds = useMemo(
    () => (player?.teamYears ?? []).map((entry) => entry.teamId),
    [player],
  );
  const teams = useQuery(
    api.teams.getManyByIds,
    teamIds.length > 0 ? { ids: teamIds } : "skip",
  );

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
  };

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

  const addLabel = () => {
    if (!canAdd) return;
    setLabels((current) => [
      ...current,
      {
        // Date.now alone collides when two labels are added in the same tick;
        // the index keeps keys unique without pulling in a uuid dependency.
        id: `${Date.now()}-${current.length}`,
        name: name.trim(),
        background: normalizedBackground!,
        text: normalizedText!,
      },
    ]);
  };

  const removeLabel = (id: string) => {
    setLabels((current) => current.filter((label) => label.id !== id));
  };

  // What the preview shows: the queued labels, or a live preview of the one
  // being designed so the page is never a blank rectangle.
  const previewLabels: SpineLabel[] =
    labels.length > 0
      ? labels
      : canAdd
        ? [
            {
              id: "preview",
              name: name.trim(),
              background: normalizedBackground!,
              text: normalizedText!,
            },
          ]
        : [];

  const sheetOptions = { labels: previewLabels, widthIn, heightIn };
  const previewHtml = spineSheetHtml(sheetOptions);
  const previewCss = spineSheetCss(sheetOptions);

  const perSheet = labelsPerSheet(widthIn);
  const pieces = splitHeightIntoSegments(heightIn);
  const sheetCount =
    previewLabels.length === 0
      ? 0
      : Math.ceil(previewLabels.length / perSheet) * pieces.length;

  const handlePrint = async () => {
    if (labels.length === 0) return;
    setPrinting(true);
    try {
      const options = { labels, widthIn, heightIn };
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
            <PlayerAutocomplete onSelect={onSelectPlayer} />
            <Input
              label="Name on the label"
              value={name}
              onChange={(e) => setName(e.target.value)}
              helperText="Edit freely — the label prints exactly this."
            />
          </section>

          {teamIds.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-300">Team</h3>
              <p className="text-xs text-slate-500">
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
                        <span className="text-xs text-slate-500">(no colors)</span>
                      )}
                    </button>
                  );
                })}
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
              <Button type="button" variant="outline" onClick={invert}>
                Invert
              </Button>
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

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-300">Size</h3>
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
            <div className="flex flex-wrap items-end gap-3">
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
            <p className="text-xs text-slate-500">
              {perSheet} label{perSheet === 1 ? "" : "s"} per sheet at{" "}
              {widthIn}
              &Prime; wide.
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

          <Button type="button" variant="primary" onClick={addLabel} disabled={!canAdd}>
            Add to sheet
          </Button>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Sheet + preview                                                   */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-300">
              Sheet ({labels.length} label{labels.length === 1 ? "" : "s"},{" "}
              {sheetCount} page{sheetCount === 1 ? "" : "s"})
            </h3>
            <Button
              type="button"
              variant="primary"
              onClick={handlePrint}
              disabled={labels.length === 0 || printing}
            >
              {printing ? "Printing…" : "Print"}
            </Button>
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
                  <span className="flex-1">{label.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => removeLabel(label.id)}
                    aria-label={`Remove ${label.name} from the sheet`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-2">Preview</h3>
            {previewLabels.length === 0 ? (
              <p className="text-sm text-slate-500">
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
                  <style>{previewCss}</style>
                  <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </div>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Preview shows the first page. Dashed lines are cut guides and are
              printed inside the label, so cutting removes them.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
