/**
 * NEO-350 — card search for the prototypes: the way a collector types, not
 * the way a database is keyed.
 *
 * "96 contenders white", "white reggie 1996", "griffey refractor", "#13",
 * "red wings howe", "96-97 yzerman" all work: tokens match in any order,
 * two-digit years expand ("96" → 1996, and "96-97" → the 1996-97 season),
 * last names score highest among name words, and a bare number matches card
 * numbers as well as years.
 *
 * Every card whose fields cover every token is returned, ranked. Callers must
 * SHOW the list and let the collector choose: a card number is never unique
 * (two #13s live in 2024 Topps Chrome alone), so even a single high-scoring
 * hit is a suggestion, never an auto-pick.
 */

import { brands, cards, players, sets, sports, teams } from "./catalog";
import type { Card } from "./types";

export interface SearchHit {
  card: Card;
  /** Higher is better. Only meaningful for ordering within one result list. */
  score: number;
  /**
   * True when every query token matched this card. When no card matches every
   * token, the list falls back to partial matches (most tokens first) with
   * this false, so a typo still shows something to pick from.
   */
  matchedAll: boolean;
}

export interface SearchOptions {
  /** Cap the list; default is every match. */
  limit?: number;
}

/** Lowercase, strip accents and apostrophes, keep `#`, `-` and `/` for numbers. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9#/\-\s.]/g, " ")
    .replace(/\./g, "")
    .trim();
}

const STOPWORDS = new Set(["the", "of", "and", "card", "cards", "a"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

const FEATURE_WORDS: Record<string, Card["features"][number]> = {
  rc: "RC",
  rookie: "RC",
  rookies: "RC",
  au: "AU",
  auto: "AU",
  autos: "AU",
  autograph: "AU",
  autographs: "AU",
  relic: "Relic",
  relics: "Relic",
  jersey: "Relic",
  patch: "Relic",
  memorabilia: "Relic",
  sp: "SP",
  "short-print": "SP",
};

interface SearchDoc {
  card: Card;
  year: number;
  /** Second year of a split season (1997 for "1996-97"), else null. */
  seasonEnd: number | null;
  number: string;
  lastNames: Set<string>;
  nameWords: Set<string>;
  teamNameWords: Set<string>;
  teamLocationWords: Set<string>;
  setWords: Set<string>;
  variantWords: Set<string>;
  isBase: boolean;
  isInsert: boolean;
}

function words(text: string): string[] {
  return normalizeSearchText(text)
    .split(/[\s\-/]+/)
    .filter(Boolean);
}

let docs: SearchDoc[] | null = null;

function buildDocs(): SearchDoc[] {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const setById = new Map(sets.map((s) => [s.id, s]));
  const brandById = new Map(brands.map((b) => [b.id, b]));
  const sportById = new Map(sports.map((s) => [s.id, s]));

  return cards.map((card) => {
    const set = setById.get(card.setId)!;
    const lastNames = new Set<string>();
    const nameWords = new Set<string>();
    for (const pid of card.playerIds) {
      const parts = words(playerById.get(pid)?.name ?? "");
      parts.forEach((w) => nameWords.add(w));
      const core = parts.filter((w) => !NAME_SUFFIXES.has(w));
      if (core.length) lastNames.add(core[core.length - 1]);
    }
    const teamNameWords = new Set<string>();
    const teamLocationWords = new Set<string>();
    for (const tid of card.teamIds) {
      const team = teamById.get(tid);
      if (!team) continue;
      words(team.name).forEach((w) => teamNameWords.add(w));
      words(team.location).forEach((w) => teamLocationWords.add(w));
    }
    const setWords = new Set<string>([
      ...words(set.name),
      ...words(brandById.get(set.brandId)?.name ?? ""),
      ...words(sportById.get(set.sportId)?.name ?? ""),
    ]);
    const variantWords = new Set<string>([
      ...words(card.variantPath.type),
      ...words(card.variantPath.name ?? ""),
      ...words(card.variation ?? ""),
    ]);
    // Singular forms, so "insert" finds Inserts and "parallel" Parallels.
    if (variantWords.has("inserts")) variantWords.add("insert");
    if (variantWords.has("parallels")) variantWords.add("parallel");
    if (card.variation) variantWords.add("variation");
    const seasonMatch = /^(\d{4})-(\d{2})$/.exec(set.season);
    return {
      card,
      year: set.year,
      seasonEnd: seasonMatch ? set.year + 1 : null,
      number: normalizeSearchText(card.cardNumber),
      lastNames,
      nameWords,
      teamNameWords,
      teamLocationWords,
      setWords,
      variantWords,
      isBase: card.variantPath.type === "Base",
      isInsert: card.variantPath.type === "Inserts",
    };
  });
}

