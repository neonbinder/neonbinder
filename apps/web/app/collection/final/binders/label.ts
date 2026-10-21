/**
 * NEO-350 — binder spine labels in the Print Shop's look (pure half).
 *
 * A binder's spine is drawn the way `/print/spine-label` prints one: a solid
 * field in the label's background, the name lettered down it in a display
 * face. The fonts, the fitter and the contrast maths are the Print Shop's own
 * (`lib/print/*`); this file only decides WHICH colours and face a binder
 * gets, and when the shelf has to swap the lettering to stay readable.
 *
 * Every choice is keyed on ids and roles, never a display name: a system
 * binder by `binder.system`, a smart binder by the team its rule names or,
 * failing that, the team on most of its cards.
 *
 * Kept apart from `model.ts` (and the shelf's `SpineLabel.tsx` +
 * `spine-label.css`) so the whole look can be rolled back in one place.
 */

import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";
import { DEFAULT_SPINE_FONT_ID, spineFontById, type SpineFont } from "@/lib/print/spine-fonts";
import { fitFontSizeIn } from "@/lib/print/spine-formats";
import {
  binderCards,
  getSet,
  getTeam,
  inkOn,
  type BinderRule,
  type Card,
  type Team,
  type TeamId,
} from "../../prototypes/_shared/data";
import type { BinderLabel, CollectionBinder } from "../store";

export type { BinderLabel };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * A binder you fill yourself starts as most real binders on a shelf are:
 * black vinyl, white lettering. Also the Print Shop designer's own starting
 * pair, so the two read the same until the collector picks colours.
 */
export const PLAIN_LABEL: BinderLabel = {
  background: "#101820",
  text: "#FFFFFF",
  fontId: DEFAULT_SPINE_FONT_ID,
};

/** "All my cards": the page's own blue on near-black. */
export const ALL_LABEL: BinderLabel = { background: "#0B1220", text: "#00C2FF", fontId: DEFAULT_SPINE_FONT_ID };

/** The special shelf's binders, by role. */
const SYSTEM_LABEL: Record<NonNullable<CollectionBinder["system"]>, BinderLabel> = {
  main: { background: "#14532D", text: "#00D558", fontId: DEFAULT_SPINE_FONT_ID },
  want: { background: "#4A0B33", text: "#FF2E9A", fontId: DEFAULT_SPINE_FONT_ID },
  trade: { background: "#5C4A00", text: "#FFE600", fontId: DEFAULT_SPINE_FONT_ID },
};

/** The rule's team, when a smart binder is "a team" (with or without alumni). */
export function ruleTeamId(rule: BinderRule): TeamId | null {
  if (rule.kind === "teamOnCard" || rule.kind === "playedFor") return rule.teamId;
  if (rule.kind === "or" || rule.kind === "and") {
    for (const r of rule.rules) {
      const id = ruleTeamId(r);
      if (id) return id;
    }
  }
  return null;
}

/** A team on a smart binder's cards, and how many of them it is on. */
export interface TeamOnCards {
  team: Team;
  /** Cards (each parallel its own card) with this team on the front. */
  cards: number;
  /** The newest of those cards' set years: the first tie-break. */
  latestYear: number;
}

/**
 * The teams on these cards, most cards first. A card with two teams on it
 * counts for both. Ties go to the team with the more recent card, then to
 * the lower team id, so the order never depends on catalog order.
 */
export function teamsOnCards(cards: Card[]): TeamOnCards[] {
  const tally = new Map<TeamId, { cards: number; latestYear: number }>();
  for (const card of cards) {
    const year = getSet(card.setId).year;
    for (const teamId of new Set(card.teamIds)) {
      const row = tally.get(teamId);
      if (row) {
        row.cards += 1;
        row.latestYear = Math.max(row.latestYear, year);
      } else {
        tally.set(teamId, { cards: 1, latestYear: year });
      }
    }
  }
  return [...tally.entries()]
    .sort(
      ([idA, a], [idB, b]) =>
        b.cards - a.cards || b.latestYear - a.latestYear || (idA < idB ? -1 : idA > idB ? 1 : 0),
    )
    .map(([teamId, row]) => ({ team: getTeam(teamId), ...row }));
}

/**
 * The teams on a smart binder's cards, most first: the label editor's quick
 * picks. Catalog cards, owned or not, so the list (and the default it leads)
 * never moves as copies come and go. Empty for any other binder.
 */
export function binderTeamsOnCards(binder: CollectionBinder): TeamOnCards[] {
  if (binder.kind !== "smart") return [];
  return teamsOnCards(binderCards(binder));
}

function teamLabel(team: Team): BinderLabel {
  return { background: team.primary, text: team.secondary, fontId: DEFAULT_SPINE_FONT_ID };
}

/** What a binder's label is until the collector picks one. */
export function defaultLabel(binder: CollectionBinder | "all"): BinderLabel {
  if (binder === "all") return ALL_LABEL;
  if (binder.system) return SYSTEM_LABEL[binder.system];
  if (binder.kind === "smart") {
    // A rule that names a team wears it. Anything else (a player, a brand, a
    // set, Hall of Famers) wears the team on most of its cards: Reggie
    // White's binder is Packers green because most of his cards are.
    const teamId = ruleTeamId(binder.rule);
    if (teamId) return teamLabel(getTeam(teamId));
    const [most] = binderTeamsOnCards(binder);
    return most ? teamLabel(most.team) : PLAIN_LABEL;
  }
  return PLAIN_LABEL;
}

