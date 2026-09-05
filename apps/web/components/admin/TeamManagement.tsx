import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/primitives";
import NeonButton from "@/components/modules/NeonButton";
import { AddLeagueDialog } from "./AddLeagueDialog";
import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { teamFullName, teamShortName } from "@/lib/teams/team-name";

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
 * A URL param this screen follows ONCE per distinct value.
 *
 * The screen re-renders on every reactive update to the tables it reads, so a
 * param applied on each of them would keep yanking the operator back to the
 * state they arrived in. This remembers what has already been applied.
 *
 * TWO values are remembered, not one, and that is not belt-and-braces. React
 * Router applies every location update inside `startTransition` — the app's
 * `BrowserRouter` and the tests' `MemoryRouter` share that code path — so the
 * render that commits a change is a render in which `searchParams` STILL
 * CARRIES THE PREVIOUS VALUE; the URL catches up one render later. A one-slot
 * marker cannot tell that stale value apart from a fresh link back to it, so it
 * follows it — undoing the operator's own action under their hands. Remembering
 * the superseded value closes exactly that window.
 *
 * The cost of the second slot is that a link back to the value just left is
 * ignored for as long as the screen stays mounted. Every write here is a
 * `replace`, so there is no history entry to go back to, and every inbound link
 * arrives as a fresh mount.
 */
