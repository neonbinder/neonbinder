import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { userFacingMessage } from "../../lib/errors/user-facing-message";
import type { Id } from "../../convex/_generated/dataModel";
import { Input } from "../primitives/Input";
import {
  nameHasQueryPrefix,
  nameMatchesQuery,
} from "../../lib/entities/name-search";
import { normalizeEntityName } from "../../lib/entities/normalize-name";
import {
  contrastRatio,
  normalizeHexColor,
  parseHexColor,
} from "../../lib/print/contrast";
import PickerPopover, { popoverFocusables } from "./PickerPopover";
import SportSwitch from "./SportSwitch";

/**
 * NEO-313 — a player row as the cross-sport search returns it. `players.search`
 * adds the sport's display value and a pre-resolved career line, so a result
 * from another sport can say WHICH Adrian Peterson it is without a second
 * round-trip per row. Both optional: the set-sport pool (`players.list`) has
 * neither, and this one type serves both pools.
 */
type PickerPlayerRow = {
  _id: Id<"players">;
  name: string;
  sportId: Id<"selectorOptions">;
  sportValue?: string;
  /** The player's sports beyond the home one (search rows only). */
  alsoSportIds?: Array<Id<"selectorOptions">>;
  stints?: Array<{
    label: string;
    primaryColor?: string;
    fromYear: number;
    toYear?: number;
  }>;
};

/**
 * NEO-313 — the quiet sport marker on anything that is NOT from the sport the
 * picker is anchored to: a cross-sport result, a chip for a guest player or
 * team, a card in another sport's set.
 *
 * A hairline stamp rather than a filled pill, so it reads as a qualifier of
 * the name beside it and never as a second thing to press. Only ever rendered
 * when it carries information — the set's own sport is never tagged, because
 * then every row would carry it and it would stop meaning anything.
 */
