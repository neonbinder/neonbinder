/**
 * NEO-362 — a smart binder's rule: its shape, its limits, and what it
 * matches. Pure, shared by Convex (`convex/binderRules.ts`, which reads a
 * card's facts and asks here) and the client (the rule builder, which checks
 * a rule before it is sent), so the two can never disagree.
 *
 * A rule is ONE level of all-of / any-of over leaves, each optionally turned
 * around with "not". Every leaf names NB data: an NB id, an NB year, an NB
 * feature, an NB print run. Never a marketplace value or a display name
 * (product invariant 4), so a rename never changes what a binder holds.
 *
 * The stored shape is `collectionRuleValidator` in `convex/schema.ts`; the
 * types below mirror it with plain strings for ids, so this file needs no
 * generated Convex types.
 */

export type RuleFeature = "RC" | "AU" | "Relic" | "SP";

export const RULE_FEATURES: readonly RuleFeature[] = ["RC", "AU", "Relic", "SP"];

export type StoredRuleLeaf =
  | { kind: "player"; playerIds: string[] }
  | { kind: "team"; teamIds: string[] }
  | { kind: "playedFor"; teamIds: string[] }
  | { kind: "sport"; sportIds: string[] }
  | { kind: "brand"; brandIds: string[] }
  | { kind: "set"; setIds: string[] }
  | { kind: "year"; from?: number; to?: number }
  | { kind: "feature"; feature: RuleFeature }
  | { kind: "printRun"; min?: number; max?: number }
  | { kind: "hallOfFame" };

export interface StoredRuleTerm {
  negate?: true;
  test: StoredRuleLeaf;
}

export interface StoredRule {
  version: 1;
  match: "all" | "any";
  terms: StoredRuleTerm[];
}

/** Terms one rule may hold. */
export const MAX_RULE_TERMS = 12;
/** Ids one leaf may list (a brand across years is one id per year). */
export const MAX_RULE_IDS = 150;
export const MIN_RULE_YEAR = 1850;
export const MAX_RULE_YEAR = 2100;
export const MAX_RULE_PRINT_RUN = 100_000;
/**
 * Line items a binder may hold and keep itself sorted (or be sorted at
 * once): it is drawn in order every time it opens, so all of it is read.
 */
export const MAX_SORTED_LINES = 2000;

/**
 * What a rule needs to know about one card. Every id is NB's. A card's set,
 * brand, year and sport come from its place in the catalog; `playedFor` is
 * every team any of its players had a stint with.
 */
export interface CardFacts {
  playerIds: ReadonlySet<string>;
  teamIds: ReadonlySet<string>;
  playedForIds: ReadonlySet<string>;
  hallOfFame: boolean;
  sportId: string | null;
  brandId: string | null;
  setId: string | null;
  /** The year the set files under (a hockey season files under its start). */
  year: number | null;
  features: ReadonlySet<RuleFeature>;
  /** Numbered print run; null when unnumbered. */
  printRun: number | null;
}

function anyOf(ids: readonly string[], have: ReadonlySet<string>): boolean {
  return ids.some((id) => have.has(id));
}

function oneOf(ids: readonly string[], have: string | null): boolean {
  return have !== null && ids.includes(have);
}

/** Does one leaf hold for the card? A leaf naming nothing that exists never matches. */
export function leafMatches(leaf: StoredRuleLeaf, facts: CardFacts): boolean {
  switch (leaf.kind) {
    case "player":
      return anyOf(leaf.playerIds, facts.playerIds);
    case "team":
      return anyOf(leaf.teamIds, facts.teamIds);
    case "playedFor":
      return anyOf(leaf.teamIds, facts.playedForIds);
    case "sport":
      return oneOf(leaf.sportIds, facts.sportId);
    case "brand":
      return oneOf(leaf.brandIds, facts.brandId);
    case "set":
      return oneOf(leaf.setIds, facts.setId);
    case "year":
      return (
        facts.year !== null &&
        (leaf.from === undefined || facts.year >= leaf.from) &&
        (leaf.to === undefined || facts.year <= leaf.to)
      );
    case "feature":
      return facts.features.has(leaf.feature);
    case "printRun":
      return (
        facts.printRun !== null &&
        (leaf.min === undefined || facts.printRun >= leaf.min) &&
        (leaf.max === undefined || facts.printRun <= leaf.max)
      );
    case "hallOfFame":
      return facts.hallOfFame;
  }
}

