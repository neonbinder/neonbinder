import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/primitives";
import { CopyButton } from "@/components/primitives/CopyButton";
import NeonButton from "@/components/modules/NeonButton";
// The add form lives in its own file since NEO-240's review: Team Management
// renders the same one inside a modal, and two copies of a create form is two
// duplicate guards to keep in step. `LevelGroup` and the field-metric constants
// travel with it because the form is their other caller.
import {
  AddLeagueForm,
  FIELD_BOX_HEIGHT,
  LABEL_CLASS,
  LEVELS,
  LevelGroup,
  type LeagueLevel,
  type Status,
} from "./AddLeagueForm";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
// NEO-240: the same two helpers PlayerManagement's row and TeamManagement's
// contrast readout use, so no two screens can disagree about what a colour
// pair scores.
import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";
import { WIKIDATA_QID, wikidataUrl } from "@/lib/players/wikidata-id";

/**
 * NEO-240 — League Management, the third of the entity editors.
 *
 * Leagues arrived in NEO-156 as a supporting row: `findOrCreateLeague` made one
 * whenever a team needed somewhere to belong, and `/admin/teams` could type a
 * new name into a select. Nothing could ever LOOK at one afterwards. So the
 * table accumulated exactly what an unattended find-or-create accumulates —
 * rows with no abbreviation, no level and no era, and two spellings of one
 * league sitting side by side because the normalizer could not tell "Amer.
 * League" from "American League".
 *
 * This is the screen that fixes those. Master-detail, deliberately the same
 * shape as `/admin/players` and `/admin/teams`: an operator moves between the
 * three all day and the muscle memory has to survive the trip.
 *
 * Two things differ from the Players screen, and both come from scale in the
 * other direction — there are dozens of leagues, not tens of thousands:
 *
 *  1. **The filter is client-side.** `listForManagement` returns the whole
 *     table, so filtering it in the browser is complete rather than a partial
 *     answer over a capped page. No search index, no debounce, no "type to
 *     search" caveat — Team Management's arrangement, for Team Management's
 *     reason.
 *  2. **The detail panel shows what belongs to the row.** A league is defined
 *     by who plays in it, so `teamsIn` is the panel's second subject and every
 *     team is a way into Team Management.
 *
 * Creating still asks first: `nearMatches` runs as the operator types and the
 * primary action demotes itself when the name already exists (the Players
 * screen's pattern, and the reason the duplicate spellings above are worth
 * folding rather than worth preventing twice).
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Structural rather than `Doc<"leagues">`, and the ids are the exception.
 *
 * The panel needs to hand `_id` and `sportId` to mutations, so those keep their
 * branded types; everything else is spelled out so this file states the shape
 * it actually consumes rather than inheriting every column the table happens to
 * grow. Same reasoning as NearMatchPanel's `NearMatch`.
 */
export interface League {
  _id: Id<"leagues">;
  name: string;
  abbreviation?: string;
  nameNormalized: string;
  sportId: Id<"selectorOptions">;
  lastUpdated: number;
  level?: LeagueLevel;
  yearsActive?: { from: number; to?: number };
  externalIds?: { wikidataId?: string };
  aliases?: string[];
}

/** One row of `leagues.teamsIn` — only what the panel paints. */
interface LeagueTeam {
  _id: Id<"teams">;
  name: string;
  city?: string;
  colors?: { primary?: string; secondary?: string };
}

/** The master row's level column — the same six labels the picker offers. */
const LEVEL_LABEL = new Map<LeagueLevel, string>(
  LEVELS.map((level) => [level.value, level.label]),
);

/**
 * How long the counter has to hold still before it is ANNOUNCED.
 *
 * The visible counter is synchronous — it recomputes on every keystroke,
 * because a sighted operator watching the number fall is how they know the
 * filter is biting. A live region cannot behave that way: `aria-live="polite"`
 * queues every intermediate value, so typing eight characters made a screen
 * reader read eight counts, all of them stale by the time the last was spoken.
 *
 * Long enough to outlast a typing burst and short enough that the number
 * arrives while the operator is still looking at the list.
 */
const COUNTER_ANNOUNCE_DEBOUNCE_MS = 400;

/**
 * The surface the team chips in the detail panel are painted on — slate-900,
 * which is also the background `PlayerManagement` measures its row team colour
 * against.
 *
 * Explicit rather than inherited from the page: `--background` flips to white
 * under a light-mode OS, so a colour measured against "whatever is behind this"
 * would be measured against the wrong thing for anyone whose system is not in
 * dark mode. A chip that carries its own background can be measured honestly.
 */
const TEAM_CHIP_BG = "#0f172a";

/** WCAG 2.2 SC 1.4.3 for text this size. Not a readout, a gate — this is UI. */
const TEXT_MIN_CONTRAST = 4.5;

/**
 * The team's own colour for a chip, or null to leave it muted.
 *
 * Primary first, secondary as the fallback, muted when neither clears the
 * floor — the order PlayerManagement's row uses, for the reason documented
 * there: a great many franchises are built on a near-black navy or maroon, and
 * their secondary is the pale one precisely because it is what they print the
 * dark on.
 *
 * Colour is never the only carrier here: the chip reads the same team name down
 * every branch, so a muted chip has lost decoration and no information.
 */
