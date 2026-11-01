import type { ListingProblemReason, SaleItem, SyncProblem } from "../../data/types";
import { BSC_NAME } from "@/lib/marketplace/listing-copy";

export {
  BSC_NAME,
  CONSENT_LINE,
  CREDENTIALS_PATH,
  PAUSED_LINE,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
} from "@/lib/marketplace/listing-copy";

/**
 * NEO-370 — the words the Sync button, the Sync status tab and the Sales tab
 * say. One place, so a reason reads the same everywhere and a new one is a
 * type error here. NB voice: short, plain, a little rad; never an internal
 * word ("outbox", "lease", "drain", "SKU"). The ones the Profile says too
 * live in `lib/marketplace/listing-copy`.
 */

/** BSC's seller orders page. BSC has no link to one order: the number is what to search. */
export const BSC_ORDERS_URL = "https://www.buysportscards.com/sellers/orders";

/** Why a card didn't list on BSC, in a collector's words. */
export const PROBLEM_COPY: Record<ListingProblemReason, string> = {
  noLink: "BuySportsCards has no match for this card yet, so there's nowhere to list it.",
  sharedLink: "Its BuySportsCards link points at another card too. We won't guess which one is yours.",
  numberMismatch: "BuySportsCards numbers this card differently. We held it back so the wrong card can't list.",
  noPrice: "No price yet. Set a common price above, or a minimum price on the card.",
  priceTooHigh: "Priced over $999, the most BuySportsCards takes.",
  noCondition: "A copy has no condition. Pick one on the card.",
  graded: "Graded cards don't list here yet. Raw copies only for now.",
  notOnSheet: "BuySportsCards doesn't show this card for this set, so it can't list there.",
  rejected: "BuySportsCards turned this one down.",
};

/**
 * The admin's read-only Sync status says the reasons that address the
 * collector ("yours", "Set a common price above") as plain description: the
 * admin is not that collector and has nothing above to press.
 */
export const PROBLEM_COPY_READ_ONLY: Record<ListingProblemReason, string> = {
  ...PROBLEM_COPY,
  sharedLink: "Its BuySportsCards link points at another card too, so it's held back rather than guessed.",
  noPrice: "No price yet: no common price on the set and no minimum price on the card.",
  noCondition: "A copy has no condition.",
};

/** The full sentence for one problem, with what BSC said when it refused a row. */
export function problemSentence(problem: Pick<SyncProblem, "reason" | "detail">, readOnly = false): string {
  const base = (readOnly ? PROBLEM_COPY_READ_ONLY : PROBLEM_COPY)[problem.reason];
  if (problem.reason === "rejected" && problem.detail) return `${base} They said: “${problem.detail}”`;
  return base;
}

/** PAUSED_LINE and REAUTH_LINE for the admin's read-only view, about the collector rather than to them. */
export const PAUSED_LINE_READ_ONLY = `${BSC_NAME} is on a break. Changes wait here and go up when it's back.`;
export const REAUTH_LINE_READ_ONLY = `The ${BSC_NAME} sign-in ran out, so nothing goes up until the collector signs in again.`;

/** A BSC row NB cannot tie to one of its cards (a problem or a sold line). */
export const UNMATCHED_CARD = `A ${BSC_NAME} card we can't match`;

/** Which card a problem is about: "#12 Ken Griffey Jr.", else that NB has no card for it. */
export function problemCardName(problem: Pick<SyncProblem, "cardNo" | "cardLabel">): string {
  const name = problem.cardLabel?.trim();
  if (problem.cardNo) return name ? `#${problem.cardNo} ${name}` : `#${problem.cardNo}`;
  return name || UNMATCHED_CARD;
}

/** "2:14 PM" today, "Oct 30, 2:14 PM" this year, "Oct 30, 2025" before. */
export function whenSynced(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  if (d.getFullYear() === today.getFullYear()) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Nov 1, 2026". */
export function orderDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Integer cents as dollars: 125 → "$1.25". */
export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * BSC's order status word as a collector reads it ("READY_TO_SHIP" → "Ready
 * to ship"). Display only: nothing decides anything on it. A word NB has not
 * seen reads as itself, tidied.
 */
export function orderStatus(status: string): string {
  const known: Record<string, string> = {
    SHIPPED: "Shipped",
    READY_TO_SHIP: "Ready to ship",
    CANCELLED: "Cancelled",
    PARTIALLY_REFUNDED_SHIPPED: "Partly refunded, shipped",
    PARTIALLY_REFUNDED_READY_TO_SHIP: "Partly refunded, ready to ship",
  };
  if (known[status]) return known[status];
  const words = status.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/** What went wrong with one sold line, or null when it came out of the boxes cleanly. */
export function saleItemProblem(item: Pick<SaleItem, "problem" | "quantity" | "shortBy">): string | null {
  switch (item.problem) {
    case undefined:
      return null;
    case "unmatched":
      return "We couldn't match this to a card in NeonBinder, so your boxes weren't touched. Pull it by hand.";
    case "linkMismatch":
      return "This sale points at a card whose BuySportsCards link doesn't line up. We left your boxes alone; give it a look.";
    case "oversold": {
      const short = item.shortBy ?? 0;
      const had = Math.max(0, item.quantity - short);
      return `Sold ${item.quantity} on BuySportsCards but only ${had} in your boxes. We took ${had === 1 ? "that one" : had === 0 ? "none" : `those ${had}`}; ${short} more ${short === 1 ? "needs" : "need"} a look.`;
    }
  }
}
