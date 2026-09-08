import { useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { splitTeamName, teamFullName } from "../../lib/teams/team-name";
import { eraLabel } from "../../lib/teams/team-era";
import { normalizeOrderedEntityName } from "../../lib/entities/normalize-name";
import { Input } from "../primitives/Input";
import NeonButton from "../modules/NeonButton";
import NewLeagueForm, {
  leagueDraftError,
  newLeaguePrefill,
  type NewLeagueDraft,
} from "./NewLeagueForm";

/**
 * NEO-254 — what staging a typed league name did.
 *
 * Three outcomes, and they read differently to the operator: a step was raised
 * ("you will fill in the details next"), the sport already answers to that name
 * ("picked it for you" — no second row for one league), or this team has
 * already raised as many league steps as it may.
 */
export type StageLeagueOutcome =
  | { kind: "staged"; name: string }
  | { kind: "existing"; leagueId: Id<"leagues">; name: string }
  | { kind: "over-cap" };

/**
 * NEO-236 — the one form a team is ever created from.
 *
 * Jason, 2026-09-05, on the review wizard showing three cramped Location/Name
 * pairs under a player's career list: "How does this dialog know which League
 * the new team is in? I think we need to show a new team dialog instead of that
 * inline thing." And, on the pickers: "we should also remove the Location box
 * from New Players as we should only be selecting existing teams or entering it
 * in the singular field which would trigger that new team dialog."
 *
 * So there is exactly one place in the product that asks the three questions a
 * `teams` row needs answering — Location, Name, League — and it renders in two
 * hosts: the review wizard's **New Team step** (`EntityReviewWizard`) and the
 * **New Team dialog** (`NewTeamDialog`) that every picker opens. Sharing the
 * fields rather than the whole screen is deliberate: the two hosts differ in
 * their chrome (a step inside a walker vs. a modal over a popover) and agree on
 * everything that decides what gets written.
 *
 * ## Why League is a row of buttons and not a `<select>`
 *
 * Maestro's web driver gives every `<option>` synthetic tap bounds from its
 * index inside its own parent, then resolves a tap by scanning
 * `document.querySelectorAll('option')` and taking the first bounds match — so
 * with more than one `<select>` on screen, only the first in document order is
 * ever reachable, and a tap meant for the second silently mutates the first.
 * Both hosts render over a page that already has selects. A dropdown here would
 * be untappable by every flow that has to use it.
 *
 * It is also the better control for this question. A sport holds a handful of
 * leagues, the choice is the point of the step, and a row of pills shows the
 * whole set at once instead of hiding it behind a closed box.
 *
 * ## Location is where they are FROM
 *
 * City, state, region or school — "Wisconsin / Badgers", "San Diego State /
 * Aztecs", "Tampa Bay / Buccaneers". Blank only when the name carries no place
 * at all ("Athletics", "Liverpool", "Orix Buffaloes") or when splitting would
 * reorder the words ("FC Dallas"). The help line says exactly that, because the
 * split is only obvious once you have been told what counts as a location.
 *
 * Nothing here guesses. Location is pre-filled ONLY from a location the
 * enrichment lookup actually returned, and only when `splitTeamName` finds it
 * as a whole-word prefix of the proposed name. Everything else starts blank
 * with the whole name in Name, and the operator splits it.
 */

/** The answer this form collects. Empty strings, not undefined — these are
 *  controlled inputs, and a blank Location is a real answer. */
export type NewTeamDraft = {
  location: string;
  name: string;
  /**
   * The league the operator picked, as one of three states that the server
   * treats differently:
   *   - a league id — this existing league;
   *   - `null` — no league, said deliberately;
   *   - `undefined` — not answered, so the server's own fallbacks apply.
   * The form only ever produces the first two once it has rendered; `undefined`
   * is the initial value a host may seed it with.
   */
  leagueId: Id<"leagues"> | null | undefined;
  /**
   * A league to CREATE, by name — the "we don't hold this one yet" answer. Set
   * only by picking the suggestion pill; mutually exclusive with `leagueId`,
   * which the pill handler enforces by clearing it.
   */
  leagueName: string | undefined;
  /**
   * NEO-254 — the years this team played, when the operator knows them.
   *
   * Load-bearing for identity, not decoration. A sport can hold two teams under
   * one name — the 1972-1996 Winnipeg Jets and the 2011- Jets — and the era is
   * the only thing that tells them apart, so it is what decides whether
   * creating finds the row we hold or makes a second one beside it.
   *
   * Optional, and stays optional: most teams are created without anybody
   * knowing or caring, and an undated row is a normal row. It matters exactly
   * when the name is already taken, which is when the form asks for it.
   */
  yearsActive?: { from: number; to?: number };
};

/**
 * What the form shows before the operator touches anything.
 *
 * `location` splits off the front of `name` only when the enrichment supplied
 * one AND it is a whole-word prefix: "San Diego" off "San Diego Padres" splits,
 * "Anaheim" off "Los Angeles Angels" does not, and neither does "Sa".
 *
 * The league is left for {@link resolveLeagueSuggestion} to settle against the
 * sport's real rows, because "the lookup said Australian Baseball League" and
 * "we hold a row called that" are different facts and only the second one can
 * be pre-selected.
 */
export function newTeamPrefill(input: {
  name: string;
  location?: string;
}): NewTeamDraft {
  const split = input.location
    ? splitTeamName(input.name, input.location)
    : null;
  return {
    location: split ? split.location : "",
    name: split ? split.name : input.name.trim(),
    leagueId: undefined,
    leagueName: undefined,
  };
}

/** `teamFullName` over a draft — the composed row, for the preview and for
 *  every comparison. Never compose these two by hand. */
export function draftFullName(draft: { location: string; name: string }): string {
  return teamFullName({ name: draft.name, location: draft.location });
}

/**
 * The league the enrichment suggested, matched against what this sport already
 * holds — WITHOUT creating anything.
 *
 * A read must not write. A suggestion the operator never accepts, in a batch
 * they end up cancelling, would otherwise leave a league row behind for a team
 * that was never created.
 *
 * Matching is by normalized name only, deliberately narrower than the server's
 * `findLeagueByName` (which also consults each row's aliases). A false negative
 * here costs one thing — the pill reads "Create <name>" instead of selecting an
 * existing row — and the server still resolves it onto that row through
 * `findOrCreateLeague`, so nothing duplicates. A false POSITIVE would silently
 * file the team in the wrong league, so the cheap comparison is the safe one.
 *
 * NEO-253: the shared order-preserving key, not a transcription of it. The
 * comparison this feeds is between a name a SOURCE supplied and a name NB
 * stores, which is precisely where the spellings disagree about accents — a
 * hand copy that stopped at `[^a-z0-9\s-]` shredded "Ligue Panaméricaine"
 * into a key resembling nothing, so the pill offered to create a league the
 * sport already held. Unordered on purpose: `leagues.nameNormalized` does not
 * token-sort, and sorting here would match "National League" against "League
 * National".
 */
function normalizeLeagueName(raw: string): string {
  return normalizeOrderedEntityName(raw);
}

export default function NewTeamForm({
  sportId,
  draft,
  onChange,
  /**
   * The league the enrichment lookup proposed, by name. Rendered as an extra
   * pill — selecting an existing row when we hold one, "Create <name>"
   * otherwise. Absent when nothing was found, which is the common case for a
   * team no source has heard of.
   */
  leagueSuggestion,
  /** NEO-254 — leagues this batch has answered but not yet written. */
  stagedLeagueNames,
  onStageLeague,
  onCreateLeague,
  onLeagueStatus,
  /** "Needed by: Travis Bazzana" — why this step exists, on the steps that
   *  were not asked for directly. */
  neededBy,
  /** Points every field at the host's own blocked-reason element. */
  describedBy,
  /**
   * STABLE ids for the two text fields — or nothing.
   *
   * This is not cosmetic. maestro-web derives `resource-id = node.id ||
   * node.ariaLabel`, so an id it cannot predict REPLACES the label every
   * `.maestro` selector targets — which is why the `Input` primitive refuses to
   * mint one of its own. A `useId()` value here would be exactly that.
   *
   * So the wizard passes the three stable, hand-written ids its step is
   * addressed by (`entity-review-team-*`), and the dialog passes NONE: its
   * fields are found by their `aria-label`, and their visible labels associate
   * by wrapping instead of by `htmlFor`.
   */
  locationFieldId,
  nameFieldId,
  leagueGroupId,
  /** Focus target for a host that opens on this field — the dialog does. */
  nameInputRef,
  disabled,
  /** Enter inside a field. The dialog submits; the wizard step does nothing,
   *  because its primary action is a walker button rather than a submit. */
  onSubmit,
}: {
  sportId: Id<"selectorOptions">;
  draft: NewTeamDraft;
  onChange: (patch: Partial<NewTeamDraft>) => void;
  leagueSuggestion?: string;
  /**
   * NEO-254 — leagues this BATCH has answered but not yet written.
   *
   * Nothing is stored until commit, so `api.leagues.list` cannot see a league
   * the New League step just created — and without this the team step went on
   * offering `Create National Hockey League` for a league the operator had
   * already answered, which is exactly the bug that step exists to remove
   * (Jason, preview test 2026-09-06: every hockey team row showed it).
   *
   * Names only, keyed the way `convex/leagues.ts` keys them. The team's
   * decision still travels as `create.leagueName`, and the commit prelude maps
   * that name to the row the league step produced.
   */
  stagedLeagueNames?: readonly string[];
  /**
   * NEO-254 — WIZARD context: stage a New League step for a name the operator
   * typed here.
   *
   * Jason, preview 2026-09-07, on "New Team: Lincoln Stars" (USHL): Wikidata
   * carried no league, the sport had none yet, and the step offered a lone
   * `No league` pill. There was nowhere to say what the league IS, so the
   * operator was stuck with a team he knew the league of and no way to record
   * it.
   *
   * Returns what happened, because the three outcomes read differently to the
   * operator: a step was raised, the sport already answers to that name (so the
   * existing league is picked instead), or the team has raised as many league
   * steps as it may.
   */
  onStageLeague?: (name: string) => Promise<StageLeagueOutcome>;
  /**
   * NEO-254 — PICKER context: create the league outright.
   *
   * There is no batch to stage into and no later step, so this is the only
   * chance to collect the record — which is why this shape opens the full
   * `NewLeagueForm` rather than a single text box.
   */
  onCreateLeague?: (draft: NewLeagueDraft) => Promise<{ id: Id<"leagues">; name: string }>;
  /** Where the two shapes above report what happened. */
  onLeagueStatus?: (status: { text: string; isError: boolean }) => void;
  neededBy?: string;
  describedBy?: string;
  locationFieldId?: string;
  nameFieldId?: string;
  leagueGroupId?: string;
  nameInputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
  onSubmit?: () => void;
}) {
  const leagues = useQuery(api.leagues.list, { sportId });

  /**
   * The suggestion, resolved against the sport's rows. Three shapes, and the
   * pill row renders each differently because they are three different
   * commitments: select a row we have, create a row we do not, or nothing.
   */
  const suggestion = useMemo(() => {
    const name = leagueSuggestion?.trim();
    if (!name) return null;
    const key = normalizeLeagueName(name);
    const existing = (leagues ?? []).find(
      (l) => normalizeLeagueName(l.name) === key,
    );
    return existing
      ? ({ kind: "existing" as const, id: existing._id, name: existing.name })
      : ({ kind: "create" as const, name });
  }, [leagueSuggestion, leagues]);

  /**
   * The operator has not answered the League question yet.
   *
   * While that is true the SUGGESTION is what will actually happen — the server
   * falls back to the enrichment's league name when no choice was recorded — so
   * its pill is shown checked. That is not a pre-selection pretending to be an
   * answer; it is the answer, until something else is pressed. Pressing it
   * anyway records it explicitly, which costs nothing and reads the same.
   */
  const unanswered = draft.leagueId === undefined && draft.leagueName === undefined;

  const preview = draftFullName(draft);

  /**
   * a11y (SC 3.3.2 Labels or Instructions) — the help line and the "Shows as"
   * preview are the two things on this form that a sighted operator reads and
   * a screen-reader operator was never given: both were plain text no control
   * pointed at, so tabbing into Location announced "New team location
   * (optional), edit text" and nothing about what a location IS.
   *
   * `useId` is safe HERE and nowhere else in this file: maestro-web derives
   * `resource-id = node.id || node.ariaLabel`, so a generated id on an INPUT
   * replaces the label a flow targets — but a `<p>` is not a tap target, and
   * its text stays matchable either way. Two `NewTeamForm`s can be mounted at
   * once (a picker's dialog over the wizard's own step), which is exactly the
   * case `useId` exists for.
   */
  const helpId = useId();
  const previewId = useId();

  /** `aria-describedby` takes a space-separated id list; drop the absent ones
   *  rather than emitting an empty or dangling reference. */
  const describedByFor = (...ids: Array<string | undefined>) =>
    ids.filter(Boolean).join(" ") || undefined;

  const pick = (patch: Partial<NewTeamDraft>) => {
    if (disabled) return;
    // Choosing does not close the list — see `leagueListOpen`.
    setLeagueListOpen(true);
    // The two league answers are alternatives, so setting either clears the
    // other. Without this a draft could carry an id AND a name, and which one
    // the server honoured would depend on its resolution order rather than on
    // what the operator pressed.
    onChange({ leagueId: undefined, leagueName: undefined, ...patch });
  };

  const onFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !onSubmit) return;
    e.preventDefault();
    onSubmit();
  };

  /** True when this pill is the current answer — explicitly, or by being the
   *  suggestion nothing has overridden yet. */
  const isPicked = (id: Id<"leagues">) =>
    draft.leagueId === id ||
    (unanswered && suggestion?.kind === "existing" && suggestion.id === id);

  /**
   * The League options, IN RENDERED ORDER — one model the JSX, the roving
   * tabindex and the arrow keys all read from.
   *
   * a11y (SC 2.1.1 / 4.1.2): `role="radiogroup"` of `role="radio"` is a promise
   * about the keyboard, not just about the announcement. A native radio group
   * is ONE Tab stop and moves between its options with the arrow keys; before
   * this, every pill was an ordinary `<button>`, so a keyboard operator paid
   * one Tab stop per league (a sport with a dozen leagues buried the Create
   * button behind twelve of them) and the arrows did nothing at all. Same
   * pattern, same reasoning and same shape as `CardPairingModal`'s name-conflict
   * group — see the APG "radio group" pattern.
   */
  const leaguePills: Array<{
    key: string;
    label: string;
    checked: boolean;
    choose: () => void;
  }> = [];
  /*
   * ── NEO-254: every league this batch can offer, in one list ──────────────
   *
   * Three sources, and the order is the order an operator would look in.
   *
   * 1. Leagues this BATCH has staged but not yet written. `api.leagues.list`
   *    cannot see them — nothing is stored until commit — so without this the
   *    operator creates "USHL" on one team's step and the next team has no way
   *    to pick it (Jason, preview 2026-09-07). Offered to EVERY later team,
   *    not just the ones whose enrichment happened to name that league: the
   *    Lincoln Stars had no suggestion at all, which is the case that made the
   *    gap visible.
   *
   *    Labelled "<name> (new)" rather than "Create <name>": once a step has
   *    been raised, the commitment exists, and re-offering it as a decision
   *    would invite a second row for one league.
   *
   * 2. THIS team's own suggestion, when the batch has not already staged it —
   *    still worded as the commitment it is.
   *
   * 3. Every league the sport actually holds, then "No league".
   */
  const existingKeys = new Set(
    (leagues ?? []).map((l) => normalizeLeagueName(l.name)),
  );
  const stagedKeys = new Set<string>();
  for (const name of stagedLeagueNames ?? []) {
    const key = normalizeLeagueName(name);
    // A staged name the sport ALREADY holds is not a separate option — it is
    // that league, and its own pill is below.
    if (!key || existingKeys.has(key) || stagedKeys.has(key)) continue;
    stagedKeys.add(key);
    leaguePills.push({
      key: `staged:${key}`,
      label: `${name} (new)`,
      checked: !!draft.leagueName && normalizeLeagueName(draft.leagueName) === key,
      choose: () => pick({ leagueName: name }),
    });
  }
  if (suggestion?.kind === "create" && !stagedKeys.has(normalizeLeagueName(suggestion.name))) {
    const checked = unanswered || draft.leagueName === suggestion.name;
    leaguePills.push({
      key: `create:${suggestion.name}`,
      label: `Create ${suggestion.name}`,
      checked,
      choose: () => pick({ leagueName: suggestion.name }),
    });
  }
  for (const league of leagues ?? []) {
    leaguePills.push({
      key: league._id,
      label: league.name,
      checked: isPicked(league._id),
      choose: () => pick({ leagueId: league._id }),
    });
  }
  leaguePills.push({
    key: "no-league",
    label: "No league",
    checked: draft.leagueId === null,
    choose: () => pick({ leagueId: null }),
  });

  const answeredIndex = leaguePills.findIndex((p) => p.checked);

  /**
   * ── Why the whole league list is not on screen by default ────────────────
   *
   * CI run 8: this picker measured 250px on the 1024x629 viewport, which is
   * what pushed the review wizard's primary action off the bottom of its
   * dialog. It renders one pill per league in the sport, `leagues` is global,
   * and nothing resets it between CI runs — so it grows every run, and on a
   * real deployment it grows as the league table fills with MiLB and defunct
   * franchises. A picker whose height is a function of a table that only ever
   * gets bigger is not a picker, it is a leak.
   *
   * When there is already a standing answer — the enrichment's suggestion, or a
   * league the operator picked — the list collapses to THAT one pill plus a
   * "Change league" disclosure: ~24px instead of 250px, and it says the thing
   * the operator actually needs to read, which is which league this team is
   * about to be filed under. With no standing answer there is nothing to
   * summarise, so the list opens as itself.
   *
   * Expanded, it is bounded at `max-h-40` and scrolls. That bound is the part
   * that must not be removed: the disclosure is a nicety, the height cap is
   * what stops a growing table from reaching the footer again.
   */
  /**
   * `null` = follow the default (open only while there is nothing to
   * summarise); `true`/`false` = the operator said so.
   *
   * A plain boolean was wrong in a way a test caught immediately: with no
   * standing answer the list is open, and the moment an arrow key or a click
   * picked a league there WAS one — so the list collapsed out from under an
   * operator who was still choosing. Picking therefore pins it open, and only
   * the disclosure's own "Done" closes it.
   */
  const [leagueListOpen, setLeagueListOpen] = useState<boolean | null>(null);

  // ── NEO-254: naming a league that does not exist yet ──────────────────────
  const newLeagueFormId = useId();
  const newLeagueTriggerRef = useRef<HTMLButtonElement>(null);
  const [namingLeague, setNamingLeague] = useState(false);
  const [newLeagueName, setNewLeagueName] = useState("");
  const [newLeagueDraft, setNewLeagueDraft] = useState<NewLeagueDraft>(() =>
    newLeaguePrefill({ name: "" }),
  );
  const [leagueBusy, setLeagueBusy] = useState(false);

  /** Close and hand focus back to the control that opened it. */
  const closeNewLeague = () => {
    setNamingLeague(false);
    setNewLeagueName("");
    setNewLeagueDraft(newLeaguePrefill({ name: "" }));
    // Back to the disclosure, not to `<body>` — closing unmounts the focused
    // field. Same rule as TeamManagement's franchise picker.
    newLeagueTriggerRef.current?.focus();
  };

  /**
   * NEO-254 — commit whichever shape is open.
   *
   * The two contexts differ in what "commit" MEANS, which is why they are two
   * shapes rather than one with a flag: the wizard records an intention the
   * batch will act on, the picker writes a row. Both end the same way — the
   * league is the team's answer, and the operator is told what happened.
   */
  const submitNewLeague = async () => {
    if (leagueBusy) return;
    if (onStageLeague) {
      const name = newLeagueName.trim();
      if (!name) return;
      setLeagueBusy(true);
      try {
        const outcome = await onStageLeague(name);
        if (outcome.kind === "over-cap") {
          onLeagueStatus?.({
            text: "That's the most new leagues this team can raise. Answer one first.",
            isError: true,
          });
          return;
        }
        if (outcome.kind === "existing") {
          // No second row for one league — the sport already answers to this
          // name (or an alias of it), so the answer is that league.
          pick({ leagueId: outcome.leagueId });
          onLeagueStatus?.({
            text: `${outcome.name} is already a league here — picked it for you.`,
            isError: false,
          });
        } else {
          pick({ leagueName: outcome.name });
          onLeagueStatus?.({
            text: `${outcome.name} will be added. You'll fill in the details next.`,
            isError: false,
          });
        }
        closeNewLeague();
      } catch {
        onLeagueStatus?.({
          text: "Could not add that league. Try again.",
          isError: true,
        });
      } finally {
        setLeagueBusy(false);
      }
      return;
    }
    if (!onCreateLeague) return;
    if (leagueDraftError(newLeagueDraft, new Date().getFullYear() + 1)) return;
    setLeagueBusy(true);
    try {
      const created = await onCreateLeague(newLeagueDraft);
      pick({ leagueId: created.id });
      onLeagueStatus?.({
        text: `Added ${created.name}. It is this team's league.`,
        isError: false,
      });
      closeNewLeague();
    } catch {
      onLeagueStatus?.({
        text: "Could not add that league. Try again.",
        isError: true,
      });
    } finally {
      setLeagueBusy(false);
    }
  };
  const collapsible = answeredIndex !== -1;
  const listOpen = leagueListOpen ?? !collapsible;
  const visiblePills = listOpen ? leaguePills : [leaguePills[answeredIndex]];

  const checkedPillIndex = visiblePills.findIndex((p) => p.checked);
  /** Roving tabindex: the checked pill is the group's single Tab stop, and
   *  when nothing is checked yet the first pill is — matching a native radio
   *  group with no initial selection. */
  const tabStopIndex = checkedPillIndex === -1 ? 0 : checkedPillIndex;

  /**
   * NEO-254 — the eras this sport already holds under the name being typed.
   *
   * Read off `teams.erasByNameAndSport`, which answers with EVERY row under the
   * key rather than the first — the whole point of the change. Skipped until
   * there is a name, so an empty form costs nothing.
   *
   * The hint it feeds is a statement, not a block: a second era of a name is a
   * legitimate thing to create, and the operator is the only one who knows
   * whether this is the 2011 Winnipeg Jets or a typo of the 1972 ones.
   */
  const existingEras = useQuery(
    api.teams.erasByNameAndSport,
    sportId && draft.name.trim()
      ? { name: draftFullName(draft), sportId }
      : "skip",
  );
  const sameNameEras = useMemo(
    () =>
      (existingEras ?? []).map(
        (row) => eraLabel(row.yearsActive) || "no years yet",
      ),
    [existingEras],
  );

  const leagueGroupRef = useRef<HTMLDivElement>(null);

  /**
   * Focus follows selection, which the APG radio pattern requires and which is
   * the only way arrow keys are usable at all: the pill that becomes checked
   * is the one that becomes the Tab stop, so it has to end up focused too.
   * Re-queried after the render rather than held as a ref, for the same reason
   * `CardPairingModal.refocusSelectedRadio` re-queries — the newly-checked pill
   * only carries `tabindex="0"` once the host's state change has committed.
   */
  const refocusCheckedPill = () => {
    requestAnimationFrame(() => {
      leagueGroupRef.current
        ?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
        ?.focus();
    });
  };

  const onLeagueKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : 0;
    if (step === 0) return;
    // Also stops the arrow from scrolling the host dialog out from under the
    // group the operator is working in.
    e.preventDefault();
    const from = checkedPillIndex === -1 ? 0 : checkedPillIndex;
    // Over the VISIBLE pills: collapsed, there is one option and the arrows
    // have nothing to move between, which is the honest behaviour rather than
    // silently changing a league the operator cannot see.
    visiblePills[
      (from + step + visiblePills.length) % visiblePills.length
    ].choose();
    refocusCheckedPill();
  };

  return (
    <div className="space-y-2">
      {neededBy && (
        /* The provenance line. This step was not asked for — a player's career
           list produced it — so it says whose card needs the team before it
           asks anything. gray-400: gray-500 on gray-900 is ~3.6:1, under the
           4.5:1 floor. */
        <p className="text-xs text-gray-400">Needed by: {neededBy}</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <FieldLabel htmlFor={locationFieldId} text="Location (optional)">
          <Input
            bare
            {...(locationFieldId ? { id: locationFieldId } : {})}
            type="text"
            value={draft.location}
            placeholder="San Diego"
            // SC 2.5.3, label in name: the visible label is "Location
            // (optional)", so the accessible name has to contain all of it.
            aria-label="New team location (optional)"
            // SC 3.3.2: the help line below explains what counts as a
            // Location; without this it was visible-only.
            aria-describedby={describedByFor(helpId, previewId, describedBy)}
            disabled={disabled}
            onChange={(e) => onChange({ location: e.target.value })}
            onKeyDown={onFieldKeyDown}
            className="w-40 p-1.5 text-sm"
          />
        </FieldLabel>
        <FieldLabel htmlFor={nameFieldId} text="Team name" grow>
          <Input
            bare
            {...(nameFieldId ? { id: nameFieldId } : {})}
            ref={nameInputRef}
            type="text"
            value={draft.name}
            placeholder="Padres"
            aria-label="New team name"
            aria-describedby={describedByFor(previewId, describedBy)}
            disabled={disabled}
            onChange={(e) => onChange({ name: e.target.value })}
            onKeyDown={onFieldKeyDown}
            className="w-full p-1.5 text-sm"
          />
        </FieldLabel>
      </div>

      {/* The rule, in one line, saying the part operators get wrong: a location
          is not only a city. When to leave it blank is carried by the
          "(optional)" in the label above. */}
      <p id={helpId} className="text-xs text-gray-400">
        Location is where they are from — a city, state, region or school:
        Wisconsin / Badgers, San Diego State / Aztecs. Leave it blank only when
        the name has no place in it.
      </p>

      {/* NEO-254 — the era.
      
          Asked for HERE, beside the name, rather than left to Team Management
          afterwards: it is part of the team's identity, so a row created
          without it cannot later be told apart from a same-named row someone
          else creates. Two narrow number boxes on one line, the same shape
          Team Management already uses for the same pair of facts.
          
          `sameNameEras` below turns this from an optional nicety into the
          question the form is actually asking, but only when it has to. */}
      <div className="flex items-end gap-2">
        <FieldLabel text="Active from (optional)">
          <Input
            bare
            type="number"
            inputMode="numeric"
            value={draft.yearsActive?.from ? String(draft.yearsActive.from) : ""}
            placeholder="1972"
            aria-label="New team active from (optional)"
            disabled={disabled}
            onChange={(e) => {
              const from = Number.parseInt(e.target.value, 10);
              onChange({
                yearsActive: Number.isInteger(from)
                  ? { from, ...(draft.yearsActive?.to !== undefined ? { to: draft.yearsActive.to } : {}) }
                  : undefined,
              });
            }}
            onKeyDown={onFieldKeyDown}
            className="w-full p-1.5 text-sm"
          />
        </FieldLabel>
        <FieldLabel text="to">
          <Input
            bare
            type="number"
            inputMode="numeric"
            value={draft.yearsActive?.to ? String(draft.yearsActive.to) : ""}
            placeholder="present"
            aria-label="New team active to"
            // A closing year with no opening one is not a span, and storing it
            // would make an era nothing can compare. The box says so by being
            // unavailable rather than by refusing after the fact.
            disabled={disabled || draft.yearsActive === undefined}
            onChange={(e) => {
              if (!draft.yearsActive) return;
              const to = Number.parseInt(e.target.value, 10);
              onChange({
                yearsActive: Number.isInteger(to)
                  ? { from: draft.yearsActive.from, to }
                  : { from: draft.yearsActive.from },
              });
            }}
            onKeyDown={onFieldKeyDown}
            className="w-full p-1.5 text-sm"
          />
        </FieldLabel>
      </div>

      {sameNameEras.length > 0 && (
        /* The hint the ticket asks for, and it is a statement rather than a
           warning: a second era is a legitimate thing to create — the Winnipeg
           Jets did it — so this names what is already there and lets the
           operator decide, instead of blocking with a colour that says
           "mistake". `neon-yellow` would claim to know; gray states. */
        <p className="text-xs text-gray-400">
          {draftFullName(draft)} already exists for{" "}
          <span className="font-mono tabular-nums">
            {sameNameEras.join(", ")}
          </span>
          . Give this one its own years if it is a different era of the club.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
      <div
        ref={leagueGroupRef}
        role="radiogroup"
        {...(leagueGroupId ? { id: leagueGroupId } : {})}
        aria-label="New team league"
        // `max-h-40 overflow-y-auto` only while open — see `leagueListOpen`.
        // Collapsed it holds one pill and a cap would be noise.
        className={`flex flex-wrap items-center gap-1.5${
          listOpen ? " max-h-40 overflow-y-auto" : ""
        }`}
        onKeyDown={onLeagueKeyDown}
      >
        <span className="text-xs text-gray-400 mr-1">League</span>
        {visiblePills.map((pill, idx) => (
          /* The "Create <name>" pill, when there is one, is a league nothing in
             this sport answers to yet — worded as the commitment it is, because
             pressing it creates a league as well as a team. */
          <button
            key={pill.key}
            type="button"
            role="radio"
            aria-checked={pill.checked}
            // Roving tabindex — see `tabStopIndex`. One Tab stop for the whole
            // group; the arrow keys move within it.
            tabIndex={idx === tabStopIndex ? 0 : -1}
            /*
              a11y (SC 4.1.2 Name, Role, Value) — the SET, not the slice of it
              on screen.

              Collapsed, this group renders exactly one `role="radio"`, and a
              screen reader derives set position from the DOM: it would announce
              "Australian Baseball League, radio button, checked, 1 of 1" and a
              screen-reader operator would reasonably conclude the sport has one
              league. `aria-posinset`/`aria-setsize` are counted against the FULL
              `leaguePills` list in both states, so the announcement is "3 of 41"
              either way and the "Change league" disclosure beside it reads as
              the way to the other 40 rather than as a puzzle.
            */
            aria-posinset={(listOpen ? idx : answeredIndex) + 1}
            aria-setsize={leaguePills.length}
            disabled={disabled}
            onClick={() => pill.choose()}
            className={pillClass(pill.checked)}
          >
            {pill.label}
          </button>
        ))}
        {leagues === undefined && (
          /* SC 4.1.3: the group changes shape under the operator when the query
             lands, so the wait is announced rather than only drawn. */
          <span role="status" className="text-xs text-gray-400">
            Loading leagues…
          </span>
        )}
      </div>
      {collapsible && (
        /* Outside the radiogroup on purpose: it is not one of the options, and
           a non-radio child of a radiogroup is a shape assistive tech cannot
           read. `aria-expanded` names the state; the label names the action. */
        <button
          type="button"
          aria-expanded={listOpen}
          aria-controls={leagueGroupId}
          disabled={disabled}
          onClick={() => {
            const next = !listOpen;
            setLeagueListOpen(next);
            // Opening a scrollable list on a league that may be well down it —
            // bring the current answer into view rather than making them hunt.
            if (next) {
              requestAnimationFrame(() => {
                leagueGroupRef.current
                  ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
                  ?.scrollIntoView({ block: "nearest" });
              });
            }
          }}
          /* a11y (SC 2.5.8 Target Size): a `text-xs` underline button with no
             vertical padding is 16px tall — the exact shape this project has
             already fixed twice (SyncDoneNotice's Dismiss, the sync-review
             pills). `py-2 -my-2` gives it a 32px hit area and hands the padding
             back to the layout, so the collapsed picker is still one pill high
             and the CI-run-8 height win is untouched. */
          className="py-2 -my-2 text-xs text-gray-400 underline decoration-dotted hover:text-[#00D558] focus-visible:text-[#00D558] focus:outline-none disabled:opacity-50"
        >
          {/* NEO-254 — "Show all leagues", not "Change league".
              Jason, preview 2026-09-07: with a standing answer the row shows
              ONE pill, and an operator looking for a league they created a
              moment ago reads that as "it is not here". The label now says
              what the control does. */}
          {listOpen ? "Hide leagues" : "Show all leagues"}
        </button>
      )}
      {(onStageLeague || onCreateLeague) && (
        /*
          NEO-254 — the way to name a league that does not exist yet.

          Jason, preview 2026-09-07, on "New Team: Lincoln Stars" (USHL):
          Wikidata carried no league, the sport had none, and the step offered a
          lone `No league` pill. There was nowhere to say what the league IS.

          OUTSIDE the radiogroup, and a disclosure rather than an option: it is
          a command, and a non-radio child of a radiogroup is a shape assistive
          tech cannot read. Styled as a pill anyway, because it belongs to this
          control visually — the same call `TeamManagement`'s
          "+ Start a new franchise…" makes. ALWAYS present: the case it exists
          for is precisely the one where there is nothing else on the row.
        */
        <button
          type="button"
          ref={newLeagueTriggerRef}
          aria-expanded={namingLeague}
          aria-controls={newLeagueFormId}
          disabled={disabled}
          onClick={() => setNamingLeague((open) => !open)}
          className={pillClass(false)}
        >
          + New league…
        </button>
      )}
      </div>

      {leagues !== undefined && leaguePills.length === 1 && (
        /* Only "No league" on the row. Saying so is the difference between an
           empty control and a broken one — and the trigger beside it is the
           invitation to act. */
        <p className="text-xs text-gray-400">No leagues in this sport yet.</p>
      )}

      {namingLeague && (
        <div id={newLeagueFormId} className="rounded-md border border-gray-700 p-2">
          {onStageLeague ? (
            /*
              WIZARD — one text box, because the league gets a step of its own
              in a moment and asking for the whole record twice would be the
              wizard arguing with itself. The button says what happens.
            */
            <div className="flex items-end gap-2">
              <Input
                label="New league name"
                aria-label="New league name"
                value={newLeagueName}
                placeholder="United States Hockey League"
                autoFocus
                disabled={disabled || leagueBusy}
                onKeyDown={(e) => {
                  // Keyboard-first: Enter commits, Escape backs out to the
                  // control that opened it — closing unmounts the focused input.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitNewLeague();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeNewLeague();
                  }
                }}
                onChange={(e) => setNewLeagueName(e.target.value)}
              />
              <NeonButton
                type="button"
                onClick={() => void submitNewLeague()}
                disabled={disabled || leagueBusy || !newLeagueName.trim()}
              >
                {leagueBusy ? "Staging…" : "Stage"}
              </NeonButton>
            </div>
          ) : (
            /*
              PICKER — there is no batch to stage into and no later step, so
              this is the only chance to collect the record. The full
              `NewLeagueForm`, reused rather than restated, so its validation
              and its bounds are the ones that apply here too.
            */
            <div
              className="flex flex-col gap-2"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeNewLeague();
                }
              }}
            >
              <NewLeagueForm
                draft={newLeagueDraft}
                onChange={(patch) =>
                  setNewLeagueDraft((prev) => ({ ...prev, ...patch }))
                }
                disabled={disabled || leagueBusy}
              />
              <div className="flex items-center gap-2">
                <NeonButton
                  type="button"
                  onClick={() => void submitNewLeague()}
                  disabled={
                    disabled ||
                    leagueBusy ||
                    leagueDraftError(newLeagueDraft, new Date().getFullYear() + 1) !== null
                  }
                >
                  {leagueBusy ? "Adding…" : "Add league"}
                </NeonButton>
                <button
                  type="button"
                  onClick={closeNewLeague}
                  className="py-2 -my-2 text-xs text-gray-400 underline decoration-dotted hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The whole point of three fields: the operator reads the row they are
          about to create, composed the way it will read everywhere else.
          Pointed at by both fields' `aria-describedby` (SC 3.3.2) rather than
          made a live region — a preview that re-announced on every keystroke
          would talk over the typing it is describing. */}
      <p id={previewId} className="text-sm text-gray-400">
        Shows as:{" "}
        <span className="font-medium text-gray-100">{preview || "—"}</span>
      </p>
    </div>
  );
}

/**
 * A visible label for one field, associated the way the host allows.
 *
 * With an id, `htmlFor` — which is what a stable, hand-written id is for. With
 * none, the label WRAPS the input, which is the other standard association and
 * needs no id at all. Both are accessible; only one of them is safe to hand
 * Maestro. Same fork the `Input` primitive itself makes, for the same reason.
 */
function FieldLabel({
  htmlFor,
  text,
  grow,
  children,
}: {
  htmlFor?: string;
  text: string;
  grow?: boolean;
  children: ReactNode;
}) {
  const className = grow
    ? "flex flex-col gap-1 flex-1 min-w-[10rem]"
    : "flex flex-col gap-1";
  const caption = <span className="text-xs text-gray-400">{text}</span>;
  if (htmlFor) {
    return (
      <div className={className}>
        <label htmlFor={htmlFor} className="text-xs text-gray-400">
          {text}
        </label>
        {children}
      </div>
    );
  }
  return (
    <label className={className}>
      {caption}
      {children}
    </label>
  );
}

/**
 * One pill. Green marks the answer; everything else stays quiet, so the row
 * reads as a set with one thing chosen rather than as a wall of controls.
 *
 * `aria-checked` carries the state for assistive tech, and the colour carries
 * it for everyone else — the two are set from the same boolean so they cannot
 * disagree.
 */
function pillClass(picked: boolean): string {
  return [
    // py-1, not py-0.5 (SC 2.5.8 Target Size): a text-xs pill at py-0.5 is 22px
    // tall, which only cleared 24x24 by leaning on the spacing exception. py-1
    // makes it 26px and stops it depending on the gaps around it.
    "rounded-full border px-2 py-1 text-xs",
    // SC 2.4.7 Focus Visible. The indicator used to be a border-colour swap to
    // #00D558 declared ONLY on the unpicked branch — so focusing the PICKED
    // pill, whose border is already #00D558, changed nothing at all, and a
    // keyboard operator arrowing through the group could not see where they
    // were. A ring is on both states and does not collide with the colour that
    // already means "checked".
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    picked
      ? "border-[#00D558] bg-[#00D558]/20 text-[#00D558]"
      : // border-gray-500, not gray-700 (SC 1.4.11 Non-text Contrast): gray-700
        // on the gray-900 panel both hosts render is 1.72:1, so the boundary of
        // an unchecked option was effectively invisible. gray-500 is 3.67:1 and
        // clears the 3:1 floor for a control boundary.
        "border-gray-500 text-gray-300 hover:border-[#00D558]",
  ].join(" ");
}
