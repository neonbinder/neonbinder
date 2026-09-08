import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { api } from "../../convex/_generated/api";
import { teamFullName } from "../../lib/teams/team-name";
import { eraLabel, teamOptionLabel } from "../../lib/teams/team-era";
import type { Id } from "../../convex/_generated/dataModel";
import {
  nameHasQueryPrefix,
  nameMatchesQuery,
} from "../../lib/entities/name-search";
import { normalizeEntityName } from "../../lib/entities/normalize-name";
import NewTeamDialog from "./NewTeamDialog";

/**
 * NEO-26 — multi-select-capable team picker, defaults to single.
 *
 * Renders the selected teams as a chip row (one chip per `teams._id`)
 * plus a single "+ Add team" trigger that opens a typeahead popover.
 * Card edit forms always commit the full array, even when it's
 * length 1, so the multi-team-rookie / "Traded" subset case is
 * handled without any special branching.
 *
 * Sibling component: `<PlayerPicker />` (NEO-25) mirrors this layout.
 *
 * Create-new (added alongside the card-level feature audit, 2026-07-16):
 * neither marketplace's checklist-sync endpoint carries team data — BSC's
 * own adapter comment says its catalog endpoint doesn't have it ("lives on
 * listings, not the catalog template"), while SportLots' adapter comment
 * assumes BSC supplies it instead — so in practice NEITHER source ever
 * populates the `teams` table, and this picker's candidate pool was
 * routinely empty. Building real team resolution (Wikidata career-history
 * lookup, per BSC's own deferred-to-listing-time plan) is a separate, much
 * larger effort. This picker instead gets the same "+ Create" escape hatch
 * PlayerPicker already has via the already-public `teams.findOrCreate` —
 * an operator is never blocked waiting on sync to populate a team.
 *
 * NEO-236 — this picker has ONE box, and creating happens somewhere else.
 *
 * Jason, 2026-09-05: "we should also remove the Location box from New Players
 * as we should only be selecting existing teams or entering it in the singular
 * field which would trigger that new team dialog." An earlier pass put a
 * Location + Name pair inline in this popover; it had no room for the League,
 * so every team created here was silently filed under the sport's default. The
 * three questions a `teams` row needs now live in `NewTeamDialog`, and this
 * popover's create affordance is one row that opens it.
 *
 * Everything the picker DISPLAYS — chips, options, aria-labels — is the
 * composed full name; only the two admin master rows go short.
 *
 * Keyboard contract (per `feedback_keyboard_navigation`):
 *   Tab/Shift+Tab — cycle chips, × buttons, "+ Add" trigger, popover input
 *   Enter on input — select highlighted match, or OPEN the new-team dialog
 *     when the create row is highlighted and no exact match exists. Enter
 *     inside that dialog is what creates: two presses rather than one, and
 *     the second one is where the League is answered.
 *   ↑/↓ on input — move highlight
 *   Esc on input — close popover without selecting
 *   Backspace on empty input — remove last chip
 *
 * Pointer users get an outside-click close as well — see the effect below for
 * why that is not just polish.
 */
