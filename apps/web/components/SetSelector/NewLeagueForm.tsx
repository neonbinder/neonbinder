/**
 * NEO-254 — the New League step's fields.
 *
 * ## Why this step exists at all
 *
 * Jason, preview test 2026-09-06: on a fresh deployment every hockey team row
 * offered `Create National Hockey League`. Nothing is written until commit, so
 * the third team asked the same question as the first, and the thirtieth asked
 * it again — and whichever pill was finally pressed created a league carrying a
 * name and nothing else. "The proper fix is pulling league up before team as
 * we'll need to fill in the rest of the year information too … I'm ok putting
 * extra steps in the user's face."
 *
 * So the league is a step of its own, walked BEFORE the team that needs it,
 * asked once per batch, and answered with the whole record League Management
 * edits.
 *
 * ## The layout problem, and the rule that solves it
 *
 * This step has SEVEN fields where the New Team step has three, and it renders
 * into the same fixed-height dialog body — roughly 370px on CI's 1024x629
 * viewport, inside an `overflow-y-auto` box that maestro-web's `window.scrollTo`
 * cannot drive. Two failures in this ticket's own history came from a step
 * outgrowing that box (a team step's primary action landing at y=620, and the
 * decided-list disclosure falling below the fold). Seven stacked inputs would
 * be the third.
 *
 * So the fields are in two tiers, and the boundary states something true rather
 * than merely saving space:
 *
 *   TIER 1, always visible — **League name** and **Level**. The name is the
 *   only required field, and level is the one fact that changes how the league
 *   behaves elsewhere (sorting, and what "major" means on a listing). One text
 *   box and one tap.
 *
 *   TIER 2, behind one disclosure — abbreviation, years, aliases, Wikidata id.
 *   These are record-keeping the operator is INVITED to complete while they are
 *   here, which is exactly what Jason asked for; none of them blocks the step.
 *
 * The disclosure follows the rule `NewTeamForm`'s league pill row already uses:
 * **collapsed means answered**. It starts collapsed when the Wikidata lookup
 * pre-filled something (there is nothing to do) and open when it did not (there
 * is). And collapsed it shows the VALUES rather than the word "details", so the
 * common case — the lookup got it right — costs zero taps and the operator can
 * still see everything the commit will write.
 *
 * ## Level is `aria-pressed` toggles, not a radiogroup
 *
 * Deliberately different from the league pill row next door, and it reuses
 * `LevelGroup` from the admin form verbatim. Level is OPTIONAL, and pressing
 * the pressed button clears it back to null — a radiogroup has no "none" state
 * without a synthetic extra radio. It also means the control an operator learns
 * here is byte-identical to the one on League Management, including its Maestro
 * selectors (`tapOn: "Major"`). Consistency with the other place this exact
 * field is edited beats consistency with the pill row beside it.
 *
 * ## No generated ids on inputs
 *
 * Same rule `NewTeamForm` documents: maestro-web derives `resource-id` from
 * `node.id || node.ariaLabel`, so a `useId()` on an input would replace the
 * name flows target. `useId` is used only for the help and error `<p>`s.
 */

import { useId, useMemo, useState } from "react";
import { Input } from "../primitives/Input";
import {
  LABEL_CLASS,
  LEVELS,
  LevelGroup,
  type LeagueLevel,
} from "../admin/AddLeagueForm";

/** Mirrors the bounds in convex/leagues.ts, which refuse the same values. */
export const MAX_LEAGUE_NAME_LENGTH = 120;
export const MAX_LEAGUE_ABBREVIATION_LENGTH = 16;
export const MAX_LEAGUE_ALIASES = 32;
export const MAX_LEAGUE_ALIAS_LENGTH = 64;
export const MIN_LEAGUE_YEAR = 1850;

/**
 * Held as STRINGS for every free-text field, including the years.
 *
 * An input's value is a string, and "" is a real state distinct from a number:
 * it means "not answered", which the commit reads as "leave whatever the league
 * already has alone". Parsing on the way out rather than on every keystroke
 * also means a half-typed "19" is never briefly a year.
 */
export type NewLeagueDraft = {
  name: string;
  abbreviation: string;
  level: LeagueLevel | null;
  fromYear: string;
  toYear: string;
  /** Comma-separated, exactly as League Management's own aliases field. */
  aliases: string;
  wikidataId: string;
};