function teamTextColor(
  colors: { primary?: string; secondary?: string } | undefined,
  background: string,
): string | null {
  for (const candidate of [colors?.primary, colors?.secondary]) {
    if (!candidate) continue;
    const hex = normalizeHexColor(candidate);
    if (!hex) continue;
    const ratio = contrastRatio(hex, background);
    if (ratio !== null && ratio >= TEXT_MIN_CONTRAST) return hex;
  }
  return null;
}

/**
 * What still needs a human, per league. Derived rather than served as buckets:
 * the server returns the facts and the screen decides how to present them, so a
 * new state does not need a new query shape (TeamManagement's `attentionFor`,
 * same contract).
 *
 * Abbreviation outranks level because it is the one that shows up somewhere
 * else — `/admin/teams` prints `league.abbreviation ?? league.name` beside
 * every team, so a league with no short form makes that list unreadable.
 */
export function attentionFor(league: League): "abbreviation" | "level" | null {
  if (!league.abbreviation) return "abbreviation";
  if (!league.level) return "level";
  return null;
}

/**
 * `A, B ,, C ` → `["A", "B", "C"]`.
 *
 * Splitting on the comma alone: an alias is a league NAME and names carry
 * spaces ("American Association"), so nothing else can be a separator. Empties
 * are dropped so a trailing comma — which is what a half-typed list always ends
 * in — does not become an empty alias.
 */
function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

/**
 * The fields the detail panel seeds a draft from, flattened into one comparable
 * string.
 *
 * Object identity is useless here: `useQuery` hands back a fresh object on every
 * reactive push, so "did the row actually change?" has to be asked of the
 * VALUES. Normalised exactly as the draft normalises them before saving, so an
 * untouched draft compares equal to the row it came from. See PlayerDetail for
 * the three-way comparison this feeds.
 */
function fieldSignature(fields: {
  name: string;
  abbreviation: string;
  level: LeagueLevel | null;
  fromYear: string;
  toYear: string;
  aliases: string[];
  wikidataId: string;
}): string {
  return JSON.stringify([
    fields.name.trim(),
    fields.abbreviation.trim(),
    fields.level,
    fields.fromYear.trim(),
    fields.toYear.trim(),
    fields.aliases,
    fields.wikidataId.trim(),
  ]);
}