export default function TeamPicker({
  value,
  onChange,
  sportId,
  disabled,
}: {
  value: Array<Id<"teams">>;
  onChange: (next: Array<Id<"teams">>) => void;
  /**
   * NEO-96: the sport-level selectorOptions row id, not its display name.
   * Filters the typeahead and tags a newly-created team.
   *
   * When undefined we still LIST the full teams table (usable, just slower),
   * but creating is disabled — see showCreateOption. Previously this passed
   * `sport: sport ?? ""`, silently writing teams with an empty-string sport
   * that no query could ever find again.
   */
  sportId?: Id<"selectorOptions">;
  disabled?: boolean;
}) {
  // Resolve currently-selected ids → display rows for the chip labels.
  // Convex deduplicates this between sibling pickers on the same page.
  const selectedRows = useQuery(api.teams.getManyByIds, { ids: value });

  /**
   * The "nothing typed yet" pool. Filtered and ranked client-side below.
   *
   * Deliberately small and deliberately NOT the thing that finds a team: it is
   * the handful of rows the popover shows before the operator types.
   */
  const browsePool = useQuery(
    api.teams.list,
    sportId ? { sportId, limit: 500 } : { limit: 500 },
  );

  /**
   * NEO-254 — once anything is TYPED, the server does the finding.
   *
   * This screen used to filter that 500-row pool client-side, and the pool is
   * an unordered `.take(500)` off the sport index. That was fine at a few dozen
   * teams per sport and is wrong at the volumes the preload produces: soccer
   * alone loads 8,305 teams into one sport, so 7,805 of them were unreachable
   * from this box — and worse, unreachable teams made `sameNameTeams` empty, so
   * the create row offered to make a team NB already held. A picker that cannot
   * find a row is a picker that mints duplicates.
   *
   * `teams.search` is the same `search_name` index `CareerTeamEntry` already
   * types against, filtered by sport server-side, so what comes back is ranked
   * against the whole table rather than against whichever 500 rows the index
   * walked first.
   */
  const [query, setQuery] = useState("");
  const searched = useQuery(
    api.teams.search,
    query.trim()
      ? { query: query.trim(), limit: 25, ...(sportId ? { sportId } : {}) }
      : "skip",
  );
  /**
   * One pool for everything downstream — the option rows, the exact-match
   * hint, the create offer. They must all see the same rows, or the create
   * offer starts contradicting the list directly above it.
   */
  const candidates = query.trim() ? searched : browsePool;

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  /**
   * NEO-236 — the New Team dialog is open over this picker.
   *
   * Read by BOTH dismissal paths below, and that is the whole reason it is
   * state rather than something local to the button: the dialog is portalled to
   * `document.body`, so a pointerdown inside it is outside `rootRef` and focus
   * moving into it leaves the picker's subtree. Without this flag, opening the
   * dialog would immediately close the popover behind it — taking the typed
   * query, and therefore the name the dialog was opened with, with it.
   */
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  /**
   * Synchronous mirror of `newTeamOpen`, and it is load-bearing rather than
   * belt-and-braces.
   *
   * `handleRootBlur` fires on the SAME click that opens the dialog: the click
   * sets the state, focus moves into the portal, and the blur handler runs from
   * the render closure that captured `newTeamOpen === false`. It therefore sailed
   * past its own guard and, a tick later, ran `setQuery("")` — which is what
   * `initialName` is read from, so the dialog's heading re-rendered from
   * "New team: San Diego Padres" to a bare "New team", and its
   * `aria-labelledby` target lost the name. (The draft itself survives: it seeds
   * once on mount. The damage was to the heading, the accessible name, and the
   * popover the operator would come back to.)
   *
   * Enter never reproduced it, because pressing Enter does not blur anything.
   */
  const newTeamOpenRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reset highlight whenever the typed query changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- typeahead highlight resets with the query it indexes into
    setHighlightIdx(0);
  }, [query]);

  // Auto-focus the input the moment the popover opens.
  useEffect(() => {
    if (popoverOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [popoverOpen]);

  /**
   * Close on a pointerdown outside the picker — ordinary popover behaviour,
   * and load-bearing in `MissingTeamFixer`. The popover is `absolute top-full
   * w-64 z-10`, which puts it over that fixer's "Save & Next (Enter)" and "No
   * team on this card", and Escape is not a way out THERE: Escape inside
   * `CardAttentionWalker` means "defer this card". So without this, a walker
   * operator who opened the picker had no way to uncover the two buttons they
   * needed next.
   *
   * `pointerdown`, not `click`, so the popover is out of the way before the
   * click resolves on whatever is underneath. Deliberately NOT `closePopover`:
   * that returns focus to the trigger, which would yank focus off the control
   * the pointer is in the middle of pressing. Selecting a match still leaves
   * the popover open (see `addChip`) — that is inside the root, so multi-team
   * picking is untouched.
   */
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (e: Event) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      // NEO-236: same portal caveat as `handleRootBlur` — a press inside the
      // New Team dialog is outside this root, and must not dismiss the popover
      // that owns the query the dialog is editing.
      if (newTeamOpenRef.current) return;
      setPopoverOpen(false);
      setQuery("");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [popoverOpen, newTeamOpen]);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of selectedRows ?? []) {
      // NEO-236: the chip is a display surface, so it carries the FULL name.
      map.set(row._id as unknown as string, teamFullName(row));
    }
    return map;
  }, [selectedRows]);

  const matches = useMemo(() => {
    if (!candidates) return [];
    const selectedSet = new Set(value as unknown as string[]);
    // NEO-236: match on the COMPOSED full name, never on `name` alone.
    // A split row stores name "Padres" + location "San Diego"; an operator
    // typing "San Diego" has to find it, or they will create a duplicate.
    //
    // NEO-253: folded on both sides, so typing "Montreal Expos" finds NB's
    // "Montréal Expos". Deliberately `nameSearchKey` and not the token-sorted
    // dedup key — sorted, "New York Yankees" does not contain "new york",
    // which is the commonest thing anybody types into this box.
    const q = query.trim();
    const filtered = candidates
      .filter((c) => !selectedSet.has(c._id as unknown as string))
      .filter((c) => nameMatchesQuery(teamFullName(c), q))
      // Rank exact-prefix matches above substring matches so typing
      // "New" surfaces "New York Yankees" before "New Orleans Saints"
      // before "Newark Eagles" before random substring hits.
      .sort((a, b) => {
        const aFull = teamFullName(a);
        const bFull = teamFullName(b);
        if (!q) return aFull.localeCompare(bFull);
        const aPrefix = nameHasQueryPrefix(aFull, q) ? 0 : 1;
        const bPrefix = nameHasQueryPrefix(bFull, q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return aFull.localeCompare(bFull);
      })
      .slice(0, 8);
    return filtered;
  }, [candidates, query, value]);

  // An exact match already exists — no "create" offer, it'd just be a
  // confusing duplicate-name affordance.
  //
  // NEO-236: compared against the composed FULL name, so typing "San Diego
  // Padres" recognises the split row that stores those two parts separately
  // and offers it as a match instead of as a create. That equivalence is the
  // whole point of the split being safe to roll out row by row.
  //
  // NEO-253: the DEDUP key here, sorting and all, unlike the filter above —
  // this must answer exactly as the server's own identity lookup will, or
  // Create is offered for a row the server would simply return.
  //
  // NEO-254 — and "an exact match exists" is no longer the same question as
  // "creating would be a duplicate".
  //
  // A sport can hold several rows under one name, told apart by their era: the
  // 1972-1996 Winnipeg Jets and the 2011- Winnipeg Jets. Suppressing Create
  // whenever the NAME exists would make the second one unreachable from this
  // picker — the operator would see one Jets row, not recognise it as the wrong
  // franchise, and attach a card to it.
  //
  // So Create stays on offer, and `sameNameTeams` below is what stops that
  // being a duplicate-minting trap: the rows already holding the name are named
  // on the create row, and `teams.findOrCreate` refuses a second era until the
  // operator confirms it. The picker offers; the server insists.
  const sameNameTeams = useMemo(() => {
    const q = normalizeEntityName(query.trim());
    if (!q || !candidates) return [];
    return candidates.filter((c) => normalizeEntityName(teamFullName(c)) === q);
  }, [query, candidates]);

  // NEO-96: no sport row → no create. A team must reference a real sport; the
  // old `sport ?? ""` fallback produced orphaned rows.
  const showCreateOption = query.trim().length > 0 && !!sportId;

  /**
   * NEO-236 — open the New Team dialog on the typed name.
   *
   * The whole create path is two steps now: this opens the form, and the
   * form's own Create button writes. Nothing is validated here beyond "there
   * is a sport and something was typed" — the dialog owns the refusals,
   * because it owns the fields they are about.
   */
  const openNewTeam = () => {
    if (disabled || !sportId || !query.trim()) return;
    // The ref FIRST, so the blur this same click is about to produce sees the
    // dialog as open. See `newTeamOpenRef`.
    newTeamOpenRef.current = true;
    setNewTeamOpen(true);
  };

  const removeChip = (idToRemove: Id<"teams">) => {
    if (disabled) return;
    onChange(value.filter((id) => id !== idToRemove));
  };

  const addChip = (id: Id<"teams">) => {
    if (disabled) return;
    if (value.includes(id)) return;
    onChange([...value, id]);
    setQuery("");
    setHighlightIdx(0);
    // Stay open so the user can pick a second team on a dual-team
    // card without re-clicking the trigger. Re-focus the input.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const closePopover = () => {
    setPopoverOpen(false);
    setQuery("");
    // Return focus to the trigger so Tab order stays predictable.
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  /**
   * Close on Tab (or Shift+Tab) out of the picker while the popover is open —
   * the keyboard counterpart to the pointerdown-outside handler above.
   *
   * That handler only ever sees mouse/touch input. A keyboard user reaches
   * the same "popover still open, covering something below it" state a
   * different way: the popover has no focus trap, so Tab from its last
   * option (or the input, if there are none) walks focus straight out of the
   * picker's subtree and onto whatever the caller placed next in the DOM —
   * in `CardChecklist`'s quick-add form, the "Add"/"Cancel" buttons
   * immediately following this field. Without closing here, those buttons
   * receive focus while still visually covered by the open `absolute
   * ... z-10` popover (WCAG 2.4.11 Focus Not Obscured) — the same overlap
   * the comment above already documents for `MissingTeamFixer`, just reached
   * by Tab instead of by leaving focus where it was.
   *
   * Checked via a deferred read of `document.activeElement` rather than the
   * blur event's own `relatedTarget`: `relatedTarget` on `blur`/`focusout` is
   * unreliable across environments (notably jsdom, where it comes back
   * `null` even for an ordinary focus move), so the read has to happen after
   * the browser/test environment has actually settled the new focus target,
   * not off the outgoing event. Deliberately NOT `closePopover`: that steals
   * focus back to the trigger, which would fight the Tab the user just
   * pressed.
   */
  const handleRootBlur = () => {
    // NEO-236: the New Team dialog is PORTALLED to `document.body`, so focus
    // moving into it leaves this picker's subtree and looks exactly like a Tab
    // out of it. Closing here would unmount the popover behind an open modal
    // and throw away the typed query the modal was opened with.
    if (!popoverOpen || newTeamOpenRef.current) return;
    setTimeout(() => {
      // Re-read the REF, not the captured state: the dialog may have opened
      // between the blur and this callback, which is exactly the case that
      // used to wipe the query out from under it.
      if (newTeamOpenRef.current) return;
      if (rootRef.current?.contains(document.activeElement)) return;
      setPopoverOpen(false);
      setQuery("");
    }, 0);
  };

  return (
    <div
      ref={rootRef}
      className="flex flex-wrap gap-1.5 items-center"
      aria-label="Team picker"
      onBlur={handleRootBlur}
    >
      {value.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-xs"
        >
          <span className="truncate max-w-[140px]" aria-label={`Team: ${labelById.get(id as unknown as string) ?? "Loading…"}`}>
            {labelById.get(id as unknown as string) ?? "Loading…"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => removeChip(id)}
            aria-label={`Remove team ${labelById.get(id as unknown as string) ?? id}`}
            // a11y (SC 1.4.3): gray-500 is ~3.0:1 on the chip's own gray-700
            // ground, under the 4.5:1 floor. gray-300 clears it in both themes,
            // and the pink hover/focus is unchanged.
            className="text-gray-600 dark:text-gray-300 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
          >
            ×
          </button>
        </span>
      ))}

      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          // Always opens. Closing is Escape (on the input) or a pointerdown
          // outside the picker — never selecting a match, which stays open
          // intentionally so the user can pick a second team for a multi-team
          // card. Earlier code used `setPopoverOpen((v) => !v)`
          // — a toggle — which silently closed the popover when the
          // test (or a real user) re-tapped "+ Add team" expecting
          // it to keep opening.
          onClick={() => setPopoverOpen(true)}
          aria-label="Add team"
          aria-expanded={popoverOpen}
          // a11y (SC 1.4.11 Non-text Contrast): the dashed border IS this
          // control's boundary, and `dark:border-gray-600` measures 2.35:1 on
          // the dark surface — under the 3:1 floor. gray-500 is 3.67:1 there
          // and the light-theme gray-400 already passes.
          className="px-2 py-0.5 text-xs rounded border border-dashed border-gray-400 dark:border-gray-500 hover:border-[#00D558] focus:border-[#00D558] focus:outline-none text-gray-600 dark:text-gray-300"
        >
          + Add team
        </button>

        {popoverOpen && (
          // NEO-236: `role="listbox"` moved OFF this container and onto the
          // options list below. The popover now holds a search box, a status
          // line and a two-field create form as well as the options, and a
          // textbox inside a listbox is not a shape assistive tech can read —
          // only `option` children are allowed there. The listbox is still
          // rendered for the whole life of the popover, so "is the listbox
          // present" remains a valid read of "is the popover open".
          <div className="absolute left-0 top-full mt-1 z-10 w-64 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg p-2 space-y-1">
            <Input
              bare
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Search or add a team..."
              aria-label="Search teams"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const rowCount = matches.length + (showCreateOption ? 1 : 0);
                if (e.key === "Escape") {
                  e.preventDefault();
                  closePopover();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIdx((i) => Math.min(i + 1, rowCount - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIdx((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (highlightIdx < matches.length) {
                    const pick = matches[highlightIdx];
                    if (pick) addChip(pick._id);
                  } else if (showCreateOption) {
                    // NEO-236: Enter on the create row OPENS the dialog rather
                    // than writing. The team still needs a League answered, and
                    // there is nowhere in this popover to answer it.
                    openNewTeam();
                  }
                } else if (
                  e.key === "Backspace" &&
                  query.length === 0 &&
                  value.length > 0
                ) {
                  // Reasonable shortcut: empty input + backspace
                  // removes the most recently added chip.
                  e.preventDefault();
                  removeChip(value[value.length - 1]);
                }
              }}
              className="w-full p-1.5 text-sm"
            />

            {/* a11y (1.4.3): gray-500 measures 2.8:1 on this popover's own
                dark:bg-gray-800 — the recurring gray-500-on-dark bug. gray-400
                is 4.87:1 there, and gray-600 is 7.85:1 on the white surface,
                so the pair clears 4.5:1 in both themes. */}
            {!candidates && (
              <div className="text-xs text-gray-600 dark:text-gray-400 px-2 py-1">
                Loading…
              </div>
            )}
            {candidates && matches.length === 0 && query.trim().length > 0 && (
              <div className="text-xs text-gray-600 dark:text-gray-400 px-2 py-1">
                No matches.
              </div>
            )}
            {candidates && matches.length === 0 && query.trim().length === 0 && (
              <div className="text-xs text-gray-600 dark:text-gray-400 px-2 py-1">
                Start typing a team name…
              </div>
            )}
            <div
              role="listbox"
              aria-label="Team typeahead results"
              className="space-y-1"
            >
              {matches.map((m, idx) => {
                // NEO-236: one composition per row, used for what is shown,
                // what is announced, and what a Maestro selector targets — so
                // those three can never disagree about a team's name.
                const fullName = teamFullName(m);
                /**
                 * NEO-254 — the era, which for two same-name rows is the only
                 * thing that tells them apart.
                 *
                 * It goes into the accessible name as well as the visible row:
                 * two "Add Winnipeg Jets" options are two identical handles for
                 * two different franchises, both to a screen reader and to a
                 * Maestro `tapOn`. `teamOptionLabel` leaves an undated row as
                 * its plain name, so nothing changes for the 99% case.
                 */
                const optionLabel = teamOptionLabel(fullName, m.yearsActive);
                return (
                  <button
                    key={m._id}
                    type="button"
                    onClick={() => addChip(m._id)}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    aria-label={`Add ${optionLabel}`}
                    role="option"
                    aria-selected={idx === highlightIdx}
                    className={`w-full text-left px-2 py-1 text-sm rounded ${
                      idx === highlightIdx
                        ? "bg-[#00D558]/20 text-[#00D558]"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    {fullName}
                    {/* NEO-254: tabular figures, matching the era wherever else
                        it decides which row you are looking at (Team
                        Management's list, the franchise thread). Before the
                        league, because it is identity and the league is
                        context. */}
                    {m.yearsActive && (
                      <span className="ml-2 font-mono text-[10px] tabular-nums text-gray-600 dark:text-gray-400">
                        {eraLabel(m.yearsActive)}
                      </span>
                    )}
                    {/* League only. The location is no longer a separate fact
                        about the row — it is the first half of the name printed
                        immediately to the left, and repeating it read as a
                        stutter ("San Diego Padres · San Diego"). */}
                    {m.league && (
                      <span className="ml-2 text-[10px] text-gray-600 dark:text-gray-400">
                        {m.league}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {showCreateOption && (
              /*
                NEO-236 — ONE row, and it opens a dialog rather than writing.
                Two fields inline had no room for the League, which is the
                question the New Team dialog exists to ask; this row is the
                door to it. It also puts the popover back to its original
                height, which is why the `scrollIntoView` above it is gone.

                Highlighted by the same ArrowDown cursor as the options, so
                Enter reaches it — but `aria-current`, not `aria-selected`: it
                is not inside the listbox, and `aria-selected` would be invalid
                on it.

                The accessible name says what pressing it does. `Create team
                <name>` moved to the dialog's own Create button, which is where
                a team is actually made and where every `.maestro` selector of
                that shape now lands.
              */
              <button
                type="button"
                aria-current={
                  highlightIdx === matches.length ? "true" : undefined
                }
                aria-label={`New team ${query.trim()}`}
                onClick={openNewTeam}
                onMouseEnter={() => setHighlightIdx(matches.length)}
                className={`w-full text-left px-2 py-1 text-sm rounded border-t border-gray-200 dark:border-gray-700 mt-1 pt-2 ${
                  highlightIdx === matches.length
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                + New team “{query.trim()}”…
                {/* NEO-254 — the create row now shows when the name is already
                    taken, because Create is no longer hidden in that case.
                    
                    A sport can hold two teams under one name (the two Winnipeg
                    Jets), so suppressing this row whenever the name existed
                    made the second franchise unreachable from the picker. It
                    stays on offer and says what it is about to sit beside; the
                    server refuses a second era until the operator confirms it
                    in the dialog. Offer here, insist there. */}
                {sameNameTeams.length > 0 && (
                  <span className="mt-0.5 block text-[10px] text-gray-600 dark:text-gray-400">
                    Already here:{" "}
                    <span className="font-mono tabular-nums">
                      {sameNameTeams
                        .map((t) => eraLabel(t.yearsActive) || "no years")
                        .join(", ")}
                    </span>
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        Portalled to `document.body` by the dialog itself, so its position in
        this tree costs nothing — it is here because this is where the state
        that opens it lives. Rendered only while open, so its league query and
        its focus trap exist only when they are being used.
      */}
      {newTeamOpen && sportId && (
        <NewTeamDialog
          sportId={sportId}
          initialName={query.trim()}
          onCreated={(id) => {
            addChip(id);
            newTeamOpenRef.current = false;
            setNewTeamOpen(false);
          }}
          onClose={() => {
            newTeamOpenRef.current = false;
            setNewTeamOpen(false);
            // Back to the box the operator was typing in. The dialog returns
            // focus to whatever opened it, and on a successful create that was
            // the "+ New team" row — which `addChip` has just unmounted by
            // clearing the query.
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}
