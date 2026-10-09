/**
 * NEO-325 — does a pending PARALLEL look like the saved Base?
 *
 * Jason, 2026-10-09: in the Reconcile dialog for a set's parallels, every
 * set still pending on either marketplace is checked against NB's saved
 * Base. A parallel is the Base's checklist printed in another colour, so its
 * marketplace listing should have the Base's card count and start on the
 * Base's first card. One that does not (SportLots lists a "Chrome Black
 * Refractor" that is a parallel of Topps Chrome AND one that is the Topps
 * Chrome Black set) is set aside behind a toggle, with this module's reason
 * on its row — never silently dropped.
 *
 * Pure: no env, no Convex, no React. The dialog's probe hook
 * (`components/SetSelector/base-match-probe.ts`) feeds it what the
 * marketplace said; this decides. Nothing it decides is stored.
 *
 * ## The rules
 *
 *  - FIRST CARD. The marketplace's first non-variation card matches when its
 *    number equals the Base's first card's (trimmed, upper-cased; the Base's
 *    `cardNumberPrefix` is already off the Base's numbers — the server strips
 *    it — and is stripped here from the marketplace's) AND the two agree on WHO is on
 *    it — `sameWho` from `convex/lib/parallelCardLink.ts`, built on
 *    `card-name.ts`: `playersKey` of the marketplace's players against the
 *    Base card's printed names, else `nameKey` of the titles; a team card is
 *    judged on its number alone.
 *  - FIRST-CARD FALLBACK. A marketplace sorted differently is not punished:
 *    when the number is not the Base's first, the marketplace's first card is
 *    looked up among ALL the Base's cards by number, and any Base card with
 *    that number and an agreeing who counts. Card numbers are never unique
 *    (invariant 7), so every Base card on the number is tried; none of them
 *    is assumed to be the one.
 *  - COUNT. Exact equality with `perSide[side]` — the Base cards linked on
 *    THAT marketplace, not the Base's total: a Base of 335 cards may have
 *    only 300 with SportLots refs, and the parallel's SportLots listing is
 *    measured against those 300. A side with no linked Base cards (`0`) is
 *    judged on the first card alone.
 *  - A probe that failed or was refused is NEVER a mismatch. It is
 *    "unverifiable": the row stays listed, and says it could not be checked.
 */

import { nameKey, playersKey } from "./card-name";

/** The marketplaces a pending row can come from. */
export type BaseMatchSide = "bsc" | "sportlots";

/** A card of the saved Base, as `getBaseSignatureForVariantType` returns it. */
export type BaseSignatureCard = {
  cardNumber: string;
  cardName: string;
  /** The names printed on the card (NB's `playerLinks[].nameOnCard`). */
  namesOnCard: string[];
  isTeamCard: boolean;
};

/** The saved Base, reduced to what a parallel is checked against. */
export type BaseSignature = {
  status: "ok";
  baseId: string;
  baseName: string;
  first: BaseSignatureCard;
  /** Non-variation Base cards linked on each marketplace. */
  perSide: { bsc: number; sportlots: number };
  /** Already stripped from every Base card number here, when set. */
  cardNumberPrefix?: string;
  /** Every non-variation Base card, in NB order. */
  cards: BaseSignatureCard[];
};

/** A marketplace's first non-variation card, as a probe saw it. */
export type ObservedCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
};

/**
 * What the marketplace said about one pending set. `count` absent means it
 * was not counted (the first card already decided, or the side has no
 * linked Base cards).
 */
export type BaseObservation =
  | { status: "failed" }
  | {
      status: "ok";
      first?: ObservedCard | null;
      count?: number;
      /**
       * The marketplace listed rows, but every one it was asked about was a
       * variation, so there is no first card to compare. Decided (NEO-325):
       * that is a first-card MISMATCH — the Base's first card is never a
       * variation, so a parallel of it does not open on a page of nothing
       * else. Set aside, never deleted; the operator can reveal it.
       */
      onlyVariations?: boolean;
    };

export type BaseVerdict = "match" | "mismatch" | "unverifiable";

export type BaseJudgement = { verdict: BaseVerdict; reason: string };

/** The first-card rule's answer on its own; `unknown` when there was no card. */
export type FirstCardOutcome = "match" | "mismatch" | "unknown";

// ---------------------------------------------------------------------------
// Copy (DRAFT — Jason signs off). Every string the check puts on screen.
// ---------------------------------------------------------------------------

const MARKETPLACE_LABEL: Record<BaseMatchSide, string> = {
  bsc: "BSC",
  sportlots: "SportLots",
};