/** {@link fieldSignature} for a stored row. */
function rowSignature(row: League): string {
  return fieldSignature({
    name: row.name,
    abbreviation: row.abbreviation ?? "",
    level: row.level ?? null,
    fromYear: row.yearsActive?.from ? String(row.yearsActive.from) : "",
    toYear: row.yearsActive?.to ? String(row.yearsActive.to) : "",
    aliases: row.aliases ?? [],
    wikidataId: row.externalIds?.wikidataId ?? "",
  });
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function LeagueDetail({
  league,
  sportLabel,
  onSelect,
}: {
  league: League;
  sportLabel: string;
  onSelect: (id: Id<"leagues">) => void;
}) {
  const saveLeagueFields = useMutation(api.leagues.saveLeagueFields);
  const enrichFromWikidata = useAction(api.leagues.enrichFromWikidata);

  // Local draft state, re-seeded when the selected league changes. Binding
  // straight to the live row would drop keystrokes whenever an unrelated
  // reactive update landed mid-edit (NEO-39).
  const [name, setName] = useState(league.name);
  const [abbreviation, setAbbreviation] = useState(league.abbreviation ?? "");
  const [level, setLevel] = useState<LeagueLevel | null>(league.level ?? null);
  const [fromYear, setFromYear] = useState(
    league.yearsActive?.from ? String(league.yearsActive.from) : "",
  );
  const [toYear, setToYear] = useState(
    league.yearsActive?.to ? String(league.yearsActive.to) : "",
  );
  const [aliasText, setAliasText] = useState((league.aliases ?? []).join(", "));
  const [wikidataId, setWikidataId] = useState(
    league.externalIds?.wikidataId ?? "",
  );
  const [nameTakenId, setNameTakenId] = useState<Id<"leagues"> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The panel's own status line, rendered directly under the action row rather
   * than routed to the page-level line at the top of the screen. On a 1024x629
   * viewport that top line sits far above the Save button and is off-screen
   * when it is pressed, so a sighted mouse user got no confirmation and, worse,
   * never saw WHY a save failed (NEO-212 found this on the Players screen).
   *
   * Detail-originated messages live here and ONLY here: exactly one live region
   * announces each one. The add form's messages stay page-level on purpose —
   * they report on the list, which the top line sits directly above.
   */
  const [status, setStatus] = useState<Status>(null);

  /**
   * The draft follows the LIVE row, not just the selected `_id`.
   *
   * `createByAdmin` schedules Wikidata enrichment, so seconds after a league is
   * added by hand the server row can grow an abbreviation, a level and an era.
   * Everything reading the row directly moves; a draft seeded once per `_id`
   * does not, and the panel ends up contradicting itself on screen.
   *
   * `seeded.signature` is the row AS SEEDED. When the live row moves:
   *
   *   - **draft === seeded** — nothing typed. Adopt the new row.
   *   - **draft === live** — the row caught up with what is already on screen.
   *     That is our own save landing; adopting only re-bases `seeded`.
   *   - **otherwise** — adopting would destroy real edits. Keep the draft and
   *     say so; `Reload` is the way out.
   *
   * Covers the seeded FIELDS and deliberately not `lastUpdated`: a write that
   * changed none of them must not throw a "someone changed this" notice at an
   * operator mid-edit.
   */
  const [seeded, setSeeded] = useState(() => ({
    id: league._id,
    signature: rowSignature(league),
  }));
  const [rowMovedUnderDraft, setRowMovedUnderDraft] = useState(false);

  /** Take the row as it now stands, discarding whatever the fields held. */
  const seedFrom = (row: League) => {
    setName(row.name);
    setAbbreviation(row.abbreviation ?? "");
    setLevel(row.level ?? null);
    setFromYear(row.yearsActive?.from ? String(row.yearsActive.from) : "");
    setToYear(row.yearsActive?.to ? String(row.yearsActive.to) : "");
    setAliasText((row.aliases ?? []).join(", "));
    setWikidataId(row.externalIds?.wikidataId ?? "");
    setSeeded({ id: row._id, signature: rowSignature(row) });
    setRowMovedUnderDraft(false);
  };

  const draftAliases = useMemo(() => parseAliases(aliasText), [aliasText]);

  const liveSignature = rowSignature(league);
  const draftSignature = fieldSignature({
    name,
    abbreviation,
    level,
    fromYear,
    toYear,
    aliases: draftAliases,
    wikidataId,
  });

  // Adjusted during render — React's documented "adjust state when props
  // change" pattern rather than an effect, which the lint rule rejects.
  if (seeded.id !== league._id) {
    seedFrom(league);
    setNameTakenId(null);
    // Otherwise "Saved American League." stays on screen under a different
    // league's Save button.
    setStatus(null);
  } else if (seeded.signature !== liveSignature) {
    if (
      draftSignature === seeded.signature ||
      draftSignature === liveSignature
    ) {
      seedFrom(league);
    } else if (!rowMovedUnderDraft) {
      setRowMovedUnderDraft(true);
    }
  }

  /** The notice's `Reload`: throw the draft away and start again from the row
   *  as it now stands. */
  const reloadFromRow = () => {
    seedFrom(league);
    setNameTakenId(null);
  };

  /** Captions live in their own grid rows so the field boxes above them stay on
   *  one line; the association the primitive's `helperText` would have made is
   *  passed back by hand. */
  const qidCaptionId = useId();
  const yearsCaptionId = useId();
  const aliasCaptionId = useId();

  /**
   * The panel's own heading takes focus whenever the league it is showing
   * changes.
   *
   * Three paths swap this column out from under the control that was pressed,
   * and all three unmount that control: creating a league (the add form's
   * Create button), picking a near match (its `Open {name}`), and the
   * NAME_TAKEN alert's "Open the existing league" (which changes this panel's
   * `key`). A React unmount does not move focus — it leaves it on `<body>`, so
   * the operator's next Tab restarts at the top of the page and a screen
   * reader is told nothing at all about the panel that just appeared (WCAG 2.2
   * SC 2.4.3).
   *
   * Focusing the heading fixes both halves at once: the name of the league now
   * on screen is announced, and Tab continues into its fields. `tabIndex={-1}`
   * makes it focusABLE without adding a tab stop.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [league._id]);

  const teams: LeagueTeam[] | undefined = useQuery(api.leagues.teamsIn, {
    leagueId: league._id,
  });

  const trimmedName = name.trim();
  const trimmedAbbreviation = abbreviation.trim();
  const trimmedQid = wikidataId.trim();
  const qidValid = trimmedQid.length === 0 || WIKIDATA_QID.test(trimmedQid);

  const from = fromYear.trim() ? Number(fromYear) : null;
  const to = toYear.trim() ? Number(toYear) : null;
  const yearsValid =
    (from === null || Number.isInteger(from)) &&
    (to === null || (Number.isInteger(to) && from !== null && to >= from));

  const storedAliases = league.aliases ?? [];
  const nameChanged = trimmedName !== league.name;
  const abbreviationChanged =
    trimmedAbbreviation !== (league.abbreviation ?? "");
  const levelChanged = level !== (league.level ?? null);
  const yearsChanged =
    fromYear.trim() !==
      (league.yearsActive?.from ? String(league.yearsActive.from) : "") ||
    toYear.trim() !==
      (league.yearsActive?.to ? String(league.yearsActive.to) : "");
  const aliasesChanged =
    JSON.stringify(draftAliases) !== JSON.stringify(storedAliases);
  const qidChanged = trimmedQid !== (league.externalIds?.wikidataId ?? "");

  const dirty =
    nameChanged ||
    abbreviationChanged ||
    levelChanged ||
    yearsChanged ||
    aliasesChanged ||
    qidChanged;
  const canSave =
    dirty &&
    trimmedName.length > 0 &&
    qidValid &&
    yearsValid &&
    busy === null;

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    setStatus(null);
    setNameTakenId(null);
    try {
      // Only what changed. `saveLeagueFields` treats every arg as optional and
      // an omitted one as "leave it alone", so sending the whole draft would
      // rewrite fields nobody touched.
      await saveLeagueFields({
        id: league._id,
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(abbreviationChanged
          ? { abbreviation: trimmedAbbreviation || null }
          : {}),
        ...(levelChanged ? { level } : {}),
        ...(yearsChanged
          ? {
              yearsActive:
                from !== null
                  ? { from, ...(to !== null ? { to } : {}) }
                  : null,
            }
          : {}),
        ...(aliasesChanged ? { aliases: draftAliases } : {}),
        ...(qidChanged ? { wikidataId: trimmedQid || null } : {}),
      });
      setStatus({ text: `Saved ${trimmedName}.`, isError: false });
    } catch (e) {
      // NAME_TAKEN carries the OTHER row's id precisely so this screen can
      // offer to go there. Read `.data` first (the only thing that survives
      // production's redaction) and fall back to `.message` for the dev path.
      const raw =
        e && typeof e === "object" && "data" in e && typeof e.data === "string"
          ? e.data
          : e instanceof Error
            ? e.message
            : "";
      const taken = /NAME_TAKEN:([^\s"]+)/.exec(raw);
      if (taken) {
        setNameTakenId(taken[1] as Id<"leagues">);
      } else {
        setStatus({
          text: userFacingMessage(e, "Could not save that league."),
          isError: true,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const reEnrich = async () => {
    setBusy("enrich");
    setStatus(null);
    try {
      await enrichFromWikidata({ id: league._id });
      setStatus({
        text: "Enrichment queued — it lands in a moment.",
        isError: false,
      });
    } catch (e) {
      setStatus({
        text: userFacingMessage(e, "Could not queue enrichment."),
        isError: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const qid = league.externalIds?.wikidataId;
  const qidUrl = wikidataUrl(qid);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* h3, not h4: nothing on this screen renders an <h3> above it, so an
            <h4> here would skip a level and hand a screen reader navigating by
            heading a broken outline (WCAG 2.2 SC 1.3.1). */}
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-semibold leading-tight focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-neon-teal"
        >
          {league.name}
        </h3>
        <CopyButton value={league.name} label="league name" />
        {qid &&
          (qidUrl ? (
            <a
              href={qidUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-neon-blue underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-neon-blue rounded-sm"
            >
              Wikidata {qid}
              <span className="sr-only"> (opens in new tab)</span>
            </a>
          ) : (
            // A stored id that is not `Q<digits>` — a legacy row, or one
            // written before this field was validated. Shown as text so the
            // operator can see the bad value and fix it in the editor below;
            // never as a link, because the id would be interpolated into the
            // href verbatim.
            <span className="text-sm text-slate-400">Wikidata {qid}</span>
          ))}
      </div>

      {nameTakenId && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-neon-pink/40 bg-neon-pink/5 p-3 text-sm text-neon-pink"
        >
          <span>That name already exists</span>
          <button
            type="button"
            onClick={() => onSelect(nameTakenId)}
            className="min-h-6 rounded px-2 py-1 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-neon-pink"
          >
            Open the existing league
          </button>
        </div>
      )}

      {/* The fields on a real grid. Each row is its OWN two-column grid rather
          than one auto-flow container: a bare caption and a field carrying a
          helper line each set their own height, so a single container leaves no
          two controls starting or ending on the same line. `sm:items-end` does
          the alignment work — every cell here ends at the bottom edge of an
          input box (see FIELD_BOX_HEIGHT). */}
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
          <Input
            label="League name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          {/* Read-only on purpose. Moving a league between sports is not an
              edit, it is a re-key: `nameNormalized` is unique per (name, sport)
              and every team pointing here was resolved under the old sport.
              Painted as a field rather than as a caption floating beside one —
              a recessed surface and a dimmer border say "not yours to change"
              without `disabled`'s opacity, which would take the text under the
              4.5:1 floor. */}
          <p
            className={`w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-base text-slate-300 ${FIELD_BOX_HEIGHT}`}
          >
            Sport: {sportLabel}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
          <Input
            label="Abbreviation"
            value={abbreviation}
            placeholder="AL"
            onChange={(e) => setAbbreviation(e.target.value)}
          />

          <Input
            label="Wikidata id"
            value={wikidataId}
            placeholder="Q…"
            // The caption is its own grid row below so the boxes stay on one
            // line; `helperText`/`error` would have put it inside this cell and
            // pushed the box off its neighbour's line. The association the
            // primitive would have made is made by hand.
            aria-describedby={qidCaptionId}
            aria-invalid={qidValid ? undefined : true}
            onChange={(e) => setWikidataId(e.target.value)}
          />
        </div>

        {/* The caption row. One line, always in the same place, whether it is
            saying how to clear the field or why the id is refused. */}
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <span className="hidden sm:block" aria-hidden="true" />
          <p
            id={qidCaptionId}
            className={`text-sm ${qidValid ? "text-slate-400" : "text-neon-pink"}`}
          >
            {qidValid
              ? "Leave empty to clear it."
              : "A Wikidata id looks like Q12345."}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
          {/* BOTH boxes are marked invalid, because the fault is the PAIR:
              "1990 to 1800" is not a bad end year, it is an inconsistent era,
              and marking only the second tells an errors-rotor user to go fix a
              field that may well be the correct one of the two. Both point at
              the same caption below, which is the sentence that explains it. */}
          <Input
            label="Active from"
            type="number"
            value={fromYear}
            aria-describedby={yearsCaptionId}
            aria-invalid={yearsValid ? undefined : true}
            onChange={(e) => setFromYear(e.target.value)}
          />
          <Input
            label="Active to"
            type="number"
            value={toYear}
            placeholder="present"
            aria-describedby={yearsCaptionId}
            aria-invalid={yearsValid ? undefined : true}
            onChange={(e) => setToYear(e.target.value)}
          />
        </div>

        <p
          id={yearsCaptionId}
          className={`text-sm ${yearsValid ? "text-slate-400" : "text-neon-pink"}`}
        >
          {yearsValid
            ? "Leave Active to empty while the league is still running."
            : "An end year cannot come before the start year."}
        </p>

        <LevelGroup value={level} onChange={setLevel} idPrefix="detail" />

        {/* Aliases are the reason this screen exists as much as anything else:
            two spellings of one league is the failure `nameNormalized` cannot
            catch, and folding the second into this row is the fix. Typed as a
            comma list because that is how a list is typed; shown back as chips
            because that is how a list is CHECKED. */}
        <div>
          <Input
            label="Aliases"
            value={aliasText}
            placeholder="Amer. League, A.L."
            aria-describedby={aliasCaptionId}
            onChange={(e) => setAliasText(e.target.value)}
          />
          {draftAliases.length > 0 && (
            // Directly under the field and ahead of the instruction: these are
            // what the string in the box PARSES to, and the failures they
            // catch are invisible in the raw text — a missing comma making one
            // long alias, a trailing one making an empty entry.
            //
            // Named "Current aliases", not "Aliases": the field above is
            // already called Aliases, and two controls sharing one accessible
            // name is ambiguous to a screen reader and to a Maestro selector.
            // Bordered and unlinked, which is this panel's grammar for a chip
            // that goes nowhere — the team chips below are underlined and go
            // somewhere.
            <ul
              aria-label="Current aliases"
              className="mt-2 flex flex-wrap gap-1.5"
            >
              {draftAliases.map((alias) => (
                <li
                  key={alias}
                  className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-xs text-slate-300"
                >
                  {alias}
                </li>
              ))}
            </ul>
          )}
          <p id={aliasCaptionId} className="mt-2 text-sm text-slate-400">
            Other spellings that mean this league, comma-separated — e.g.
            American League, National League
          </p>
        </div>
      </div>

      {/* The row moved while there were unsaved edits on screen. Deliberately
          not a modal and not an auto-adopt: the operator's own typing is the
          thing most likely to be lost, so nothing is overwritten until they say
          so. Orange rather than pink — nothing has failed. */}
      {rowMovedUnderDraft && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-neon-orange/40 bg-neon-orange/5 px-3 py-2 text-sm text-neon-orange"
        >
          <span>This league was updated elsewhere — Reload to see the latest.</span>
          <button
            type="button"
            onClick={reloadFromRow}
            aria-label={`Reload league ${league.name}`}
            className="min-h-6 rounded px-2 py-1 underline underline-offset-2 transition-colors hover:bg-neon-orange/10 focus:outline-none focus:ring-2 focus:ring-neon-orange"
          >
            Reload
          </button>
        </div>
      )}

      {/* A hairline, not a card: the roster is a second subject within the same
          panel, and boxing it would have implied a second surface. */}
      <div className="space-y-3 border-t border-slate-800 pt-4">
        <h3 className="text-base font-semibold">Teams in this league</h3>

        {teams === undefined ? (
          <p className="text-sm text-slate-400">Loading teams…</p>
        ) : teams.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-800 px-3 py-2 text-sm text-slate-400">
            No teams yet.
          </p>
        ) : (
          // Chips, not stacked rows: a league's teams are a SET, and thirty of
          // them read as a roster here and as a scroll trap in a column. Each
          // chip carries its own slate-900 surface, which is also the
          // background the colour below is measured against.
          <ul aria-label="Teams in this league" className="flex flex-wrap gap-1.5">
            {teams.map((team) => {
              // Painted in the team's own livery when that colour is readable
              // (see `teamTextColor`); `text-slate-300` stays on the element as
              // the fallback the inline colour overrides, so a team with no
              // readable colour is muted rather than absent. The name reads the
              // same either way — colour carries no meaning on its own.
              // Hover deliberately adds a ring rather than lightening the
              // fill: the fill IS the background this colour was measured
              // against, and a lighter hover state would take a knife-edge
              // colour under the floor exactly while it is being pointed at.
              const color = teamTextColor(team.colors, TEAM_CHIP_BG);
              return (
                <li key={team._id}>
                  <Link
                    to={`/admin/teams?team=${team._id}`}
                    title={`Open ${team.name} in Team Management`}
                    style={color ? { color } : undefined}
                    className="flex min-h-6 items-center rounded-full bg-slate-900 px-2.5 py-1 text-sm text-slate-300 underline underline-offset-2 transition-shadow hover:ring-1 hover:ring-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-teal"
                  >
                    {team.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {/* The way out of a roster this panel cannot edit: everything about a
            team belongs to Team Management, and typing the league name into
            its filter is the navigation this link saves. */}
        <p className="text-sm">
          <Link
            to={`/admin/teams?league=${league._id}`}
            className="rounded-sm text-neon-blue underline underline-offset-2 transition-colors hover:text-neon-blue/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-blue"
          >
            Manage in Team Management
          </Link>
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
        <NeonButton type="button" onClick={() => void save()} disabled={!canSave}>
          {busy === "save" ? "Saving…" : "Save"}
        </NeonButton>
        {/* Black label, like the "Add stint" button on the Players screen:
            NeonButton's `secondary` paints white on #00C2FF, which is 2.07:1 —
            under SC 1.4.3's 4.5:1 floor. Black on the same blue is 10.1:1. */}
        <NeonButton
          type="button"
          secondary
          style={{ color: "#000000" }}
          onClick={() => void reEnrich()}
          disabled={busy !== null}
        >
          {busy === "enrich" ? "Queueing…" : "Re-enrich from Wikidata"}
        </NeonButton>
      </div>

      {status && (
        <p
          className={`text-sm ${status.isError ? "text-neon-pink" : "text-slate-300"}`}
          role={status.isError ? "alert" : "status"}
        >
          {status.text}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function LeagueManagement() {
  const [filter, setFilter] = useState("");
  const [sportFilter, setSportFilter] = useState<string>("all");
  // A plain string, not `Id<"leagues">`, and that is the point: one of the
  // things that lands here is the `?league=` param, which anybody can retype.
  // `leagues.getByIdParam` takes the raw string and answers `null` for anything
  // that is not a live league id — see the deep link below.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const sports = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const sportList = useMemo(() => sports ?? [], [sports]);
  const sportNameById = useMemo(
    () => new Map(sportList.map((s) => [s._id as string, s.value as string])),
    [sportList],
  );

  const sportId =
    sportFilter === "all" ? undefined : (sportFilter as Id<"selectorOptions">);

  const management = useQuery(
    api.leagues.listForManagement,
    sportId ? { sportId } : {},
  );

  // The filter takes focus once the list has loaded, because the only reason to
  // open this screen is to work on a specific league and typing its name is how
  // you get there.
  //
  // Gated on `management !== undefined`, not on mount: the teams screen shipped
  // this as an unconditional mount effect, which ran against a not-yet-mounted
  // input and silently did nothing. `hasFocusedRef` keeps it ONE-SHOT —
  // `management` changes on every reactive write to the leagues table, and
  // yanking focus back mid-edit would be worse than never focusing at all.
  const filterRef = useRef<HTMLInputElement>(null);
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    if (management === undefined || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    filterRef.current?.focus();
  }, [management]);

  // Arriving here from somewhere else, on one league.
  //
  // `/admin/leagues?league=<id>` opens the screen with that league already
  // selected, and every selection writes the id back. The second half is what
  // the first half is for: the panel links each team to `/admin/teams?team=…`,
  // and without an id in this screen's own history entry, Back from there
  // returns to an empty list the operator has to find their way back through.
  //
  // The param is followed during RENDER, not in an effect: the effect version
  // sets state on a commit that has already happened, cascading a second render
  // that the lint rule rejects. This is React's documented "adjust state when a
  // prop changes" pattern, the same one LeagueDetail uses to re-seed its draft.
  //
  // TWO ids are remembered, not one, and that is not belt-and-braces. React
  // Router applies every location update inside `startTransition` — the app's
  // `BrowserRouter` and the tests' `MemoryRouter` share that code path — so the
  // render that commits a new selection is a render in which `searchParams`
  // STILL NAMES THE PREVIOUS LEAGUE; the URL catches up one render later. A
  // one-slot marker cannot tell that stale value apart from a fresh link back to
  // that league, so it follows it — and because following a link clears the
  // filters, the filter the operator typed a moment ago empties itself under
  // their own click. Remembering the superseded id closes exactly that window.
  //
  // Gated on the LIST having loaded rather than on the id resolving, which are
  // two different things: the id goes straight to `getByIdParam`, so the panel
  // can open for a league the master list is not showing. The gate exists for
  // the scroll — the commit that first paints rows is the first one in which
  // the selected row's ref exists to scroll to.
  const [searchParams, setSearchParams] = useSearchParams();
  const [followedParams, setFollowedParams] = useState<
    readonly [string | null, string | null]
  >([null, null]);
  const followParam = (id: string) =>
    setFollowedParams(([current]) => [id, current]);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const leagueParam = searchParams.get("league");

  if (
    leagueParam !== null &&
    !followedParams.includes(leagueParam) &&
    management !== undefined
  ) {
    followParam(leagueParam);
    // Handed on RAW, with no cast to `Id<"leagues">` — this string came out of
    // a URL and casting it would only be a lie to the type checker. Anything
    // that is not a live league id of this deployment (a stale link, one copied
    // from another deployment, or a hand-typed nonsense id that does not parse
    // at all) resolves to `null` out of `leagues.getByIdParam` and leaves the
    // panel on its placeholder with no row highlighted. One outcome for all
    // three: there is nothing the operator could do about any of them from
    // here, so none of them gets an error banner — and none of them may throw.
    setSelectedId(leagueParam);
    setAdding(false);
    // The linked row has to be REACHABLE, not merely selected: both filters can
    // hide it from the master list, so following a link clears them.
    setFilter("");
    setSportFilter("all");
  }

  // Bring the row into view once it has rendered. The master list is a 32rem
  // scroller, so the selected row can sit outside it and the link would look
  // like it had done nothing. `block: "nearest"` leaves a row that is already on
  // screen where it is — the usual case for `selectLeague`, which writes the
  // param too.
  const followedLeagueParam = followedParams[0];
  useEffect(() => {
    if (followedLeagueParam === null) return;
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [followedLeagueParam]);

  const loaded: League[] = useMemo(() => management?.leagues ?? [], [management]);

  /**
   * Client-side, and complete: `listForManagement` returns the whole table
   * because there are dozens of leagues, not thousands. The Players screen
   * switches to a search index at two characters precisely because ITS list is
   * a capped page; here there is nothing past the end to miss.
   */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return loaded;
    return loaded.filter((league) => {
      if (league.name.toLowerCase().includes(needle)) return true;
      if (league.abbreviation?.toLowerCase().includes(needle)) return true;
      // Aliases are searchable for the same reason they exist: the operator
      // folding "Amer. League" into this row is very likely typing the spelling
      // they are trying to get RID of.
      return (league.aliases ?? []).some((alias) =>
        alias.toLowerCase().includes(needle),
      );
    });
  }, [loaded, filter]);

  // Fetched by id rather than found in `visible`: the row an operator opens from
  // a near-match, or from the NAME_TAKEN alert, may be excluded by the filter
  // still in the box. This also keeps the panel reactive to its own saves.
  //
  // `getByIdParam`, not `get`: one of the ids that reaches this state came out
  // of the URL, and `get`'s `v.id("leagues")` argument makes a hand-mangled
  // `?league=` a THROWN query rather than an empty panel — which unmounts the
  // screen into the app-level error boundary.
  const selected: League | null | undefined = useQuery(
    api.leagues.getByIdParam,
    selectedId ? { id: selectedId } : "skip",
  );

  /**
   * Every path that opens a league goes through here — a master row, the add
   * form's `Added {name}.`, its near-match `Open {name}` pick, and the detail
   * panel's `NAME_TAKEN` destination — so the URL cannot fall out of step with
   * the panel by one of them forgetting to write it.
   */
  const selectLeague = (id: Id<"leagues">) => {
    setSelectedId(id);
    setAdding(false);
    // `followParam` is part of writing the URL, not bookkeeping after the fact:
    // an id this screen selected itself must never be read back as a fresh link
    // to follow, or the very next render wipes the filter the operator is
    // working under. `replace`, so Back stays an exit from this screen rather
    // than a walk back through every row they looked at.
    followParam(id);
    setSearchParams({ league: id }, { replace: true });
  };

  const needingAttention = loaded.filter(
    (league) => attentionFor(league) !== null,
  ).length;

  const counter = management
    ? `${visible.length} of ${management.totalCount} leagues${
        needingAttention > 0 ? ` · ${needingAttention} need attention` : ""
      }${management.truncated ? " · list truncated" : ""}`
    : "";

  // The announced copy of the counter, one debounce behind the visible one.
  // See COUNTER_ANNOUNCE_DEBOUNCE_MS for why the two cannot be the same node.
  const [announcedCounter, setAnnouncedCounter] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setAnnouncedCounter(counter),
      COUNTER_ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [counter]);

  return (
    <div className="space-y-4">
      {/* Page-level status — the ADD FORM's messages only. Those report on the
          LIST, which sits directly below this line. The detail panel keeps its
          own status line under its action row instead. */}
      {status && (
        <p
          className={`text-sm ${status.isError ? "text-neon-pink" : "text-slate-300"}`}
          role={status.isError ? "alert" : "status"}
        >
          {status.text}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Input
          ref={filterRef}
          label="Filter leagues"
          value={filter}
          placeholder="Start typing a league name…"
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
        <div>
          <label htmlFor="sport-filter" className={LABEL_CLASS}>
            Sport
          </label>
          <select
            id="sport-filter"
            value={sportFilter}
            onChange={(e) => setSportFilter(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
          >
            <option value="all">All sports</option>
            {sportList.map((sport) => (
              <option key={sport._id} value={sport._id}>
                {sport.value}
              </option>
            ))}
          </select>
        </div>
        {/* The counter is the only feedback that a filter or a sport change did
            anything. Centred against the field boxes rather than nudged up with
            a `pb-2`, so it stays put when the row wraps.

            Deliberately NOT a live region itself: it changes on every keystroke,
            and a polite region queues every intermediate value rather than
            replacing it, so filtering by hand read a screen-reader user a count
            per character — none of them current by the time they were spoken.
            The announcement rides the sr-only channel below instead, one
            debounce behind, and this node stays synchronous for the eyes. */}
        <p
          className={`flex items-center text-xs text-slate-400 ${FIELD_BOX_HEIGHT}`}
        >
          {counter}
        </p>
        {/* The announced counter. Mounted unconditionally and from the first
            render, empty or not: a live region that appears at the same moment
            its text does is frequently missed entirely — the region has to
            already exist for the change to be a CHANGE. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcedCounter}
        </span>
        <NeonButton
          type="button"
          onClick={() => {
            setAdding(true);
            setStatus(null);
          }}
        >
          Add league
        </NeonButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,18rem)_1fr] gap-4">
        {/* Master */}
        <div className="rounded-lg border border-slate-800 max-h-[32rem] overflow-y-auto">
          {management === undefined ? (
            <p className="p-3 text-sm text-slate-400">Loading leagues…</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-sm text-slate-400">
              No leagues match that filter.
            </p>
          ) : (
            <ul>
              {visible.map((league) => {
                const isSelected = league._id === selectedId;
                const sportLabel =
                  sportNameById.get(league.sportId as string) ?? "";
                const levelLabel = league.level
                  ? LEVEL_LABEL.get(league.level)
                  : undefined;
                return (
                  <li key={league._id}>
                    <button
                      type="button"
                      ref={isSelected ? selectedRowRef : null}
                      onClick={() => selectLeague(league._id)}
                      aria-current={isSelected ? "true" : undefined}
                      // Two lines, the Players screen's shape and for its
                      // reason: in the 18rem master column a name and three
                      // metadata segments cannot share a line without one of
                      // them truncating, and a clipped league name defeats the
                      // list's only job.
                      className={`flex w-full flex-col gap-y-0.5 px-3 py-2 text-left text-sm border-l-2 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500 ${
                        isSelected
                          ? "border-neon-teal bg-neon-teal/10 text-neon-teal"
                          : "border-transparent text-slate-300 hover:bg-slate-900"
                      }`}
                    >
                      <span className="w-full truncate" title={league.name}>
                        {league.name}
                      </span>
                      <span className="flex w-full items-baseline gap-x-2 text-xs">
                        {/* slate-400, not slate-500 — #64748b on this row is
                            4.0:1, under SC 1.4.3's 4.5:1 floor for text this
                            size. */}
                        {sportLabel && (
                          <span className="shrink-0 text-slate-400">
                            {sportLabel}
                          </span>
                        )}
                        {/* The two facts an operator opens this screen to fix,
                            held apart by hairline rules rather than "·"
                            characters. The rule is CSS, so it stays out of the
                            button's accessible name.

                            A missing value shows a glyph in the attention
                            colour, and the glyph is aria-hidden with the words
                            beside it: "—" and "?" mean nothing read aloud, and
                            a warning only a sighted operator receives is not a
                            warning. */}
                        {league.abbreviation ? (
                          <span
                            className={`min-w-0 shrink-0 truncate pl-2 ${
                              sportLabel ? "border-l border-slate-700" : ""
                            }`}
                          >
                            {league.abbreviation}
                          </span>
                        ) : (
                          <span
                            className={`shrink-0 pl-2 text-neon-orange ${
                              sportLabel ? "border-l border-slate-700" : ""
                            }`}
                            title="No abbreviation yet"
                          >
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">No abbreviation yet</span>
                          </span>
                        )}
                        {levelLabel ? (
                          <span className="min-w-0 truncate border-l border-slate-700 pl-2">
                            {levelLabel}
                          </span>
                        ) : (
                          <span
                            className="shrink-0 border-l border-slate-700 pl-2 text-neon-orange"
                            title="Level not set"
                          >
                            <span aria-hidden="true">?</span>
                            <span className="sr-only">Level not set</span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Detail — the add form takes this column while it is open, rather
            than opening a dialog. A modal here would hide the very list the
            operator is checking their new name against. */}
        <div className="rounded-lg border border-slate-800 p-4">
          {adding ? (
            <AddLeagueForm
              sports={sportList}
              sportId={sportId ?? null}
              onStatus={setStatus}
              // The form reports WHAT it opened; this screen only ever needs
              // the id, because the panel it hands off to re-reads the row.
              onCreated={(league) => selectLeague(league.id)}
              onCancel={() => setAdding(false)}
            />
          ) : selected ? (
            <LeagueDetail
              key={selected._id}
              league={selected}
              sportLabel={
                sportNameById.get(selected.sportId as string) ?? "unknown"
              }
              onSelect={selectLeague}
            />
          ) : (
            <p className="text-sm text-slate-400">
              Select a league to see its teams and edit what we know about it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
