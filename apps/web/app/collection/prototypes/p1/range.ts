import type { Card } from "../_shared/data";

/**
 * "1-20, -12, 45, 13b" → which cards of a checklist the collector means.
 *
 * - `a-b` is every card numbered a to b (plain numbers only).
 * - A bare token is that exact card number ("13b", "GJ1").
 * - A leading `-` takes a number or range back out: "1-20, -12, -15-17".
 *
 * A card number is never assumed unique: a number two cards share comes back
 * in `shared`, so the screen can ask which one rather than ticking both.
 */
export interface RangePick {
  /** Numbers that matched exactly one card. */
  single: Card[];
  /** Numbers that matched several cards (a base card and its image variation). */
  shared: { number: string; cards: Card[] }[];
  /** Tokens that matched nothing, as typed. */
  unknown: string[];
  /** True when the text could not be read at all. */
  invalid: boolean;
}

const RANGE = /^(\d+)\s*-\s*(\d+)$/;

function tokens(text: string): string[] {
  // Keep "1 - 20" together before splitting on commas and spaces, but leave
  // "1-20 -12" alone: a dash with a space on one side only is an exclusion.
  return text
    .replace(/(\d)\s+-\s+(\d)/g, "$1-$2")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function numbersFor(token: string, cards: Card[]): { numbers: string[]; ok: boolean } {
  const range = RANGE.exec(token);
  if (range) {
    let [from, to] = [Number(range[1]), Number(range[2])];
    if (from > to) [from, to] = [to, from];
    const numbers = cards
      .map((c) => c.cardNumber)
      .filter((n) => /^\d+$/.test(n) && Number(n) >= from && Number(n) <= to);
    return { numbers, ok: true };
  }
  const wanted = token.replace(/^#/, "").toLowerCase();
  const numbers = cards.map((c) => c.cardNumber).filter((n) => n.toLowerCase() === wanted);
  return { numbers, ok: numbers.length > 0 };
}

export function parseRange(text: string, cards: Card[]): RangePick {
  const include = new Set<string>();
  const exclude = new Set<string>();
  const unknown: string[] = [];
  for (const raw of tokens(text)) {
    const negative = raw.startsWith("-");
    const token = negative ? raw.slice(1) : raw;
    if (!token) continue;
    const { numbers, ok } = numbersFor(token, cards);
    if (!ok) {
      unknown.push(raw);
      continue;
    }
    for (const n of numbers) (negative ? exclude : include).add(n);
  }
  const byNumber = new Map<string, Card[]>();
  for (const card of cards) {
    if (!include.has(card.cardNumber) || exclude.has(card.cardNumber)) continue;
    const list = byNumber.get(card.cardNumber) ?? [];
    list.push(card);
    byNumber.set(card.cardNumber, list);
  }
  const single: Card[] = [];
  const shared: RangePick["shared"] = [];
  for (const [number, list] of byNumber) {
    if (list.length === 1) single.push(list[0]);
    else shared.push({ number, cards: list });
  }
  return {
    single,
    shared,
    unknown,
    invalid: text.trim() !== "" && include.size === 0 && unknown.length > 0,
  };
}