const cards = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`;

const sets = (n: number) => `${n} ${n === 1 ? "set" : "sets"}`;

export const BASE_MATCH_COPY = {
  /** Column counter while checks are running. */
  checkingHeader: (done: number, total: number) =>
    `Checking against Base — ${done} of ${total}`,
  /** Column counter once every row in scope has a verdict. */
  checkedHeader: (match: number, mismatch: number, unverifiable: number) =>
    `Checked against Base — ${match} match, ${mismatch} don't${
      unverifiable > 0 ? `, ${unverifiable} couldn't be checked` : ""
    }`,
  /**
   * The reveal toggle's visible text. Constant whichever way it is open:
   * `aria-expanded` carries the state, so the name never flips under a
   * screen reader (and the visible words stay inside the name, WCAG 2.5.3).
   */
  mismatchedToggle: (n: number) => `${n} that don't match the Base`,
  /**
   * The toggle's accessible name: the visible words first (WCAG 2.5.3), then
   * the column, because both columns can show one at once.
   */
  toggleName: (visible: string, side: BaseMatchSide) =>
    `${visible}, ${MARKETPLACE_LABEL[side]}`,
  /** Screen-reader status on a row, beside its name. */
  srChecking: "checking against the Base",
  srMatch: "matches the Base",
  srMismatch: "doesn't match the Base",
  srUnverifiable: "couldn't be checked against the Base",
  /**
   * The dialog's ONE polite live line for the whole check (both columns):
   * a start line, at most a line per quarter, and one closing sentence.
   * Progress is counted against the total taken when the check started.
   */
  liveStart: (total: number) => `Checking ${sets(total)} against the Base.`,
  liveQuarter: (percent: number) => `Base check ${percent}% done.`,
  liveDone: (
    checked: number,
    match: number,
    mismatch: number,
    unverifiable: number,
  ) =>
    `Checked ${sets(checked)} against the Base: ${match} match, ${mismatch} don't${
      unverifiable > 0 ? `, ${unverifiable} couldn't be checked` : ""
    }.`,
  /**
   * Said once when a column's check stops because the marketplace answered
   * every set in a batch with a sign-in failure (security F1): its remaining
   * sets are marked "couldn't be checked" rather than asked again.
   */
  liveStopped: (side: BaseMatchSide) =>
    `Stopped checking the ${MARKETPLACE_LABEL[side]} sets against the Base: ${MARKETPLACE_LABEL[side]} needs you to sign in. Sign in, then reopen this to check them.`,
  /** Row reasons. Never names a marketplace as why a check failed. */
  matched: "Matches the Base",
  unverifiable: "Couldn't check this one against the Base. Try again later.",
  nothingToCompare: "Couldn't check this one against the Base: no card to compare.",
  onlyVariations: "only variations on its first page",
  mismatch: (observed: string, base: string) =>
    `Doesn't match the Base — ${observed} (Base: ${base})`,
  /**
   * Keep all's accessible name: its visible words ("Keep all" or
   * "Keep all N") first, then the column (WCAG 2.5.3 label in name).
   */
  keepAllName: (shown: number | null, sideName: string) =>
    shown === null
      ? `Keep all, ${sideName} sets`
      : `Keep all ${shown}, ${sideName} ${shown === 1 ? "set" : "sets"}`,
  /** Keep all's description clause for what it leaves out. */
  keepAllLeftOut: (checking: number, mismatched: number) => {
    const parts: string[] = [];
    if (checking > 0) parts.push(`${checking} still being checked against the Base`);
    if (mismatched > 0) parts.push(`${mismatched} that don't match the Base`);
    return parts.length > 0 ? ` Leaves out ${parts.join(" and ")}.` : "";
  },
} as const;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Trimmed, upper-cased, with `prefix` removed from the front when present. */
export function normalizedCardNumber(
  cardNumber: string,
  prefix: string | undefined,
): string {
  const n = cardNumber.trim().toUpperCase();
  const p = prefix?.trim().toUpperCase();
  return p && n.startsWith(p) && n.length > p.length ? n.slice(p.length) : n;
}

const cleanNames = (names: readonly string[] | undefined) =>
  (names ?? []).map((n) => n.trim()).filter(Boolean);

/**
 * Do a Base card and a marketplace card agree on who is on it?
 * `parallelCardLink.ts`'s `sameWho`, applied to a Base card: its printed
 * names keyed with `playersKey` against the marketplace's players (else the
 * two titles with `nameKey`); a team card with no names agrees on any who;
 * a card with no names compares its title.
 */
export function sameWho(base: BaseSignatureCard, observed: ObservedCard): boolean {
  const names = cleanNames(base.namesOnCard);
  const players = cleanNames(observed.players);
  if (names.length > 0) {
    return players.length > 0
      ? playersKey(players) === playersKey(names)
      : nameKey(observed.cardName) === nameKey(base.cardName);
  }
  if (base.isTeamCard) return true;
  const key = nameKey(base.cardName);
  return key.length > 0 && nameKey(observed.cardName) === key;
}

