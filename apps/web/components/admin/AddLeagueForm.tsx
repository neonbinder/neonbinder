import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/primitives";
import NeonButton from "@/components/modules/NeonButton";
import {
  NearMatchPanel,
  type NearMatch,
} from "@/components/entities/NearMatchPanel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";

/**
 * NEO-240 — "add a league", the one form, wherever it is asked for.
 *
 * It began as a private component inside `LeagueManagement`, where it replaces
 * the detail column. Team Management then grew its own way to create a league:
 * choosing `+ Add a new league…` in the team's League select revealed two bare
 * inputs under the dropdown, and the league was created as a side effect of
 * pressing Save on the TEAM. An operator reviewing that on the preview called
 * it confusing, and they were right about the reason — the fields belonged to a
 * different object than the form they appeared in, and nothing on screen said
 * when the league would come into existence.
 *
 * So there is now one form and two ways to reach it: this component, in the
 * detail column on `/admin/leagues` and in a modal on `/admin/teams`. That
 * matters beyond tidiness. The inline version had no duplicate guard at all —
 * an operator could type "Amer. League" into a team and create the exact second
 * row that `/admin/leagues` exists to fold back together. Sharing the form
 * means sharing `nearMatches`, and the guard arrives on the screen that most
 * needed it.
 *
 * ## What the two surfaces differ on, and nothing else
 * - **The sport.** On `/admin/leagues` it is a choice (`sports` + a select).
 *   On `/admin/teams` the team already fixes it, so `lockSport` renders it as
 *   read-only text — the same recessed, non-`disabled` field treatment
 *   `LeagueDetail` uses for its own unchangeable sport, for the same reason:
 *   `disabled`'s opacity takes the text under the 4.5:1 floor.
 * - **Where focus lands.** Replacing a column and opening a modal want
 *   different first stops — see `initialFocus`.
 *
 * Everything else — the near-match panel, the one-element primary that demotes
 * itself to `Open {name}`, `Create anyway`, the busy naming — is identical by
 * construction, because it is literally the same element tree.
 */

// ---------------------------------------------------------------------------
// Shapes shared with the screens that render this form
// ---------------------------------------------------------------------------

/** The operator-set classification of a league. */
export type LeagueLevel =
  | "major"
  | "minor"
  | "college"
  | "international"
  | "independent"
  | "other";

/** A status line for the surface hosting this form to render. */
export type Status = { text: string; isError: boolean } | null;

type SportRow = Doc<"selectorOptions">;

/**
 * What came back from a create — or from picking a near match instead of
 * creating anything.
 *
 * `created` is the honest half: `createByAdmin` answers `false` when the name
 * (or one of its aliases) already existed, and a host that reported "Added
 * American League." either way would be claiming a creation it did not make.
 * `name` is here so the host can name the row without waiting for the reactive
 * list to catch up with a row it does not have yet.
 */
export interface CreatedLeague {
  id: Id<"leagues">;
  created: boolean;
  name: string;
}

/**
 * The six levels, in the order an operator thinks about them: the two
 * professional tiers a card most often names, then the three that explain an
 * unfamiliar league, then the escape hatch.
 *
 * A button group rather than a select, and that is the one real interface
 * decision on this form. Six short, mutually exclusive values that all fit on
 * two lines — a select would hide five of six behind a click, and "which of
 * these is set, and is one set at all?" is the exact question an operator opens
 * this panel to answer. A group answers it without being opened.
 */
export const LEVELS: ReadonlyArray<{ value: LeagueLevel; label: string }> = [
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
  { value: "college", label: "College" },
  { value: "international", label: "International" },
  { value: "independent", label: "Independent" },
  { value: "other", label: "Other" },
];

/**
 * Longer than a filter debounce would be. This fires while the operator is
 * still typing a name they intend to CREATE, and a suggestion list that
 * reshuffles under a half-typed name is noise. Same value, same reason, as the
 * Players screen.
 */
const NEAR_MATCH_DEBOUNCE_MS = 300;

export const LABEL_CLASS = "block text-sm font-medium mb-1 text-slate-300";

/**
 * Height of an `Input` box: 24px line-height + 2×8px padding + 2×1px border.
 * Anything sharing a baseline with a field — the read-only sport — matches it
 * rather than guessing.
 */
export const FIELD_BOX_HEIGHT = "min-h-[2.625rem]";

// ---------------------------------------------------------------------------
// Level picker
// ---------------------------------------------------------------------------

/**
 * The level, as six toggles.
 *
 * `aria-pressed` rather than a radio group: level is OPTIONAL, and a radio
 * group with nothing checked has no way back to nothing once something is
 * checked. Pressing the pressed button clears it, which is the affordance a
 * toggle already promises — and "not set" is a state this screen exists to fix,
 * so it must stay reachable.
 *
 * Shared by the add form and the detail panel so the two can never offer
 * different levels or different wording.
 */
