/**
 * NEO-350 prototype 4 — what the counter's omnibox finds.
 *
 * Two modes:
 * - **Open**: no scope, so the whole catalog via `searchCards` ("96
 *   contenders white", "griffey refractor", "13").
 * - **Scoped**: the collector is working one set and variant ("In: 1996
 *   Playoff Contenders · Base"), so a bare number, a list or a range ("27",
 *   "3 6 9", "1-5, 9") reads straight off that checklist. A word query
 *   searches the scope first and falls back to everything when the scope has
 *   nothing like it.
 *
 * A card number is never unique, even inside one variant (2024 Topps Chrome
 * base has #13 and its Sliding variation), so the omnibox always SHOWS every
 * match; `sharedNumber` tells it when not to pre-highlight one.
 */

import {
  cardsInSet,
  compareCards,
  getSet,
  searchCards,
  setLabel,
  variantLabel,
  type Card,
  type SetId,
  type VariantPath,
} from "../_shared/data";

export interface Scope {
  setId: SetId;
  variant: VariantPath;
}

/** "1996 Playoff Contenders · Base". */
export function scopeLabel(scope: Scope): string {
  return `${setLabel(getSet(scope.setId))} · ${variantLabel(scope.variant)}`;
}

export function scopeOf(card: Card): Scope {
  return { setId: card.setId, variant: card.variantPath };
}

export function inScope(card: Card, scope: Scope): boolean {
  return (
    card.setId === scope.setId &&
    card.variantPath.type === scope.variant.type &&
    card.variantPath.name === scope.variant.name
  );
}

export type SearchMode =
  /** Nothing typed. */
  | "idle"
  /** Whole catalog. */
  | "open"
  /** Numbers read off the scoped checklist. */
  | "numbers"
  /** Words, inside the scope. */
  | "scoped"
  /** Words that found nothing in the scope: whole catalog instead. */
  | "fallback";

export interface CounterResult {
  mode: SearchMode;
  hits: Card[];
  /** Numbers typed in scope that the checklist does not have. */
  notOnChecklist: string[];
  /** Quantity typed as "x3" / "3x"; 1 when absent. */
  quantity: number;
  /** True when the query was a list or range of numbers (bulk path). */
  multiple: boolean;
}

const MAX_RANGE = 200;

/** Pull a trailing or leading "x3" / "3x" quantity token out of the query. */
function takeQuantity(query: string): { rest: string; quantity: number } {
  const tokens = query.trim().split(/\s+/);
  let quantity = 1;
  const rest = tokens.filter((t) => {
    const m = /^(?:x(\d{1,2})|(\d{1,2})x)$/i.exec(t);
    if (m && quantity === 1) {
      quantity = Math.max(1, Number(m[1] ?? m[2]));
      return false;
    }
    return true;
  });
  return { rest: rest.join(" "), quantity };
}

/**
 * "27" → ["27"]; "3 6, 9" → ["3","6","9"]; "1-5" → ["1".."5"]; "#13b" → ["13b"].
 * Null when any token is not a number, so "96 contenders" stays a search.
 */
export function parseNumberList(text: string): string[] | null {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const out: string[] = [];
  for (const t of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(t);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      if (hi - lo > MAX_RANGE) return null;
      for (let n = lo; n <= hi; n++) out.push(String(n));
      continue;
    }
    if (/^[a-z]{0,3}\d+[a-z]?$/i.test(t) || /^[a-z]{1,3}-[a-z0-9]{1,4}$/i.test(t)) {
      out.push(t.toLowerCase());
      continue;
    }
    return null;
  }
  return [...new Set(out)];
}

export function counterSearch(query: string, scope: Scope | null): CounterResult {
  const { rest, quantity } = takeQuantity(query);
  const empty: CounterResult = {
    mode: "idle",
    hits: [],
    notOnChecklist: [],
    quantity,
    multiple: false,
  };
  if (!rest.trim()) return empty;

  if (scope) {
    const numbers = parseNumberList(rest);
    if (numbers) {
      const checklist = cardsInSet(scope.setId, {
        type: scope.variant.type,
        name: scope.variant.name,
      });
      const hits: Card[] = [];
      const notOnChecklist: string[] = [];
      for (const n of numbers) {
        const matches = checklist.filter((c) => c.cardNumber.toLowerCase() === n);
        if (matches.length === 0) notOnChecklist.push(n);
        hits.push(...matches);
      }
      return {
        mode: "numbers",
        hits,
        notOnChecklist,
        quantity,
        multiple: numbers.length > 1,
      };
    }
    const all = searchCards(rest).map((h) => h.card);
    const scoped = all.filter((c) => inScope(c, scope));
    if (scoped.length > 0) {
      return { mode: "scoped", hits: scoped, notOnChecklist: [], quantity, multiple: false };
    }
    return { mode: "fallback", hits: all, notOnChecklist: [], quantity, multiple: false };
  }

  return {
    mode: "open",
    hits: searchCards(rest).map((h) => h.card),
    notOnChecklist: [],
    quantity,
    multiple: false,
  };
}

/**
 * True when another hit carries the same card number as `card` (any set, any
 * variant): the omnibox must not pre-highlight either one.
 */
export function sharedNumber(card: Card, hits: Card[]): boolean {
  return hits.some((h) => h.id !== card.id && h.cardNumber === card.cardNumber);
}

/**
 * Bulk add: the hits whose number is unambiguous in the list. A number with
 * two cards behind it is left for the collector to pick by hand.
 */
export function unambiguousHits(hits: Card[]): { sure: Card[]; ambiguous: string[] } {
  const sure: Card[] = [];
  const ambiguous = new Set<string>();
  for (const h of hits) {
    if (sharedNumber(h, hits)) ambiguous.add(`#${h.cardNumber}`);
    else sure.push(h);
  }
  return { sure: sure.sort(compareCards), ambiguous: [...ambiguous] };
}
