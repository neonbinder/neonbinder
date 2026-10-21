/**
 * NEO-350 prototype 3 — "1-50, -12, -33" into a list of cards, pure.
 *
 *   1-50      every card numbered 1 through 50 in the row
 *   27        every card numbered exactly 27 (or "13b", "GJ1", "RA-PS")
 *   -12       leave #12 out, wherever it appears in the text
 *   -30-40    leave 30 through 40 out
 *
 * Commas or spaces separate pieces. A number that matches more than one card
 * in the row (the regular #13 and its Sliding variation) is reported as
 * ambiguous so the preview can show both: a number never picks one card.
 */

import type { Card } from "../_shared/data";

export interface RangePlan {
  /** Cards the text selects, in checklist order. */
  cards: Card[];
  /** Numbers that selected more than one card. */
  ambiguous: { number: string; cards: Card[] }[];
  /** Typed numbers / spans with no card in the row, already compacted. */
  notFound: string[];
  error: string | null;
  /** True when the text held at least one include piece. */
  hasIncludes: boolean;
}

const RANGE = /^(-)?(\d+)-(\d+)$/;
const MAX_SPAN = 2000;

function numeric(card: Card): number | null {
  return /^\d+$/.test(card.cardNumber) ? Number(card.cardNumber) : null;
}

export function parseRange(text: string, rowCards: Card[]): RangePlan {
  const pieces = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const include = new Set<string>();
  const exclude = new Set<string>();
  const notFound: string[] = [];
  let hasIncludes = false;

  for (const piece of pieces) {
    const m = RANGE.exec(piece);
    if (m) {
      const [, neg, a, b] = m;
      let lo = Number(a);
      let hi = Number(b);
      if (lo > hi) [lo, hi] = [hi, lo];
      if (hi - lo > MAX_SPAN) {
        return { cards: [], ambiguous: [], notFound: [], hasIncludes, error: `${piece} is a lot of cards. Try a smaller span.` };
      }
      const hits = rowCards.filter((c) => {
        const n = numeric(c);
        return n !== null && n >= lo && n <= hi;
      });
      const target = neg ? exclude : include;
      for (const c of hits) target.add(c.id);
      if (!neg) {
        hasIncludes = true;
        const have = new Set(hits.map((c) => numeric(c)));
        const gaps: number[] = [];
        for (let n = lo; n <= hi; n++) if (!have.has(n)) gaps.push(n);
        notFound.push(...compact(gaps));
      }
      continue;
    }
    const neg = piece.startsWith("-");
    const body = (neg ? piece.slice(1) : piece).replace(/^#/, "").toLowerCase();
    if (!body) continue;
    const hits = rowCards.filter((c) => c.cardNumber.toLowerCase() === body);
    if (neg) {
      for (const c of hits) exclude.add(c.id);
    } else {
      hasIncludes = true;
      if (hits.length === 0) notFound.push(body);
      for (const c of hits) include.add(c.id);
    }
  }

  const cards = rowCards.filter((c) => include.has(c.id) && !exclude.has(c.id));
  const byNumber = new Map<string, Card[]>();
  for (const c of cards) {
    const list = byNumber.get(c.cardNumber) ?? [];
    list.push(c);
    byNumber.set(c.cardNumber, list);
  }
  const ambiguous = [...byNumber.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([number, list]) => ({ number, cards: list }));

  return { cards, ambiguous, notFound, error: null, hasIncludes };
}

/** [41,42,43,47] → ["41–43", "47"] */
function compact(nums: number[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j + 1;
  }
  return out;
}