export function SportTag({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-block rounded-sm border border-gray-400 dark:border-gray-500 px-1 text-[10px] font-normal leading-4 text-gray-700 dark:text-gray-300 align-middle ${className}`}
    >
      {label}
    </span>
  );
}

/**
 * {@link SportTag} for a bare sport id. Its own component so the sport list is
 * subscribed ONLY when a tag is actually on screen — the set-sport default path
 * (every picker, nearly always) never reads it. Convex de-duplicates identical
 * subscriptions, so a popover full of tags is still one query.
 */
export function SportTagById({
  sportId,
  className,
}: {
  sportId: Id<"selectorOptions">;
  className?: string;
}) {
  const sports = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const label = sports?.find((s) => s._id === sportId)?.value;
  if (!label) return null;
  return <SportTag label={label} className={className} />;
}

/**
 * `hex` composited over `base` at `alpha` — what the eye sees under a
 * translucent Tailwind fill such as `bg-[#00D558]/20`.
 */
function composite(base: string, tint: string, alpha: number): string {
  const b = parseHexColor(base);
  const t = parseHexColor(tint);
  if (!b || !t) return base;
  const mix = (x: number, y: number) =>
    Math.round(x * (1 - alpha) + y * alpha)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(b.r, t.r)}${mix(b.g, t.g)}${mix(b.b, t.b)}`;
}

/** The ArrowDown highlight: `bg-[#00D558]/20` in BOTH themes (no dark split). */
const HIGHLIGHT_TINT = "#00D558";
const HIGHLIGHT_ALPHA = 0.2;

/**
 * Every surface a result row can sit on, per theme. The popover is
 * `bg-white dark:bg-gray-800`, a row under the pointer adds
 * `hover:bg-gray-100 dark:hover:bg-gray-700`, and the ArrowDown row adds the
 * green highlight over the base. Tailwind 4's gray-800 / gray-700, as hex.
 */
const LIGHT_SURFACES = [
  "#ffffff",
  "#f3f4f6",
  composite("#ffffff", HIGHLIGHT_TINT, HIGHLIGHT_ALPHA),
];
const DARK_SURFACES = [
  "#1e2939",
  "#364153",
  composite("#1e2939", HIGHLIGHT_TINT, HIGHLIGHT_ALPHA),
];

function readsOnAll(hex: string, surfaces: readonly string[]): boolean {
  return surfaces.every((bg) => {
    const ratio = contrastRatio(hex, bg);
    return ratio !== null && ratio >= 4.5;
  });
}

/**
 * A team name in its own livery, decided PER THEME (SC 1.4.3, 4.5:1): the
 * colour is used in a theme only when it reads on every surface the row can
 * sit on in that theme, and the row stays muted there otherwise. No single
 * colour can clear both a white and a gray-800 popover, so the two answers
 * are independent — navy survives the light popover, gold the dark one.
 * The name is the information, the colour is only the nod.
 */
function liveryColors(primary: string | undefined): {
  light: string | null;
  dark: string | null;
} {
  const hex = primary ? normalizeHexColor(primary) : null;
  if (!hex) return { light: null, dark: null };
  return {
    light: readsOnAll(hex, LIGHT_SURFACES) ? hex : null,
    dark: readsOnAll(hex, DARK_SURFACES) ? hex : null,
  };
}

/**
 * NEO-313 — the sport tag on a chip whose player's HOME sport is not the
 * set's. It is shown only for a true guest: a multi-sport member of the set's
 * sport (Bo Jackson, home football, on a baseball card) is a player of this
 * sport and carries no tag. Membership is read per chip, and only for chips
 * that reach here — the ordinary chip, home sport = set's sport, never
 * subscribes. Nothing is shown until the answer lands, so a member's chip
 * never flashes a tag it should not have.
 */
function PlayerGuestTag({
  playerId,
  homeSportId,
  setSportId,
}: {
  playerId: Id<"players">;
  homeSportId: Id<"selectorOptions">;
  setSportId: Id<"selectorOptions">;
}) {
  const player = useQuery(api.players.getByIdParam, {
    id: playerId as string,
  });
  if (!player) return null;
  if ((player.alsoSportIds ?? []).includes(setSportId)) return null;
  return <SportTagById sportId={homeSportId} />;
}

/** A stable empty pool, so a switched-but-untyped popover does not re-memo. */
const NO_ROWS: PickerPlayerRow[] = [];

/** At most this many career stints on a cross-sport result's second line. */
const RESULT_STINT_LIMIT = 3;

/**
 * NEO-220 — the four container-level accessible names, overridable per
 * instance. Every one of them is present whatever the picker's state, and
 * NONE of them carries a player's name, so they are exactly the labels that
 * collide when two PlayerPickers are on screen at once — which is now
 * reachable in `CardChecklist`, where the card drawer and the quick-add form
 * mount one each and neither hides the other.
 *
 * Whole strings rather than a prefix/suffix knob, deliberately. Maestro
 * selects by `resource-id` (= the aria-label) with a REGEX FIND, so a derived
 * label that contains the base one — "Add player to new card" — would make the
 * drawer's own `id: "Add player"` match BOTH elements: strictly worse than the
 * collision it set out to fix. Every override below is checked to share no
 * substring with its default in either direction.
 *
 * Chip and option labels ("Player: Mike Trout", "Add Mike Trout", "Create
 * player X") are deliberately NOT overridable: they carry the player's name,
 * which is the disambiguator, and the existing drawer flows target them that
 * way.
 */
export type PlayerPickerLabels = {
  /** The chip row's own name. Default "Player picker". */
  root: string;
  /** The "+ Add player" trigger. Default "Add player". */
  trigger: string;
  /** The popover's search input. Default "Search players". */
  search: string;
  /** The popover listbox. Default "Player typeahead results". */
  results: string;
};

const DEFAULT_LABELS: PlayerPickerLabels = {
  root: "Player picker",
  trigger: "Add player",
  search: "Search players",
  results: "Player typeahead results",
};

/**
 * NEO-25 — multi-select player picker. Mirrors `TeamPicker`'s chip/popover
 * layout (that component's docstring names this as the reuse target), with
 * one addition: teams can only ever be picked from existing candidates, but
 * a card's players are frequently NOT in the `players` table yet (a brand
 * new rookie, or any player on a manually-added custom card, since custom
 * cards never went through the marketplace-sync UnknownEntitiesDialog
 * confirmation flow that normally creates player rows). So alongside typeahead
 * matches, an exact-name miss offers a "+ Create '<name>'" option that calls
 * the already-public `players.findOrCreate` mutation — the same
 * create-if-missing helper the sync pipeline uses — and adds the resulting id
 * as a chip. This is what makes custom cards able to hold players at all: no
 * separate custom-card code path is needed, `findOrCreate` + `updateCard`'s
 * existing `playerIds` arg already covers it.
 *
 * Keyboard contract mirrors TeamPicker:
 *   Tab/Shift+Tab — cycle chips, x buttons, "+ Add" trigger, popover input
 *   Enter on input — select highlighted match (or create, if it's the
 *     highlighted row and no exact match exists)
 *   Up/Down on input — move highlight
 *   Esc on input — close popover without selecting
 *   Backspace on empty input — remove last chip
 *
 * NEO-220 — the three dismissal/feedback behaviours `TeamPicker` grew in
 * NEO-208 are ported here verbatim, because this picker now sits in the SAME
 * place that forced them: `CardChecklist`'s quick-add form, immediately ABOVE
 * the Team row and the Add/Cancel buttons. Its popover hangs under the trigger
 * at `w-64`, so an open one physically covers all three. See
 * `handleRootBlur` (WCAG 2.4.11), the pointerdown-outside effect, and
 * `createError` below.
 */
export default function PlayerPicker({
  value,
  onChange,
  sportId,
  disabled,
  labels = DEFAULT_LABELS,
}: {
  value: Array<Id<"players">>;
  onChange: (next: Array<Id<"players">>) => void;
  /**
   * NEO-96: the sport-level selectorOptions row id, not its display name.
   * Filters typeahead candidates and tags a newly-created player. When absent,
   * listing still works but creating is disabled — the old `sport ?? ""`
   * fallback wrote players no query could find again.
   */
  sportId?: Id<"selectorOptions">;
  disabled?: boolean;
  /**
   * Accessible names for this instance's four container controls. Omit on the
   * one picker a screen can be sure of having only one of; pass all four when a
   * second picker can be mounted alongside it. All four together, never a
   * subset — a half-renamed instance is a collision you then have to find.
   */
  labels?: PlayerPickerLabels;
}) {
  const selectedRows = useQuery(api.players.getManyByIds, { ids: value });
  const setSportPool = useQuery(
    api.players.list,
    sportId ? { sportId, limit: 500 } : { limit: 500 },
  );
  const findOrCreate = useMutation(api.players.findOrCreate);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");

  /**
   * NEO-313 — the sport this popover is searching. Starts as, and returns to,
   * the set's sport: every open of the popover resets it (see the trigger's
   * `onClick`), and so does a new `sportId` arriving for a different card. The
   * switch is an override the operator has to reach for every time — nothing
   * here remembers a previous cross-sport pick.
   *
   * Reset during render rather than in an effect when the prop moves — React's
   * "adjust state when a prop changes" pattern, as elsewhere in this directory.
   */
  const [searchSportId, setSearchSportId] = useState(sportId);
  const [anchorSportId, setAnchorSportId] = useState(sportId);
  if (anchorSportId !== sportId) {
    setAnchorSportId(sportId);
    setSearchSportId(sportId);
  }
  const activeSportId = searchSportId ?? sportId;
  /** Searching a sport other than the set's. Only ever the operator's doing. */
  const crossSport =
    !!sportId && !!activeSportId && activeSportId !== sportId;

  /**
   * NEO-313 — a typed query also goes to the server's search index, for the
   * sport being searched. Two jobs, one subscription, and nothing until the
   * operator types:
   *
   *  - Cross-sport, it IS the pool — never a second 500-row fetch for the
   *    rare path — and each row brings its sport and career line, which is
   *    what tells a guest apart.
   *  - On the set's sport it tops up the 500-row pool with what that pool
   *    cannot hold: a multi-sport member whose HOME sport is another one
   *    (`players.list` reads the home index only), and anyone past row 500.
   *    Added to the pool rather than replacing it, so the pool's folded
   *    substring match ("Jose" finds "José", "york" finds mid-name) is kept.
   */
  const typed = query.trim();
  const searchResults: PickerPlayerRow[] | undefined = useQuery(
    api.players.search,
    typed && activeSportId
      ? { query: typed, sportId: activeSportId, limit: 10 }
      : "skip",
  );
  /** Rows the server matched by its own rules; the client filter lets them through. */
  const serverMatchedIds = useMemo(
    () => new Set((searchResults ?? []).map((r) => r._id as string)),
    [searchResults],
  );
  /**
   * One pool for everything downstream — options, the exact-match check, the
   * create offer — so they cannot disagree about which sport they describe.
   * On the set's sport the search is additive: while it is in flight the pool
   * alone answers, exactly as before this existed.
   */
  const candidates: PickerPlayerRow[] | undefined = useMemo(() => {
    if (crossSport) return typed ? searchResults : NO_ROWS;
    if (!setSportPool || !typed || !searchResults?.length) return setSportPool;
    const inPool = new Set(setSportPool.map((r) => r._id as string));
    const extra = searchResults.filter((r) => !inPool.has(r._id as string));
    return extra.length ? [...setSportPool, ...extra] : setSportPool;
  }, [crossSport, typed, searchResults, setSportPool]);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  /**
   * NEO-220 — why the last "+ Create" attempt was refused, shown inline
   * beside the search input. Ported from `TeamPicker` (NEO-208), where the
   * handler being a bare try/finally meant a refusal landed as a silent
   * no-op — "Creating…" flipped back, no chip appeared, no reason given —
   * plus an unhandled rejection in the console.
   *
   * Safe to render verbatim: NEO-220 gave `players.findOrCreate` the same
   * refusals its `teams` twin carries (a name over the 120-char cap, a
   * `sportId` that is not a SPORT row, an empty name), and every one of those
   * messages names a LENGTH or a category, never the typed content. Anything
   * that is not a ConvexError gets the generic fallback instead, because
   * production redacts a plain Error to "Server Error" (see
   * `userFacingMessage`).
   */
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * NEO-272 — the popover's own element, because it is no longer a DOM
   * descendant of `rootRef`.
   *
   * The popover is portalled to `document.body` so a scrolling ancestor cannot
   * clip it (see `PickerPopover`; `UnreviewedNameFixer` mounts this picker
   * inside the attention walker's `overflow-y-auto` body, and the card drawer
   * has a scroll box of its own). React events still bubble through the REACT
   * tree, so every key and blur handler below is unchanged — but
   * `Node.contains()` is a DOM question, and both dismissal paths ask it.
   */
  const popoverRef = useRef<HTMLDivElement | null>(null);

  /** Inside the picker as the OPERATOR sees it: the chip row or the popover. */
  const insidePicker = (node: Node | null) =>
    !!node &&
    (!!rootRef.current?.contains(node) || !!popoverRef.current?.contains(node));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- typeahead highlight resets with the query it indexes into
    setHighlightIdx(0);
  }, [query]);

  useEffect(() => {
    if (popoverOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [popoverOpen]);

  /**
   * Close on a pointerdown outside the picker — see `TeamPicker`, where the
   * same effect is documented at length. This picker had no outside-close at
   * all, which was survivable while its only homes were the card drawer and
   * `UnreviewedNameFixer` (both of which have room below the popover). In the
   * quick-add form it is not: an operator who opens this popover and then
   * reaches for the Team picker or Add/Cancel is clicking at a control the
   * popover is drawn over.
   *
   * `pointerdown`, not `click`, so the popover is gone before the click
   * resolves underneath it. Deliberately NOT `closePopover`, which would pull
   * focus back to the trigger mid-press.
   */
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (e: Event) => {
      // NEO-272: the portalled popover counts as inside — a press on an option
      // must select it, not dismiss the list out from under the pointer.
      if (insidePicker(e.target as Node)) return;
      setPopoverOpen(false);
      setQuery("");
      setCreateError(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [popoverOpen]);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of selectedRows ?? []) {
      map.set(row._id as unknown as string, row.name);
    }
    return map;
  }, [selectedRows]);

  /**
   * NEO-313 — the selected players whose HOME sport is not the set's: guest
   * candidates. Whether they really are guests (and not a multi-sport member
   * of the set's sport) is `PlayerGuestTag`'s question, asked only for these.
   */
  const guestSportById = useMemo(() => {
    const map = new Map<string, Id<"selectorOptions">>();
    if (!sportId) return map;
    for (const row of selectedRows ?? []) {
      if (row.sportId !== sportId) {
        map.set(row._id as unknown as string, row.sportId);
      }
    }
    return map;
  }, [selectedRows, sportId]);

  const matches = useMemo(() => {
    if (!candidates) return [];
    const selectedSet = new Set(value as unknown as string[]);
    // NEO-253: folded on both sides, so typing "Jose Ramirez" finds NB's
    // "José Ramírez". Deliberately `nameSearchKey` and not the token-sorted
    // dedup key — sorted, "New York Yankees" does not contain "new york".
    const q = query.trim();
    return candidates
      .filter((c) => !selectedSet.has(c._id as unknown as string))
      .filter(
        (c) =>
          serverMatchedIds.has(c._id as string) || nameMatchesQuery(c.name, q),
      )
      .sort((a, b) => {
        if (!q) return a.name.localeCompare(b.name);
        const aPrefix = nameHasQueryPrefix(a.name, q) ? 0 : 1;
        const bPrefix = nameHasQueryPrefix(b.name, q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [candidates, query, value, serverMatchedIds]);

  // An exact match already exists — no need to offer "create", it'd just be a
  // confusing duplicate-name affordance.
  //
  // NEO-253: this one uses `normalizeEntityName`, the DEDUP key, sorting and
  // all — unlike the filter above. It has to answer the question exactly as
  // `players.findOrCreate` will: anything softer offers Create for a row the
  // server would simply return (which is what "Jose Ramirez" against an
  // existing "José Ramírez" did — Create silently linked the row the list had
  // just hidden), and anything harder hides Create for a name the server would
  // genuinely insert.
  const hasExactMatch = useMemo(() => {
    const q = normalizeEntityName(query.trim());
    if (!q || !candidates) return true;
    return candidates.some((c) => normalizeEntityName(c.name) === q);
  }, [query, candidates]);

  // NEO-96: no sport row → no create. See TeamPicker for the rationale.
  //
  // NEO-220 (focus-park pattern): deliberately no longer gated on `!creating`.
  // This row used to unmount the instant `creating` flipped true, which parks
  // focus — a click had just landed on the button — onto <body>.
  // `handleRootBlur` below closes the popover on exactly that signal, so it
  // would fire mid-request and clear `createError` before the awaited
  // `findOrCreate` had even settled, leaving the refusal invisible. The row
  // stays mounted and announces itself `aria-disabled` instead; the `creating`
  // guard inside `createAndAdd` is what actually blocks a second submit.
  const showCreateOption =
    query.trim().length > 0 && !hasExactMatch && !!activeSportId;

  const removeChip = (idToRemove: Id<"players">) => {
    if (disabled) return;
    onChange(value.filter((id) => id !== idToRemove));
  };

  const addChip = (id: Id<"players">) => {
    if (disabled) return;
    if (value.includes(id)) return;
    onChange([...value, id]);
    setQuery("");
    setHighlightIdx(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const createAndAdd = async () => {
    const name = query.trim();
    // `creating` guard: re-entry protection now that the button stays mounted
    // (and clickable — `aria-disabled`, not `disabled`) for the request.
    if (!name || disabled || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      if (!activeSportId) return;
      // NEO-313: created in the sport being SEARCHED. After a switch that is
      // the operator's explicit choice, and the new player is filed under it —
      // never under the set's sport by default.
      const id = await findOrCreate({ name, sportId: activeSportId });
      addChip(id);
    } catch (err) {
      // The ConvexError's `data`, never `.message`: production redacts a plain
      // Error, and a surviving message arrives wrapped in "[CONVEX M(...)]
      // [Request ID: ...]" noise. The query is left alone so "+ Create" stays
      // available for a retry after a fix.
      setCreateError(userFacingMessage(err, "Could not create player."));
      // Land the operator back in the input, which is what a retry needs to
      // edit — not on the button they just pressed verbatim.
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setCreating(false);
    }
  };

  const closePopover = () => {
    setPopoverOpen(false);
    setQuery("");
    setCreateError(null);
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  /**
   * Close on Tab (or Shift+Tab) out of the picker while the popover is open —
   * the keyboard counterpart to the pointerdown handler above, and WCAG 2.4.11
   * (Focus Not Obscured) in the quick-add form specifically: Tab out of the
   * popover puts focus on whatever the caller placed next — there, the Team
   * picker's "+ Add team" trigger and then Add/Cancel, all of which this
   * popover is drawn over. (NEO-272 portalled it and gave `PickerPopover` the
   * boundary Tab hops; this handler is still what closes on every other way
   * focus can leave, including a click elsewhere.)
   *
   * Checked via a deferred read of `document.activeElement` rather than the
   * blur event's `relatedTarget`, which is unreliable across environments
   * (notably jsdom, where it comes back `null` for an ordinary focus move).
   * Deliberately NOT `closePopover`: that steals focus back to the trigger,
   * fighting the Tab the operator just pressed.
   */
  const handleRootBlur = () => {
    // The "+ Create" row no longer unmounts mid-request (see
    // `showCreateOption`), so this should not fire during a create at all —
    // guarded anyway, so a future change to that row's mount behaviour cannot
    // silently reopen the race.
    if (!popoverOpen || creating) return;
    setTimeout(() => {
      // NEO-272: "still in the picker" includes the portalled popover — the
      // open-time autofocus moves focus straight into it.
      if (insidePicker(document.activeElement)) return;
      setPopoverOpen(false);
      setQuery("");
      setCreateError(null);
    }, 0);
  };

  // Highlight index spans matches PLUS the trailing "create" row when shown.
  const rowCount = matches.length + (showCreateOption ? 1 : 0);

  return (
    <div
      ref={rootRef}
      className="flex flex-wrap gap-1.5 items-center"
      aria-label={labels.root}
      onBlur={handleRootBlur}
    >
      {value.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-xs"
        >
          <span
            className="truncate max-w-[140px]"
            aria-label={`Player: ${labelById.get(id as unknown as string) ?? "Loading…"}`}
          >
            {labelById.get(id as unknown as string) ?? "Loading…"}
          </span>
          {sportId && guestSportById.has(id as unknown as string) && (
            <PlayerGuestTag
              playerId={id}
              homeSportId={guestSportById.get(id as unknown as string)!}
              setSportId={sportId}
            />
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => removeChip(id)}
            aria-label={`Remove player ${labelById.get(id as unknown as string) ?? id}`}
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
          onClick={() => {
            // NEO-313: every open starts on the set's sport.
            setSearchSportId(sportId);
            setPopoverOpen(true);
          }}
          // NEO-272: Tab from the trigger lands in the popover, which is what
          // DOM order did for free until the popover was portalled to the end
          // of `document.body`. The way back out is `PickerPopover`'s own Tab
          // handling.
          onKeyDown={(e) => {
            if (e.key !== "Tab" || e.shiftKey || !popoverOpen) return;
            const first = popoverFocusables(popoverRef.current)[0];
            if (!first) return;
            e.preventDefault();
            e.stopPropagation();
            first.focus();
          }}
          aria-label={labels.trigger}
          aria-expanded={popoverOpen}
          className="px-2 py-0.5 text-xs rounded border border-dashed border-gray-400 dark:border-gray-600 hover:border-[#00D558] focus:border-[#00D558] focus:outline-none text-gray-600 dark:text-gray-300"
        >
          + Add player
        </button>

        {popoverOpen && (
          // NEO-272: `PickerPopover` rather than an `absolute` div. The surface
          // classes are untouched — only the positioning ones moved, into the
          // portal that keeps a scrolling host from clipping this list. The
          // listbox role and its accessible name stay exactly where they were.
          <PickerPopover
            anchorRef={triggerRef}
            popoverRef={popoverRef}
            onTabOut={closePopover}
            className="w-64 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg p-2 space-y-1"
            role="listbox"
            aria-label={labels.results}
          >
            <Input
              bare
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Search or add a player..."
              aria-label={labels.search}
              onChange={(e) => {
                // The refusal described the name that was in this box; the
                // next keystroke makes it stale, so it goes with the query.
                setCreateError(null);
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
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
                  e.preventDefault();
                  removeChip(value[value.length - 1]);
                }
              }}
              className="w-full p-1.5 text-sm"
            />

            {createError && (
              // a11y: NOT the brand `#FF2EB3` — measured against this
              // popover's own `bg-white dark:bg-gray-800` it is 3.34:1 /
              // 4.4:1, both under WCAG 1.4.3's 4.5:1 floor for normal text.
              // Same-hue darkened/lightened pair CardDetailPanel's
              // `parentError` and TeamPicker already use: 5.55:1 on white,
              // 5.87:1 on dark:bg-gray-800.
              <p
                role="alert"
                className="px-2 py-1 text-xs text-[#C2178A] dark:text-[#FF6FCB]"
              >
                {createError}
              </p>
            )}

            {!candidates && (
              <div className="text-xs text-gray-500 px-2 py-1">Loading…</div>
            )}
            {candidates &&
              matches.length === 0 &&
              query.trim().length === 0 && (
                <div className="text-xs text-gray-500 px-2 py-1">
                  Start typing a player name…
                </div>
              )}
            {matches.map((m, idx) => (
              <button
                key={m._id}
                type="button"
                onClick={() => addChip(m._id)}
                onMouseEnter={() => setHighlightIdx(idx)}
                aria-label={`Add ${m.name}`}
                role="option"
                aria-selected={idx === highlightIdx}
                className={`w-full text-left px-2 py-1 text-sm rounded ${
                  idx === highlightIdx
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                {m.name}
                {/* NEO-313 — only on a cross-sport search: the sport, then
                    the career line that tells two same-name men apart. Never
                    on the set-sport path, whose rows are exactly as before. */}
                {crossSport && (
                  <>
                    {m.sportValue ? (
                      <SportTag label={m.sportValue} className="ml-2" />
                    ) : (
                      <SportTagById sportId={m.sportId} className="ml-2" />
                    )}
                    {m.stints && m.stints.length > 0 && (
                      <span className="mt-0.5 block truncate text-[11px] text-gray-600 dark:text-gray-400">
                        {m.stints.slice(0, RESULT_STINT_LIMIT).map((st, i) => {
                          const color = liveryColors(st.primaryColor);
                          // Each theme reads its own custom property, so a
                          // colour that fails one theme is dropped there
                          // only (see `liveryColors`).
                          const style = {
                            ...(color.light ? { "--livery-light": color.light } : {}),
                            ...(color.dark ? { "--livery-dark": color.dark } : {}),
                          } as CSSProperties;
                          return (
                            <span key={i}>
                              {i > 0 && ", "}
                              <span
                                style={style}
                                className={`${
                                  color.light
                                    ? "text-[color:var(--livery-light)]"
                                    : "text-gray-700"
                                } ${
                                  color.dark
                                    ? "dark:text-[color:var(--livery-dark)]"
                                    : "dark:text-gray-300"
                                }`}
                              >
                                {st.label}
                              </span>{" "}
                              <span className="tabular-nums">
                                {st.toYear === undefined
                                  ? `${st.fromYear}–`
                                  : st.toYear === st.fromYear
                                    ? `${st.fromYear}`
                                    : `${st.fromYear}–${st.toYear}`}
                              </span>
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}
            {showCreateOption && (
              <button
                type="button"
                // NEO-220: `aria-disabled`, not `disabled` — the row stays
                // mounted and focusable for the request (see
                // `showCreateOption`). Native `disabled` force-blurs a focused
                // element straight to <body>, which is the same focus-park
                // pattern documented on `TitleFixer`'s Save button and would
                // reproduce the very bug this avoids.
                aria-disabled={creating || undefined}
                onClick={() => void createAndAdd()}
                onMouseEnter={() => setHighlightIdx(matches.length)}
                aria-label={`Create player ${query.trim()}`}
                role="option"
                aria-selected={highlightIdx === matches.length}
                className={`w-full text-left px-2 py-1 text-sm rounded border-t border-gray-200 dark:border-gray-700 ${
                  highlightIdx === matches.length
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                {creating ? "Creating…" : `+ Create "${query.trim()}"`}
                {/* NEO-313: after a switch, say where the new player goes. */}
                {crossSport && activeSportId && !creating && (
                  <SportTagById sportId={activeSportId} className="ml-2" />
                )}
              </button>
            )}

            {/* NEO-313 — the cross-sport override, last in the popover and
                quiet on purpose: it is used rarely, it must never be the
                default focus (the search box keeps that), and it sits below
                the rows so the options land where they always have. Tab from
                the last option reaches it; Tab again leaves the picker. */}
            {sportId && (
              <div className="border-t border-gray-200 dark:border-gray-700 px-2 pt-1">
                <SportSwitch
                  // Only one picker's popover is ever open, but the review
                  // wizard's own switch ("Sport for this name") can share the
                  // screen, so this one is worded apart from it.
                  label="Sport to search for players"
                  value={activeSportId ?? sportId}
                  setSportId={sportId}
                  disabled={disabled}
                  onChange={(next) => {
                    setSearchSportId(next);
                    setHighlightIdx(0);
                    setCreateError(null);
                  }}
                />
              </div>
            )}
          </PickerPopover>
        )}
      </div>
    </div>
  );
}