/** A team's colors as a label, keeping the lettering face already chosen. */
export function teamColorsOn(label: BinderLabel, team: Team): BinderLabel {
  return { ...label, background: team.primary, text: team.secondary };
}

/** Same colours (either case) and the same face. */
export function sameLabel(a: BinderLabel, b: BinderLabel): boolean {
  return (
    a.background.toLowerCase() === b.background.toLowerCase() &&
    a.text.toLowerCase() === b.text.toLowerCase() &&
    a.fontId === b.fontId
  );
}

/** The label a binder wears: the collector's, else its default. */
export function labelOf(binder: CollectionBinder | "all"): BinderLabel {
  if (binder !== "all" && binder.label) return binder.label;
  return defaultLabel(binder);
}

/** Default label for a binder about to be made, from what the dialog knows. */
export function defaultLabelForNew(input: { kind: "manual" } | { kind: "smart"; rule: BinderRule }): BinderLabel {
  if (input.kind === "manual") return PLAIN_LABEL;
  return defaultLabel({ id: "new", kind: "smart", name: "", rule: input.rule });
}

// ---------------------------------------------------------------------------
// Lettering on the shelf
// ---------------------------------------------------------------------------

/** WCAG large text: 14pt bold. The lettering is always set bold. */
export const LARGE_TEXT_PX = 18.66;
/** Never letter a spine smaller than this, however long the name. */
export const MIN_LETTERING_PX = 12;
/** The phone shelf's spine height: the smallest a spine is ever drawn. */
const PHONE_SPINE_PX = 196;
/** What the spine's rim, the count sticker and the gaps take off its height. */
const SPINE_CHROME_PX = 52;
/** What the rim takes off its width. */
const SPINE_RIM_PX = 10;

/**
 * Headroom along the spine on screen. The fitter's per-face mean width is
 * measured on player names; binder names run to capitals, digits and
 * apostrophes ("'96 Contenders") and measured about 5% longer than it
 * guessed, which on paper only eats the end margin but on the shelf would
 * clip the name. A tenth off keeps every seed name whole.
 */
const SHELF_ALONG = 0.9;

/**
 * The lettering size, as CSS, for a name in this face. The Print Shop's
 * fitter, applied to the label's own box in container units: as large as fits
 * ACROSS the spine and ALONG it, whichever binds first.
 */
export function letteringSizeCss(name: string, font: SpineFont): string {
  const across = fitFontSizeIn("", 100, 100, font.charWidthRatio); // % of the width
  const along = fitFontSizeIn(name, Number.POSITIVE_INFINITY, 100, font.charWidthRatio) * SHELF_ALONG; // % of the height
  return `max(${MIN_LETTERING_PX}px, min(${across.toFixed(2)}cqw, ${along.toFixed(2)}cqh))`;
}

/** The smallest the lettering is ever drawn (on a phone), in px. */
export function smallestLetteringPx(name: string, font: SpineFont, spineWidthPx: number): number {
  const width = spineWidthPx - SPINE_RIM_PX;
  const height = PHONE_SPINE_PX - SPINE_CHROME_PX;
  const across = fitFontSizeIn("", width, height, font.charWidthRatio);
  const along = fitFontSizeIn(name, Number.POSITIVE_INFINITY, height, font.charWidthRatio) * SHELF_ALONG;
  return Math.max(MIN_LETTERING_PX, Math.min(across, along));
}

export interface ShelfColors {
  background: string;
  /** The lettering the shelf actually draws. */
  text: string;
  /** The collector's pair, measured. Null when either is not a colour yet. */
  ratio: number | null;
  /** The minimum this lettering needs: 3:1 when large, 4.5:1 otherwise. */
  needed: number;
  /** True when the collector's lettering fell short and black or white stands in. */
  swapped: boolean;
}

/**
 * The colours the shelf draws, never below WCAG AA. The collector's pair is
 * kept whenever it reaches AA for the size it is drawn at (3:1 for large
 * text, 4.5:1 below that). When it does not, the background stays (it is the
 * binder's colour) and the lettering becomes black or white, whichever reads
 * better on it: the better of the two always clears 4.5:1. Swapping the pair
 * would not help: contrast is the same both ways round.
 *
 * The collector's choice is never changed in the store; the Print Shop still
 * prints exactly what they picked.
 */
export function shelfColors(label: BinderLabel, letteringPx: number): ShelfColors {
  const background = normalizeHexColor(label.background) ?? PLAIN_LABEL.background;
  const chosen = normalizeHexColor(label.text);
  const ratio = chosen ? contrastRatio(chosen, background) : null;
  const needed = letteringPx >= LARGE_TEXT_PX ? 3 : 4.5;
  if (chosen && ratio !== null && ratio >= needed) {
    return { background, text: chosen, ratio, needed, swapped: false };
  }
  return { background, text: inkOn(background), ratio, needed, swapped: true };
}

/** A label is saveable once both colours are colours. */
export function validLabel(label: BinderLabel): BinderLabel | null {
  const background = normalizeHexColor(label.background);
  const text = normalizeHexColor(label.text);
  if (!background || !text) return null;
  return { background, text, fontId: spineFontById(label.fontId).id };
}
