import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { api } from "../../convex/_generated/api";
import { userFacingMessage } from "../../lib/errors/user-facing-message";
import { teamFullName } from "../../lib/teams/team-name";
import type { Id } from "../../convex/_generated/dataModel";

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
 * NEO-236 — that escape hatch is a two-field form, not a free-text row.
 * `teams.name` is the nickname ("Padres") and `teams.location` is the place
 * ("San Diego"); a team is only ever created from those two inputs, never
 * from a full string somebody typed, because there is no reliable way back
 * from "San Diego State Aztecs baseball" to its parts. The typed query
 * pre-fills the NAME (no guessed split), the location starts empty, and the
 * "Shows as:" line composes them so the operator sees the row they are about
 * to create. Everything the picker DISPLAYS — chips, options, aria-labels —
 * is the composed full name; only the two admin master rows go short.
 *
 * Keyboard contract (per `feedback_keyboard_navigation`):
 *   Tab/Shift+Tab — cycle chips, × buttons, "+ Add" trigger, popover input
 *   Enter on input — select highlighted match (or create, if highlighted
 *     and no exact match exists)
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

  // Candidate pool. `list` caps at 100 by default; for the per-sport
  // typeahead that's plenty (every league hits well below). The pool
  // is filtered + ranked client-side in the popover.
  const candidates = useQuery(
    api.teams.list,
    sportId ? { sportId, limit: 500 } : { limit: 500 },
  );
  const findOrCreate = useMutation(api.teams.findOrCreate);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  /**
   * NEO-208 — the reason the last "+ Create" attempt was refused, shown
   * inline beside the search input.
   *
   * `teams.findOrCreate` grew two refusals in NEO-208 (a name over the
   * length cap, and a `sportId` that is a real `selectorOptions` id but not
   * a SPORT row) on top of the empty-name one. This handler used to be a
   * bare try/finally, so each of those landed as a silent no-op — the
   * "Creating…" label flipped back and nothing appeared — plus an unhandled
   * rejection in the console. The operator's next move differs per reason
   * (shorten the name vs. re-open the panel under a sport), so the reason
   * has to be on screen.
   *
   * Safe to render verbatim: every one of those messages carries a LENGTH or
   * a category, never the typed content — see the comments on the throws in
   * `convex/teams.ts`. Anything that is not a ConvexError gets the generic
   * fallback instead, because production redacts a plain Error to "Server
   * Error" (see `userFacingMessage`).
   */
  const [createError, setCreateError] = useState<string | null>(null);
  /**
   * Bumped every time a refusal is recorded, and used as the alert's `key`.
   *
   * a11y (audit fix, SC 3.3.1): pressing the submit twice with the same
   * problem sets the SAME string, which React resolves to no re-render — so
   * the `role="alert"` never fires again and the second press is silent for a
   * screen-reader user, exactly the state this alert exists to prevent.
   * Keying the element on a counter remounts it instead, which is what makes
   * a live region announce. Deliberately not the clear-then-setTimeout dance:
   * a deferred setState can land after the popover has closed.
   */
  const [errorNonce, setErrorNonce] = useState(0);
  const refuse = (message: string) => {
    setCreateError(message);
    setErrorNonce((n) => n + 1);
  };
  /**
   * NEO-236 — the create form's own two fields.
   *
   * `createName === null` means "still mirroring the search box": the typed
   * query IS the proposed name until the operator edits the name field, at
   * which point their value sticks. That mirroring is why the field can be
   * pre-filled without ever guessing where a location ends and a nickname
   * begins — the whole typed string becomes the name, and pulling "San Diego"
   * out of it is the operator's call, made by typing it in the box above.
   */
  const [createLocation, setCreateLocation] = useState("");
  const [createName, setCreateName] = useState<string | null>(null);
  const previewId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const createSubmitRef = useRef<HTMLButtonElement>(null);
  /** False→true edge detector for the scroll-into-view effect below. */
  const createFormShown = useRef(false);

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
      setPopoverOpen(false);
      setQuery("");
      setCreateError(null);
      setCreateLocation("");
      setCreateName(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [popoverOpen]);

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
    const q = query.trim().toLowerCase();
    // NEO-236: match on the COMPOSED full name, never on `name` alone.
    // A split row stores name "Padres" + location "San Diego"; an operator
    // typing "San Diego" has to find it, or they will create a duplicate.
    const filtered = candidates
      .filter((c) => !selectedSet.has(c._id as unknown as string))
      .filter((c) => !q || teamFullName(c).toLowerCase().includes(q))
      // Rank exact-prefix matches above substring matches so typing
      // "New" surfaces "New York Yankees" before "New Orleans Saints"
      // before "Newark Eagles" before random substring hits.
      .sort((a, b) => {
        const aFull = teamFullName(a);
        const bFull = teamFullName(b);
        if (!q) return aFull.localeCompare(bFull);
        const aPrefix = aFull.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = bFull.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return aFull.localeCompare(bFull);
      })
      .slice(0, 8);
    return filtered;
  }, [candidates, query, value]);

  // An exact (case-insensitive) match already exists — no "create" offer,
  // it'd just be a confusing duplicate-name affordance.
  //
  // NEO-236: compared against the composed FULL name, so typing "San Diego
  // Padres" recognises the split row that stores those two parts separately
  // and offers it as a match instead of as a create. That equivalence is the
  // whole point of the split being safe to roll out row by row.
  const hasExactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !candidates) return true;
    return candidates.some((c) => teamFullName(c).toLowerCase() === q);
  }, [query, candidates]);

  // NEO-96: no sport row → no create. A team must reference a real sport; the
  // old `sport ?? ""` fallback produced orphaned rows.
  //
  // NEO-208 (focus-park-pattern fix): deliberately NOT gated on `!creating`
  // anymore. This row used to unmount the instant `creating` flipped true,
  // which yanked focus off the "+ Create" button (it had focus — a click
  // just landed on it) onto <body>. `handleRootBlur` below exists to close
  // the popover on exactly that signal ("focus left the root"), so it fired
  // mid-request and closed the popover — clearing `createError` along with
  // it — before the awaited `findOrCreate` had even rejected. The refusal
  // then landed in state on an already-closed popover, invisible until the
  // next open. Keeping this row mounted (see the button below, which swaps
  // to a "Creating…" `aria-disabled` state instead of unmounting) means
  // focus never leaves the root, so `handleRootBlur` never fires and the
  // popover is still open — with `createError` still live — by the time the
  // mutation settles either way.
  //
  // NEO-236 note on what this is gated on: the TYPED QUERY, not the create
  // form's own fields. The form must not unmount while the operator is typing
  // in it — an unmount parks focus on <body>, which `handleRootBlur` reads as
  // "focus left the picker" and closes the whole popover. So emptying the name
  // field leaves the form standing and only the submit goes inert.
  const showCreateOption =
    query.trim().length > 0 && !hasExactMatch && !!sportId;

  /**
   * NEO-236 — bring the create form's submit into view the moment the form
   * appears.
   *
   * The popover is `absolute` and grew from ~112px to ~261px when the create
   * row became a two-field form, and an absolutely-positioned child is still
   * CLIPPED by any `overflow-y-auto` ancestor. `CardAttentionWalker`'s body is
   * `min-h-80 max-h-[70vh] overflow-y-auto` — a 320px box at 1024x629 — so
   * with the trigger two thirds of the way down it, "+ Create team" landed
   * ~25px below the clip and an operator had to scroll the dialog to reach
   * the button they had just asked for.
   *
   * Scrolling the container beats flipping the popover above the trigger:
   * flipping trades a clip at the bottom for a clip at the top in a box this
   * short, and it needs live measurement against whichever ancestor happens
   * to scroll. `block: "nearest"` needs none of that — it scrolls the nearest
   * scrollable ancestor by the MINIMUM required, and does nothing at all when
   * the form already fits, which is every other place this picker renders.
   * One line, and it holds for any small container it is dropped into later.
   *
   * The submit, not the form: it is the last element and the one that was
   * clipped, so pulling it into view brings the fields above it along. It
   * carries `scroll-mb-2` so it does not land flush against the clip edge.
   *
   * `useLayoutEffect`, so the scroll lands before paint and the clipped state
   * is never shown. Fires on the false→true edge only: without that guard
   * every keystroke that keeps the form open would re-scroll and fight an
   * operator who had scrolled the dialog themselves.
   */
  useLayoutEffect(() => {
    if (!showCreateOption) {
      createFormShown.current = false;
      return;
    }
    if (createFormShown.current) return;
    createFormShown.current = true;
    // Optional-called: not every environment this renders in implements
    // scrollIntoView, and a missing scroll must never break creating a team.
    createSubmitRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [showCreateOption]);

  /**
   * The name the form will actually submit: the operator's edit if they made
   * one, else the typed query verbatim. Never a split of the query — see the
   * component docstring.
   */
  const effectiveCreateName = (createName ?? query).trim();
  /**
   * What the created row will read as, everywhere outside the two admin master
   * rows. This is the ONLY place the two fields are composed, and it is the
   * same helper the server keys the row on, so the preview cannot drift from
   * what gets written.
   */
  const previewFullName = effectiveCreateName
    ? teamFullName({ name: effectiveCreateName, location: createLocation })
    : "";

  const createAndAdd = async () => {
    const name = effectiveCreateName;
    const location = createLocation.trim();
    // `creating` guard: re-entry protection now that the button stays
    // mounted (and clickable — see aria-disabled, not disabled, below) for
    // the duration of the request instead of unmounting.
    if (disabled || creating) return;
    if (!name) {
      // a11y (audit fix): the submit is `aria-disabled`, not `disabled`, so it
      // stays clickable and focusable on purpose — which means activating it
      // has to SAY something. A bare early return here was indistinguishable
      // from a broken control for anyone who cannot see that the button is
      // dimmed.
      refuse("Enter a team name.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      if (!sportId) return;
      // `location` is omitted rather than sent empty: the server models "no
      // location" as an absent optional (colleges, national sides, Orix
      // Buffaloes), and an empty string would be a third state meaning the
      // same thing.
      const id = await findOrCreate({
        name,
        sportId,
        ...(location ? { location } : {}),
      });
      addChip(id);
    } catch (err) {
      // Read the ConvexError's `data`, never `.message`: production redacts a
      // plain Error, and a surviving message arrives wrapped in
      // "[CONVEX M(...)] [Request ID: ...]" noise. The query is left alone, so
      // the "+ Create" row stays available for a retry after a fix.
      refuse(userFacingMessage(err, "Could not create team."));
      // Refocus the input (not the create row, which is what a retry needs
      // to reread the reason next to): the button that had focus is a
      // "+ Create" affordance the operator likely wants to edit past, not
      // press again verbatim.
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setCreating(false);
    }
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
    // The create form was proposing a team that now exists and is attached;
    // leaving its fields populated would offer to create it a second time.
    setCreateLocation("");
    setCreateName(null);
    // Stay open so the user can pick a second team on a dual-team
    // card without re-clicking the trigger. Re-focus the input.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const closePopover = () => {
    setPopoverOpen(false);
    setQuery("");
    setCreateError(null);
    setCreateLocation("");
    setCreateName(null);
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
    // NEO-208: while a create request is in flight the "+ Create" row stays
    // mounted (see `showCreateOption`), so this should not normally fire at
    // all — but guard it explicitly anyway, since the belt-and-suspenders
    // is cheap and a future change to the row's mount behavior shouldn't be
    // able to reopen the same race silently.
    if (!popoverOpen || creating) return;
    setTimeout(() => {
      if (rootRef.current?.contains(document.activeElement)) return;
      setPopoverOpen(false);
      setQuery("");
      setCreateError(null);
      setCreateLocation("");
      setCreateName(null);
    }, 0);
  };

  /**
   * Enter and Escape inside the create form's own fields.
   *
   * Enter submits, which is what a two-field form owes a keyboard operator —
   * without it the only way to create is to Tab past the fields to the button.
   * Escape closes the popover, the same as Escape in the search box, so the
   * way out is the same key wherever focus happens to be.
   *
   * `MissingTeamFixer` wraps this picker in a keydown handler that treats
   * Enter as "Save & Next", and it already excludes INPUT for exactly this
   * reason — these fields own their own Enter.
   */
  const handleCreateFieldKeyDown = (
    e: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void createAndAdd();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePopover();
    }
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
            className="text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
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
          className="px-2 py-0.5 text-xs rounded border border-dashed border-gray-400 dark:border-gray-600 hover:border-[#00D558] focus:border-[#00D558] focus:outline-none text-gray-600 dark:text-gray-300"
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
              onChange={(e) => {
                // The refusal described the name that was in this box; the
                // next keystroke makes it stale, so it goes away with the
                // query it was about.
                setCreateError(null);
                setQuery(e.target.value);
              }}
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
                    void createAndAdd();
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

            {createError && (
              // a11y: NOT the brand `#FF2EB3` used for destructive affordances
              // elsewhere — measured against this popover's own
              // `bg-white dark:bg-gray-800` that hex is 3.34:1 / 4.4:1, both
              // under WCAG 1.4.3's 4.5:1 floor for normal text. This pair is
              // the same-hue darkened/lightened variant CardDetailPanel's
              // `parentError` already uses on the identical backgrounds:
              // 5.55:1 on white, 5.87:1 on dark:bg-gray-800.
              <p
                key={errorNonce}
                role="alert"
                className="px-2 py-1 text-xs text-[#C2178A] dark:text-[#FF6FCB]"
              >
                {createError}
              </p>
            )}

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
                return (
                  <button
                    key={m._id}
                    type="button"
                    onClick={() => addChip(m._id)}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    aria-label={`Add ${fullName}`}
                    role="option"
                    aria-selected={idx === highlightIdx}
                    className={`w-full text-left px-2 py-1 text-sm rounded ${
                      idx === highlightIdx
                        ? "bg-[#00D558]/20 text-[#00D558]"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700"
                    }`}
                  >
                    {fullName}
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
              <div
                // Not a `<form>`: this popover is routinely rendered inside
                // the card drawer's own form, and a nested form is invalid
                // HTML that browsers resolve by dropping the inner one.
                role="group"
                aria-label="Create a new team"
                className="space-y-1.5 border-t border-gray-200 dark:border-gray-700 pt-2"
              >
                <label className="block space-y-0.5">
                  <span className="block text-[11px] text-gray-600 dark:text-gray-400">
                    Location (optional)
                  </span>
                  <Input
                    bare
                    type="text"
                    value={createLocation}
                    // a11y (audit fix, SC 2.5.3 Label in Name): the visible
                    // label is "Location (optional)", so the accessible name
                    // has to contain that whole string, "(optional)" included.
                    aria-label="New team location (optional)"
                    aria-describedby={previewId}
                    placeholder="San Diego"
                    onChange={(e) => {
                      setCreateError(null);
                      setCreateLocation(e.target.value);
                    }}
                    onKeyDown={handleCreateFieldKeyDown}
                    className="w-full p-1.5 text-sm"
                  />
                </label>
                <label className="block space-y-0.5">
                  <span className="block text-[11px] text-gray-600 dark:text-gray-400">
                    Team name
                  </span>
                  <Input
                    bare
                    type="text"
                    value={effectiveCreateName}
                    aria-label="New team name"
                    aria-describedby={previewId}
                    required
                    placeholder="Padres"
                    onChange={(e) => {
                      setCreateError(null);
                      setCreateName(e.target.value);
                    }}
                    onKeyDown={handleCreateFieldKeyDown}
                    className="w-full p-1.5 text-sm"
                  />
                </label>
                {/* The whole point of two fields: the operator reads the row
                    they are about to create before they create it. Described-by
                    both fields, so it is announced on focus rather than being a
                    live region that re-announces on every keystroke. */}
                <p
                  id={previewId}
                  className="px-0.5 text-[11px] text-gray-600 dark:text-gray-400"
                >
                  Shows as:{" "}
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {previewFullName || "add a team name"}
                  </span>
                </p>
                <button
                  ref={createSubmitRef}
                  type="button"
                  // NEO-208: `aria-disabled`, not `disabled` — the control
                  // stays mounted and focusable for the duration of the
                  // request. Native `disabled` here would reproduce the exact
                  // bug that fixed: the browser force-blurs a disabled element
                  // that has focus, straight to <body>, which `handleRootBlur`
                  // reads as "focus left the picker" and closes the popover —
                  // taking the refusal message with it. The `creating` guard
                  // inside `createAndAdd` is what actually blocks a second
                  // submit; this is only the announcement.
                  aria-disabled={creating || !effectiveCreateName || undefined}
                  // The preview says what this will create, and — when the
                  // name is empty — why it currently will not.
                  aria-describedby={previewId}
                  // a11y (audit fix, SC 4.1.2): this button shares the search
                  // box's ArrowDown cursor with the options above it, but it
                  // is not in the listbox any more, so `aria-selected` would
                  // be invalid here. `aria-current` is valid on any element
                  // and means exactly this: the current item of a set.
                  aria-current={
                    highlightIdx === matches.length ? "true" : undefined
                  }
                  onClick={() => void createAndAdd()}
                  onMouseEnter={() => setHighlightIdx(matches.length)}
                  // Carries the COMPOSED name, so a screen reader announces
                  // exactly the row that is about to be written — and so the
                  // Maestro selector `Create team <full name>` keeps working
                  // unchanged for a team with no location.
                  // a11y (audit fix, SC 2.5.3): while the request is in
                  // flight the visible text reads "Creating…", so the name
                  // follows it. The RESTING string is untouched — that is the
                  // one every `.maestro` `Create team <name>` selector targets.
                  aria-label={
                    creating
                      ? `Creating team${previewFullName ? ` ${previewFullName}` : ""}`
                      : previewFullName
                        ? `Create team ${previewFullName}`
                        : "Create team"
                  }
                  className={`w-full scroll-mb-2 text-left px-2 py-1 text-sm rounded ${
                    highlightIdx === matches.length
                      ? "bg-[#00D558]/20 text-[#00D558]"
                      : "hover:bg-gray-100 dark:hover:bg-gray-700"
                  } ${effectiveCreateName ? "" : "opacity-50"}`}
                >
                  {creating ? "Creating…" : "+ Create team"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
