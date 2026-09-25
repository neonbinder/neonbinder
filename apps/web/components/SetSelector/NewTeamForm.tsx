import { useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { splitTeamName, teamFullName } from "../../lib/teams/team-name";
import { eraLabel } from "../../lib/teams/team-era";
import { normalizeOrderedEntityName } from "../../lib/entities/normalize-name";
import { Input } from "../primitives/Input";
import { Autocomplete } from "../primitives/Autocomplete";
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
 * ## Why League is a type-ahead
 *
 * It was a row of pills, one per league, for as long as a sport held a
 * handful. Bulk-loaded leagues ended that: Baseball alone now carries dozens
 * (MLB, every MiLB level, the independents, the defunct ones), and the row
 * wrapped across line after line behind a "Show all leagues" toggle. Jason,
 * 2026-09-25, on the New Team step: "This is a terrible interface for
 * selecting a league. It should be a type ahead select like we use for lots
 * of other teams and such things."
 *
 * So it is the shared {@link Autocomplete} combobox (NEO-147): the field shows
 * the current answer at rest, focusing it opens the whole list (the
 * suggestion and this batch's staged leagues first), and typing narrows it by
 * name, alias or abbreviation — or offers to create what was typed. Every
 * answer the pills gave is still an option, including "No league".
 *
 * The reason the pills were not a `<select>` does not apply to this control.
 * Maestro's web driver resolves an `<option>` tap by scanning every `<option>`
 * on the page and taking the first bounds match, so a second native select is
 * unreachable (and both hosts render over pages that have one). The combobox
 * renders `<li role="option">` rows, which Maestro taps like any other
 * element. There is still no `<select>` anywhere in this form.
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
   * by picking the suggestion's "Create <name>", a league this batch staged, or
   * a typed name the wizard staged; mutually exclusive with `leagueId`, which
   * `pick` enforces by clearing it.
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
  /**
   * NEO-284 — other names this team answers to, comma-separated exactly as
   * the League forms take theirs (`parseAliases` in `NewLeagueForm` turns it
   * into the list). A string rather than a list because it is a box the
   * operator is typing into; the host parses it once, at create.
   *
   * Empty string, not undefined: a controlled input, and "no aliases" is a
   * real answer.
   */
  aliases: string;
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
    aliases: "",
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
 * here costs one thing — the option reads "Create <name>" instead of selecting an
 * existing row — and the server still resolves it onto that row through
 * `findOrCreateLeague`, so nothing duplicates. A false POSITIVE would silently
 * file the team in the wrong league, so the cheap comparison is the safe one.
 *
 * NEO-253: the shared order-preserving key, not a transcription of it. The
 * comparison this feeds is between a name a SOURCE supplied and a name NB
 * stores, which is precisely where the spellings disagree about accents — a
 * hand copy that stopped at `[^a-z0-9\s-]` shredded "Ligue Panaméricaine"
 * into a key resembling nothing, so the form offered to create a league the
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
   * The league the enrichment lookup proposed, by name. Offered first in the
   * League list — the existing row when we hold one, "Create <name>"
   * otherwise — and the standing answer until the operator picks another.
   * Absent when nothing was found, which is the common case for a team no
   * source has heard of.
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
   *
   * `leagueGroupId` lands on the League field's WRAPPER, never on the
   * combobox input: an id there would replace "League" as the input's Maestro
   * resource-id.
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
   * League list offers each differently because they are three different
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
      : ({ kind: "create" as const, name, key });
  }, [leagueSuggestion, leagues]);

  /**
   * The operator has not answered the League question yet.
   *
   * While that is true the SUGGESTION is what will actually happen — the server
   * falls back to the enrichment's league name when no choice was recorded — so
   * the field shows it as the answer. That is not a pre-selection pretending to
   * be an answer; it is the answer, until something else is picked. Picking it
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
  // NEO-284 — the alias caption, on the same footing as `helpId`.
  const aliasHelpId = useId();

  /** `aria-describedby` takes a space-separated id list; drop the absent ones
   *  rather than emitting an empty or dangling reference. */
  const describedByFor = (...ids: Array<string | undefined>) =>
    ids.filter(Boolean).join(" ") || undefined;

  const pick = (patch: Partial<NewTeamDraft>) => {
    if (disabled) return;
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

  /**
   * NEO-307 — what the operator has typed into the League field, or `null`
   * while they have not.
   *
   * `null` is the resting state: the field shows the current answer's label
   * and the list is the whole set. Typing takes the field over and narrows the
   * list — WITHOUT touching the answer, so clearing the box or typing a
   * half-name and tabbing away changes nothing. Only picking an option answers.
   * A pick or a dismissal (blur, Escape) puts it back to `null`, which puts
   * the answer's label back in the box.
   */
  const [leagueQuery, setLeagueQuery] = useState<string | null>(null);

  /**
   * The league a PICKER just created, until `leagues.list` reports it. The id
   * is the answer the moment `onCreateLeague` returns, but the reactive list
   * lags it by a round trip, and without this the field would read blank for
   * that moment.
   */
  const [createdLeague, setCreatedLeague] = useState<{
    id: Id<"leagues">;
    name: string;
  } | null>(null);

  const leagueFieldRef = useRef<HTMLDivElement>(null);
  const focusLeagueField = () =>
    leagueFieldRef.current
      ?.querySelector<HTMLInputElement>('[role="combobox"]')
      ?.focus();

  // ── NEO-254: naming a league that does not exist yet ──────────────────────
  const newLeagueFormId = useId();
  const [namingLeague, setNamingLeague] = useState(false);
  const [newLeagueDraft, setNewLeagueDraft] = useState<NewLeagueDraft>(() =>
    newLeaguePrefill({ name: "" }),
  );
  const [leagueBusy, setLeagueBusy] = useState(false);
  const canCreateLeague = !!(onStageLeague || onCreateLeague);

  /** Close the PICKER's league form and hand focus back to the League field —
   *  closing unmounts the focused field, and `<body>` is nowhere. */
  const closeNewLeague = () => {
    setNamingLeague(false);
    setNewLeagueDraft(newLeaguePrefill({ name: "" }));
    focusLeagueField();
  };

  /**
   * NEO-254 / NEO-307 — the operator picked `Create “<typed>”`.
   *
   * The two contexts differ in what "create" MEANS, which is why they are two
   * shapes rather than one with a flag: the wizard records an intention the
   * batch will act on, the picker writes a row. Both end the same way — the
   * league is the team's answer, and the operator is told what happened.
   *
   * WIZARD — staged straight away. The league gets a step of its own in a
   * moment, and asking for the whole record here too would be the wizard
   * arguing with itself; the typed text is the one thing this step needs.
   *
   * PICKER — there is no batch to stage into and no later step, so this is the
   * only chance to collect the record: the full `NewLeagueForm` opens under
   * the field, pre-filled with what was typed.
   */
  const createTypedLeague = async (typed: string) => {
    const name = typed.trim();
    if (!name || leagueBusy || disabled) return;
    if (onStageLeague) {
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
    setNewLeagueDraft(newLeaguePrefill({ name }));
    setNamingLeague(true);
    // Into the form it just opened, on the name it was given — the operator
    // came here to finish this record, and the combobox's list is closed.
    //
    // The WHOLE form is scrolled into view first, and focus then asks for no
    // scroll of its own. Focusing the name field alone scrolls only that
    // field into view, which in NewTeamDialog's scrolling body leaves
    // "Add league" below the fold, under the footer — where a tap meant for
    // it lands on "Create team" instead.
    //
    // NEO-307 (CI, 1024x629): the form alone was not enough. With every detail
    // field open it was taller than the dialog body, and `nearest` on an
    // element taller than its scroller aligns the TOP — so "Add league" stayed
    // under the footer. The details now open collapsed here
    // (`detailsDefaultOpen={false}`), and the ACTIONS row is brought into view
    // last, so whatever the form's height the button that finishes it is on
    // screen. `nearest` on the row: no jump when it is already visible, its
    // bottom aligned to the body's bottom when it is not.
    requestAnimationFrame(() => {
      const form = document.getElementById(newLeagueFormId);
      form?.scrollIntoView?.({ block: "nearest" });
      form
        ?.querySelector<HTMLElement>("[data-new-league-actions]")
        ?.scrollIntoView?.({ block: "nearest" });
      form
        ?.querySelector<HTMLInputElement>("input")
        ?.focus({ preventScroll: true });
    });
  };

  /** PICKER — write the league the `NewLeagueForm` collected. */
  const submitNewLeague = async () => {
    if (leagueBusy || !onCreateLeague) return;
    if (leagueDraftError(newLeagueDraft, new Date().getFullYear() + 1)) return;
    setLeagueBusy(true);
    try {
      const created = await onCreateLeague(newLeagueDraft);
      setCreatedLeague(created);
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

  /*
   * ── NEO-254 / NEO-307: every league this form can offer, in one list ─────
   *
   * Four sources, and the order is the order an operator would look in.
   *
   * 1. THIS team's own suggestion — first, because it is the standing answer
   *    until something else is picked. An existing row is lifted out of the
   *    alphabetical list to sit here; a league we do not hold reads
   *    "Create <name>", the commitment it is.
   *
   * 2. Leagues this BATCH has staged but not yet written. `api.leagues.list`
   *    cannot see them — nothing is stored until commit — so without this the
   *    operator creates "USHL" on one team's step and the next team has no way
   *    to pick it (Jason, preview 2026-09-07). Offered to EVERY later team,
   *    not just the ones whose enrichment happened to name that league.
   *    Labelled "<name> (new)" rather than "Create <name>": once a step has
   *    been raised, the commitment exists, and re-offering it as a decision
   *    would invite a second row for one league.
   *
   * 3. Every league the sport actually holds, alphabetical (the server sorts).
   *
   * 4. What the operator typed, ONLY when it finds nothing above —
   *    `Create “<typed>”` — and then "No league", always.
   *
   *    Jason, 2026-09-25: offered only when the typed text matches no league
   *    (name, alias or abbreviation), no staged league and no suggestion. A
   *    partial match means the league is probably already there under a
   *    longer name, and a Create beside it invites the duplicate.
   */
  type LeagueOption = {
    key: string;
    label: string;
    /** What a typed query is matched against. */
    haystack: string[];
    choose: () => void;
  };

  const existingKeys = new Map<string, Id<"leagues">>();
  for (const league of leagues ?? []) {
    existingKeys.set(normalizeLeagueName(league.name), league._id);
  }

  const stagedByKey = new Map<string, string>();
  for (const name of stagedLeagueNames ?? []) {
    const key = normalizeLeagueName(name);
    // A staged name the sport ALREADY holds is not a separate option — it is
    // that league, and its own row is below.
    if (!key || existingKeys.has(key) || stagedByKey.has(key)) continue;
    stagedByKey.set(key, name);
  }

  const baseOptions: LeagueOption[] = [];
  const hoistedId = suggestion?.kind === "existing" ? suggestion.id : null;
  const leagueOption = (league: NonNullable<typeof leagues>[number]): LeagueOption => ({
    key: league._id,
    label: league.name,
    haystack: [
      league.name,
      ...(league.abbreviation ? [league.abbreviation] : []),
      ...(league.aliases ?? []),
    ],
    choose: () => pick({ leagueId: league._id }),
  });
  if (hoistedId) {
    const league = (leagues ?? []).find((l) => l._id === hoistedId);
    if (league) baseOptions.push(leagueOption(league));
  }
  if (suggestion?.kind === "create" && !stagedByKey.has(suggestion.key)) {
    baseOptions.push({
      key: `create:${suggestion.key}`,
      label: `Create ${suggestion.name}`,
      haystack: [suggestion.name],
      choose: () => pick({ leagueName: suggestion.name }),
    });
  }
  for (const [key, name] of stagedByKey) {
    baseOptions.push({
      key: `staged:${key}`,
      label: `${name.trim()} (new)`,
      haystack: [name],
      choose: () => pick({ leagueName: name }),
    });
  }
  for (const league of leagues ?? []) {
    if (league._id !== hoistedId) baseOptions.push(leagueOption(league));
  }
  const noLeagueOption: LeagueOption = {
    key: "no-league",
    label: "No league",
    haystack: [],
    choose: () => pick({ leagueId: null }),
  };

  /**
   * The current answer, as the key of the option that stands for it. Read
   * straight off the draft, so the field and the list can never disagree with
   * what the host is about to write.
   */
  const currentKey = ((): string | undefined => {
    if (draft.leagueId === null) return noLeagueOption.key;
    if (draft.leagueId !== undefined) return draft.leagueId;
    const name = draft.leagueName ?? (unanswered ? suggestion?.name : undefined);
    if (unanswered && suggestion?.kind === "existing") return suggestion.id;
    if (!name) return undefined;
    const key = normalizeLeagueName(name);
    if (existingKeys.has(key)) return existingKeys.get(key);
    if (stagedByKey.has(key)) return `staged:${key}`;
    if (suggestion?.kind === "create" && suggestion.key === key) {
      return `create:${key}`;
    }
    return undefined;
  })();

  /** What the field reads at rest: the chosen option's own label, so it is the
   *  same words the operator picked. */
  const currentLabel = ((): string => {
    const option =
      currentKey === noLeagueOption.key
        ? noLeagueOption
        : baseOptions.find((o) => o.key === currentKey);
    if (option) return option.label;
    if (draft.leagueId && createdLeague?.id === draft.leagueId) {
      return createdLeague.name;
    }
    // A league NAME no option stands for — staged a moment ago, before the
    // batch's list caught up. It is still a league to create.
    if (draft.leagueName?.trim()) return `${draft.leagueName.trim()} (new)`;
    return "";
  })();

  const typed = leagueQuery?.trim() ?? "";
  const typedKey = typed ? normalizeLeagueName(typed) : "";
  const typedLower = typed.toLowerCase();
  /** Case-insensitive substring, on the raw text AND on the normalized key —
   *  so "st louis" finds "St. Louis Amateur League" and "panamer" finds
   *  "Ligue Panaméricaine". */
  const matchesTyped = (option: LeagueOption) =>
    option.haystack.some(
      (text) =>
        text.toLowerCase().includes(typedLower) ||
        (typedKey !== "" && normalizeLeagueName(text).includes(typedKey)),
    );

  const leagueOptions: LeagueOption[] = typed
    ? baseOptions.filter(matchesTyped)
    : [...baseOptions];
  // `leagueOptions` is `baseOptions` filtered — every held league (name,
  // aliases, abbreviation), every staged one and the suggestion — so empty
  // means the typed text found nothing at all. See source 4 above.
  if (
    typed &&
    canCreateLeague &&
    typedKey &&
    leagueOptions.length === 0 &&
    typedKey !== normalizeLeagueName(noLeagueOption.label)
  ) {
    leagueOptions.push({
      key: `typed:${typedKey}`,
      label: `Create “${typed}”`,
      haystack: [],
      choose: () => void createTypedLeague(typed),
    });
  }
  leagueOptions.push(noLeagueOption);

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

      {/* NEO-284 — the other names this team answers to.

          Under the years, before the league: it is part of what the team IS,
          not where it plays. Asked here rather than left to Team Management
          because the row is usually being created FROM one of those other
          names — a checklist that says "LSU" — and the moment of creation is
          when the operator has both spellings in front of them.

          One line, not a textarea: this form lives in a dialog body that has
          to fit CI's 1024x629 viewport, and a team created here has a handful
          of aliases, not the sixty a college programme carries. The admin
          panel is where the long list lives.

          No client-side bound: the server refuses an over-long list with a
          message the dialog already renders, and printing the limit here
          would be exposing a rule as copy. */}
      <FieldLabel text="Aliases (optional)">
        <Input
          bare
          type="text"
          value={draft.aliases}
          placeholder="LSU, Louisiana State"
          // SC 2.5.3, label in name: the visible label is "Aliases (optional)"
          // and the accessible name has to contain it. "New team" prefixes it
          // the way every other field on this form is prefixed, so the two
          // alias boxes a wizard can show (this one and New League's) never
          // share a name.
          aria-label="New team aliases (optional)"
          aria-describedby={aliasHelpId}
          disabled={disabled}
          onChange={(e) => onChange({ aliases: e.target.value })}
          onKeyDown={onFieldKeyDown}
          className="w-full p-1.5 text-sm"
        />
      </FieldLabel>
      <p id={aliasHelpId} className="text-xs text-gray-400">
        Separate with commas. Other names this team answers to — the school,
        an old nickname, how a checklist spells it.
      </p>

      {/* NEO-307 — the League, as a type-ahead. See the module doc for why it
          stopped being a row of pills.

          The id (wizard only) is on this wrapper and never on the input: an id
          on the combobox would replace "League" as its Maestro resource-id.

          Enter on the field with its list CLOSED is the form's own Enter —
          the dialog creates — exactly as in the text boxes above. With the
          list open Enter picks the highlighted option, and the combobox has
          already claimed the key (`isDefaultPrevented`). */}
      <div
        ref={leagueFieldRef}
        {...(leagueGroupId ? { id: leagueGroupId } : {})}
        className="flex flex-col gap-1"
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !onSubmit || e.isDefaultPrevented()) return;
          if ((e.target as HTMLElement).getAttribute("role") !== "combobox") return;
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-baseline gap-2">
          {/* The visible caption. Not a <label>: the combobox's accessible
              name is its own `aria-label` ("League", which this text matches
              for SC 2.5.3), and a <label> may not contain the listbox. */}
          <span className="text-xs text-gray-400">League</span>
          {leagues === undefined && (
            /* SC 4.1.3: the list changes under the operator when the query
               lands, so the wait is announced rather than only drawn. */
            <span role="status" className="text-xs text-gray-400">
              Loading leagues…
            </span>
          )}
        </div>
        <div className="relative">
          <Autocomplete<LeagueOption>
            label="League"
            query={leagueQuery ?? currentLabel}
            onQueryChange={setLeagueQuery}
            items={leagueOptions}
            getKey={(o) => o.key}
            getLabel={(o) => o.label}
            onSelect={(o) => {
              setLeagueQuery(null);
              if (leagueBusy) return;
              o.choose();
            }}
            onDismiss={() => setLeagueQuery(null)}
            selectedKey={currentKey}
            openOnEmpty
            selectOnFocus
            placeholder={
              canCreateLeague ? "Pick a league or type a new one" : "Pick a league"
            }
            disabled={disabled}
            // CI run 8: an unbounded league list pushed the review wizard's
            // primary action off the 1024x629 viewport. The list floats over
            // the form rather than growing it, and this cap is what keeps a
            // table that only ever gets bigger from reaching the footer.
            listMaxHeightClassName="max-h-40"
            // The compact geometry of every other field on this form, plus
            // room on the right for the chevron.
            inputGeometryClassName="py-1.5 pl-1.5 pr-7 text-sm"
          />
          {/* The one cue that this box opens a list rather than taking free
              text. Decorative; the combobox role says it to assistive tech. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400"
          >
            ▾
          </span>
        </div>
        {leagues !== undefined && baseOptions.length === 0 && (
          /* Only "No league" in the list. Saying so is the difference between
             an empty control and a broken one — the placeholder is the
             invitation to type one. */
          <p className="text-xs text-gray-400">No leagues in this sport yet.</p>
        )}
      </div>

      {namingLeague && onCreateLeague && (
        /*
          PICKER — there is no batch to stage into and no later step, so this is
          the only chance to collect the record. The full `NewLeagueForm`,
          reused rather than restated, so its validation and its bounds are the
          ones that apply here too.
        */
        <div
          id={newLeagueFormId}
          className="flex flex-col gap-2 rounded-md border border-gray-700 p-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              // One level at a time: Escape here cancels THIS sub-form only.
              // Without stopping it, NewTeamDialog's own Escape handler (on
              // an ancestor) also ran and closed the whole dialog, throwing
              // away the team the operator was in the middle of.
              e.stopPropagation();
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
            detailsDefaultOpen={false}
          />
          {/* `data-new-league-actions`: how the open path finds this row to
              scroll it into view. A data attribute, never an id — an id
              would be nothing a user can see, and no flow targets it. */}
          <div data-new-league-actions="" className="flex items-center gap-2">
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
