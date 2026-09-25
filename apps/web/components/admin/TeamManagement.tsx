import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Input, Textarea } from "@/components/primitives";
import { Autocomplete } from "@/components/primitives/Autocomplete";
import { normalizeOrderedEntityName } from "@/lib/entities/normalize-name";
import NeonButton from "@/components/modules/NeonButton";
import { parseAliases } from "@/components/SetSelector/NewLeagueForm";
import { AddLeagueDialog } from "./AddLeagueDialog";
import { FIELD_BOX_HEIGHT } from "./AddLeagueForm";
import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { teamFullName, teamShortName } from "@/lib/teams/team-name";
import { eraLabel, teamOptionLabel } from "@/lib/teams/team-era";
import { useFollowedParam } from "@/src/hooks/use-followed-param";

/**
 * NEO-236 security review — the browser-side half of `teams.saveTeamFields`'s
 * length cap.
 *
 * A courtesy bound, not the enforcement. The SERVER checks the COMPOSED name
 * ("San Diego" + " " + "Padres") against this same number and refuses with a
 * `ConvexError`, which is what actually protects the row; `maxLength` here
 * just stops the operator typing a paragraph into a field that was always
 * going to be rejected. Deliberately per-field rather than a live composed
 * count: a maxLength that moves as you type the other box silently eats
 * keystrokes, and a refusal an operator can read beats an input that fights
 * them. Keep this in step with `MAX_TEAM_NAME_LENGTH` in convex/teams.ts.
 */
const MAX_TEAM_NAME_LENGTH = 120;

/**
 * NEO-156 — Team Management.
 *
 * Replaces NEO-147's flat colors worklist, which listed every team needing
 * attention as a card with its own inputs. That was fine when colors were the
 * only editable field and wrong the moment leagues arrived: a page of long
 * stacked forms has nowhere to put a fifth field, and no way to look at one
 * team.
 *
 * Master-detail instead. The list is for finding a team; the panel is for
 * everything known about the one you picked. Adding a field is a row in the
 * panel rather than another control on every card.
 *
 * The filter takes focus on arrival, because the only reason to open this
 * screen is to work on a specific team and typing its name is how you get
 * there.
 */

type Team = Doc<"teams">;

/**
 * NEO-240 — `leagues.level`, widened to `string`.
 *
 * The column arrives with League Management, and this screen only ever reads
 * it to decide an order. Typing it as `string` rather than off `Doc<"leagues">`
 * means the screen compiles before the schema change lands AND keeps compiling
 * if the union later grows a member — an unrecognized level sorts with the
 * unset ones instead of failing to typecheck.
 */
type League = Doc<"leagues"> & { level?: string };

/**
 * NEO-254 — a franchise row, as this screen needs it.
 *
 * Structural rather than `Doc<"franchises">` for the reason `League` above is:
 * the screen only reads a name, a sport and a count, and typing it that way
 * keeps it compiling independently of the table's other columns.
 */
type Franchise = {
  _id: Id<"franchises">;
  name: string;
  sportId: Id<"selectorOptions">;
};

/** Sentinel for the "no league" option — a select's value must be a string. */
const NO_LEAGUE = "";
/**
 * The "add a new league" option's value.
 *
 * A COMMAND, not a value: choosing it opens a dialog and the select snaps back
 * to the league the draft already had. Nothing downstream ever sees this string
 * — `leagueId` is never set to it, so `save()` has no sentinel to unpick and
 * the "Manage leagues" link has no impossible id to guard against.
 */
const ADD_LEAGUE = "__add__";
/** The league filter's "every team" value — not an id, so it is never a param. */
const ALL_LEAGUES = "all";

/** NEO-254 — the franchise field's "not on a thread" value. */
const NO_FRANCHISE = "";

/** NEO-307 — the Franchise field's "not on a thread" option, as a list key. */
const NO_FRANCHISE_KEY = "no-franchise";

/**
 * NEO-284 — how long the "also answers to" note has to hold still before it
 * is ANNOUNCED.
 *
 * The visible note is synchronous: `teams.aliasesInUse` re-runs with new args
 * on nearly every keystroke in the alias box, and a sighted operator watching
 * the sentence appear is how they learn a name is shared. A live region
 * cannot behave that way — `aria-live="polite"` queues every intermediate
 * value, so typing "Miami Hurricanes" would read a screen-reader user a
 * sentence per character, none of them current by the time it was spoken.
 * Same number and same reasoning as League Management's counter.
 */
const ALIAS_NOTE_ANNOUNCE_DEBOUNCE_MS = 400;

/**
 * Competitive tier, most prominent first.
 *
 * Leagues are listed in this order rather than alphabetically because the
 * league an operator wants is nearly always the top-flight one: a baseball
 * team is MLB far more often than it is any of the affiliates, indy leagues
 * and college conferences that outnumber it in the list. Alphabetical order
 * buries the common answer among the rare ones.
 */
const LEVEL_ORDER: readonly string[] = [
  "major",
  "minor",
  "college",
  "international",
  "independent",
  "other",
];

/** Unset — and any level this build does not know — sorts last. */
function levelRank(league: League): number {
  const index = league.level ? LEVEL_ORDER.indexOf(league.level) : -1;
  return index === -1 ? LEVEL_ORDER.length : index;
}

/** Level first, then name. Applied once, so both league pickers agree. */
function byLevelThenName(a: League, b: League): number {
  return levelRank(a) - levelRank(b) || a.name.localeCompare(b.name);
}

type Status = { text: string; isError: boolean } | null;

/**
 * NEO-254 moved `useFollowedParam` to `src/hooks/use-followed-param.ts`, so
 * Franchise Management shares it rather than growing a second copy. Its
 * docstring carries the `startTransition` reasoning the two-slot marker exists
 * for; read that before changing either caller.
 */

function ColorSwatch({ hex, label }: { hex?: string; label: string }) {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 rounded border border-slate-600 align-middle"
      style={{ background: hex ?? "transparent" }}
      title={hex ? `${label}: ${hex}` : `${label}: not set`}
      aria-label={hex ? `${label} ${hex}` : `${label} not set`}
      role="img"
    />
  );
}

/**
 * What still needs a human, per team. Derived rather than served as buckets:
 * the server returns the two underlying facts and the screen decides how to
 * present them, so a new state does not need a new query shape.
 */
