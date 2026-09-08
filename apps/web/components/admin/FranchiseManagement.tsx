import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/primitives";
import NeonButton from "@/components/modules/NeonButton";
import { LABEL_CLASS, FIELD_BOX_HEIGHT, type Status } from "./AddLeagueForm";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { teamFullName } from "@/lib/teams/team-name";
import { useFollowedParam } from "@/src/hooks/use-followed-param";

/**
 * NEO-254 — Franchise Management, the fourth entity editor.
 *
 * ## What a franchise is, and why this screen is small
 *
 * `teams` holds one row per historical NAME. "Houston Oilers", "Tennessee
 * Oilers" and "Tennessee Titans" are three team rows, because that is what a
 * card says and what a stint has to read as. A FRANCHISE is an operator saying
 * those three are one continuous thing.
 *
 * Jason, 2026-09-06: "building a collection of all Tennessee Titans and letting
 * the user determine if that should also include Houston Oilers and Tennessee
 * Oilers players." This screen is the admin half of that sentence — where the
 * operator DECIDES. What a collector's binder later does with the thread is a
 * different ticket, and nothing here anticipates it.
 *
 * So a franchise row has exactly one editable field: its name. Everything else
 * on the screen is the membership, and membership is edited from the team side
 * (`teams.franchiseId`) — which is why the only control on a team row here is
 * "Remove", the inverse of the Franchise dropdown on Team Management.
 *
 * ## The thread
 *
 * The teams on a franchise are rendered as a dated rail rather than a list,
 * and that is the one place this screen departs from its three siblings. It
 * earns the departure: a franchise IS a sequence, the order carries the fact
 * the operator opened the page to check ("did the Oilers become the Titans, or
 * did I string two unrelated clubs together?"), and a flat alphabetical list
 * actively hides it. Teams nobody has dated cannot be placed in that sequence,
 * so they sit below the rail under their own heading instead of being given a
 * position they have not earned.
 *
 * ## Never inferred
 *
 * Nothing on this screen guesses. There is no "suggest a franchise" affordance
 * and there will not be one: the Oilers → Titans rename and the Browns →
 * Ravens relocation are indistinguishable from a name, and only a human knows
 * which is which. See `convex/franchises.ts`.
 */

/** A franchise as the list renders it. */
type FranchiseRow = {
  _id: Id<"franchises">;
  name: string;
  sportId: Id<"selectorOptions">;
  teamCount: number;
};

/** The "every sport" value for the sport filter — not an id, never a param. */
const ALL_SPORTS = "all";

/**
 * How long the counter has to hold still before it is ANNOUNCED. Same value
 * and same reasoning as League Management's: the visible number recomputes on
 * every keystroke because watching it fall is how a sighted operator knows the
 * filter is biting, and `aria-live="polite"` queues every intermediate value.
 */
const COUNTER_ANNOUNCE_DEBOUNCE_MS = 400;

/** "1960–1996", "1999–present", or "" for a team nobody has dated. */
function eraLabel(years?: { from: number; to?: number }): string {
  if (!years) return "";
  return `${years.from}–${years.to ?? "present"}`;
}

/**
 * "Remove Houston Oilers" — one team's link to the thread, cut.
 *
 * ## Why `aria-disabled` and a hand-written guard, not `disabled`
 *
 * The click handler sets `busy` synchronously, so the very button the operator
 * just pressed re-renders as unavailable while the mutation is in flight. A
 * NATIVE `disabled` cannot hold focus, so the browser blurs it to `<body>` on
 * every removal — a keyboard operator loses their place in the list each time,
 * and every OTHER row's button drops out of the tab order with nothing saying
 * why. `aria-disabled` keeps the button focusable and announced, and the guard
 * in `onClick` does the blocking that `aria-disabled` does not. Same trade
 * `components/modules/NeonButton.tsx` documents.
 *
 * Extracted rather than repeated because the dated rail and the undated list
 * both render one, and two copies of a focus rule is two places to lose it.
 *
 * `py-1` on a text-xs line box makes the pointer target exactly 24px — WCAG 2.2
 * SC 2.5.8's floor — the same treatment the inline links on Team Management get.
 *
 * `text-neon-pink` on this ground is 5.2:1. Note that `text-neon-purple`
 * (#A44AFF), used for the links beside it, measures only 4.25:1 against
 * `bg-slate-900` — it passes on the page and panel grounds it is actually used
 * on, but do not move a purple label onto a slate-900 surface without
 * re-checking it.
 */