/** Two-digit years: 00-29 are 2000s, 30-99 are 1900s. */
function expandYear(text: string): number | null {
  if (/^\d{4}$/.test(text)) {
    const y = Number(text);
    return y >= 1900 && y <= 2099 ? y : null;
  }
  if (/^\d{2}$/.test(text)) {
    const y = Number(text);
    return y < 30 ? 2000 + y : 1900 + y;
  }
  return null;
}

function prefixHit(token: string, pool: Set<string>): boolean {
  if (token.length < 3) return false;
  for (const w of pool) if (w.startsWith(token)) return true;
  return false;
}

/** Best score this single token earns on this card; 0 = no match. */
function scoreToken(raw: string, doc: SearchDoc): number {
  let best = 0;
  const bump = (n: number) => {
    if (n > best) best = n;
  };
  const card = doc.card;

  // Print runs: "/50", "1/1".
  const printRun = /^(\d+)?\/(\d+)$/.exec(raw);
  if (printRun) {
    const run = Number(printRun[2]);
    if (printRun[1] === "1" && run === 1) return card.printRun === 1 ? 30 : 0;
    return card.printRun === run ? 30 : 0;
  }

  // Split seasons: "96-97", "1996-97".
  const season = /^(\d{2}|\d{4})-(\d{2}|\d{4})$/.exec(raw);
  if (season) {
    const start = expandYear(season[1]);
    if (start !== null && start === doc.year && doc.seasonEnd !== null) bump(32);
  }

  // "#13" means a card number and nothing else.
  const hashed = raw.startsWith("#");
  const token = hashed ? raw.slice(1) : raw;
  if (!token) return 0;

  if (token === doc.number) bump(hashed ? 36 : 28);
  else if (
    doc.number.startsWith(token) &&
    /^[a-z]+$/.test(doc.number.slice(token.length))
  ) {
    // "13" also offers "13b", below the exact #13s.
    bump(hashed ? 18 : 12);
  }
  if (hashed) return best;

  const year = expandYear(token.replace(/^'/, ""));
  if (year !== null) {
    if (year === doc.year) bump(token.length === 4 ? 30 : 26);
    else if (doc.seasonEnd === year) bump(14);
  }

  if (doc.lastNames.has(token)) bump(26);
  else if (doc.nameWords.has(token)) bump(16);
  else if (prefixHit(token, doc.nameWords)) bump(9);

  if (doc.teamNameWords.has(token)) bump(16);
  else if (doc.teamLocationWords.has(token)) bump(11);
  else if (prefixHit(token, doc.teamNameWords) || prefixHit(token, doc.teamLocationWords)) bump(6);

  if (doc.setWords.has(token)) bump(15);
  else if (prefixHit(token, doc.setWords)) bump(7);

  if (doc.variantWords.has(token)) bump(15);
  else if (prefixHit(token, doc.variantWords)) bump(7);

  const feature = FEATURE_WORDS[token];
  if (feature && card.features.includes(feature)) bump(13);
  if ((token === "numbered" || token === "serial") && card.printRun !== null) bump(12);

  return best;
}

/** Natural order for card numbers: 2 < 13 < 13b < 301 < GJ1. */
function compareNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Every card matching the query, best first. Empty or stopword-only query → [].
 * See the module note: show the list, never auto-pick the top hit.
 */
export function searchCards(query: string, options: SearchOptions = {}): SearchHit[] {
  const tokens = normalizeSearchText(query)
    .split(/[\s,]+/)
    .map((t) => t.replace(/^'/, ""))
    .filter((t) => t && !STOPWORDS.has(t));
  if (tokens.length === 0) return [];

  docs ??= buildDocs();
  const scored = docs.map((doc) => {
    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      const s = scoreToken(token, doc);
      if (s > 0) matched++;
      score += s;
    }
    // Ties go to the regular card over its inserts and parallels.
    if (score > 0) score += doc.isBase ? 3 : doc.isInsert ? 1 : 0;
    return { doc, score, matched };
  });

  const full = scored.filter((s) => s.matched === tokens.length);
  const pool = full.length > 0 ? full : scored.filter((s) => s.matched > 0);
  const matchedAll = full.length > 0;

  pool.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      b.doc.year - a.doc.year ||
      compareNumbers(a.doc.card.cardNumber, b.doc.card.cardNumber),
  );

  const hits = pool.map((s) => ({ card: s.doc.card, score: s.score, matchedAll }));
  return options.limit ? hits.slice(0, options.limit) : hits;
}