/** The draft a step starts from, before the operator touches anything. */
export function newLeaguePrefill(row: {
  name: string;
  enrichment?: {
    abbreviation?: string;
    wikidataId?: string;
    yearsActive?: { from: number; to?: number };
  } | null;
}): NewLeagueDraft {
  const e = row.enrichment;
  return {
    name: row.name.trim(),
    abbreviation: e?.abbreviation ?? "",
    level: null,
    fromYear: e?.yearsActive?.from !== undefined ? String(e.yearsActive.from) : "",
    toYear: e?.yearsActive?.to !== undefined ? String(e.yearsActive.to) : "",
    aliases: "",
    wikidataId: e?.wikidataId ?? "",
  };
}

/** The comma-separated alias box, as the list it stands for. */
export function parseAliases(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const alias = part.trim();
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/**
 * Why the step cannot be committed yet, or null.
 *
 * Every message names the field and the fix, in the same words
 * `convex/leagues.ts` throws — an operator who hits a limit in two places
 * should not have to learn two vocabularies for it. The server re-validates;
 * this is the fast half of defence in depth, not the guarantee.
 */
export function leagueDraftError(
  draft: NewLeagueDraft,
  maxYear: number,
): string | null {
  const name = draft.name.trim();
  if (!name) return "A league name is required.";
  if (name.length > MAX_LEAGUE_NAME_LENGTH) {
    return `A league name is ${name.length} characters; the limit is ${MAX_LEAGUE_NAME_LENGTH}.`;
  }
  const abbreviation = draft.abbreviation.trim();
  if (abbreviation.length > MAX_LEAGUE_ABBREVIATION_LENGTH) {
    return `An abbreviation is ${abbreviation.length} characters; the limit is ${MAX_LEAGUE_ABBREVIATION_LENGTH}.`;
  }
  const from = draft.fromYear.trim();
  const to = draft.toYear.trim();
  const yearError = (label: string, raw: string): string | null => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < MIN_LEAGUE_YEAR || n > maxYear) {
      return `A league ${label} year must be a whole year between ${MIN_LEAGUE_YEAR} and ${maxYear}.`;
    }
    return null;
  };
  if (from) {
    const err = yearError("start", from);
    if (err) return err;
  }
  if (to) {
    // An end year with no start is not a span — it is half an answer, and the
    // server stores `yearsActive` as a required `from` with an optional `to`.
    if (!from) return "Add the year this league started before the year it ended.";
    const err = yearError("end", to);
    if (err) return err;
    if (Number(to) < Number(from)) return "A league cannot end before it starts.";
  }
  const aliases = parseAliases(draft.aliases);
  if (aliases.length > MAX_LEAGUE_ALIASES) {
    return `That is ${aliases.length} aliases; the limit is ${MAX_LEAGUE_ALIASES}.`;
  }
  const tooLong = aliases.find((a) => a.length > MAX_LEAGUE_ALIAS_LENGTH);
  if (tooLong) {
    return `An alias is ${tooLong.length} characters; the limit is ${MAX_LEAGUE_ALIAS_LENGTH}.`;
  }
  const qid = draft.wikidataId.trim();
  if (qid && !/^Q\d+$/.test(qid)) {
    return `Not a Wikidata entity id; the value is ${qid.length} characters.`;
  }
  return null;
}