function attentionFor(team: Team): "choice" | "colors" | null {
  if ((team.colorCandidates?.length ?? 0) > 0) return "choice";
  if (!team.colors?.primary) return "colors";
  return null;
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function TeamDetail({
  team,
  leagues,
  franchises,
  onSelect,
}: {
  team: Team;
  leagues: League[];
  franchises: Franchise[];
  /**
   * NEO-253 — open another team from this panel. Today's only caller is the
   * `NAME_TAKEN` alert below, which has the OTHER row's id and would otherwise
   * leave the operator to go and search for a team they have just been told
   * exists. Same shape and same reason as `PlayerManagement`'s.
   */
  onSelect: (id: Id<"teams">) => void;
}) {
  const saveTeamFields = useMutation(api.teams.saveTeamFields);
  const findOrCreateFranchise = useMutation(api.franchises.findOrCreate);
  const enrichFromWikidata = useAction(api.teams.enrichFromWikidata);
  const chooseColorSource = useAction(api.teamColorSources.chooseColorSource);

  // Local draft state, re-seeded when the selected team changes. Binding
  // straight to the live row would drop keystrokes whenever an unrelated
  // reactive update landed mid-edit (NEO-39).
  const [name, setName] = useState(team.name);
  const [leagueId, setLeagueId] = useState<string>(team.leagueId ?? NO_LEAGUE);
  const [addingLeague, setAddingLeague] = useState(false);
  /**
   * Leagues created from the dialog, held here until the reactive list catches
   * up.
   *
   * `leagues.list` re-runs and this row arrives on its own a moment later — but
   * a controlled `<select>` whose value names an option it does not have renders
   * BLANK, so for that moment the operator would watch their new league vanish
   * out of the dropdown they just added it to. Merged by id, so the local copy
   * disappears silently the instant the real row lands.
   */
  const [addedLeagues, setAddedLeagues] = useState<
    { id: Id<"leagues">; name: string }[]
  >([]);
  const leagueSelectRef = useRef<HTMLSelectElement>(null);
  /**
   * NEO-254 — the franchise thread. NEO-307 — picked from a type-ahead.
   *
   * `newFranchises` is the same optimistic tail `addedLeagues` is, and exists
   * for the same reason: a thread the operator just started is the answer the
   * moment `findOrCreate` returns, but `franchises.list` catches up a round
   * trip later, and without the tail the field would read blank until it did.
   *
   * `franchiseQuery` is what the operator has typed into the field, or `null`
   * while they have not — the same resting/typing split `NewTeamForm`'s League
   * field uses. `null` shows the current answer's label and the whole list;
   * typing narrows the list WITHOUT changing the answer, and a pick, a blur or
   * Escape puts it back to `null`.
   */
  const [franchiseId, setFranchiseId] = useState<string>(
    team.franchiseId ?? NO_FRANCHISE,
  );
  const [franchiseQuery, setFranchiseQuery] = useState<string | null>(null);
  const [newFranchises, setNewFranchises] = useState<
    { id: Id<"franchises">; name: string }[]
  >([]);
  const [location, setLocation] = useState(team.location ?? "");
  const [fromYear, setFromYear] = useState(
    team.yearsActive?.from ? String(team.yearsActive.from) : "",
  );
  const [toYear, setToYear] = useState(
    team.yearsActive?.to ? String(team.yearsActive.to) : "",
  );
  const [primary, setPrimary] = useState(team.colors?.primary ?? "");
  const [secondary, setSecondary] = useState(team.colors?.secondary ?? "");
  /**
   * NEO-284 — the other names this team answers to, as the comma list the
   * operator types. Seeded from the stored list joined the same way League
   * Management seeds its box, so an untouched draft parses back to exactly
   * what is stored and Save has nothing to send.
   */
  const [aliasText, setAliasText] = useState((team.aliases ?? []).join(", "));
  const [nameTakenId, setNameTakenId] = useState<Id<"teams"> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * NEO-236 — a refused save, shown WHERE THE OPERATOR CAN ACT ON IT.
   *
   * The name-collision refusal ("Another team in this sport is already called
   * San Diego Padres.") is about the two fields directly above this message and
   * is fixed by editing them, so it belongs next to them rather than in the
   * screen-level status line at the top of the page — which, on a panel that is
   * usually scrolled past the fold, is off-screen at the moment Save is pressed.
   *
   * Only a ConvexError's `data` crosses production intact; everything else gets
   * the fallback (see `userFacingMessage`).
   */
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * NEO-254 — the SUCCESS line, in the panel, beside the button that produced
   * it.
   *
   * It used to be hoisted to the screen-level status line at the top of the
   * page through `onStatus`, and the note on `saveError` directly above already
   * said why that was wrong for a refusal: this panel is usually scrolled past
   * the fold, so the top of the page is off-screen at the moment Save is
   * pressed. The success line had the same defect and nothing had tripped over
   * it yet.
   *
   * NEO-254's Franchise field made the panel tall enough to trip it. Two E2E
   * flows scroll the Save button into view, tap it, and assert "Saved <name>."
   * is VISIBLE; with the page pinned at its new maximum scroll, the line
   * rendered correctly at the top of the document and was simply not on screen.
   * Both had been green for months, which is the tell — nothing about saving
   * changed, only the height above it.
   *
   * So it renders where its cause is. `role="status"` rather than a plain
   * paragraph: it appears after an async round trip that a screen-reader user
   * has no other way to know finished.
   *
   * NEO-260 widened it from `Saved <name>` to EVERY message this panel makes.
   * Discover, "pick the right source page" and "Started the <name> franchise.
   * Save the team to put it on there." were all still being hoisted through
   * `onStatus` to that same screen-level line, for exactly the reason NEO-236
   * and NEO-254 had already rejected twice. The last one is the clearest case:
   * its whole content is an instruction to press the Save button it was being
   * rendered ~570px away from. The screen-level line has no producers left and
   * is gone; `onStatus` is gone from this panel's props with it.
   */
  const [panelStatus, setPanelStatus] = useState<Status>(null);
  /**
   * NEO-212 (a11y) — the preview and the refusal are ASSOCIATED with BOTH
   * fields, not merely printed under them.
   *
   * "Shows as: San Diego Padres" is a fact about Location and Name together, so
   * both inputs point at it and a screen-reader user hears the composed name on
   * entering either one. The ids live on the paragraphs; the inputs carry only
   * `aria-describedby`, because `Input` never emits an `id` of its own (an id
   * would clobber the `aria-label` Maestro derives `resource-id` from).
   */
  const previewId = useId();
  const errorId = useId();
  // NEO-236: the Location/Name rule, described by BOTH fields rather than sat
  // silently beside them — the split is only obvious once you have been told
  // what counts as a location.
  const helpId = useId();
  // NEO-284: the alias caption. On the paragraph, pointed at by the box.
  const aliasCaptionId = useId();

  // Re-seed on selection change. Keyed on _id so editing a field does not
  // clobber itself; this is React's documented "adjust state when props
  // change" pattern rather than an effect, which the lint rule rejects.
  const [seededId, setSeededId] = useState(team._id);
  if (seededId !== team._id) {
    setSeededId(team._id);
    setName(team.name);
    setLeagueId(team.leagueId ?? NO_LEAGUE);
    setAddingLeague(false);
    setAddedLeagues([]);
    setFranchiseId(team.franchiseId ?? NO_FRANCHISE);
    setFranchiseQuery(null);
    setNewFranchises([]);
    setLocation(team.location ?? "");
    setFromYear(team.yearsActive?.from ? String(team.yearsActive.from) : "");
    setToYear(team.yearsActive?.to ? String(team.yearsActive.to) : "");
    setPrimary(team.colors?.primary ?? "");
    setSecondary(team.colors?.secondary ?? "");
    setAliasText((team.aliases ?? []).join(", "));
    setSaveError(null);
    // NEO-284 fixed a dangling `setSaveStatus` here (NEO-260 renamed the
    // state to `panelStatus` and missed this line). Unreachable in practice —
    // the parent keys this panel by `_id` — which is why nothing tripped it.
    setPanelStatus(null);
    setNameTakenId(null);
  }

  /**
   * NEO-236 — the row's name is composed, never stored whole.
   *
   * `fullName` is what this team is called everywhere outside the two admin
   * master rows; `draftFullName` is what it WOULD be called if the operator
   * pressed Save now, which is what the preview line under the fields shows.
   */
  const fullName = teamFullName(team);
  const draftFullName = teamFullName({ name, location });
  const describedBy =
    [helpId, name.trim() ? previewId : null, saveError ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const normalizedPrimary = primary ? normalizeHexColor(primary) : null;
  const normalizedSecondary = secondary ? normalizeHexColor(secondary) : null;
  const colorsValid =
    (!primary || normalizedPrimary) && (!secondary || normalizedSecondary);
  const ratio =
    normalizedPrimary && normalizedSecondary
      ? contrastRatio(normalizedSecondary, normalizedPrimary)
      : null;

  const canSave = name.trim().length > 0 && colorsValid;

  /**
   * NEO-284 — the box, as the list it stands for. Parsed with the league
   * form's parser (split on commas, trim, drop empties, dedupe) so the three
   * alias boxes in this app cannot disagree about what a comma means.
   */
  const draftAliases = useMemo(() => parseAliases(aliasText), [aliasText]);
  const storedAliases = team.aliases ?? [];
  const aliasesChanged =
    JSON.stringify(draftAliases) !== JSON.stringify(storedAliases);
  /**
   * NEO-284 — who else in this sport already answers to one of these names.
   *
   * A shared alias is LEGAL and sometimes deliberate: "Miami" belongs to the
   * Hurricanes and the RedHawks, and the card year is what decides which one
   * a checklist means. So this is a note, never a refusal — but an operator
   * typing one should hear it here rather than from a review queue three sets
   * later. Skipped while the box is empty; the server bounds the list.
   */
  const sharedAliases = useQuery(
    api.teams.aliasesInUse,
    draftAliases.length > 0
      ? { sportId: team.sportId, aliases: draftAliases, selfId: team._id }
      : "skip",
  );
  const aliasNote = (sharedAliases ?? [])
    .map(
      (hit) =>
        `${hit.name} also answers to “${hit.alias}”. Cards will ask which one when the years don't decide.`,
    )
    .join(" ");
  // The announced copy of the note, one debounce behind the visible one. See
  // ALIAS_NOTE_ANNOUNCE_DEBOUNCE_MS for why the two cannot be the same node.
  const [announcedAliasNote, setAnnouncedAliasNote] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setAnnouncedAliasNote(aliasNote),
      ALIAS_NOTE_ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [aliasNote]);

  /**
   * Every league this dropdown can offer, in the order the parent sorted them,
   * with anything just created from the dialog appended.
   *
   * The tail is deliberately unsorted: a row that appears for a second or two
   * before the query re-runs would only be moving somewhere else while the
   * operator looked at it. Last is where they left it.
   */
  const leagueOptions = useMemo(() => {
    const known = new Set(leagues.map((league) => league._id as string));
    return [
      ...leagues.map((league) => ({
        id: league._id as string,
        label: league.abbreviation
          ? `${league.name} (${league.abbreviation})`
          : league.name,
      })),
      ...addedLeagues
        .filter((league) => !known.has(league.id as string))
        .map((league) => ({ id: league.id as string, label: league.name })),
    ];
  }, [leagues, addedLeagues]);

  /** Every thread this group can offer, plus anything just started here. */
  const franchiseOptions = useMemo(() => {
    const known = new Set(franchises.map((f) => f._id as string));
    return [
      ...franchises
        .map((f) => ({ id: f._id as string, label: f.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      // The optimistic tail: a thread started from the field is offered at
      // once rather than disappearing for the moment before `franchises.list`
      // re-runs. Deliberately unsorted — an option that moved somewhere else
      // while the operator was looking at it is worse than one out of order.
      ...newFranchises
        .filter((f) => !known.has(f.id as string))
        .map((f) => ({ id: f.id as string, label: f.name })),
    ];
  }, [franchises, newFranchises]);

  /*
   * ── NEO-307: the Franchise options, as the type-ahead lists them ─────────
   *
   * Jason, 2026-09-25, approving the change after League went the same way:
   * the franchise pills, capped at 24 behind a filter box, were the control he
   * had just called "a terrible interface" for leagues, and the NEO-254
   * preload mints one franchise per thread across five sports.
   *
   * At rest the whole sport, alphabetical, then "No franchise" — always there,
   * because taking a team OFF its thread is an answer (Save sends `null`).
   * Typing narrows on the name, case-insensitive, raw or normalized (so
   * "titans oilers" finds "Titans / Oilers"); franchises carry no aliases.
   * `Start “<typed>”` is offered ONLY when the typed text matches no franchise
   * at all — the same rule Jason set for League, and for the same reason: a
   * partial match means the thread is probably already here.
   */
  type FranchiseOption = { key: string; label: string; choose: () => void };
  const noFranchiseOption: FranchiseOption = {
    key: NO_FRANCHISE_KEY,
    label: "No franchise",
    choose: () => setFranchiseId(NO_FRANCHISE),
  };
  const franchiseTyped = franchiseQuery?.trim() ?? "";
  const franchiseTypedLower = franchiseTyped.toLowerCase();
  const franchiseTypedKey = franchiseTyped
    ? normalizeOrderedEntityName(franchiseTyped)
    : "";
  const franchiseMatches = franchiseTyped
    ? franchiseOptions.filter(
        (f) =>
          f.label.toLowerCase().includes(franchiseTypedLower) ||
          (franchiseTypedKey !== "" &&
            normalizeOrderedEntityName(f.label).includes(franchiseTypedKey)),
      )
    : franchiseOptions;
  const franchiseListOptions: FranchiseOption[] = franchiseMatches.map((f) => ({
    key: f.id,
    label: f.label,
    choose: () => setFranchiseId(f.id),
  }));
  if (
    franchiseTyped &&
    franchiseTypedKey &&
    franchiseMatches.length === 0 &&
    franchiseTypedKey !== normalizeOrderedEntityName(noFranchiseOption.label)
  ) {
    franchiseListOptions.push({
      key: `start:${franchiseTypedKey}`,
      label: `Start “${franchiseTyped}”`,
      choose: () => void createFranchise(franchiseTyped),
    });
  }
  franchiseListOptions.push(noFranchiseOption);

  /** The current answer — its option key, and the words the field shows. */
  const franchiseCurrentKey =
    franchiseId === NO_FRANCHISE ? NO_FRANCHISE_KEY : franchiseId;
  const franchiseCurrentLabel =
    franchiseId === NO_FRANCHISE
      ? noFranchiseOption.label
      : (franchiseOptions.find((f) => f.id === franchiseId)?.label ?? "");

  /**
   * Create the thread the operator just named and put this team's draft on it.
   *
   * Find-or-create, so pressing it twice — or naming a thread that already
   * exists under a different word order — selects the existing row rather than
   * failing on a duplicate the operator cannot see. The TEAM is not saved here:
   * starting a franchise and deciding this team belongs to it are two
   * decisions, and Save still commits the second.
   */
  const createFranchise = async (typed: string) => {
    const name = typed.trim();
    if (!name || busy !== null) return;
    setBusy("franchise");
    setSaveError(null);
    try {
      const { id, created } = await findOrCreateFranchise({
        name,
        sportId: team.sportId,
      });
      setNewFranchises((rows) =>
        rows.some((row) => row.id === id) ? rows : [...rows, { id, name }],
      );
      setFranchiseId(id);
      setPanelStatus({
        text: created
          ? `Started the ${name} franchise. Save the team to put it on there.`
          : `${name} was already a franchise. Save the team to put it on there.`,
        isError: false,
      });
    } catch (e) {
      setSaveError(
        userFacingMessage(e, "Could not start that franchise. Try again."),
      );
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    setSaveError(null);
    setPanelStatus(null);
    setNameTakenId(null);
    try {
      // The league already exists by the time Save is pressed — the dialog
      // creates it and hands back an id. Nothing about a league is written
      // from here any more.
      const resolvedLeagueId: Id<"leagues"> | null =
        leagueId !== NO_LEAGUE ? (leagueId as Id<"leagues">) : null;
      // NEO-254: the franchise exists by the time Save is pressed — the inline
      // box creates it and hands back an id. `null` is a real answer here, and
      // it is the one the franchise view's "Remove from franchise" sends too.
      const resolvedFranchiseId: Id<"franchises"> | null =
        franchiseId !== NO_FRANCHISE ? (franchiseId as Id<"franchises">) : null;

      const from = Number(fromYear);
      const to = Number(toYear);
      await saveTeamFields({
        id: team._id,
        name: name.trim(),
        leagueId: resolvedLeagueId,
        franchiseId: resolvedFranchiseId,
        location: location.trim() || null,
        yearsActive:
          fromYear && Number.isFinite(from)
            ? { from, ...(toYear && Number.isFinite(to) ? { to } : {}) }
            : null,
        colors: normalizedPrimary
          ? {
              primary: normalizedPrimary,
              ...(normalizedSecondary
                ? { secondary: normalizedSecondary }
                : {}),
            }
          : null,
        // NEO-284 — only when the list moved. Unlike the fields above, an
        // alias write re-syncs the lookup table behind it, so sending an
        // unchanged list on every Save would be a rewrite nobody asked for.
        ...(aliasesChanged ? { aliases: draftAliases } : {}),
      });
      // In the panel, not hoisted — see `panelStatus`.
      setPanelStatus({ text: `Saved ${draftFullName}.`, isError: false });
    } catch (e) {
      // Inline, not the status line: every way this call can fail is a thing
      // about the fields above it — the name is taken, the name is empty, the
      // colour is not a hex — and the panel is where it gets fixed.
      //
      // NEO-253 — one refusal is more than a sentence. `NAME_TAKEN:<id>`
      // carries the OTHER row's id precisely so this screen can offer to go
      // there, so it is parsed out into its own state rather than printed: the
      // "Open the existing team" button below is gated on that id being
      // present, never on the shape of the message text. Read `.data` first
      // (the only thing that survives production's redaction) and fall back to
      // `.message` for the dev path — verbatim from `PlayerManagement`, which
      // has had this since the same guard was added on the players side.
      const raw =
        e && typeof e === "object" && "data" in e && typeof e.data === "string"
          ? e.data
          : e instanceof Error
            ? e.message
            : "";
      const taken = /NAME_TAKEN:([^\s"]+)/.exec(raw);
      if (taken) {
        setNameTakenId(taken[1] as Id<"teams">);
        setSaveError(
          `Another team in this sport is already called ${draftFullName}.`,
        );
      } else {
        setNameTakenId(null);
        setSaveError(
          userFacingMessage(e, "Could not save this team. Try again."),
        );
      }
    } finally {
      setBusy(null);
    }
  };

  /**
   * Re-run every source for this one team.
   *
   * A new team already gets this automatically when it is created; this is the
   * manual re-run for a team that predates the pipeline, whose sources had
   * nothing at the time, or whose colors matched the wrong franchise. It
   * always forces the color search — "search again" is the entire point of
   * pressing it, so skipping an already-resolved team would make the button
   * appear to do nothing.
   *
   * The outcome is reported rather than left to "watch the row and see",
   * because a live sitemap search takes a few seconds and three of its five
   * outcomes change nothing visible on the row.
   */
  const discover = async () => {
    setBusy("discover");
    setPanelStatus(null);
    try {
      const outcome = await enrichFromWikidata({ id: team._id, force: true });
      const message: Record<
        typeof outcome,
        { text: string; isError: boolean }
      > = {
        resolved: { text: `Found colors for ${fullName}.`, isError: false },
        ambiguous: {
          text: `Several source pages match “${fullName}”. Pick the right one above.`,
          isError: false,
        },
        "no-match": {
          text: `No color source lists ${fullName}. Enter colors by hand below.`,
          isError: false,
        },
        unreadable: {
          text: `Found a page for ${fullName} but could not read colors from it.`,
          isError: true,
        },
        skipped: {
          text: `Nothing to look up for ${fullName}.`,
          isError: false,
        },
      };
      setPanelStatus(message[outcome]);
    } catch (e) {
      setPanelStatus({
        text: e instanceof Error ? e.message : "Discovery failed",
        isError: true,
      });
    } finally {
      setBusy(null);
    }
  };

  /** Sends WHICH candidate, never its URL — see the note on chooseColorSource. */
  const choose = async (candidateIndex: number) => {
    setBusy(`candidate-${candidateIndex}`);
    setPanelStatus(null);
    try {
      const outcome = await chooseColorSource({
        teamId: team._id,
        candidateIndex,
      });
      setPanelStatus(
        outcome === "unreadable"
          ? {
              text: "That page did not yield colors. Try another, or enter them by hand.",
              isError: true,
            }
          : { text: `Applied colors to ${fullName}.`, isError: false },
      );
    } catch (e) {
      setPanelStatus({
        text: e instanceof Error ? e.message : "Could not apply that source",
        isError: true,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ColorSwatch hex={team.colors?.primary} label="Primary" />
        <ColorSwatch hex={team.colors?.secondary} label="Secondary" />
        <h4 className="text-lg font-semibold">{fullName}</h4>
      </div>

      {(team.colorCandidates?.length ?? 0) > 0 && (
        <div className="rounded-md border border-neon-orange/40 bg-neon-orange/5 p-3 space-y-2">
          <p className="text-sm text-neon-orange">
            {team.colorCandidates!.length} source pages match this name. Pick
            the right team — nothing is applied until you do.
          </p>
          <ul className="flex flex-wrap gap-2">
            {team.colorCandidates!.map((candidate, index) => (
              <li key={candidate.url}>
                <NeonButton
                  type="button"
                  secondary
                  onClick={() => choose(index)}
                  disabled={busy !== null}
                >
                  {busy === `candidate-${index}` ? "Applying…" : candidate.name}
                </NeonButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/*
          NEO-236 — LOCATION FIRST, THEN NAME, and they are two fields rather
          than one.

          A franchise name is a place plus a nickname, and this screen is the
          only place either half is ever typed: "We simply shouldn't allow for
          full string creation. Location & Team Name should be the input."
          Location leads because that is the order the name is said in, so the
          two boxes read left-to-right as the thing they compose — and the
          preview line under them shows that composition before it is saved,
          which is the only way an operator can tell "Padres" with a blank
          Location apart from a correctly split row.

          "Location", not "City": the leading part of a franchise name is a
          place and not reliably a city — Tampa Bay, New England, Golden State
          — and labelling the field "City" was what made operators leave it
          blank for those teams. Location is wherever the team is FROM, which
          includes a school: "Wisconsin" / "Badgers", "San Diego State" /
          "Aztecs". It is empty only when the name carries no place at all
          ("Athletics", "Liverpool", "Orix Buffaloes"), which is why the rule
          is printed under the two boxes rather than left to be guessed.
        */}
        <Input
          label="Location"
          value={location}
          placeholder="San Diego"
          maxLength={MAX_TEAM_NAME_LENGTH}
          aria-describedby={describedBy}
          aria-invalid={saveError ? true : undefined}
          onChange={(e) => {
            setLocation(e.target.value);
            // The refusal is about these two fields; editing either one is the
            // operator answering it, so the message — and the escape hatch it
            // carried — goes as soon as they do.
            setSaveError(null);
            setNameTakenId(null);
          }}
        />

        <Input
          label="Name"
          value={name}
          placeholder="Padres"
          maxLength={MAX_TEAM_NAME_LENGTH}
          aria-describedby={describedBy}
          aria-invalid={saveError ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setSaveError(null);
            setNameTakenId(null);
          }}
        />

        {/* Examples deliberately avoid a plain city pair: a city is the case
            operators already get right. A state and a bay teach the two they
            do not, and the last clause names the only reason to leave Location
            empty. Kept clear of the literal "San Diego" — that string is how
            the E2E flow finds this screen's empty Location box. */}
        <p id={helpId} className="sm:col-span-2 -mt-1 text-xs text-slate-400">
          Location is where they&rsquo;re from &mdash; city, state, region or
          school. Wisconsin / Badgers, Tampa Bay / Buccaneers. Leave it blank
          only if the name has no place in it, like Athletics.
        </p>

        {name.trim() && (
          <p
            id={previewId}
            className="sm:col-span-2 -mt-1 text-xs text-slate-400"
          >
            Shows as:{" "}
            <span className="font-medium text-slate-200">{draftFullName}</span>
          </p>
        )}

        {/* NEO-253 — a refused rename, and the way out of it, in ONE place.
            This sits with the two fields it is about rather than in the
            page-level status line: on a 1024x629 viewport that line is well
            above the fold when Save is pressed, so an operator would see the
            save do nothing and be told why somewhere they cannot see.

            The escape hatch is gated on `nameTakenId` — an explicit id parsed
            off the refusal — and never on the message text, so a future
            refusal that happens to read similarly cannot grow a button that
            navigates nowhere. The destination is a real button rather than a
            link because the id belongs in a handler, not interpolated into an
            href. Same markup and same copy shape as PlayerManagement's. */}
        {saveError && (
          <div
            id={errorId}
            role="alert"
            className="sm:col-span-2 flex flex-wrap items-center gap-3 text-sm text-neon-pink"
          >
            <span>{saveError}</span>
            {nameTakenId && (
              <button
                type="button"
                onClick={() => onSelect(nameTakenId)}
                className="min-h-6 rounded px-2 py-1 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-neon-pink"
              >
                Open the existing team
              </button>
            )}
          </div>
        )}

        {/* NEO-284 — the other names this team answers to.

            Right under the name it is a name FOR, spanning both columns:
            a college programme carries dozens ("LSU", "Louisiana State",
            "LSU Tigers baseball"), and a one-line box would hide all but the
            first few. A textarea that grows with the list, then the list AS
            PARSED — a missing comma making one long alias, a trailing one
            making an empty entry, are invisible in the raw text and obvious
            in chips.

            Named "Current aliases", not "Also known as": the box above is
            already called that, and two controls sharing one accessible name
            is ambiguous to a screen reader and to a Maestro selector alike.
            Chips are bordered and unlinked — this panel's grammar for a chip
            that goes nowhere; the franchise pills below are the ones that
            do something. */}
        <div className="sm:col-span-2">
          <Textarea
            label="Also known as"
            value={aliasText}
            placeholder="LSU, Louisiana State, LSU Tigers baseball"
            rows={2}
            aria-describedby={aliasCaptionId}
            onChange={(e) => setAliasText(e.target.value)}
            className="min-h-[3.5rem] resize-y"
          />
          {draftAliases.length > 0 && (
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
          <p id={aliasCaptionId} className="mt-2 text-xs text-slate-400">
            Separate with commas. Other names this team answers to &mdash; the
            school, an old nickname, how a checklist spells it.
          </p>
          {/* Nothing is wrong: a shared alias is the feature working — a
              checklist carrying that name will offer both teams and the year
              will usually settle it. So this is a note, not an alert.

              Deliberately NOT a live region itself: it follows the query,
              which follows the keystrokes, and a polite region would queue a
              sentence per character. The announcement rides the sr-only
              channel below instead, one debounce behind, and this node stays
              synchronous for the eyes. */}
          {aliasNote && (
            <p className="mt-1 text-xs text-slate-400">{aliasNote}</p>
          )}
          {/* The announced note. Mounted unconditionally and from the first
              render, empty or not: a live region that appears at the same
              moment its text does is frequently missed entirely — the region
              has to already exist for the change to be a CHANGE. */}
          <span role="status" aria-live="polite" className="sr-only">
            {announcedAliasNote}
          </span>
        </div>

        <div>
          <label
            htmlFor="team-league"
            className="block text-sm font-medium mb-1 text-slate-300"
          >
            League
          </label>
          <select
            id="team-league"
            ref={leagueSelectRef}
            value={leagueId}
            onChange={(e) => {
              const value = e.target.value;
              if (value === ADD_LEAGUE) {
                // The draft's league does not move. React re-applies `value`
                // on this render, so the box goes straight back to whatever it
                // was showing — the dialog is the only thing that changed, and
                // cancelling it therefore costs nothing to undo.
                setAddingLeague(true);
                return;
              }
              setLeagueId(value);
            }}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
          >
            <option value={NO_LEAGUE}>— none —</option>
            {leagueOptions.map((league) => (
              <option key={league.id} value={league.id}>
                {league.label}
              </option>
            ))}
            <option value={ADD_LEAGUE}>+ Add a new league…</option>
          </select>
          {/* Everything this dropdown cannot do — renaming a league, giving it
              a level, recording what else it is called — lives on League
              Management, so the dropdown says where that is instead of growing
              those controls. Deep-linked to the league in hand when there is
              one, because "manage leagues" from here nearly always means this
              one. */}
          <Link
            to={
              leagueId ? `/admin/leagues?league=${leagueId}` : "/admin/leagues"
            }
            // `py-1` on an inline-block, not decoration: text-xs is a 16px
            // line box, which leaves this link's pointer target 8px short of
            // WCAG 2.2 SC 2.5.8's 24px floor. 16 + 2x4 = 24 exactly, and the
            // padding grows the hit area without moving the text.
            className="mt-1 inline-block rounded-sm py-1 text-xs text-neon-blue underline underline-offset-2 transition-colors hover:text-neon-blue/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-blue"
          >
            Manage leagues
          </Link>
        </div>

        {/* NEO-254 — the franchise thread.
            Beside League rather than below it: both answer "what larger thing
            does this team belong to", and a franchise is the only one of the
            two an operator invents themselves. Jason, 2026-09-06: "building a
            collection of all Tennessee Titans and letting the user determine
            if that should also include Houston Oilers and Tennessee Oilers
            players."

            ## Why it is a type-ahead (NEO-307)

            It was a `<select>`, which Maestro's web driver cannot reach as
            the third select on a page (it resolves an `<option>` tap against
            the FIRST bounds match across every `<option>` in the document).
            It then became a radiogroup of pills, capped at 24 behind a filter
            box — fine for a handful of threads, not for the NEO-254 preload's
            one per franchise across five sports. Jason, 2026-09-25, approving
            this after League went the same way, having called the league
            pills "a terrible interface for selecting a league. It should be a
            type ahead select like we use for lots of other teams and such
            things."

            So it is the shared `Autocomplete` combobox, exactly as
            `NewTeamForm`'s League is: the field shows the current answer at
            rest, focus opens the whole list, typing narrows it, and a name
            that matches nothing is offered as `Start “<typed>”` — which
            replaced the "+ Start a new franchise…" box and its Start button.
            Its options are `<li role="option">`, which Maestro taps like any
            element, so the select trap does not apply.

            The League select beside it still has that defect and is NOT
            converted here — swapping a control an E2E suite already drives is
            its own change. */}
        <div id="team-franchise">
          {/* The visible caption. Not a <label>: the combobox's accessible
              name is its own `aria-label` ("Franchise", which this text
              matches for SC 2.5.3), and a <label> may not contain the list.
              The id sits on the WRAPPER above, never on the input — an id
              there would replace "Franchise" as its Maestro resource-id. */}
          <span className="block text-sm font-medium mb-1 text-slate-300">
            Franchise
          </span>
          <div className="relative">
            <Autocomplete<{ key: string; label: string; choose: () => void }>
              label="Franchise"
              query={franchiseQuery ?? franchiseCurrentLabel}
              onQueryChange={setFranchiseQuery}
              items={franchiseListOptions}
              getKey={(o) => o.key}
              getLabel={(o) => o.label}
              onSelect={(o) => {
                setFranchiseQuery(null);
                // A thread being started is the answer the moment it lands;
                // a second pick in that window would race it.
                if (busy === "franchise") return;
                o.choose();
              }}
              onDismiss={() => setFranchiseQuery(null)}
              selectedKey={franchiseCurrentKey}
              openOnEmpty
              selectOnFocus
              placeholder="Pick a franchise or type a new one"
              // Room on the right for the chevron; the default geometry
              // otherwise, so it lines up with every other field in the panel.
              inputGeometryClassName="py-2 pl-3 pr-8 text-base"
            />
            {/* The one cue that this box opens a list rather than taking free
                text. Decorative; the combobox role says it to assistive tech. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400"
            >
              ▾
            </span>
          </div>

          {/* Deep-linked to the thread in hand, because "see the franchise"
              from here nearly always means this one. Same 24px pointer-target
              padding as the leagues link beside it (WCAG 2.2 SC 2.5.8). */}
          <Link
            to={
              franchiseId
                ? `/admin/franchises?franchise=${franchiseId}`
                : "/admin/franchises"
            }
            className="mt-1 inline-block rounded-sm py-1 text-xs text-neon-purple underline underline-offset-2 transition-colors hover:text-neon-purple/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple"
          >
            See the franchise
          </Link>
        </div>

        <div className="flex gap-2">
          <Input
            label="Active from"
            type="number"
            value={fromYear}
            onChange={(e) => setFromYear(e.target.value)}
          />
          <Input
            label="to"
            type="number"
            value={toYear}
            placeholder="present"
            onChange={(e) => setToYear(e.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <Input
            label="Primary color"
            value={primary}
            placeholder="#01214b"
            onChange={(e) => setPrimary(e.target.value)}
          />
          <Input
            label="Secondary"
            value={secondary}
            placeholder="#ffffff"
            onChange={(e) => setSecondary(e.target.value)}
          />
        </div>
      </div>

      {ratio !== null && (
        <p className="text-xs text-slate-400">
          Contrast {ratio.toFixed(1)}:1 — how the spine label will read.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <NeonButton
          type="button"
          onClick={save}
          disabled={!canSave || busy !== null}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </NeonButton>
        <NeonButton
          type="button"
          secondary
          onClick={discover}
          disabled={busy !== null}
        >
          {busy === "discover" ? "Searching…" : "Discover"}
        </NeonButton>
        {panelStatus && (
          /* IN the button row, not under it. The row already exists and is on
             screen whenever Save is, so the confirmation costs no extra height
             — which matters because the two E2E flows scroll Save to the bottom
             of a page that is already at its maximum scroll, and anything
             appended BELOW the button would land under the fold for the same
             reason the screen-level line did. It wraps to its own line only
             when the panel is too narrow to hold it beside the buttons.

             Both buttons in this row report here (NEO-260), and so does the
             inline franchise box above — see `panelStatus`. */
          <p
            role={panelStatus.isError ? "alert" : "status"}
            className={`self-center text-sm ${
              panelStatus.isError ? "text-neon-pink" : "text-slate-300"
            }`}
          >
            {panelStatus.text}
          </p>
        )}
      </div>

      {/* Last in the tree, and last for a reason: everything above it is the
          TEAM, and this is the one thing on the panel that is about something
          else. Rendered only while open, so its sport lookup and near-match
          subscription cost nothing the rest of the time. */}
      {addingLeague && (
        <AddLeagueDialog
          sportId={team.sportId}
          returnFocusTo={leagueSelectRef}
          /* NEO-260: no `onStatus`. The dialog renders its own line inside
             itself, where the operator already is; mirroring it out to a
             second live region on the page behind announced every message
             twice and put the copy somewhere nobody could see. */
          onClose={() => setAddingLeague(false)}
          onSelect={(league) => {
            setAddedLeagues((rows) =>
              rows.some((row) => row.id === league.id)
                ? rows
                : [...rows, { id: league.id, name: league.name }],
            );
            // The draft only — the team is not saved here. Creating a league
            // and deciding this team plays in it are two decisions, and Save
            // is still where the second one is committed.
            setLeagueId(league.id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function TeamManagement() {
  const management = useQuery(api.teams.listForManagement, {});
  const leagues = useQuery(api.leagues.list, {});

  const [filter, setFilter] = useState("");
  const [leagueFilter, setLeagueFilter] = useState<string>(ALL_LEAGUES);
  const [selectedId, setSelectedId] = useState<Id<"teams"> | null>(null);

  // The filter takes focus on arrival: the reason to open this screen is to
  // work on a particular team, and typing its name is how you find it.
  //
  // Keyed on `management`, not `[]`. An empty dep array runs the effect after
  // the FIRST render — which is the `management === undefined` loading branch
  // below, where this input does not exist yet. `filterRef.current` was null,
  // the focus silently did nothing, and no effect re-ran once the input finally
  // mounted. The screen looked completely correct and quietly ignored typing;
  // an E2E flow that typed without tapping first is what exposed it.
  //
  // `hasFocusedRef` keeps it one-shot: `management` changes on every reactive
  // update to the teams table, and yanking focus back mid-edit because someone
  // else's write landed would be worse than never focusing at all.
  const filterRef = useRef<HTMLInputElement>(null);
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    if (management === undefined || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    filterRef.current?.focus();
  }, [management]);

  // NEO-235 — arriving here from somewhere else, on one team.
  //
  // `/admin/teams?team=<id>` opens the screen with that team already selected.
  // The player editor links every career stint here, and a link that lands on
  // an unselected list is a navigation the operator has to finish by hand:
  // typing the name of the team they just clicked.
  //
  // NEO-240 adds `?league=<id>`, the same idea one level up: League Management
  // links a league to the teams playing in it. Both params run through
  // `useFollowedParam` — see it for why a follow is remembered twice.
  //
  // Both are followed during render, not in an effect. The effect version sets
  // state on a commit that has already happened, which cascades a second render
  // and the lint rule rejects it; this is React's documented "adjust state when
  // a prop changes" pattern, the same one TeamDetail above uses to re-seed its
  // draft.
  //
  // `/admin/players` follows its `?player` param through the same helper.
  const [searchParams, setSearchParams] = useSearchParams();
  const followedTeam = useFollowedParam();
  const followedLeague = useFollowedParam();
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const teamParam = searchParams.get("team");
  const leagueParam = searchParams.get("league");

  // The league filter is applied BEFORE the team param below, so that a link
  // carrying both lands on the team: selecting a team clears the filters (they
  // can hide the very row the link names), and that has to be the last word.
  //
  // An id this deployment does not carry is ignored rather than applied, since
  // a filter matching nothing reads as "there are no teams" with no visible
  // cause. `none` is the filter's own "teams with no league" value, not an id.
  if (
    leagueParam !== null &&
    !followedLeague.hasFollowed(leagueParam) &&
    leagues !== undefined
  ) {
    followedLeague.follow(leagueParam);
    if (
      leagueParam === "none" ||
      leagues.some((league) => league._id === leagueParam)
    ) {
      setLeagueFilter(leagueParam);
    }
  }

  if (
    teamParam !== null &&
    !followedTeam.hasFollowed(teamParam) &&
    management !== undefined
  ) {
    // The click handler below marks the param followed too — what it writes is
    // the operator's own selection, not a fresh link to follow. Following a
    // stale one is what the helper's second slot exists to prevent: because a
    // followed link clears the filters, it would empty the word the operator
    // typed a moment ago under their own click and drop the row they picked.
    followedTeam.follow(teamParam);
    const match = management.teams.find((team) => team._id === teamParam);
    // An id this deployment does not carry — a stale link, or one copied from
    // another deployment — leaves the screen exactly as it was: no selection,
    // no error banner. There is nothing the operator could do about it here.
    if (match) {
      setSelectedId(match._id);
      // The linked row has to be REACHABLE, not merely selected.
      // `listForManagement` returns every team whatever is typed here, but
      // both client-side filters below can hide the linked row from the master
      // list, so following a link clears them.
      setFilter("");
      setLeagueFilter(ALL_LEAGUES);
    }
  }

  /**
   * The URL this screen can be sent as: the team being looked at and the
   * league it is being looked at under, so a shared link reproduces the screen
   * rather than half of it.
   *
   * `replace` keeps Back an exit from the screen rather than a walk through
   * every row and filter the operator tried.
   */
  const syncUrl = (team: string | null, league: string) => {
    const next: Record<string, string> = {};
    if (team) next.team = team;
    if (league !== ALL_LEAGUES) next.league = league;
    setSearchParams(next, { replace: true });
  };

  /**
   * NEO-253 — open a team this screen was handed the id of.
   *
   * Clears both client-side filters for the same reason the `?team=` link
   * follower above does: `listForManagement` returns every team, but the name
   * filter and the league dropdown can each hide the destination row from the
   * master list, and a row that is selected but not REACHABLE reads as the
   * button having done nothing. The URL is written too, so the team on screen
   * is the team a reload reopens.
   */
  const selectTeam = (id: Id<"teams">) => {
    setSelectedId(id);
    setFilter("");
    setLeagueFilter(ALL_LEAGUES);
    // Marking the param followed is part of writing it, exactly as in the row
    // click handler below: a param this screen wrote itself must not read back
    // as a fresh deep link on a later render.
    followedTeam.follow(id);
    syncUrl(id, ALL_LEAGUES);
  };

  // Bring the row into view once it has rendered. The list is a 32rem scroller
  // over every team, so the selected row can easily sit outside it and the
  // link would look like it had done nothing. `block: "nearest"` leaves a row
  // that is already on screen where it is — which is the usual case for the
  // click below, since that writes the param too.
  const followedTeamParam = followedTeam.latest;
  useEffect(() => {
    if (followedTeamParam === null) return;
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [followedTeamParam]);

  const teams = useMemo(() => management?.teams ?? [], [management]);
  // Sorted once here so the filter dropdown and the detail panel's league
  // dropdown cannot present the same leagues in two different orders.
  const leagueList = useMemo(
    () => [...(leagues ?? [])].sort(byLevelThenName),
    [leagues],
  );
  const leagueById = useMemo(
    () => new Map(leagueList.map((l) => [l._id as string, l])),
    [leagueList],
  );

  /**
   * NEO-236 — ORDERED BY WHAT THE ROW PRINTS, which is the nickname.
   *
   * `listForManagement` sorts by the composed full name, because that is the
   * order every other consumer of it wants. This list is the one place that
   * shows the SHORT name on its first line, and a column of first lines that
   * runs Yankees, Mets, Knicks — all filed under "New" where nothing says so —
   * reads as no order at all. A list is sorted by the thing you can see.
   *
   * Location breaks the tie, so the two Giants and the two Cardinals land next
   * to each other in a stable order rather than in whatever order the server
   * happened to return them.
   */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = teams.filter((team) => {
      // NEO-236 — matched on the composed name, so typing "san diego" finds
      // the Padres even though `name` alone now holds only "Padres". The row
      // below prints the short name; the filter has to answer to what the
      // operator has in their head, which is the whole thing.
      // NEO-284 — and on the aliases, for the same reason they exist: the
      // operator folding "LSU" into a row is very likely typing the spelling
      // they came here about.
      if (
        needle &&
        !teamFullName(team).toLowerCase().includes(needle) &&
        !(team.aliases ?? []).some((alias) =>
          alias.toLowerCase().includes(needle),
        )
      ) {
        return false;
      }
      if (leagueFilter === ALL_LEAGUES) return true;
      if (leagueFilter === "none") return !team.leagueId;
      return team.leagueId === leagueFilter;
    });
    return matched.sort(
      (a, b) =>
        teamShortName(a).localeCompare(teamShortName(b)) ||
        (a.location ?? "").localeCompare(b.location ?? "") ||
        // NEO-254: era LAST, and oldest first. Two rows can now share a
        // nickname and a location — the two Winnipeg Jets do — and without
        // this they land adjacent in whatever order the query returned, which
        // is both arbitrary and unstable between renders. A lineage reads
        // forwards, so 1972 sits above 2011. Undated sorts last: it is the row
        // with work outstanding, not the row the history starts with.
        (a.yearsActive?.from ?? Infinity) - (b.yearsActive?.from ?? Infinity),
    );
  }, [teams, filter, leagueFilter]);

  const selected = teams.find((t) => t._id === selectedId) ?? null;
  /**
   * NEO-254 — the franchise threads for the panel's Franchise pills, scoped to
   * the SELECTED team's sport.
   *
   * It used to ask for every franchise in every sport and filter client-side,
   * which broke twice over once the load landed. `list` without a `sportId`
   * walks the table and caps at 500, so with 202 franchises per sport across
   * several sports a thread was simply outside the window and never offered —
   * and the ones that were offered cost a full-table read on a screen that
   * re-renders on every keystroke.
   *
   * Scoped, it is an indexed read of ~202 rows, well inside the cap, so the
   * window cannot bite. `"skip"` until a team is selected: with no panel open
   * there is no sport to ask about and nothing to render them into.
   */
  const franchises = useQuery(
    api.franchises.list,
    selected ? { sportId: selected.sportId } : "skip",
  );
  const needingAttention = teams.filter((t) => attentionFor(t) !== null).length;

  if (management === undefined) {
    return <p className="text-sm text-slate-400">Loading teams…</p>;
  }

  return (
    <div className="space-y-4">
      {/* NEO-260 removed the screen-level status line that used to sit here.
          This screen has no add form — every message it can produce comes from
          the detail panel, and NEO-236 (the refusal), NEO-254 (`Saved <name>`)
          and now NEO-260 (Discover, the colour-source picker and the inline
          franchise box) have moved all of them into the panel, beside the
          controls that produce them. Nothing was left to render. */}

      <div className="flex flex-wrap items-end gap-3">
        <Input
          ref={filterRef}
          label="Filter teams"
          value={filter}
          placeholder="Start typing a team name…"
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
        {/* Fixed width, not content width. `leagues` is its own query and
            resolves independently of `management`, so a content-sized select
            jumps from the width of "All leagues" to the width of the longest
            league label the moment it lands — flipping this row across its
            wrap boundary and shifting the entire master list under the
            operator's cursor. Long note at the same spot in
            LeagueManagement.tsx.

            `w-72` rather than the `w-44` its siblings use because these
            options are league LABELS (`abbreviation ?? name`), and a row
            `findOrCreateLeague` wrote mid-import carries no abbreviation — so
            the width to hold is "Major League Baseball" or "American Athletic
            Conference", not "Basketball". */}
        <div className="w-72">
          <label
            htmlFor="league-filter"
            className="block text-sm font-medium mb-1 text-slate-300"
          >
            League
          </label>
          <select
            id="league-filter"
            value={leagueFilter}
            onChange={(e) => {
              const value = e.target.value;
              setLeagueFilter(value);
              // Marked followed as part of writing it: without this, the param
              // written here reads as a fresh deep link on a later render.
              followedLeague.follow(value);
              // `selectedId` before the raw param, because a click one render
              // ago has not reached `searchParams` yet — see `useFollowedParam`.
              // Falling back to the param preserves a team id that named a row
              // this deployment does not carry, which nothing selected.
              syncUrl(selectedId ?? teamParam, value);
            }}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
          >
            <option value={ALL_LEAGUES}>All leagues</option>
            <option value="none">No league</option>
            {leagueList.map((league) => (
              <option key={league._id} value={league._id}>
                {league.abbreviation ?? league.name}
              </option>
            ))}
          </select>
        </div>
        {/* Floored and matched to the field-box height like its siblings
            (LeagueManagement.tsx, PlayerManagement.tsx, FranchiseManagement.tsx)
            rather than nudged up with a `pb-2`: centred against the field boxes
            it stays put when the row wraps, and the `min-w` floor keeps a
            resolving count from widening the row under the cursor. */}
        <p
          className={`flex items-center text-xs text-slate-400 min-w-[13rem] ${FIELD_BOX_HEIGHT}`}
        >
          {visible.length} of {teams.length} teams
          {needingAttention > 0 && ` · ${needingAttention} need attention`}
          {management.truncated && " · list truncated"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,18rem)_1fr] gap-4">
        {/* Master */}
        <div className="rounded-lg border border-slate-800 max-h-[32rem] overflow-y-auto">
          {visible.length === 0 ? (
            <p className="p-3 text-sm text-slate-400">
              No teams match that filter.
            </p>
          ) : (
            <ul>
              {visible.map((team) => {
                const attention = attentionFor(team);
                const league = team.leagueId
                  ? leagueById.get(team.leagueId)
                  : undefined;
                /**
                 * NEO-254 — "1972–1996", or "" for a row nobody has dated.
                 *
                 * Part of the row's identity now, not decoration: two Winnipeg
                 * Jets rows are told apart by this and by nothing else.
                 */
                const era = eraLabel(team.yearsActive);
                const isSelected = team._id === selectedId;
                return (
                  <li key={team._id}>
                    <button
                      type="button"
                      ref={isSelected ? selectedRowRef : null}
                      onClick={() => {
                        setSelectedId(team._id);
                        // Keep the URL in step with the selection so this
                        // team can be linked, shared or reloaded. Marking the
                        // param followed is part of writing it, not bookkeeping
                        // after the fact: without it, the param written here
                        // reads as a fresh deep link on a later render and
                        // clears the filters the operator is working under.
                        followedTeam.follow(team._id);
                        syncUrl(team._id, leagueFilter);
                      }}
                      aria-current={isSelected ? "true" : undefined}
                      /*
                        NEO-236 — the accessible name is the FULL name, exactly,
                        while the row prints the short one.

                        The list is sorted by nickname, so the nicknames have to
                        start at the same x for the alphabet to be scannable —
                        which rules out an inline "New York " prefix and puts
                        the location on the metadata line below instead. That
                        leaves the accessible name saying "Yankees", which is
                        not what anyone would look for, so the full name is
                        spelled out here.

                        NEO-254 — and the ERA, when the row has one.

                        This used to be exactly `teamFullName` with nothing
                        appended, because Maestro builds
                        `resource-id = node.id || node.ariaLabel` and this string
                        is the handle every `.maestro` flow taps the row by. That
                        rule held while a name identified a row. It does not any
                        more: a sport can hold two "Winnipeg Jets", and two rows
                        with one accessible name are two identical handles for
                        two different franchises — Maestro taps whichever comes
                        first, and a screen-reader operator cannot tell them
                        apart at all.

                        So the era goes IN the name rather than in the
                        description beside it: `aria-describedby` is not part of
                        what Maestro resolves, so a description could never make
                        the handle unique. `teamOptionLabel` appends nothing when
                        a row has no years, which is what keeps every existing
                        flow working — the E2E author audited that none taps a
                        DATED row by its full name. Same helper, same string,
                        as the TeamPicker option rows.
                      */
                      aria-label={teamOptionLabel(teamFullName(team), team.yearsActive)}
                      /*
                        a11y (SC 4.1.2) — an `aria-label` REPLACES the accessible
                        name, so the league tag and the attention glyph below
                        stop being announced the moment it is set. Both are real
                        state on an admin list whose whole job is surfacing rows
                        that need a human, so they are said again in the
                        `sr-only` line at the end of this button and pointed at
                        from here.

                        `describedby`, not a longer label: the label carries the
                        row's IDENTITY (name and era — see above) and a
                        description is the attribute for "and also, about this
                        thing…". State does not belong in a handle a test taps.
                        Keyed on `team._id` rather than `useId`, because this is
                        inside a `.map` and `useId` cannot be called per row.
                      */
                      aria-describedby={
                        attention || league ? `team-row-${team._id}` : undefined
                      }
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm border-l-2 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500 ${
                        isSelected
                          ? "border-neon-purple bg-neon-purple/10 text-neon-purple"
                          : "border-transparent text-slate-300 hover:bg-slate-900"
                      }`}
                    >
                      <ColorSwatch hex={team.colors?.primary} label="Primary" />
                      {/* Two lines, and the second one is where the location
                          and the league both went. Line one is nothing but the
                          nickname, left-aligned, so a 2000-row alphabetical
                          list can be run down with the eye; line two carries
                          the facts that tell two "Giants" apart. The rows that
                          have neither — a college side with no conference —
                          simply stay one line, and the structure says so.

                          `truncate` is CSS, so the full strings stay in the DOM
                          for assistive tech and for the E2E matcher. */}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {teamShortName(team)}
                        </span>
                        {(team.location || league || era) && (
                          <span className="flex items-baseline gap-x-2 text-xs text-slate-400">
                            {team.location && (
                              <span className="min-w-0 truncate">
                                {team.location}
                              </span>
                            )}
                            {league && (
                              // The hairline rule is a border rather than a
                              // "·" so it stays out of the text content, and it
                              // appears only when there are two facts to hold
                              // apart.
                              <span
                                className={`shrink-0 ${team.location ? "border-l border-slate-700 pl-2" : ""}`}
                              >
                                {league.abbreviation ?? league.name}
                              </span>
                            )}
                            {era && (
                              /* NEO-254 — the era, last on the line and set in
                                 tabular figures.
                                 
                                 It is here because it is now part of a team's
                                 IDENTITY: two "Winnipeg Jets" rows differ by
                                 nothing else, and without this the list shows
                                 the operator the same row twice. Monospaced
                                 digits rather than the body face, matching the
                                 franchise thread on /admin/franchises — the
                                 same fact should look the same wherever it
                                 decides which row you are looking at.
                                 
                                 `shrink-0` and last: the nickname and location
                                 truncate before a range that is the whole point
                                 of the line loses a digit. */
                              <span
                                className={`shrink-0 font-mono tabular-nums ${
                                  team.location || league
                                    ? "border-l border-slate-700 pl-2"
                                    : ""
                                }`}
                              >
                                {era}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                      {attention && (
                        // `aria-hidden`: "?" and "—" are glyphs, not words, and
                        // the sentence they stand for is in the `sr-only` line
                        // below. `title` stays for the pointer.
                        <span
                          aria-hidden="true"
                          className="text-xs text-neon-orange"
                          title={
                            attention === "choice"
                              ? "Several color sources match — needs a pick"
                              : "No colors yet"
                          }
                        >
                          {attention === "choice" ? "?" : "—"}
                        </span>
                      )}
                      {(attention || league) && (
                        <span id={`team-row-${team._id}`} className="sr-only">
                          {league
                            ? `${league.abbreviation ?? league.name}. `
                            : ""}
                          {attention === "choice"
                            ? "Several color sources match — needs a pick."
                            : attention === "colors"
                              ? "No colors yet."
                              : ""}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="rounded-lg border border-slate-800 p-4">
          {selected ? (
            <TeamDetail
              key={selected._id}
              team={selected}
              leagues={leagueList.filter((l) => l.sportId === selected.sportId)}
              franchises={franchises?.franchises ?? []}
              onSelect={selectTeam}
            />
          ) : (
            <p className="text-sm text-slate-400">
              Select a team to see and edit everything we know about it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