function RemoveTeamButton({
  busy,
  teamId,
  label,
  onRemove,
}: {
  busy: string | null;
  teamId: Id<"teams">;
  label: string;
  onRemove: (teamId: Id<"teams">, label: string) => Promise<void>;
}) {
  const unavailable = busy !== null;
  return (
    <button
      type="button"
      onClick={() => {
        if (unavailable) return;
        void onRemove(teamId, label);
      }}
      aria-disabled={unavailable}
      className={`ml-auto rounded-sm px-1 py-1 text-xs text-neon-pink underline underline-offset-2 transition-colors hover:text-neon-pink/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-pink ${
        unavailable ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      {busy === teamId ? "Removing…" : `Remove ${label}`}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function FranchiseDetail({
  franchiseId,
  sportLabel,
  sportNameById,
}: {
  franchiseId: string;
  /** The sport's name when the LIST happened to carry the row; "" otherwise. */
  sportLabel: string;
  /**
   * NEO-254 — the fallback, for a franchise the list window does not hold.
   *
   * The panel is now mounted from an id alone (see the note on `selectedRow`),
   * so it can be showing a row the list has never seen. Its own `franchises.get`
   * knows the sport; this turns that id into the name.
   */
  sportNameById: Map<string, string>;
}) {
  const view = useQuery(api.franchises.get, { id: franchiseId });
  const save = useMutation(api.franchises.save);
  const saveTeamFields = useMutation(api.teams.saveTeamFields);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Re-seed the draft when a different franchise arrives, and when the row
  // itself first loads. Keyed on the row's id rather than on `view` so an
  // unrelated reactive update cannot clobber a half-typed rename.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (view && seededId !== view.franchise._id) {
    setSeededId(view.franchise._id);
    setName(view.franchise.name);
    setStatus(null);
  }

  // Focus the panel heading on selection, so a keyboard operator who picked a
  // row from the list is put where the row's content starts rather than back at
  // the top of the page. Same treatment as League Management's panel.
  const loadedId = view?.franchise._id;
  useEffect(() => {
    if (loadedId) headingRef.current?.focus();
  }, [loadedId]);

  if (view === undefined) {
    return <p className="text-sm text-slate-400">Loading the franchise…</p>;
  }
  if (view === null) {
    return (
      <p className="text-sm text-slate-400">
        That franchise is gone. Pick another from the list.
      </p>
    );
  }

  const { franchise, teams, truncated } = view;
  const trimmed = name.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== franchise.name && busy === null;
  const dated = teams.filter((team) => team.yearsActive);
  const undated = teams.filter((team) => !team.yearsActive);

  const rename = async () => {
    if (!canSave) return;
    setBusy("save");
    setStatus(null);
    try {
      await save({ id: franchise._id, name: trimmed });
      setStatus({ text: `Renamed to ${trimmed}.`, isError: false });
    } catch (e) {
      setStatus({
        text: userFacingMessage(e, "Could not rename that franchise."),
        isError: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const removeTeam = async (teamId: Id<"teams">, label: string) => {
    setBusy(teamId);
    setStatus(null);
    try {
      // The team row itself is untouched — only the link is cut. This is the
      // exact inverse of the Franchise dropdown on Team Management, and it
      // sends the same `null` that dropdown's "— none —" sends.
      await saveTeamFields({ id: teamId, franchiseId: null });
      setStatus({ text: `Took ${label} off this franchise.`, isError: false });
    } catch (e) {
      setStatus({
        text: userFacingMessage(e, "Could not take that team off. Try again."),
        isError: true,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-semibold leading-tight focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-neon-purple"
        >
          {franchise.name}
        </h3>
        <p className="text-sm text-slate-400">
          {teams.length === 1 ? "1 team" : `${teams.length} teams`} on this
          thread
        </p>
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
        <Input
          label="Franchise name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        {/* Read-only treatment: a recessed surface rather than a `disabled`
            input, whose opacity takes the text under the 4.5:1 floor. */}
        <p
          className={`w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-base text-slate-300 ${FIELD_BOX_HEIGHT}`}
        >
          Sport:{" "}
          {sportLabel || sportNameById.get(franchise.sportId) || "Unknown"}
        </p>
      </div>
      <p className="-mt-2 text-sm text-slate-400">
        Call it whatever reads right to you — the teams keep their own names.
      </p>

      <div className="flex flex-wrap gap-2">
        <NeonButton
          type="button"
          onClick={() => void rename()}
          disabled={!canSave}
        >
          {busy === "save" ? "Saving…" : "Save name"}
        </NeonButton>
      </div>

      {/* ------------------------------------------------------------------
          The thread. See the file header for why this is a rail and not a
          list, and why undated rows sit outside it.
          ------------------------------------------------------------------ */}
      <div className="space-y-3 border-t border-slate-800 pt-4">
        <h4 className="text-base font-semibold">The thread</h4>

        {teams.length === 0 ? (
          <p className="text-sm text-slate-400">
            No teams yet. Open a team on{" "}
            <Link
              to="/admin/teams"
              className="rounded-sm text-neon-purple underline underline-offset-2 hover:text-neon-purple/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple"
            >
              Team Management
            </Link>{" "}
            and pick this franchise to put it on here.
          </p>
        ) : null}

        {dated.length > 0 && (
          // The rail is a sibling of the <ol>, not a child of it: only <li>
          // (and script/template) may be an ol's child, and an invalid child
          // there is a real risk of being re-parented out of the list — which
          // would take the list semantics with it.
          <div className="relative">
            {/* Decorative. The <ol> is what tells a screen reader this is a
                sequence; the rail only says it to the eye. */}
            <span
              aria-hidden="true"
              className="absolute left-[3px] top-3 bottom-3 w-px bg-slate-700"
            />
            <ol className="space-y-1 pl-5">
              {dated.map((team) => {
                const label = teamFullName(team);
                return (
                  <li key={team._id} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-5 top-3 h-[7px] w-[7px] rounded-full bg-neon-purple"
                    />
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
                      <Link
                        to={`/admin/teams?team=${team._id}`}
                        className="rounded-sm text-sm text-slate-100 underline decoration-slate-700 underline-offset-4 transition-colors hover:decoration-neon-purple focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple"
                      >
                        {label}
                      </Link>
                      <span className="font-mono text-xs tabular-nums text-slate-400">
                        {eraLabel(team.yearsActive)}
                      </span>
                      <RemoveTeamButton
                        busy={busy}
                        teamId={team._id}
                        label={label}
                        onRemove={removeTeam}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {undated.length > 0 && (
          <div className="space-y-1 border-t border-dashed border-slate-800 pt-3">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              No years yet
            </h5>
            <p className="text-xs text-slate-400">
              Add active years on Team Management and these drop into the thread
              in order.
            </p>
            <ul>
              {undated.map((team) => {
                const label = teamFullName(team);
                return (
                  <li
                    key={team._id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5"
                  >
                    <Link
                      to={`/admin/teams?team=${team._id}`}
                      className="rounded-sm text-sm text-slate-100 underline decoration-slate-700 underline-offset-4 transition-colors hover:decoration-neon-purple focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple"
                    >
                      {label}
                    </Link>
                    <RemoveTeamButton
                      busy={busy}
                      teamId={team._id}
                      label={label}
                      onRemove={removeTeam}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {truncated && (
          <p className="text-sm text-neon-yellow" role="status">
            Showing the first {teams.length} teams on this franchise. There are
            more.
          </p>
        )}
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

export default function FranchiseManagement() {
  // `withTeamCounts` because this screen RENDERS the counts on every master
  // row; Team Management's copy of this query deliberately does not ask, so it
  // never pays for the team scan behind them.
  const listing = useQuery(api.franchises.list, { withTeamCounts: true });
  const sports = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const findOrCreate = useMutation(api.franchises.findOrCreate);

  const sportList = useMemo(() => sports ?? [], [sports]);
  const sportNameById = useMemo(
    () => new Map(sportList.map((s) => [s._id as string, s.value as string])),
    [sportList],
  );

  const [filter, setFilter] = useState("");
  const [sportFilter, setSportFilter] = useState<string>(ALL_SPORTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSportId, setNewSportId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const filterRef = useRef<HTMLInputElement>(null);
  /**
   * The button that opened the add form, so closing the form puts focus back
   * where it came from rather than on `<body>` (WCAG 2.4.3). Closing unmounts
   * the focused input, and a keyboard operator who pressed Escape would
   * otherwise be dropped to the top of the document. Team Management's inline
   * franchise reveal does the same with its select.
   */
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const closeAddForm = () => {
    setAdding(false);
    setNewName("");
    addTriggerRef.current?.focus();
  };
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    // Keyed on `listing`, not `[]`: an empty dep array runs before the input
    // exists (the loading branch renders no list), so the focus silently does
    // nothing and never re-runs. `hasFocusedRef` keeps it one-shot, so a
    // reactive update cannot yank focus back mid-edit.
    if (listing === undefined || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    filterRef.current?.focus();
  }, [listing]);

  const [searchParams, setSearchParams] = useSearchParams();
  const followed = useFollowedParam();
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const franchiseParam = searchParams.get("franchise");

  // Applied during render, not in an effect — see `useFollowedParam` for why
  // the marker remembers two values rather than one.
  if (
    franchiseParam !== null &&
    !followed.hasFollowed(franchiseParam) &&
    listing !== undefined
  ) {
    followed.follow(franchiseParam);
    setSelectedId(franchiseParam);
    setAdding(false);
    // A followed link has to be able to show the row it names, so the filters
    // that could hide it are cleared.
    setFilter("");
    setSportFilter(ALL_SPORTS);
  }

  const followedLatest = followed.latest;
  useEffect(() => {
    if (followedLatest)
      selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [followedLatest]);

  const select = (id: string) => {
    setSelectedId(id);
    setAdding(false);
    followed.follow(id);
    setSearchParams({ franchise: id }, { replace: true });
  };

  const rows: FranchiseRow[] = useMemo(
    () => listing?.franchises ?? [],
    [listing],
  );
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (sportFilter === ALL_SPORTS || row.sportId === sportFilter) &&
        (needle === "" || row.name.toLowerCase().includes(needle)),
    );
  }, [rows, filter, sportFilter]);

  const counter = listing
    ? `${visible.length} of ${rows.length} franchises${
        listing.truncated ? " · list truncated" : ""
      }`
    : "";
  const [announcedCounter, setAnnouncedCounter] = useState("");
  useEffect(() => {
    const timer = setTimeout(
      () => setAnnouncedCounter(counter),
      COUNTER_ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [counter]);

  /**
   * NEO-254 — the selection is resolved BY ID, never out of the list window.
   *
   * `rows.find(...)` looked correct and was a latent bug the moment the table
   * outgrew the cap: `list` returns at most 500 rows, so a franchise the
   * operator had just created — or reached by a `?franchise=` link — could be
   * outside the window, and the panel then rendered "pick a franchise" while
   * its row sat highlighted in the list. `add()` calling `select(id)` hit this
   * every time on a loaded deployment, which is what killed two CI flows.
   *
   * `FranchiseDetail` already fetches the row by id through `franchises.get`,
   * so the panel is correct as soon as it is MOUNTED. All this has to do is
   * mount it, and an id is enough for that — the list is a way to find a
   * franchise, not the definition of which ones exist.
   *
   * The sport label still comes from the row when the list happens to hold it;
   * `FranchiseDetail` falls back to the row's own sport when it does not.
   */
  const selectedRow = rows.find((row) => row._id === selectedId) ?? null;
  const selectedSportLabel = selectedRow
    ? (sportNameById.get(selectedRow.sportId) ?? "")
    : "";

  const addSportId =
    newSportId ||
    (sportFilter !== ALL_SPORTS ? sportFilter : sportList[0]?._id) ||
    "";
  const canAdd = newName.trim().length > 0 && addSportId !== "" && !busy;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    setStatus(null);
    try {
      const { id, created } = await findOrCreate({
        name: newName.trim(),
        sportId: addSportId as Id<"selectorOptions">,
      });
      setStatus({
        text: created
          ? `Started ${newName.trim()}. Now go put some teams on it.`
          : `${newName.trim()} was already here — opened it for you.`,
        isError: false,
      });
      setNewName("");
      setAdding(false);
      select(id);
    } catch (e) {
      setStatus({
        text: userFacingMessage(e, "Could not start that franchise."),
        isError: true,
      });
    } finally {
      setBusy(false);
    }
  };

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
          label="Filter franchises"
          value={filter}
          placeholder="Start typing a franchise name…"
          onChange={(e) => setFilter(e.target.value)}
          className="w-64"
        />
        <div>
          <label htmlFor="franchise-sport-filter" className={LABEL_CLASS}>
            Sport
          </label>
          <select
            id="franchise-sport-filter"
            value={sportFilter}
            onChange={(e) => setSportFilter(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
          >
            <option value={ALL_SPORTS}>All sports</option>
            {sportList.map((sport) => (
              <option key={sport._id} value={sport._id}>
                {sport.value}
              </option>
            ))}
          </select>
        </div>
        <p
          className={`flex items-center text-xs text-slate-400 ${FIELD_BOX_HEIGHT}`}
        >
          {counter}
        </p>
        {/* Mounted from the first render, empty or not: a live region that
            appears at the same moment its text does is frequently missed —
            the region has to already exist for the change to be a CHANGE. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcedCounter}
        </span>
        <NeonButton
          ref={addTriggerRef}
          type="button"
          onClick={() => {
            setAdding(true);
            setStatus(null);
          }}
        >
          Start a franchise
        </NeonButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,18rem)_1fr] gap-4">
        {/* Master */}
        <div className="rounded-lg border border-slate-800 max-h-[32rem] overflow-y-auto">
          {listing === undefined ? (
            <p className="p-3 text-sm text-slate-400">Loading franchises…</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-sm text-slate-400">
              {rows.length === 0
                ? "No franchises yet. Start one to string a team's old names together."
                : "No franchises match that filter."}
            </p>
          ) : (
            <ul>
              {visible.map((row) => {
                const isSelected = row._id === selectedId;
                return (
                  <li key={row._id}>
                    <button
                      type="button"
                      ref={isSelected ? selectedRowRef : null}
                      onClick={() => select(row._id)}
                      aria-current={isSelected ? "true" : undefined}
                      className={`flex w-full flex-col gap-y-0.5 border-l-2 px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-green-500 ${
                        isSelected
                          ? "border-neon-purple bg-neon-purple/10 text-neon-purple"
                          : "border-transparent text-slate-300 hover:bg-slate-900"
                      }`}
                    >
                      <span className="w-full truncate" title={row.name}>
                        {row.name}
                      </span>
                      <span className="flex w-full items-baseline gap-x-2 text-xs text-slate-400">
                        <span>
                          {sportNameById.get(row.sportId) ?? "Unknown sport"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {row.teamCount === 1
                            ? "1 team"
                            : `${row.teamCount} teams`}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="rounded-lg border border-slate-800 p-4">
          {adding ? (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Start a franchise</h3>
              <p className="text-sm text-slate-400">
                One name for a team's whole run — every version of it, in every
                city it ever played.
              </p>
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
                <Input
                  label="Franchise name"
                  value={newName}
                  maxLength={120}
                  autoFocus
                  placeholder="Titans / Oilers"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void add();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeAddForm();
                    }
                  }}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <div>
                  <label htmlFor="new-franchise-sport" className={LABEL_CLASS}>
                    Sport
                  </label>
                  <select
                    id="new-franchise-sport"
                    value={addSportId}
                    onChange={(e) => setNewSportId(e.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
                  >
                    {sportList.map((sport) => (
                      <option key={sport._id} value={sport._id}>
                        {sport.value}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <NeonButton
                  type="button"
                  onClick={() => void add()}
                  disabled={!canAdd}
                >
                  {busy ? "Starting…" : "Start franchise"}
                </NeonButton>
                <NeonButton type="button" cancel onClick={closeAddForm}>
                  Cancel
                </NeonButton>
              </div>
            </div>
          ) : selectedId ? (
            <FranchiseDetail
              key={selectedId}
              franchiseId={selectedId}
              sportLabel={selectedSportLabel}
              sportNameById={sportNameById}
            />
          ) : (
            <p className="text-sm text-slate-400">
              Pick a franchise to see every team on it, oldest first.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
