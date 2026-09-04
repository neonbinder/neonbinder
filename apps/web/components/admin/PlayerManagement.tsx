import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/primitives";
import { CopyButton } from "@/components/primitives/CopyButton";
import NeonButton from "@/components/modules/NeonButton";
import TeamPicker from "@/components/SetSelector/TeamPicker";
import {
  NearMatchPanel,
  type NearMatch,
} from "@/components/entities/NearMatchPanel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
// NEO-235: `tenureYears` owns the open-ended-stint rule ("still there" counts
// through the current year). `primaryTeamId` below sums it per team rather than
// re-deriving it — see that function for why it is not `pickDefaultTeamYear`.
import { tenureYears } from "@/lib/players/team-tenure";
// NEO-235: the same two helpers TeamManagement's contrast readout uses, so the
// row and that readout can never disagree about what a colour pair scores.
import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";
// NEO-212 security review: `WIKIDATA_QID` used to be re-declared here. It now
// comes from the one module that also gates the href — see
// lib/players/wikidata-id.ts.
import { WIKIDATA_QID, wikidataUrl } from "@/lib/players/wikidata-id";

/**
 * NEO-212 — Player Management, the `/admin/teams` twin.
 *
 * Players are globally-shared rows keyed on (normalized name, sport), and until
 * now the only ways one could be created were the checklist reconciler and the
 * entity-review wizard — both of which run mid-import, against names a
 * marketplace chose. There was no screen for "this player's name is wrong",
 * "this is the same person as that one", or "record the two seasons he spent in
 * Kansas City". This is that screen.
 *
 * Master-detail, deliberately identical in shape to TeamManagement: the list is
 * for FINDING a player, the panel is for everything known about the one you
 * picked. Two things differ, and both come from scale:
 *
 *  1. **The list is not the whole table.** `listForManagement` caps at 500 and
 *     reports `truncated`; past two characters this screen stops filtering that
 *     page client-side and switches to the `search_name` index instead. A
 *     client-side filter over a capped page silently answers "no such player"
 *     for anyone past the cap, which is exactly the wrong answer on the screen
 *     whose job is to prevent duplicates.
 *  2. **Creating asks first.** The add form runs `players.nearMatches` as you
 *     type and demotes its own create button when the name already exists —
 *     see the comment on the primary action below.
 */

type Player = Omit<Doc<"players">, "createdByUserId">;
type SportRow = Doc<"selectorOptions">;

/** One career stint, in the shape `savePlayerFields` takes. */
type Stint = { teamId: Id<"teams">; fromYear: number; toYear?: number };

type Status = { text: string; isError: boolean } | null;

/**
 * Below two characters the search index is not worth a subscription — a
 * one-letter search matches most of the table — so the loaded page is filtered
 * in the browser instead. At two the screen switches to `players.search`.
 */
const SEARCH_MIN_CHARS = 2;

/** See PlayerAutocomplete: one Convex subscription per distinct arg set, so an
 *  undebounced field opens one per keystroke. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Longer than the filter's. This one fires while the operator is still typing a
 * name they intend to CREATE, and a suggestion that reshuffles under a
 * half-typed name is noise; the filter's job is to keep up with typing, this
 * one's is to be right once they pause.
 */
const NEAR_MATCH_DEBOUNCE_MS = 300;

/**
 * `fromYear` ascending, open-ended stint last among stints starting the same
 * year — the same ordering `convex/players.ts#sortTeamYears` persists. Repeated
 * here rather than imported because importing a Convex module pulls
 * `./_generated/server` into the browser bundle.
 */
function sortStints(stints: Stint[]): Stint[] {
  return [...stints].sort(
    (a, b) =>
      a.fromYear - b.fromYear ||
      (a.toYear ?? Number.POSITIVE_INFINITY) -
        (b.toYear ?? Number.POSITIVE_INFINITY),
  );
}

function stintsEqual(a: Stint[], b: Stint[]): boolean {
  const key = (s: Stint[]) =>
    JSON.stringify(
      sortStints(s).map((x) => [x.teamId, x.fromYear, x.toYear ?? null]),
    );
  return key(a) === key(b);
}

function stintRange(stint: Stint): string {
  return `${stint.fromYear}–${stint.toYear ?? "present"}`;
}

/**
 * NEO-235 — the franchise a player is most associated with, for the master row.
 *
 * Deliberately NOT `pickDefaultTeamYear` from lib/players/team-tenure.ts, and
 * the difference is the reason there are two. That one names a single STINT,
 * because the spine label it feeds has to print that stint's years ("Angels
 * 2011–2019"), so a summed total would leave it with nothing to print. This
 * one names a TEAM and prints no years at all, so the honest reading of "played
 * with the longest" is the SUM of the stints there: a player with two four-year
 * runs in Seattle and one six-year run in Cincinnati is a Mariner to anyone who
 * collects him, and per-stint ranking would file him under the Reds. That
 * module anticipated this exact split ("a separate function over the same rows,
 * not a change to these two"), so only `tenureYears` is borrowed.
 *
 * Ties go to the earliest `fromYear` — with nothing to separate two franchises
 * by time served, the one he came up with is the one the hobby names him after.
 *
 * Returns null for a player with no stints; the row then shows the sport alone.
 */
function primaryTeamId(
  stints: Stint[] | undefined,
  currentYear: number,
): Id<"teams"> | null {
  if (!stints || stints.length === 0) return null;

  const totals = new Map<string, { years: number; firstYear: number }>();
  for (const stint of stints) {
    const key = stint.teamId as string;
    const running = totals.get(key);
    totals.set(key, {
      years: (running?.years ?? 0) + tenureYears(stint, currentYear),
      firstYear: Math.min(running?.firstYear ?? stint.fromYear, stint.fromYear),
    });
  }

  let bestId: string | null = null;
  let best: { years: number; firstYear: number } | null = null;
  for (const [id, totalled] of totals) {
    if (
      best === null ||
      totalled.years > best.years ||
      (totalled.years === best.years && totalled.firstYear < best.firstYear)
    ) {
      bestId = id;
      best = totalled;
    }
  }
  return bestId as Id<"teams"> | null;
}