export function LevelGroup({
  value,
  onChange,
  idPrefix,
}: {
  value: LeagueLevel | null;
  onChange: (next: LeagueLevel | null) => void;
  /** Only for keys; the group is named by `aria-label`, not by an id. */
  idPrefix: string;
}) {
  return (
    <div>
      <span className={LABEL_CLASS}>Level</span>
      <div role="group" aria-label="Level" className="flex flex-wrap gap-1.5">
        {LEVELS.map((level) => {
          const pressed = value === level.value;
          return (
            <button
              key={`${idPrefix}-${level.value}`}
              type="button"
              aria-pressed={pressed}
              onClick={() => onChange(pressed ? null : level.value)}
              // min-h-8 clears WCAG 2.2 SC 2.5.8's 24px target floor with room
              // to spare — these sit close together, so the extra is what keeps
              // a mis-tap from setting the wrong level.
              //
              // `font-semibold` is the pressed state's NON-COLOUR cue (WCAG 2.2
              // SC 1.4.1): teal-on-teal-tint is the whole difference otherwise,
              // and "which of these is set?" is the question this group exists
              // to answer at a glance. Weight rather than a leading glyph on
              // purpose — the label text stays byte-identical, so neither the
              // accessible name nor a Maestro `tapOn: "Major"` moves.
              className={`min-h-8 rounded-md border px-2.5 py-1 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-neon-teal ${
                pressed
                  ? "border-neon-teal bg-neon-teal/15 font-semibold text-neon-teal"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600 hover:text-slate-100"
              }`}
            >
              {level.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface AddLeagueFormProps {
  /** Choices for the sport select. Not read at all when `lockSport`. */
  sports: SportRow[];
  /**
   * Pre-selected sport — the list's sport filter on `/admin/leagues`, the
   * team's own sport on `/admin/teams`. Required in practice when `lockSport`,
   * since there is then no way to pick one.
   */
  sportId: Id<"selectorOptions"> | null;
  /** Shown as `Sport: {label}` when `lockSport`. Ignored otherwise. */
  sportLabel?: string;
  /**
   * The sport is fixed by the surface and cannot be chosen here. A league is
   * keyed on (name, sport), so a form opened from a team must create under
   * THAT team's sport or it creates a league the team cannot point at.
   */
  lockSport?: boolean;
  /** Level to open with. Unset by default — "not set" is a legitimate answer. */
  defaultLevel?: LeagueLevel | null;
  /** Names the form for a dialog's `aria-labelledby`. */
  headingId?: string;
  /**
   * Where focus goes on mount.
   *
   * `heading` (the default) is for `/admin/leagues`, where the form REPLACES
   * the detail column: the control that opened it is still mounted but the
   * column under it changed wholesale, and for a screen-reader or keyboard user
   * nothing says so. The heading announces "Add a league, heading level 3" and
   * puts the next Tab on the first field rather than at the top of the page
   * (WCAG 2.2 SC 2.4.3).
   *
   * `name` is for the modal, where the dialog itself is announced by its
   * `aria-labelledby` — so repeating the heading as the first stop would say
   * the same words twice and cost the operator a Tab before they can type.
   */
  initialFocus?: "heading" | "name";
  onStatus: (status: Status) => void;
  onCreated: (league: CreatedLeague) => void;
  onCancel: () => void;
  /**
   * Whether a create is in flight. A host that can be dismissed from OUTSIDE
   * the form — the modal, via Escape or the scrim — has to know, or it closes
   * over a round trip whose result then lands on nothing.
   */
  onBusyChange?: (busy: boolean) => void;
}

export function AddLeagueForm({
  sports,
  sportId: fixedSportId,
  sportLabel,
  lockSport = false,
  defaultLevel = null,
  headingId,
  initialFocus = "heading",
  onStatus,
  onCreated,
  onCancel,
  onBusyChange,
}: AddLeagueFormProps) {
  const createByAdmin = useMutation(api.leagues.createByAdmin);

  const [name, setName] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [level, setLevel] = useState<LeagueLevel | null>(defaultLevel);
  const [sportId, setSportId] = useState<string>(fixedSportId ?? "");
  const [debouncedName, setDebouncedName] = useState("");
  const [busy, setBusy] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Focused directly rather than through requestAnimationFrame: neither host
    // portals this form, so the node exists by the time the effect runs.
    if (initialFocus === "name") nameRef.current?.focus();
    else headingRef.current?.focus();
  }, [initialFocus]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedName(name),
      NEAR_MATCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [name]);

  // Three characters, not two: `nearMatches` is a duplicate guard, and two
  // letters match half a small table without telling the operator anything.
  const probe = debouncedName.trim();
  const matches: NearMatch[] | undefined = useQuery(
    api.leagues.nearMatches,
    probe.length >= 3 && sportId
      ? { name: probe, sportId: sportId as Id<"selectorOptions"> }
      : "skip",
  );

  const trimmed = name.trim();
  const trimmedAbbreviation = abbreviation.trim();
  // The panel exports `hasExact` for callers that only need the boolean; this
  // one needs the ROW as well, to name the button.
  const exact = (matches ?? []).find((m) => m.confidence === "exact");
  /**
   * What the panel still has to show once the primary action has been promoted.
   *
   * When an exact match exists the primary button IS that row — same id, same
   * `Open {name}` accessible name — so listing it again below puts two controls
   * with one accessible name on screen, which is ambiguous to a screen reader
   * reading the list and to a Maestro `tapOn` matching by it. Filtered by
   * `_id`, so any genuinely different league still belongs in the list.
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
        ...(trimmedAbbreviation ? { abbreviation: trimmedAbbreviation } : {}),
        ...(level ? { level } : {}),
        sportId: sportId as Id<"selectorOptions">,
      });
      onStatus(
        result.created
          ? { text: `Added ${trimmed}.`, isError: false }
          : { text: "That league already exists — opened it.", isError: false },
      );
      onCreated({ id: result.id, created: result.created, name: trimmed });
    } catch (e) {
      onStatus({
        text: userFacingMessage(e, "Could not add that league."),
        isError: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-neon-teal"
      >
        Add a league
      </h3>

      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 sm:items-end">
        <Input
          ref={nameRef}
          label="New league name"
          value={name}
          placeholder="American Association"
          onChange={(e) => setName(e.target.value)}
        />

        <Input
          label="Abbreviation"
          value={abbreviation}
          placeholder="AA"
          onChange={(e) => setAbbreviation(e.target.value)}
        />
      </div>

      {lockSport ? (
        // Read-only, not `disabled`: the sport is a fact of the surface the
        // operator opened this from, not a field they declined to fill in.
        // Painted as a recessed field rather than a caption floating beside one
        // — the same treatment `LeagueDetail` gives its own unchangeable sport,
        // and for the same reason: `disabled`'s opacity would take the text
        // under SC 1.4.3's 4.5:1 floor.
        <p
          className={`w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-base text-slate-300 ${FIELD_BOX_HEIGHT}`}
        >
          Sport: {sportLabel}
        </p>
      ) : (
        <div>
          <label htmlFor="new-league-sport" className={LABEL_CLASS}>
            Sport
          </label>
          <select
            id="new-league-sport"
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
      )}

      <LevelGroup value={level} onChange={setLevel} idPrefix="add" />

      <NearMatchPanel
        kind="league"
        matches={panelMatches}
        // Not "Link to": this button opens the row for editing, it does not
        // link anything to anything.
        pickLabel={(n) => `Open ${n}`}
        onPick={(id, matchName) =>
          onCreated({
            id: id as Id<"leagues">,
            // Nothing was created — this is the row that was already there,
            // which is the entire point of offering it.
            created: false,
            name: matchName,
          })
        }
      />

      {/* The primary action swaps rather than the create button merely warning.
          An operator who has just been shown the row they were about to
          duplicate is, nine times in ten, looking for THAT row. "Create anyway"
          stays one press away — two sports can hold the same league name and
          two eras of one sport genuinely can too, so this must never block. */}
      <div className="flex flex-wrap items-center gap-3">
        {/*
          ONE primary button element across both states. `nearMatches` lands
          ~300ms after the operator stops typing, so `exact` can appear while
          the create button already HAS focus — and a ternary swapping which
          element renders here unmounts the focused node, sending focus to
          <body> so the next Tab restarts at the top of the page (WCAG 2.2 SC
          3.2.2 / 2.4.3). Label, handler and enablement are props on a single
          element, so React patches the node and focus survives.
        */}
        <NeonButton
          type="button"
          onClick={() => {
            if (exact) {
              onCreated({
                id: exact._id as Id<"leagues">,
                created: false,
                name: exact.name,
              });
              return;
            }
            void create();
          }}
          disabled={exact ? false : !canCreate}
          // Busy is part of the NAME, not only of the visible text. The label
          // was static while the text flipped to "Adding…", so a screen-reader
          // user pressing it heard "Create league American League" both before
          // and after — no confirmation that anything happened, and an
          // invitation to press again (WCAG 2.2 SC 4.1.2). `exact` keeps no
          // label because the visible "Open {name}" already names it.
          aria-label={
            exact
              ? undefined
              : busy
                ? "Adding league"
                : `Create league ${trimmed}`
          }
        >
          {exact ? `Open ${exact.name}` : busy ? "Adding…" : "Create league"}
        </NeonButton>
        {exact && (
          <button
            type="button"
            onClick={() => void create()}
            disabled={!canCreate}
            // Same rule as the primary above: the name says busy because the
            // text does.
            aria-label={
              busy ? "Adding league" : `Create league ${trimmed} anyway`
            }
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

export default AddLeagueForm;