function useFollowedParam() {
  const [slots, setSlots] = useState<readonly [string | null, string | null]>([
    null,
    null,
  ]);
  return {
    /** The value most recently followed — an effect dependency, not state. */
    latest: slots[0],
    hasFollowed: (value: string) => slots.includes(value),
    follow: (value: string) => setSlots(([current]) => [value, current]),
  };
}

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
  onStatus,
}: {
  team: Team;
  leagues: League[];
  onStatus: (status: Status) => void;
}) {
  const saveTeamFields = useMutation(api.teams.saveTeamFields);
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
  const [location, setLocation] = useState(team.location ?? "");
  const [fromYear, setFromYear] = useState(
    team.yearsActive?.from ? String(team.yearsActive.from) : "",
  );
  const [toYear, setToYear] = useState(
    team.yearsActive?.to ? String(team.yearsActive.to) : "",
  );
  const [primary, setPrimary] = useState(team.colors?.primary ?? "");
  const [secondary, setSecondary] = useState(team.colors?.secondary ?? "");
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
    setLocation(team.location ?? "");
    setFromYear(team.yearsActive?.from ? String(team.yearsActive.from) : "");
    setToYear(team.yearsActive?.to ? String(team.yearsActive.to) : "");
    setPrimary(team.colors?.primary ?? "");
    setSecondary(team.colors?.secondary ?? "");
    setSaveError(null);
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
    [name.trim() ? previewId : null, saveError ? errorId : null]
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

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    onStatus(null);
    setSaveError(null);
    try {
      // The league already exists by the time Save is pressed — the dialog
      // creates it and hands back an id. Nothing about a league is written
      // from here any more.
      const resolvedLeagueId: Id<"leagues"> | null =
        leagueId !== NO_LEAGUE ? (leagueId as Id<"leagues">) : null;

      const from = Number(fromYear);
      const to = Number(toYear);
      await saveTeamFields({
        id: team._id,
        name: name.trim(),
        leagueId: resolvedLeagueId,
        location: location.trim() || null,
        yearsActive: fromYear && Number.isFinite(from)
          ? { from, ...(toYear && Number.isFinite(to) ? { to } : {}) }
          : null,
        colors: normalizedPrimary
          ? {
              primary: normalizedPrimary,
              ...(normalizedSecondary ? { secondary: normalizedSecondary } : {}),
            }
          : null,
      });
      onStatus({ text: `Saved ${draftFullName}.`, isError: false });
    } catch (e) {
      // Inline, not the status line: every way this call can fail is a thing
      // about the fields above it — the name is taken, the name is empty, the
      // colour is not a hex — and the panel is where it gets fixed.
      setSaveError(
        userFacingMessage(e, "Could not save this team. Try again."),
      );
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
    onStatus(null);
    try {
      const outcome = await enrichFromWikidata({ id: team._id, force: true });
      const message: Record<typeof outcome, { text: string; isError: boolean }> = {
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
        skipped: { text: `Nothing to look up for ${fullName}.`, isError: false },
      };
      onStatus(message[outcome]);
    } catch (e) {
      onStatus({
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
    onStatus(null);
    try {
      const outcome = await chooseColorSource({
        teamId: team._id,
        candidateIndex,
      });
      onStatus(
        outcome === "unreadable"
          ? {
              text: "That page did not yield colors. Try another, or enter them by hand.",
              isError: true,
            }
          : { text: `Applied colors to ${fullName}.`, isError: false },
      );
    } catch (e) {
      onStatus({
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
            {team.colorCandidates!.length} source pages match this name. Pick the
            right team — nothing is applied until you do.
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
          blank for those teams. It is optional, and legitimately empty for
          colleges, national sides and corporate-named clubs.
        */}
        <Input
          label="Location"
          value={location}
          placeholder="San Diego"
          aria-describedby={describedBy}
          aria-invalid={saveError ? true : undefined}
          onChange={(e) => {
            setLocation(e.target.value);
            // The refusal is about these two fields; editing either one is the
            // operator answering it, so the message goes as soon as they do.
            setSaveError(null);
          }}
        />

        <Input
          label="Name"
          value={name}
          placeholder="Padres"
          aria-describedby={describedBy}
          aria-invalid={saveError ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setSaveError(null);
          }}
        />

        {name.trim() && (
          <p id={previewId} className="sm:col-span-2 -mt-1 text-xs text-slate-400">
            Shows as:{" "}
            <span className="font-medium text-slate-200">{draftFullName}</span>
          </p>
        )}

        {saveError && (
          <p
            id={errorId}
            role="alert"
            className="sm:col-span-2 text-sm text-neon-pink"
          >
            {saveError}
          </p>
        )}

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
      </div>

      {/* Last in the tree, and last for a reason: everything above it is the
          TEAM, and this is the one thing on the panel that is about something
          else. Rendered only while open, so its sport lookup and near-match
          subscription cost nothing the rest of the time. */}
      {addingLeague && (
        <AddLeagueDialog
          sportId={team.sportId}
          returnFocusTo={leagueSelectRef}
          onStatus={onStatus}
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
  const [status, setStatus] = useState<Status>(null);

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
      if (needle && !teamFullName(team).toLowerCase().includes(needle)) {
        return false;
      }
      if (leagueFilter === ALL_LEAGUES) return true;
      if (leagueFilter === "none") return !team.leagueId;
      return team.leagueId === leagueFilter;
    });
    return matched.sort(
      (a, b) =>
        teamShortName(a).localeCompare(teamShortName(b)) ||
        (a.location ?? "").localeCompare(b.location ?? ""),
    );
  }, [teams, filter, leagueFilter]);

  const selected = teams.find((t) => t._id === selectedId) ?? null;
  const needingAttention = teams.filter((t) => attentionFor(t) !== null).length;

  if (management === undefined) {
    return <p className="text-sm text-slate-400">Loading teams…</p>;
  }

  return (
    <div className="space-y-4">
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
          label="Filter teams"
          value={filter}
          placeholder="Start typing a team name…"
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
        <div>
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
        <p className="text-xs text-slate-400 pb-2">
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

                        EXACTLY `teamFullName`, with nothing appended: Maestro
                        builds `resource-id = node.id || node.ariaLabel`, so
                        this string is the handle every `.maestro` flow taps
                        this row by. Appending a state word to it would break
                        every one of them silently.
                      */
                      aria-label={teamFullName(team)}
                      /*
                        a11y (SC 4.1.2) — an `aria-label` REPLACES the accessible
                        name, so the league tag and the attention glyph below
                        stop being announced the moment it is set. Both are real
                        state on an admin list whose whole job is surfacing rows
                        that need a human, so they are said again in the
                        `sr-only` line at the end of this button and pointed at
                        from here.

                        `describedby`, not a longer label: the label has to stay
                        exactly `teamFullName` (see above), and a description is
                        the attribute for "and also, about this thing…".
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
                        {(team.location || league) && (
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
                          {league ? `${league.abbreviation ?? league.name}. ` : ""}
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
              onStatus={setStatus}
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