/** Does the card fit the rule? An empty rule matches nothing. */
export function ruleMatches(rule: StoredRule, facts: CardFacts): boolean {
  if (rule.terms.length === 0) return false;
  const holds = (term: StoredRuleTerm) => leafMatches(term.test, facts) !== (term.negate === true);
  return rule.match === "all" ? rule.terms.every(holds) : rule.terms.some(holds);
}

/**
 * Why a rule can't be saved, in words for the collector; null when it is
 * fine. The server checks the same (and that every id is the right kind of
 * row); the builder calls it so Save can say what is missing before it asks.
 */
export function ruleProblem(rule: StoredRule): string | null {
  if (rule.terms.length === 0) return "Add at least one line to the rule.";
  if (rule.terms.length > MAX_RULE_TERMS) return `A rule can have up to ${MAX_RULE_TERMS} lines.`;
  if (rule.terms.every((t) => t.negate)) {
    return "A rule needs at least one line that says what to include, not only what to leave out.";
  }
  for (const { test } of rule.terms) {
    const problem = leafProblem(test);
    if (problem) return problem;
  }
  return null;
}

function idsProblem(ids: readonly string[], what: string): string | null {
  if (ids.length === 0) return `Pick a ${what} for every ${what} line.`;
  if (ids.length > MAX_RULE_IDS) return `One line can name up to ${MAX_RULE_IDS} ${what}s.`;
  return null;
}

function wholeIn(n: number | undefined, min: number, max: number): boolean {
  return n === undefined || (Number.isInteger(n) && n >= min && n <= max);
}

function leafProblem(leaf: StoredRuleLeaf): string | null {
  switch (leaf.kind) {
    case "player":
      return idsProblem(leaf.playerIds, "player");
    case "team":
    case "playedFor":
      return idsProblem(leaf.teamIds, "team");
    case "sport":
      return idsProblem(leaf.sportIds, "sport");
    case "brand":
      return idsProblem(leaf.brandIds, "brand");
    case "set":
      return idsProblem(leaf.setIds, "set");
    case "year":
      if (leaf.from === undefined && leaf.to === undefined) return "Give the years line a first year, a last year, or both.";
      if (!wholeIn(leaf.from, MIN_RULE_YEAR, MAX_RULE_YEAR) || !wholeIn(leaf.to, MIN_RULE_YEAR, MAX_RULE_YEAR)) {
        return `Years need to be between ${MIN_RULE_YEAR} and ${MAX_RULE_YEAR}.`;
      }
      if (leaf.from !== undefined && leaf.to !== undefined && leaf.from > leaf.to) {
        return "The first year comes after the last one. Swap them.";
      }
      return null;
    case "feature":
      return RULE_FEATURES.includes(leaf.feature) ? null : "Pick a feature for the feature line.";
    case "printRun":
      if (leaf.min === undefined && leaf.max === undefined) return "Give the print run line a number.";
      if (!wholeIn(leaf.min, 1, MAX_RULE_PRINT_RUN) || !wholeIn(leaf.max, 1, MAX_RULE_PRINT_RUN)) {
        return "Print runs are whole numbers from 1 up.";
      }
      if (leaf.min !== undefined && leaf.max !== undefined && leaf.min > leaf.max) {
        return "The print run's low end is above its high end.";
      }
      return null;
    case "hallOfFame":
      return null;
  }
}

/** The ids a rule names, by the table they live in: what the server checks and names. */
export function ruleIds(rule: StoredRule): {
  players: string[];
  teams: string[];
  options: string[];
} {
  const players = new Set<string>();
  const teams = new Set<string>();
  const options = new Set<string>();
  for (const { test } of rule.terms) {
    if (test.kind === "player") test.playerIds.forEach((id) => players.add(id));
    if (test.kind === "team" || test.kind === "playedFor") test.teamIds.forEach((id) => teams.add(id));
    if (test.kind === "sport") test.sportIds.forEach((id) => options.add(id));
    if (test.kind === "brand") test.brandIds.forEach((id) => options.add(id));
    if (test.kind === "set") test.setIds.forEach((id) => options.add(id));
  }
  return { players: [...players], teams: [...teams], options: [...options] };
}

/** "1996-97" files under 1996; anything without a leading year is unknown. */
export function yearOfSeason(value: string | undefined): number | null {
  const m = /^(\d{4})/.exec(value ?? "");
  return m ? Number(m[1]) : null;
}