/**
 * The team as a fan says it out loud: "Padres", not "San Diego Padres".
 *
 * Only the row's own stored `city` is stripped, and only as a whole leading
 * word — nothing here guesses where a city ends. A team whose `city` was never
 * enriched keeps its full name, which is the safe failure: a longer label,
 * never a wrong one.
 *
 * Row-only. The detail panel and the career-history list stay on full names —
 * an operator editing a stint needs the name the row actually carries, and the
 * E2E flows match on it.
 */
function teamNickname(team: { name: string; city?: string }): string {
  const name = team.name.trim();
  const city = team.city?.trim();
  if (!city) return name;
  if (!name.toLowerCase().startsWith(`${city.toLowerCase()} `)) return name;
  const nickname = name.slice(city.length).trim();
  return nickname.length > 0 ? nickname : name;
}

/**
 * NEO-235 — the master row paints the team nod in the team's OWN livery rather
 * than in a NeonBinder accent, because a franchise's colours are how a
 * collector recognises it before they have finished reading the word.
 *
 * These are the two backgrounds a row is ever painted on. `ROW_BG_IDLE` is
 * slate-900, the HOVER fill — not the page's near-black underneath it. The
 * hover state is the lightest an unselected row ever gets, so a light colour
 * that clears 4.5:1 there clears it everywhere else on that row; a dark one
 * fails against both and is rejected either way. `ROW_BG_SELECTED` is
 * `bg-neon-blue/10` (#00C2FF at 10%) composited over that near-black, worked
 * out once here rather than guessed at, because the selected row is measurably
 * lighter and a colour can pass on one row and fail on the other.
 */
const ROW_BG_IDLE = "#0f172a";
const ROW_BG_SELECTED = "#02192e";

/** WCAG 2.2 SC 1.4.3 for text this size. Not a readout, a gate — this is UI. */
const ROW_TEXT_MIN_CONTRAST = 4.5;

/**
 * The team's own colour for the row label, or null to leave it muted.
 *
 * Primary first, secondary as the fallback, default when neither clears the
 * floor. That order is not a nicety: a great many franchises are built on a
 * near-black navy or maroon (the Yankees' #132448 scores about 1.4:1 on a
 * slate-900 row) and their secondary is the pale one precisely because it is
 * what they print the dark on. So the fallback is usually the RIGHT colour for
 * the team as well as the readable one.
 *
 * Colour is never the only carrier: the label reads the same word whichever
 * branch is taken, so a muted row loses decoration and no information (SC
 * 1.4.1). `normalizeHexColor` first, so a stored `#FFF` or an unhashed value
 * is measured and emitted in the same form.
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
    if (ratio !== null && ratio >= ROW_TEXT_MIN_CONTRAST) return hex;
  }
  return null;
}

/**
 * NEO-235 — the four fields the detail panel seeds a draft from, flattened
 * into one comparable string.
 *
 * Object identity is useless here: `useQuery` hands back a fresh object on
 * every reactive push, so "did the row actually change?" has to be asked of the
 * VALUES. Normalised the same way the draft normalises them before saving
 * (trimmed name and id, stints sorted, an absent `toYear` as null) so an
 * untouched draft compares equal to the row it came from.
 */
function fieldSignature(fields: {
  name: string;
  isHallOfFame: boolean;
  wikidataId: string;
  stints: Stint[];
}): string {
  return JSON.stringify([
    fields.name.trim(),
    fields.isHallOfFame,
    fields.wikidataId.trim(),
    sortStints(fields.stints).map((s) => [
      s.teamId,
      s.fromYear,
      s.toYear ?? null,
    ]),
  ]);
}

/** {@link fieldSignature} for a stored row. */
function rowSignature(row: Player): string {
  return fieldSignature({
    name: row.name,
    isHallOfFame: row.isHallOfFame ?? false,
    wikidataId: row.externalIds?.wikidataId ?? "",
    stints: row.teamYears ?? [],
  });
}

/**
 * Height of an `Input` box: 24px line-height + 2×8px padding + 2×1px border.
 * Anything that has to sit on the same baseline as a field — the read-only
 * sport, the Hall of Fame checkbox — matches it rather than guessing.
 */
const FIELD_BOX_HEIGHT = "min-h-[2.625rem]";

/**
 * Two lines of `text-sm leading-tight`, reserved for every label in the
 * add-stint row so the controls under them share one baseline whether or not a
 * given label wraps. "Stint to year (optional)" does wrap in the ~440px detail
 * column at 1024px wide and does not at 1440px; without the reserve that single
 * wrap dropped its input 18px below its neighbour's, which is the ragged row
 * NEO-235 was filed about. `items-end` inside the reserve keeps the text on the
 * line nearest its own field.
 */
const STINT_LABEL_CLASS =
  "mb-1 flex min-h-[2.25rem] items-end text-sm font-medium leading-tight text-slate-300";

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

/**
 * Its own component so `useQuery(nearMatches)` is mounted only while the form
 * is open — the lookup costs a subscription and there is no reason to hold one
 * for a form nobody opened.
 */