/**
 * The first-card rule, with its fallback. `unknown` when the marketplace
 * gave no first card at all.
 */
export function judgeFirstCard(
  signature: BaseSignature,
  first: ObservedCard | null | undefined,
): FirstCardOutcome {
  if (!first || !first.cardNumber.trim()) return "unknown";
  // The server sends the Base's numbers with the prefix already off; the
  // marketplace's may still carry it.
  const number = normalizedCardNumber(first.cardNumber, signature.cardNumberPrefix);
  if (
    number === normalizedCardNumber(signature.first.cardNumber, undefined) &&
    sameWho(signature.first, first)
  ) {
    return "match";
  }
  // The fallback: any Base card on that number whose who agrees.
  for (const card of signature.cards) {
    if (normalizedCardNumber(card.cardNumber, undefined) !== number) continue;
    if (sameWho(card, first)) return "match";
  }
  return "mismatch";
}

/**
 * Does this side need a COUNT after its first card? Only when there is a
 * linked count to compare against and the first card has not already
 * decided against the set. The probe hook asks this between its two
 * SportLots steps, so a set whose first card is wrong costs no count.
 */
export function needsCount(
  signature: BaseSignature,
  side: BaseMatchSide,
  firstOutcome: FirstCardOutcome,
): boolean {
  return signature.perSide[side] > 0 && firstOutcome !== "mismatch";
}

/** "#1 Mike Trout" — the title, else the names joined. */
function cardLabel(cardNumber: string, cardName: string, names: string[]): string {
  const who = cardName.trim() || names.join(" / ");
  return `#${cardNumber.trim()}${who ? ` ${who}` : ""}`;
}

function mismatchReason(
  signature: BaseSignature,
  side: BaseMatchSide,
  first: ObservedCard | null | undefined,
  count: number | undefined,
  onlyVariations = false,
): string {
  const observed: string[] = [];
  if (count !== undefined) observed.push(cards(count));
  if (onlyVariations) observed.push(BASE_MATCH_COPY.onlyVariations);
  if (first && first.cardNumber.trim()) {
    observed.push(
      `first ${cardLabel(first.cardNumber, first.cardName, cleanNames(first.players))}`,
    );
  }
  const expected = signature.perSide[side];
  const base: string[] = [];
  if (expected > 0) base.push(`${expected} on ${MARKETPLACE_LABEL[side]}`);
  base.push(
    `first ${cardLabel(
      signature.first.cardNumber,
      signature.first.cardName,
      cleanNames(signature.first.namesOnCard),
    )}`,
  );
  return BASE_MATCH_COPY.mismatch(
    observed.length > 0 ? observed.join(", ") : cards(0),
    base.join(", "),
  );
}

/**
 * The verdict on one pending set, from everything its side's probe said.
 *
 *   failed / refused                       → unverifiable (stays listed)
 *   rows, but only variations              → mismatch (no first card)
 *   first card disagrees                   → mismatch
 *   side has linked Base cards:
 *     count missing                        → unverifiable (never guessed)
 *     count differs                        → mismatch
 *     count equal                          → match (first agreed, or the
 *                                            marketplace listed no card to
 *                                            compare but the count is exact)
 *   side has no linked Base cards:
 *     first agrees                         → match
 *     no first card                        → unverifiable
 */
export function judgeAgainstBase(
  signature: BaseSignature,
  side: BaseMatchSide,
  observed: BaseObservation,
): BaseJudgement {
  if (observed.status !== "ok") {
    return { verdict: "unverifiable", reason: BASE_MATCH_COPY.unverifiable };
  }
  const outcome = judgeFirstCard(signature, observed.first);
  if (outcome === "unknown" && observed.onlyVariations) {
    return {
      verdict: "mismatch",
      reason: mismatchReason(signature, side, null, observed.count, true),
    };
  }
  if (outcome === "mismatch") {
    return {
      verdict: "mismatch",
      reason: mismatchReason(signature, side, observed.first, observed.count),
    };
  }
  const expected = signature.perSide[side];
  if (expected > 0) {
    if (observed.count === undefined) {
      return { verdict: "unverifiable", reason: BASE_MATCH_COPY.unverifiable };
    }
    if (observed.count !== expected) {
      return {
        verdict: "mismatch",
        reason: mismatchReason(signature, side, observed.first, observed.count),
      };
    }
    return { verdict: "match", reason: BASE_MATCH_COPY.matched };
  }
  if (outcome === "match") {
    return { verdict: "match", reason: BASE_MATCH_COPY.matched };
  }
  return {
    verdict: "unverifiable",
    reason: BASE_MATCH_COPY.nothingToCompare,
  };
}
