import { useEffect, useId, useMemo, useRef, useState } from "react";
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
                <span className="truncate">
                  {teamName(stint.teamId)} · {stintRange(stint)}
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
  const [selectedId, setSelectedId] = useState<Id<"players"> | null>(null);
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

  // Fetched by id rather than found in `visible`: the row an operator opens
  // from a near-match, or from the NAME_TAKEN alert, is frequently NOT in the
  // current page — it may be past the 500 cap or excluded by the filter that is
  // still in the box. This also keeps the panel reactive to its own saves.
  const selected = useQuery(
    api.players.get,
    selectedId ? { id: selectedId } : "skip",
  );

  const selectPlayer = (id: Id<"players">) => {
    setSelectedId(id);
    setAdding(false);
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
                const stintCount = player.teamYears?.length ?? 0;
                const qid = player.externalIds?.wikidataId;
                return (
                  <li key={player._id}>
                    <button
                      type="button"
                      onClick={() => selectPlayer(player._id)}
                      aria-current={isSelected ? "true" : undefined}
                      // NEO-235: `items-baseline`, not `items-center` — the
                      // name is text-sm and every tag beside it is text-xs, so
                      // centring left five slightly different lines through one
                      // row. One gap value across the whole row, and every tag
                      // `shrink-0` so the NAME is what gives when the row is
                      // narrow.
                      className={`flex w-full items-baseline gap-x-2 px-3 py-2 text-left text-sm border-l-2 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500 ${
                        isSelected
                          ? "border-neon-blue bg-neon-blue/10 text-neon-blue"
                          : "border-transparent text-slate-300 hover:bg-slate-900"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {player.name}
                      </span>
                      {/* NEO-212 (a11y): slate-400, not slate-500 — #64748b on
                          the slate-950 row is 4.0:1, under SC 1.4.3's 4.5:1
                          floor for this size. slate-400 clears it. */}
                      <span className="shrink-0 text-xs text-slate-400">
                        {sportNameById.get(player.sportId as string) ?? ""}
                      </span>
                      {/* NEO-212 (a11y): `title` is a mouse-hover affordance
                          and nothing else — it is not announced reliably and
                          never on touch or keyboard. The aria-label puts the
                          expansion into the row's accessible name, so "HoF"
                          and "Q…" are not two unexplained glyphs. */}
                      {player.isHallOfFame && (
                        <span
                          className="shrink-0 text-xs text-neon-orange"
                          aria-label="Hall of Fame"
                          title="Hall of Fame"
                        >
                          HoF
                        </span>
                      )}
                      {stintCount > 0 && (
                        <span className="shrink-0 text-xs text-slate-400">
                          {stintCount} {stintCount === 1 ? "stint" : "stints"}
                        </span>
                      )}
                      {qid && (
                        <span
                          className="shrink-0 text-xs text-neon-teal"
                          aria-label={`Wikidata ${qid}`}
                          title={`Wikidata ${qid}`}
                        >
                          Q…
                        </span>
                      )}
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