function AddPlayerForm({
  sports,
  defaultSportId,
  onStatus,
  onCreated,
  onCancel,
}: {
  sports: SportRow[];
  /** Pre-selected from the list's sport filter, when one is set. */
  defaultSportId: Id<"selectorOptions"> | null;
  onStatus: (status: Status) => void;
  onCreated: (id: Id<"players">) => void;
  onCancel: () => void;
}) {
  const createByAdmin = useMutation(api.players.createByAdmin);

  const [name, setName] = useState("");
  const [sportId, setSportId] = useState<string>(defaultSportId ?? "");
  const [debouncedName, setDebouncedName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedName(name),
      NEAR_MATCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [name]);

  // Three characters, not two: `nearMatches` is a duplicate guard, and two
  // letters match half the table without telling the operator anything.
  const probe = debouncedName.trim();
  const matches: NearMatch[] | undefined = useQuery(
    api.players.nearMatches,
    probe.length >= 3 && sportId
      ? { name: probe, sportId: sportId as Id<"selectorOptions"> }
      : "skip",
  );

  const trimmed = name.trim();
  // The panel exports `hasExact` for callers that only need the boolean; this
  // one needs the ROW as well, to name the button, and the find narrows the
  // type where the predicate could not.
  const exact = (matches ?? []).find((m) => m.confidence === "exact");
  /**
   * What the panel still has to show once the primary action has been promoted.
   *
   * Mirrors EntityReviewWizard's `panelMatches` deliberately: when an exact
   * match exists the primary button IS that row — same id, same `Open {name}`
   * accessible name — so listing it again below puts two controls with one
   * accessible name on screen, which is ambiguous to a screen reader reading
   * the list and to a Maestro `tapOn` matching by it. Filtered by `_id`, not by
   * confidence: any OTHER row is a genuinely different player and still belongs
   * in the list. If nothing else remains this is `[]`, which the panel already
   * renders as no panel at all.
   */
  const panelMatches = exact
    ? (matches ?? []).filter((m) => m._id !== exact._id)
    : matches;
  const canCreate = trimmed.length > 0 && sportId.length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    onStatus(null);
    try {
      const result = await createByAdmin({
        name: trimmed,
        sportId: sportId as Id<"selectorOptions">,
      });
      onStatus(
        result.created
          ? { text: `Added ${trimmed}.`, isError: false }
          : { text: "That player already exists — opened it.", isError: false },
      );
      onCreated(result.id);
    } catch (e) {
      onStatus({
        text: userFacingMessage(e, "Could not add that player."),
        isError: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Add a player</h3>

      <Input
        label="New player name"
        value={name}
        placeholder="Ken Griffey Jr."
        onChange={(e) => setName(e.target.value)}
      />

      <div>
        <label
          htmlFor="new-player-sport"
          className="block text-sm font-medium mb-1 text-slate-300"
        >
          Sport
        </label>
        <select
          id="new-player-sport"
          value={sportId}
          onChange={(e) => setSportId(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
        >
          <option value="">— pick a sport —</option>
          {sports.map((sport) => (
            <option key={sport._id} value={sport._id}>
              {sport.value}
            </option>
          ))}
        </select>
      </div>

      <NearMatchPanel
        kind="player"
        matches={panelMatches}
        // Not "Link to": this button opens the row for editing, it does not
        // link anything to anything.
        pickLabel={(n) => `Open ${n}`}
        onPick={(id) => onCreated(id as Id<"players">)}
      />

      {/* The primary action swaps rather than the create button merely warning.
          An operator who has just been shown the row they were about to
          duplicate is, nine times in ten, looking for THAT row; making "open
          it" the green button and demoting creation to a plain text button
          makes the safe move the easy one. "Create anyway" is still one press
          away — a genuine second player with the same name is real (two Ken
          Griffeys), so this must never be a block. */}
      <div className="flex flex-wrap items-center gap-3">
        {/*
          ONE primary button element across both states (NEO-212 a11y).
          `nearMatches` lands ~300ms after the operator stops typing, so `exact`
          can appear while the create button already HAS focus — and a ternary
          swapping which element renders here unmounts the focused node, sending
          focus to <body> so the next Tab restarts at the top of the page (WCAG
          2.2 SC 3.2.2 / 2.4.3). Label, handler and enablement are props on a
          single element, so React patches the node and focus survives.
        */}
        <NeonButton
          type="button"
          onClick={() => {
            if (exact) {
              onCreated(exact._id as Id<"players">);
              return;
            }
            void create();
          }}
          disabled={exact ? false : !canCreate}
          aria-label={exact ? undefined : `Create player ${trimmed}`}
        >
          {exact ? `Open ${exact.name}` : busy ? "Adding…" : "Create player"}
        </NeonButton>
        {exact && (
          <button
            type="button"
            onClick={() => void create()}
            disabled={!canCreate}
            aria-label={`Create player ${trimmed} anyway`}
            className="min-h-6 rounded px-2 py-1 text-sm text-slate-300 underline underline-offset-2 transition-colors hover:text-neon-green focus:outline-none focus:ring-2 focus:ring-neon-green disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Adding…" : "Create anyway"}
          </button>
        )}
        <NeonButton type="button" cancel onClick={onCancel} disabled={busy}>
          Cancel
        </NeonButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function PlayerDetail({
  player,
  sportLabel,
  onSelect,
}: {
  player: Player;
  sportLabel: string;
  onSelect: (id: Id<"players">) => void;
}) {
  const savePlayerFields = useMutation(api.players.savePlayerFields);
  const enrichFromWikidata = useAction(api.players.enrichFromWikidata);

  // Local draft state, re-seeded when the selected player changes. Binding
  // straight to the live row would drop keystrokes whenever an unrelated
  // reactive update landed mid-edit (NEO-39).
  const [name, setName] = useState(player.name);
  const [isHallOfFame, setIsHallOfFame] = useState(
    player.isHallOfFame ?? false,
  );
  const [wikidataId, setWikidataId] = useState(
    player.externalIds?.wikidataId ?? "",
  );
  const [stints, setStints] = useState<Stint[]>(
    sortStints(player.teamYears ?? []),
  );
  const [pendingTeam, setPendingTeam] = useState<Id<"teams"> | null>(null);
  const [pendingFrom, setPendingFrom] = useState("");
  const [pendingTo, setPendingTo] = useState("");
  const [stintError, setStintError] = useState<string | null>(null);
  const [nameTakenId, setNameTakenId] = useState<Id<"players"> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * NEO-212 (a11y/UX): the panel's own status line, rendered directly under the
   * action row rather than routed to the page-level line at the top of the
   * screen. On a 1024x629 viewport that top line sits ~600px above the Save
   * button and is off-screen when it is pressed, so a sighted mouse user got no
   * confirmation and, worse, never saw WHY a save failed. `role="status"` had
   * it announced to AT the whole time — this was a sighted-user-only gap.
   *
   * Detail-originated messages live here and ONLY here: exactly one live region
   * announces each one. The add form's messages stay page-level on purpose —
   * they report on the list, which the top line sits directly above.
   */
  const [status, setStatus] = useState<Status>(null);

  /**
   * NEO-235 — the draft follows the LIVE row, not just the selected `_id`.
   *
   * `createByAdmin` schedules Wikidata enrichment, so seconds after a player is
   * added by hand the server row grows `teamYears`, `externalIds.wikidataId`
   * and `isHallOfFame`. Everything reading the row directly moved — the master
   * row started saying "2 stints", the header link above these fields started
   * showing the QID — while the draft, seeded once per `_id`, went on saying
   * "No stints recorded yet." next to an empty Wikidata box. The panel
   * contradicted itself on screen.
   *
   * `seeded.signature` is the row AS SEEDED. When the live row moves, three
   * comparisons decide what happens:
   *
   *   - **draft === seeded** — nothing has been typed. Adopt the new row.
   *   - **draft === live** — the row caught up with what is already on screen.
   *     That is our own save landing (or someone else saving the same edit);
   *     adopting is a no-op for the fields and only re-bases `seeded`, so a
   *     save can never be mistaken for a write from elsewhere.
   *   - **otherwise** — adopting would destroy real edits. Keep the draft and
   *     say so; `Reload` below is the way out.
   *
   * The signature covers the seeded FIELDS and deliberately not `lastUpdated`:
   * a write that changed none of them (a re-enrichment that found nothing new)
   * must not throw a "someone changed this" notice at an operator mid-edit.
   */
  const [seeded, setSeeded] = useState(() => ({
    id: player._id,
    signature: rowSignature(player),
  }));
  const [rowMovedUnderDraft, setRowMovedUnderDraft] = useState(false);

  /** Take the row as it now stands, discarding whatever the fields held. */
  const seedFrom = (row: Player) => {
    setName(row.name);
    setIsHallOfFame(row.isHallOfFame ?? false);
    setWikidataId(row.externalIds?.wikidataId ?? "");
    setStints(sortStints(row.teamYears ?? []));
    setSeeded({ id: row._id, signature: rowSignature(row) });
    setRowMovedUnderDraft(false);
  };

  const liveSignature = rowSignature(player);
  const draftSignature = fieldSignature({
    name,
    isHallOfFame,
    wikidataId,
    stints,
  });

  // Adjusted during render — React's documented "adjust state when props
  // change" pattern rather than an effect, which the lint rule rejects. Same
  // mechanism as TeamManagement's TeamDetail.
  if (seeded.id !== player._id) {
    seedFrom(player);
    setPendingTeam(null);
    setPendingFrom("");
    setPendingTo("");
    setStintError(null);
    setNameTakenId(null);
    // Otherwise "Saved Ken Griffey Jr." stays on screen under a different
    // player's Save button.
    setStatus(null);
  } else if (seeded.signature !== liveSignature) {
    if (
      draftSignature === seeded.signature ||
      draftSignature === liveSignature
    ) {
      seedFrom(player);
    } else if (!rowMovedUnderDraft) {
      setRowMovedUnderDraft(true);
    }
  }

  /** The notice's `Reload`: throw the draft away — including anything staged in
   *  the add-stint row — and start again from the row as it now stands. */
  const reloadFromRow = () => {
    seedFrom(player);
    setPendingTeam(null);
    setPendingFrom("");
    setPendingTo("");
    setStintError(null);
    setNameTakenId(null);
  };

  /** Caption under the Wikidata field. Its own row in the grid (see the render)
   *  rather than the primitive's `helperText`, so the field boxes above it stay
   *  on one line; the association it would have lost is passed back by hand. */
  const qidCaptionId = useId();

  // One batched lookup for every team named anywhere in this panel — the drafted
  // stints plus whatever the picker currently holds, so the duplicate refusal
  // below can name the team rather than saying "that team".
  const teamIds = useMemo(() => {
    const ids = stints.map((s) => s.teamId);
    if (pendingTeam && !ids.includes(pendingTeam)) ids.push(pendingTeam);
    return ids;
  }, [stints, pendingTeam]);
  const teamRows = useQuery(api.teams.getManyByIds, { ids: teamIds });
  const teamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of teamRows ?? []) map.set(row._id as string, row.name);
    return map;
  }, [teamRows]);
  const teamName = (id: Id<"teams">) => teamNameById.get(id as string) ?? "…";

  const trimmedName = name.trim();
  const trimmedQid = wikidataId.trim();
  const qidValid = trimmedQid.length === 0 || WIKIDATA_QID.test(trimmedQid);

  const nameChanged = trimmedName !== player.name;
  const hofChanged = isHallOfFame !== (player.isHallOfFame ?? false);
  const qidChanged = trimmedQid !== (player.externalIds?.wikidataId ?? "");
  const stintsChanged = !stintsEqual(stints, player.teamYears ?? []);
  const dirty = nameChanged || hofChanged || qidChanged || stintsChanged;
  const canSave =
    dirty && trimmedName.length > 0 && qidValid && busy === null;

  const addStint = () => {
    setStintError(null);
    const from = Number(pendingFrom);
    if (!pendingTeam || !pendingFrom || !Number.isInteger(from)) {
      setStintError("Pick a team and a whole start year.");
      return;
    }
    const to = pendingTo ? Number(pendingTo) : undefined;
    if (pendingTo && !Number.isInteger(to)) {
      setStintError("An end year must be a whole year.");
      return;
    }
    if (to !== undefined && to < from) {
      setStintError("A career stint cannot end before it starts.");
      return;
    }
    // (team, fromYear), NOT team: two stints at one franchise are real history
    // — traded away, re-signed later — and the server keeps both. Only a
    // literal repeat is refused, and it is refused HERE so nothing is sent.
    if (
      stints.some((s) => s.teamId === pendingTeam && s.fromYear === from)
    ) {
      setStintError(
        `${teamName(pendingTeam)} already has a stint starting in ${from}.`,
      );
      return;
    }
    setStints(
      sortStints([
        ...stints,
        { teamId: pendingTeam, fromYear: from, ...(to !== undefined ? { toYear: to } : {}) },
      ]),
    );
    setPendingTeam(null);
    setPendingFrom("");
    setPendingTo("");
  };

  const removeStint = (index: number) => {
    setStints(stints.filter((_, i) => i !== index));
    setStintError(null);
  };

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    setStatus(null);
    setNameTakenId(null);
    try {
      // Only what changed. `savePlayerFields` treats every arg as optional and
      // an omitted one as "leave it alone", so sending the whole draft would
      // rewrite `teamYears` on a rename and re-validate stints nobody touched.
      await savePlayerFields({
        id: player._id,
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(hofChanged ? { isHallOfFame } : {}),
        ...(qidChanged ? { wikidataId: trimmedQid || null } : {}),
        ...(stintsChanged ? { teamYears: sortStints(stints) } : {}),
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
        setNameTakenId(taken[1] as Id<"players">);
      } else {
        setStatus({
          text: userFacingMessage(e, "Could not save that player."),
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
      await enrichFromWikidata({ id: player._id });
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

  const qid = player.externalIds?.wikidataId;
  const qidUrl = wikidataUrl(qid);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* NEO-212 (a11y): h3, not h4. Nothing on this screen renders an
            <h3> above it, so an <h4> here skipped a level and a screen reader
            navigating by heading gets a broken outline (WCAG 2.2 SC 1.3.1). */}
        <h3 className="text-lg font-semibold leading-tight">{player.name}</h3>
        <CopyButton value={player.name} label="player name" />
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
            Open the existing player
          </button>
        </div>
      )}

      {/* NEO-235 — the fields on a real grid.
          Three rows, each an explicit two-column grid rather than one auto-flow
          container: the old single grid let a bare `Sport:` caption, a lone
          checkbox and a field carrying its own helper line each set their own
          height, so no two controls started or ended on the same line.
          `sm:items-end` is what does the alignment work — every cell here is
          built to end at the bottom edge of an input box (see
          FIELD_BOX_HEIGHT), so the boxes, the read-only sport and the checkbox
          all land on one line. */}
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
          <Input
            label="Player name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          {/* Read-only on purpose. Moving a player between sports is not an
              edit, it is a re-key: `nameNormalized` is unique per (name,
              sport), every lookup scopes by sportId, and existing card rows
              point at this row under the old sport. Out of scope for NEO-212 —
              delete the row and re-add it under the right sport if it is
              genuinely wrong.

              NEO-235: painted as a field rather than as a caption floating
              beside one. Recessed surface and a dimmer border say "not yours to
              change" without `disabled`'s opacity, which would have taken the
              text under the 4.5:1 floor. The visible text stays exactly
              `Sport: {label}` — the E2E flow reads this line to prove the row
              was created under the sport that was picked. */}
          <p
            className={`w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-base text-slate-300 ${FIELD_BOX_HEIGHT}`}
          >
            Sport: {sportLabel}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
          <Input
            label="Wikidata id"
            value={wikidataId}
            placeholder="Q…"
            onChange={(e) => setWikidataId(e.target.value)}
            // The caption is rendered as its own grid row below so the boxes
            // stay on one line; `helperText`/`error` would have put it inside
            // this cell and pushed the box up off the checkbox's line. The
            // association the primitive would have made is made by hand.
            aria-describedby={qidCaptionId}
            aria-invalid={qidValid ? undefined : true}
          />

          <label
            className={`flex items-center gap-2 text-sm text-slate-200 ${FIELD_BOX_HEIGHT}`}
          >
            <input
              type="checkbox"
              checked={isHallOfFame}
              onChange={(e) => setIsHallOfFame(e.target.checked)}
              className="h-6 w-6 shrink-0 rounded border-slate-700 bg-slate-900 text-neon-green focus:outline-none focus:ring-2 focus:ring-neon-green"
            />
            Hall of Fame
          </label>
        </div>

        {/* The caption row. One line, always in the same place, whether it is
            saying how to clear the field or why the id is refused. */}
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          <p
            id={qidCaptionId}
            className={`text-sm ${qidValid ? "text-slate-400" : "text-neon-pink"}`}
          >
            {qidValid
              ? "Leave empty to clear it."
              : "A Wikidata id looks like Q12345."}
          </p>
        </div>
      </div>

      {/* NEO-235 — the row moved while there were unsaved edits on screen.
          Deliberately not a modal and not an auto-adopt: the operator's own
          typing is the thing most likely to be lost, so nothing is overwritten
          until they say so. Orange rather than pink — nothing has failed. */}
      {rowMovedUnderDraft && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-neon-orange/40 bg-neon-orange/5 px-3 py-2 text-sm text-neon-orange"
        >
          <span>This player was updated elsewhere — Reload to see the latest.</span>
          <button
            type="button"
            onClick={reloadFromRow}
            aria-label={`Reload player ${player.name}`}
            className="min-h-6 rounded px-2 py-1 underline underline-offset-2 transition-colors hover:bg-neon-orange/10 focus:outline-none focus:ring-2 focus:ring-neon-orange"
          >
            Reload
          </button>
        </div>
      )}

      {/* A hairline, not a card: the career history is a second subject within
          the same panel, and boxing it would have implied a second surface. */}
      <div className="space-y-3 border-t border-slate-800 pt-4">
        {/* Stays a plain, non-interactive heading directly above the add row:
            the E2E flow taps this text to dismiss TeamPicker's popover, which
            can only ever hang BELOW the trigger, so the heading is the one
            thing in this section the popover can never cover. */}
        <h3 className="text-base font-semibold">Career history</h3>

        {stints.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-800 px-3 py-2 text-sm text-slate-400">
            No stints recorded yet.
          </p>
        ) : (
          <ul
            aria-label="Career history"
            className="divide-y divide-slate-800 rounded-md border border-slate-800"
          >
            {stints.map((stint, index) => (
              <li
                key={`${stint.teamId}-${stint.fromYear}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5 text-sm text-slate-200"
              >
                {/* NEO-235 — the stint row is a way INTO the team.
                    Correcting a stint usually means the team behind it needs
                    looking at (wrong colors, no league, a name to fix), and
                    the only route there was to leave, open Team Management
                    and retype the name that was already on screen.

                    The whole "{team} · {years}" string is one link, name and
                    years together, so the row still reads as a single piece of
                    text: the E2E flow matches that string and anchors a
                    `below:` assertion on it, and a link wrapping only the name
                    would split it into two text nodes for both of those. The
                    visible text IS the accessible name, so no aria-label —
                    `title` carries the destination for a pointer instead. */}
                <span className="truncate">
                  <Link
                    to={`/admin/teams?team=${stint.teamId}`}
                    title={`Open ${teamName(stint.teamId)} in Team Management`}
                    className="rounded-sm text-neon-blue underline underline-offset-2 transition-colors hover:text-neon-blue/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-blue"
                  >
                    {teamName(stint.teamId)} · {stintRange(stint)}
                  </Link>
                </span>
                <button
                  type="button"
                  onClick={() => removeStint(index)}
                  aria-label={`Remove ${teamName(stint.teamId)} ${stint.fromYear} stint`}
                  className="min-h-6 shrink-0 rounded px-2 py-1 text-xs text-neon-pink transition-colors hover:bg-neon-pink/10 focus:outline-none focus:ring-2 focus:ring-neon-pink"
                >
                  Remove stint
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* NEO-235 — one baseline for the whole add row.
            It was `flex flex-wrap`, which in the ~440px detail column dropped
            the year boxes onto a second line under the picker (straight beneath
            its popover) and left the four controls on three different baselines.
            A grid fixes the columns instead: the picker sizes to its pill, the
            two year fields split the remaining width EQUALLY — equal widths are
            what stop one label wrapping a beat before the other — and the
            button takes what it needs. `items-end` puts every control's bottom
            edge on the same line whatever its label did. */}
        <div className="grid max-w-2xl grid-cols-2 items-end gap-x-3 gap-y-3 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <span className={STINT_LABEL_CLASS}>Team</span>
            <div className={`flex items-center ${FIELD_BOX_HEIGHT}`}>
              <TeamPicker
                // Single stint at a time, so the picker's array is collapsed to
                // its most recent pick rather than accumulating chips: a stint
                // has one team, and the multi-select is the shared component's
                // contract, not this field's.
                value={pendingTeam ? [pendingTeam] : []}
                onChange={(next) => {
                  setStintError(null);
                  setPendingTeam(next.length > 0 ? next[next.length - 1] : null);
                }}
                sportId={player.sportId}
              />
            </div>
          </div>

          {/* `bare`, so this file owns the label markup and can give both year
              labels the same reserved height — the primitive's own label is a
              fixed one-line block and cannot be told to reserve two. Geometry
              comes with `bare` being the caller's job (see the Input header);
              the primitive still supplies the surface and the Maestro-unique
              marker class. */}
          <label className="block min-w-0">
            <span className={STINT_LABEL_CLASS}>Stint from year</span>
            <Input
              bare
              type="number"
              value={pendingFrom}
              onChange={(e) => setPendingFrom(e.target.value)}
              className="w-full px-3 py-2 text-base"
            />
          </label>

          <label className="block min-w-0">
            <span className={STINT_LABEL_CLASS}>Stint to year (optional)</span>
            <Input
              bare
              type="number"
              value={pendingTo}
              placeholder="present"
              onChange={(e) => setPendingTo(e.target.value)}
              className="w-full px-3 py-2 text-base"
            />
          </label>

          {/* NEO-212 (a11y): NeonButton's `secondary` paints white on #00C2FF
              — 2.07:1, under SC 1.4.3's 4.5:1 floor. The primitive is shared by
              the whole app so it is not repainted here; this call site
              overrides only the foreground through the `style` passthrough
              NeonButton already spreads last (black on #00C2FF is 10.2:1). */}
          <NeonButton
            type="button"
            secondary
            style={{ color: "#000000" }}
            onClick={addStint}
            className="justify-self-start"
          >
            Add stint
          </NeonButton>
        </div>

        {stintError && (
          <p role="alert" className="text-sm text-neon-pink">
            {stintError}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
        <NeonButton type="button" onClick={() => void save()} disabled={!canSave}>
          {busy === "save" ? "Saving…" : "Save"}
        </NeonButton>
        <NeonButton
          type="button"
          secondary
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

export default function PlayerManagement() {
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [sportFilter, setSportFilter] = useState<string>("all");
  // A plain string, not `Id<"players">`, and that is the point: one of the
  // things that lands here is the `?player=` param, which anybody can retype.
  // `players.getByIdParam` takes the raw string and answers `null` for anything
  // that is not a live player id — see the comment on the deep link below.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedFilter(filter),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [filter]);

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
    api.players.listForManagement,
    sportId ? { sportId } : {},
  );

  const searchTerm = debouncedFilter.trim();
  const searching = filter.trim().length >= SEARCH_MIN_CHARS;
  const results = useQuery(
    api.players.search,
    searchTerm.length >= SEARCH_MIN_CHARS
      ? { query: searchTerm, ...(sportId ? { sportId } : {}) }
      : "skip",
  );

  // The filter takes focus once the list has loaded, because the only reason to
  // open this screen is to work on a specific player and typing their name is
  // how you get there.
  //
  // Gated on `management !== undefined`, not on mount: on the teams screen the
  // equivalent effect ran against a not-yet-mounted input and silently did
  // nothing (an E2E flow that typed without tapping first is what exposed it).
  // `hasFocusedRef` keeps it ONE-SHOT — `management` changes on every reactive
  // write to the players table and on every sport-filter change, and yanking
  // focus back mid-edit would be worse than never focusing at all.
  const filterRef = useRef<HTMLInputElement>(null);
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    if (management === undefined || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    filterRef.current?.focus();
  }, [management]);

  // NEO-235 — arriving here from somewhere else, on one player.
  //
  // `/admin/players?player=<id>` opens the screen with that player already
  // selected, and every selection writes the id back. The second half is what
  // the first half is for: the detail panel links each career stint to
  // `/admin/teams?team=<id>`, and without an id in this screen's own history
  // entry, Back from there returns to an empty list the operator has to find
  // their way back through by typing the name again.
  //
  // The param is followed during RENDER, not in an effect. The effect version
  // sets state on a commit that has already happened, which cascades a second
  // render and the lint rule rejects it; this is React's documented "adjust
  // state when a prop changes" pattern, the same one PlayerDetail above uses to
  // re-seed its draft. `/admin/teams` follows its `?team` param the same way.
  //
  // `followedParams` is what keeps it to once per distinct id: this runs on
  // every reactive update to the players table, and re-selecting on each one
  // would pull the operator off a row they had clicked since arriving.
  // `selectPlayer` below marks it too — the param IT writes is the operator's
  // own selection, not a fresh link to follow, so it must not be re-treated as
  // one and wipe the filter they are working under.
  //
  // TWO ids are remembered, not one, and that is not belt-and-braces. React
  // Router applies every location update inside `startTransition` — the app's
  // `BrowserRouter` and the tests' `MemoryRouter` share that code path — so the
  // render that commits a new selection is a render in which `searchParams`
  // STILL NAMES THE PREVIOUS PLAYER; the URL catches up one render later. A
  // one-slot marker cannot tell that stale value apart from a fresh link back
  // to that player, so it follows it — and because following a link clears the
  // filters, the filter the operator typed a moment ago empties itself under
  // their own click. Remembering the superseded id closes exactly that window,
  // and the "never again" half of the filter test is what pins it.
  //
  // The cost of the second slot is that a link BACK to the player just left
  // would be ignored for as long as this screen stays mounted. Nothing can
  // produce one: every write here is a `replace`, so there is no history entry
  // to go back to, and no other screen links to `?player=`.
  //
  // Gated on the LIST having loaded rather than on the id resolving, which are
  // two different things here. The id goes straight to `getByIdParam` below, so
  // the panel opens for a player the master list cannot show at all — one past
  // `listForManagement`'s 500-row cap, or one the search index has not been
  // asked for. The gate exists for the scroll: the commit that first paints
  // rows is the first one in which the selected row's ref exists to scroll to.
  const [searchParams, setSearchParams] = useSearchParams();
  const [followedParams, setFollowedParams] = useState<
    readonly [string | null, string | null]
  >([null, null]);
  const followParam = (id: string) =>
    setFollowedParams(([current]) => [id, current]);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const playerParam = searchParams.get("player");

  if (
    playerParam !== null &&
    !followedParams.includes(playerParam) &&
    management !== undefined
  ) {
    followParam(playerParam);
    // Handed on RAW, with no cast to `Id<"players">` — this string came out of
    // a URL and casting it would only be a lie to the type checker. Anything
    // that is not a live player id of this deployment (a stale link, one copied
    // from another deployment, or a hand-typed nonsense id that does not parse
    // at all) resolves to `null` out of `players.getByIdParam` and leaves the
    // panel on its placeholder with no row highlighted. One outcome for all
    // three: there is nothing the operator could do about any of them from
    // here, so none of them gets an error banner — and none of them may throw.
    setSelectedId(playerParam);
    setAdding(false);
    // The linked row has to be REACHABLE, not merely selected: both filters
    // can hide it from the master list, so following a link clears them. The
    // debounced copy is cleared with the box it mirrors, or the search
    // subscription outlives the term that opened it.
    setFilter("");
    setDebouncedFilter("");
    setSportFilter("all");
  }

  // Bring the row into view once it has rendered. The master list is a 32rem
  // scroller, so the selected row can easily sit outside it and the link would
  // look like it had done nothing. `block: "nearest"` leaves a row that is
  // already on screen where it is — the usual case for `selectPlayer`, which
  // writes the param too. A deep-linked player with no row at all (past the
  // cap) simply has nothing to scroll to; the detail panel still opens.
  const followedPlayerParam = followedParams[0];
  useEffect(() => {
    if (followedPlayerParam === null) return;
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [followedPlayerParam]);

  const loaded = useMemo(() => management?.players ?? [], [management]);

  /**
   * The one-character case stays client-side (see SEARCH_MIN_CHARS); from two
   * characters the search index answers instead, and its results are already
   * sport-scoped by the query argument.
   */
  const visible = useMemo(() => {
    if (searching) return results ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return loaded;
    return loaded.filter((p) => p.name.toLowerCase().includes(needle));
  }, [searching, results, loaded, filter]);

  /**
   * NEO-235 — the team nod on each master row.
   *
   * ONE batched lookup for the whole visible page, not one per row: the longest
   * team is derived from `teamYears`, which every row already carries, so the
   * only thing missing is names. Unique ids, so a page of 500 Yankees costs a
   * single id; sorted, so the arg set is stable across reactive pushes that
   * reorder nothing (Convex keys a subscription on the serialized args).
   *
   * `getManyByIds` takes an unbounded `v.array(v.id("teams"))` and does one
   * `db.get` each, so no chunking is needed at this list's 500-row cap — a page
   * that size cannot name more distinct teams than there are teams.
   */
  const currentYear = new Date().getFullYear();
  const rowTeamIdByPlayer = useMemo(() => {
    const map = new Map<string, Id<"teams">>();
    for (const player of visible) {
      const teamId = primaryTeamId(player.teamYears, currentYear);
      if (teamId) map.set(player._id as string, teamId);
    }
    return map;
  }, [visible, currentYear]);

  const rowTeamIds = useMemo(
    () => [...new Set(rowTeamIdByPlayer.values())].sort(),
    [rowTeamIdByPlayer],
  );

  const rowTeamRows = useQuery(
    api.teams.getManyByIds,
    rowTeamIds.length > 0 ? { ids: rowTeamIds } : "skip",
  );

  const rowTeamById = useMemo(() => {
    const map = new Map<
      string,
      { label: string; colors?: { primary?: string; secondary?: string } }
    >();
    for (const team of rowTeamRows ?? []) {
      map.set(team._id as string, {
        label: teamNickname(team),
        colors: team.colors,
      });
    }
    return map;
  }, [rowTeamRows]);

  // Fetched by id rather than found in `visible`: the row an operator opens
  // from a near-match, or from the NAME_TAKEN alert, is frequently NOT in the
  // current page — it may be past the 500 cap or excluded by the filter that is
  // still in the box. This also keeps the panel reactive to its own saves.
  //
  // `getByIdParam`, not `get`: one of the ids that reaches this state came out
  // of the URL, and `get`'s `v.id("players")` argument makes a hand-mangled
  // `?player=` a THROWN query rather than an empty panel — which unmounts the
  // screen into the app-level error boundary. One query for both sources, not
  // two: an id off the master list is a valid string, so it normalizes and
  // resolves exactly as before, and a second subscription would only be a
  // second way for the panel to disagree with itself.
  const selected = useQuery(
    api.players.getByIdParam,
    selectedId ? { id: selectedId } : "skip",
  );

  /**
   * Every path that opens a player goes through here — a master row, the add
   * form's `Added {name}.`, its near-match `Open {name}` pick, and the detail
   * panel's `NAME_TAKEN` destination — so the URL cannot fall out of step with
   * the panel by one of them forgetting to write it.
   */
  const selectPlayer = (id: Id<"players">) => {
    setSelectedId(id);
    setAdding(false);
    // Keep the URL in step with the selection, so the player on screen is the
    // player a reload or a shared link reopens — and so Back from a career
    // stint's Team Management link comes back to this player rather than to
    // the bare list. `followParam` is part of writing it, not bookkeeping
    // after the fact: an id this screen selected itself must never be read
    // back as a fresh link to follow, or the very next render wipes the filter
    // the operator is working under. `replace`, so Back stays an exit from
    // this screen rather than a walk back through every row they looked at.
    followParam(id);
    setSearchParams({ player: id }, { replace: true });
  };

  const counter = searching
    ? results === undefined
      ? ""
      : `${visible.length} matches`
    : management
      ? `${visible.length} of ${management.totalCount} players${
          management.truncated ? " · list truncated, type to search" : ""
        }`
      : "";

  return (
    <div className="space-y-4">
      {/* Page-level status — the ADD FORM's messages only ("Added {name}.",
          "That player already exists — opened it."). Those report on the LIST,
          which sits directly below this line, so the top of the page is where
          they belong. The detail panel keeps its own status line under its
          action row instead; see PlayerDetail (NEO-212). */}
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
          label="Filter players"
          value={filter}
          placeholder="Start typing a player name…"
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
        <div>
          <label
            htmlFor="sport-filter"
            className="block text-sm font-medium mb-1 text-slate-300"
          >
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
        {/* NEO-212 (a11y): the counter is the only feedback that a filter or
            a sport change did anything — silent for a screen-reader user until
            it was a live region. Text format unchanged: the E2E flow waits on
            "0 matches". */}
        {/* NEO-235: centred against the field boxes rather than nudged up with
            a `pb-2`, so it stays put when the row wraps. */}
        <p
          role="status"
          aria-live="polite"
          className={`flex items-center text-xs text-slate-400 ${FIELD_BOX_HEIGHT}`}
        >
          {counter}
        </p>
        <NeonButton
          type="button"
          onClick={() => {
            setAdding(true);
            setStatus(null);
          }}
        >
          Add player
        </NeonButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,18rem)_1fr] gap-4">
        {/* Master */}
        <div className="rounded-lg border border-slate-800 max-h-[32rem] overflow-y-auto">
          {searching && results === undefined ? (
            <p className="p-3 text-sm text-slate-400">Searching…</p>
          ) : management === undefined && !searching ? (
            <p className="p-3 text-sm text-slate-400">Loading players…</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-sm text-slate-400">
              No players match that filter.
            </p>
          ) : (
            <ul>
              {visible.map((player) => {
                const isSelected = player._id === selectedId;
                const sportLabel =
                  sportNameById.get(player.sportId as string) ?? "";
                const rowTeamId = rowTeamIdByPlayer.get(player._id as string);
                const rowTeam = rowTeamId
                  ? rowTeamById.get(rowTeamId as string)
                  : undefined;
                // The row this is measured against is the one it will be
                // painted on: selecting a player lightens the background, and
                // a colour that cleared 4.5:1 on an idle row can stop clearing
                // it on the selected one.
                const teamColor = rowTeam
                  ? teamTextColor(
                      rowTeam.colors,
                      isSelected ? ROW_BG_SELECTED : ROW_BG_IDLE,
                    )
                  : null;
                return (
                  <li key={player._id}>
                    <button
                      type="button"
                      ref={isSelected ? selectedRowRef : null}
                      onClick={() => selectPlayer(player._id)}
                      aria-current={isSelected ? "true" : undefined}
                      // NEO-235 — TWO LINES, and the second one is the whole
                      // reason. Measured in the 18rem master column at 1024px:
                      // the row has 262px of content, the sport tag and its
                      // separator take 59 of them, and that leaves 187px for a
                      // name and a team that need about 112 and 99. They do not
                      // both fit, so a single line has to truncate one of them,
                      // and neither answer is any good — a clipped "Bartolo
                      // C…" defeats the list's only job, and a clipped "New
                      // York Y…" is a worse nod than no nod. Given a line of
                      // its own the metadata gets the full 262px and the name
                      // gets it too, so "Christian Bethancourt-Villarreal" and
                      // "New York Yankees" both render whole. It costs about
                      // five visible rows out of fourteen, which is affordable
                      // here precisely because nobody scans this list: the
                      // filter takes focus on load and typing a name is how you
                      // get to a player.
                      className={`flex w-full flex-col gap-y-0.5 px-3 py-2 text-left text-sm border-l-2 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500 ${
                        isSelected
                          ? "border-neon-blue bg-neon-blue/10 text-neon-blue"
                          : "border-transparent text-slate-300 hover:bg-slate-900"
                      }`}
                    >
                      {/* NEO-235 — the row answers "which of the people with
                          similar names is this?", and nothing else. The Hall of
                          Fame tag, the stint count and the "Q…" Wikidata glyph
                          all moved out: none of them tells two Tony Gwynns
                          apart, and four competing sizes and colours per row
                          made the NAMES — the only thing anyone comes to this
                          list for — the hardest thing on it to read. All three
                          are still in the detail panel, in full. */}
                      <span className="w-full truncate" title={player.name}>
                        {player.name}
                      </span>
                      <span className="flex w-full items-baseline gap-x-2 text-xs">
                        {/* NEO-212 (a11y): slate-400, not slate-500 — #64748b
                            on this row is 4.0:1, under SC 1.4.3's 4.5:1 floor
                            for text this size. slate-400 clears it. */}
                        {sportLabel && (
                          <span className="shrink-0 text-slate-400">
                            {sportLabel}
                          </span>
                        )}
                        {/* The team nod, held apart from the sport by a hairline
                            rule rather than a "·". The rule is CSS, so it stays
                            out of the button's accessible name — which reads
                            "Ken Griffey Jr. Baseball Padres", three plain words
                            — and it appears ONLY when there are two facts to
                            separate: a player with no recorded stints shows the
                            sport alone, and the row's structure says so.

                            Painted in the team's own livery when that colour is
                            readable here (see `teamTextColor`); the rule earns
                            its keep twice over, holding a fixed neutral apart
                            from a segment that changes colour row to row.
                            `text-slate-300` stays on the element as the fallback
                            the inline colour overrides, so a team with no
                            readable colour is simply muted rather than absent.

                            `truncate` + `title` for the farm clubs ("Gulf Coast
                            League Yankees Development Complex"); truncation is
                            CSS, so the full string stays in the DOM for the E2E
                            matcher and for assistive tech. */}
                        {rowTeam && (
                          <span
                            className="min-w-0 truncate border-l border-slate-700 pl-2 text-slate-300"
                            title={rowTeam.label}
                            style={teamColor ? { color: teamColor } : undefined}
                          >
                            {rowTeam.label}
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
            <AddPlayerForm
              sports={sportList}
              defaultSportId={sportId ?? null}
              onStatus={setStatus}
              onCreated={selectPlayer}
              onCancel={() => setAdding(false)}
            />
          ) : selected ? (
            <PlayerDetail
              key={selected._id}
              player={selected}
              sportLabel={
                sportNameById.get(selected.sportId as string) ?? "unknown"
              }
              onSelect={selectPlayer}
            />
          ) : (
            <p className="text-sm text-slate-400">
              Select a player to see and edit everything we know about them.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