/** The one-line summary the collapsed disclosure shows. */
export function leagueDetailSummary(draft: NewLeagueDraft): string | null {
  const parts: string[] = [];
  if (draft.abbreviation.trim()) parts.push(draft.abbreviation.trim());
  const from = draft.fromYear.trim();
  if (from) parts.push(`${from}–${draft.toYear.trim() || "present"}`);
  const aliases = parseAliases(draft.aliases);
  if (aliases.length > 0) {
    parts.push(aliases.length === 1 ? "1 alias" : `${aliases.length} aliases`);
  }
  if (draft.wikidataId.trim()) parts.push(draft.wikidataId.trim());
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default function NewLeagueForm({
  draft,
  onChange,
  neededBy,
  describedBy,
  nameFieldId,
  levelGroupId,
  disabled,
}: {
  draft: NewLeagueDraft;
  onChange: (patch: Partial<NewLeagueDraft>) => void;
  /** The team this league was staged for — "Needed by: Vancouver Canucks". */
  neededBy?: string;
  describedBy?: string;
  nameFieldId?: string;
  levelGroupId?: string;
  disabled?: boolean;
}) {
  const helpId = useId();
  const summary = leagueDetailSummary(draft);
  /**
   * `null` follows the default; a boolean is the operator's own choice.
   *
   * Default = open only when there is nothing to show. Collapsed on a
   * pre-filled step means "the lookup answered this"; open on an empty one
   * means "nobody has". The same "collapsed means answered" rule the New Team
   * step's league pill row uses, so the two steps read the same way.
   */
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const open = detailsOpen ?? summary === null;

  const maxYear = useMemo(() => new Date().getFullYear() + 1, []);
  const error = leagueDraftError(draft, maxYear);
  const aliasCount = parseAliases(draft.aliases).length;

  return (
    <div className="flex flex-col gap-3">
      {neededBy && (
        <p className="text-xs text-gray-400">Needed by: {neededBy}</p>
      )}

      <Input
        label="League name"
        aria-label="New league name"
        {...(nameFieldId ? { id: nameFieldId } : {})}
        value={draft.name}
        placeholder="National Hockey League"
        disabled={disabled}
        aria-describedby={[helpId, describedBy].filter(Boolean).join(" ") || undefined}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <p id={helpId} className="text-xs text-gray-400">
        The competition this team plays in. One league, asked once for the whole
        batch.
      </p>

      <div {...(levelGroupId ? { id: levelGroupId } : {})}>
        <LevelGroup
          idPrefix="entity-review-league"
          value={draft.level}
          onChange={(level) => onChange({ level })}
        />
      </div>

      {/*
        One disclosure, and its label carries the information rather than the
        word "details": collapsed it names what is already known, so the common
        case needs no interaction and nothing is hidden from the operator.
        Outside any group, and a plain button rather than <details>, because a
        native <summary>'s text is not reliably reported by maestro-web.
      */}
      <div className="flex flex-wrap items-baseline gap-2">
        <button
          type="button"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setDetailsOpen(!open)}
          className="py-2 -my-2 text-xs text-gray-400 underline decoration-dotted hover:text-[#00D558] focus-visible:text-[#00D558] focus:outline-none disabled:opacity-50"
        >
          {open ? "Hide details" : "Add abbreviation, years and aliases"}
        </button>
        {!open && summary && (
          <span className="min-w-0 truncate text-xs text-gray-400">{summary}</span>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-l-2 border-gray-700 pl-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              label="Abbreviation"
              aria-label="New league abbreviation"
              value={draft.abbreviation}
              placeholder="NHL"
              disabled={disabled}
              onChange={(e) => onChange({ abbreviation: e.target.value })}
            />
            <Input
              label="Active from"
              aria-label="New league active from"
              type="number"
              inputMode="numeric"
              min={MIN_LEAGUE_YEAR}
              max={maxYear}
              value={draft.fromYear}
              placeholder="1917"
              disabled={disabled}
              onChange={(e) => onChange({ fromYear: e.target.value })}
            />
            <Input
              label="Active to"
              aria-label="New league active to"
              type="number"
              inputMode="numeric"
              min={MIN_LEAGUE_YEAR}
              max={maxYear}
              value={draft.toYear}
              placeholder="present"
              disabled={disabled}
              onChange={(e) => onChange({ toYear: e.target.value })}
            />
          </div>
          <Input
            label="Aliases"
            aria-label="New league aliases"
            value={draft.aliases}
            placeholder="NHL, National Hockey Lg"
            disabled={disabled}
            helperText={
              aliasCount > 0
                ? `Separate with commas. ${aliasCount === 1 ? "1 alias" : `${aliasCount} aliases`} — other names this league answers to.`
                : "Separate with commas. Other names this league answers to."
            }
            onChange={(e) => onChange({ aliases: e.target.value })}
          />
          <Input
            label="Wikidata id"
            aria-label="New league Wikidata id"
            value={draft.wikidataId}
            placeholder="Q…"
            disabled={disabled}
            onChange={(e) => onChange({ wikidataId: e.target.value })}
          />
        </div>
      )}

      {error && (
        // `role="alert"` so a limit hit while the field is off screen is still
        // announced. The footer's primary is separately blocked on the same
        // check, so this explains a button that will not fire rather than
        // being the only signal.
        <p role="alert" className="text-sm text-[#FF2EB3]">
          {error}
        </p>
      )}
    </div>
  );
}

/** The level labels, re-exported so the wizard's tests can name them. */
export { LEVELS, LABEL_CLASS };
