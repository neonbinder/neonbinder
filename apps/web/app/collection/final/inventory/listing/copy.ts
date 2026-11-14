import type {
  ListingPlatform,
  ListingProblemReason,
  SaleItem,
  SyncProblem,
  SyncStep,
  SyncStepStatus,
} from "../../data/types";
import { BSC_NAME, EBAY_NAME, PLATFORM_NAME } from "@/lib/marketplace/listing-copy";

/**
 * NEO-500 — the Sales tab's one-order link (`?tab=sales&sorder=<sale id>`):
 * the tab brings that order into view and marks it. Not `sale`, which the
 * page retired (it redirects to the Inventory list).
 */
export const SALE_PARAM = "sorder";

export {
  BSC_NAME,
  CONSENT_LINE,
  CREDENTIALS_PATH,
  EBAY_NAME,
  EBAY_PATH,
  EBAY_SETUP_LINE,
  PAUSED_LINE,
  PLATFORM_NAME,
  PLATFORM_PROFILE_PATH,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
  pausedLine,
  reauthLine,
  sellerConflictLine,
} from "@/lib/marketplace/listing-copy";

/**
 * NEO-370 — the words the Sync button, the Sync status tab and the Sales tab
 * say. One place, so a reason reads the same everywhere and a new one is a
 * type error here. NB voice: short, plain, a little rad; never an internal
 * word ("outbox", "lease", "drain", "SKU"). The ones the Profile says too
 * live in `lib/marketplace/listing-copy`. NEO-415: every sentence that names
 * a marketplace takes the platform it is about (BuySportsCards or eBay).
 */

/** BSC's seller orders page. BSC has no link to one order: the number is what to search. */
export const BSC_ORDERS_URL = "https://www.buysportscards.com/sellers/orders";

/** eBay's Seller Hub orders list, real and sandbox. */
export const EBAY_ORDERS_URL = "https://www.ebay.com/sh/ord";
export const EBAY_SANDBOX_ORDERS_URL = "https://www.sandbox.ebay.com/sh/ord";

/**
 * One eBay order in Seller Hub. UNVERIFIED (NEO-415 plan): the path is what
 * Seller Hub's own order rows link to today, not a documented API; if eBay
 * moves it, the order number on the card is still there to search.
 */
export function ebayOrderUrl(orderNo: string, sandbox = false): string {
  const host = sandbox ? "https://www.sandbox.ebay.com" : "https://www.ebay.com";
  return `${host}/sh/ord/details?orderid=${encodeURIComponent(orderNo)}`;
}

/** Each platform's seller orders list. */
export function ordersUrl(platform: ListingPlatform, sandbox = false): string {
  if (platform === "ebay") return sandbox ? EBAY_SANDBOX_ORDERS_URL : EBAY_ORDERS_URL;
  return BSC_ORDERS_URL;
}

/** Where a platform's connection and settings live, said as the path a collector clicks: "Profile → Credentials → eBay". */
export function credentialsWords(platform: ListingPlatform): string {
  return `Profile → Credentials → ${PLATFORM_NAME[platform]}`;
}

/** Why a card didn't list on a platform, in a collector's words. */
export function problemCopy(platform: ListingPlatform): Record<ListingProblemReason, string> {
  const name = PLATFORM_NAME[platform];
  return {
    noLink: `${name} has no match for this card yet, so there's nowhere to list it.`,
    sharedLink: `Its ${name} link points at another card too. We won't guess which one is yours.`,
    numberMismatch: `${name} numbers this card differently. We held it back so the wrong card can't list.`,
    noPrice: "No price yet. Set a common price above, or a minimum price on the card.",
    priceTooHigh: platform === "bsc" ? `Priced over $999, the most ${name} takes.` : `Priced over the most ${name} takes.`,
    noCondition: "A copy has no condition. Pick one on the card.",
    graded: "Graded cards don't list here yet. Raw copies only for now.",
    notOnSheet: `${name} doesn't show this card for this set, so it can't list there.`,
    rejected: `${name} turned this one down.`,
    missingAspect: `${name} wants a card detail we don't have yet, so it's held back.`,
    noPhoto: `${name} listings need a photo. Add one to a copy of this card and it goes up.`,
    setupIncomplete: `Finish your ${name} setup in ${credentialsWords(platform)} and this one goes up.`,
  };
}

/** The BSC sentences (NEO-370's set), kept by name for the screens and tests that say BSC's. */
export const PROBLEM_COPY: Record<ListingProblemReason, string> = problemCopy("bsc");

/**
 * The admin's read-only Sync status says the reasons that address the
 * collector ("yours", "Set a common price above") as plain description: the
 * admin is not that collector and has nothing above to press.
 */
export function problemCopyReadOnly(platform: ListingPlatform): Record<ListingProblemReason, string> {
  const name = PLATFORM_NAME[platform];
  return {
    ...problemCopy(platform),
    sharedLink: `Its ${name} link points at another card too, so it's held back rather than guessed.`,
    noPrice: "No price yet: no common price on the set and no minimum price on the card.",
    noCondition: "A copy has no condition.",
    noPhoto: `No photo on a copy of this card yet, and ${name} listings need one.`,
    setupIncomplete: `The collector's ${name} setup isn't finished.`,
  };
}
export const PROBLEM_COPY_READ_ONLY: Record<ListingProblemReason, string> = problemCopyReadOnly("bsc");

/**
 * The full sentence for one problem: for `rejected`, NB's own sentence for
 * what didn't go through (the server writes it: eBay's `EBAY_CARD_REJECTED`,
 * BSC's `rejectedPushDetail`), said as ours, never framed as a quote from the
 * platform; for `missingAspect` the detail it wants, when the server names
 * it ("Team").
 */
export function problemSentence(
  problem: Pick<SyncProblem, "reason" | "detail">,
  readOnly = false,
  platform: ListingPlatform = "bsc",
): string {
  const detail = problem.detail?.trim();
  if (problem.reason === "missingAspect" && detail) {
    return `${PLATFORM_NAME[platform]} wants this card's ${detail}, and we don't have it yet, so it's held back.`;
  }
  const base = (readOnly ? problemCopyReadOnly(platform) : problemCopy(platform))[problem.reason];
  if (problem.reason === "rejected" && detail) return `${base} ${/[.!?]$/.test(detail) ? detail : `${detail}.`}`;
  return base;
}

/**
 * NEO-464 — the card panel's one line for a card a sync held back, when the
 * dashboard's Sync status opened it: why, and that the fix is right here. A
 * price or a photo is fixed on the copy below (the panel opens its Edit form
 * there); every other reason says what it says on Sync status.
 */
export function heldBackNotice(reason: ListingProblemReason, platform: ListingPlatform): string {
  const name = PLATFORM_NAME[platform];
  if (reason === "noPrice") return `Held back from ${name}: no price yet. Set one on your copy below and it goes up next sync.`;
  if (reason === "noPhoto") {
    return `Held back from ${name}: listings there need a photo. Add one to your copy below and it goes up next sync.`;
  }
  return problemSentence({ reason }, false, platform);
}

/** The paused and expired lines for the admin's read-only view, about the collector rather than to them. */
export function pausedLineReadOnly(platform: ListingPlatform): string {
  return `${PLATFORM_NAME[platform]} is on a break. Changes wait here and go up when it's back.`;
}
export function reauthLineReadOnly(platform: ListingPlatform): string {
  return platform === "ebay"
    ? `The ${EBAY_NAME} connection ran out, so nothing goes up until the collector connects again.`
    : `The ${BSC_NAME} sign-in ran out, so nothing goes up until the collector signs in again.`;
}
export const PAUSED_LINE_READ_ONLY = pausedLineReadOnly("bsc");
export const REAUTH_LINE_READ_ONLY = reauthLineReadOnly("bsc");

/** A platform row NB cannot tie to one of its cards (a problem or a sold line). */
export function unmatchedCard(platform: ListingPlatform = "bsc"): string {
  const name = PLATFORM_NAME[platform];
  return `${/^[aeiou]/i.test(name) ? "An" : "A"} ${name} card we can't match`;
}
export const UNMATCHED_CARD = unmatchedCard("bsc");

/** Which card a problem is about: "#12 Ken Griffey Jr.", else that NB has no card for it. */
export function problemCardName(
  problem: Pick<SyncProblem, "cardNo" | "cardLabel">,
  platform: ListingPlatform = "bsc",
): string {
  const name = problem.cardLabel?.trim();
  if (problem.cardNo) return name ? `#${problem.cardNo} ${name}` : `#${problem.cardNo}`;
  return name || unmatchedCard(platform);
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

/** BSC's order status words. */
const BSC_STATUS: Record<string, string> = {
  SHIPPED: "Shipped",
  READY_TO_SHIP: "Ready to ship",
  CANCELLED: "Cancelled",
  PARTIALLY_REFUNDED_SHIPPED: "Partly refunded, shipped",
  PARTIALLY_REFUNDED_READY_TO_SHIP: "Partly refunded, ready to ship",
};

/**
 * eBay's order words (NEO-415): its fulfillment status (NOT_STARTED,
 * IN_PROGRESS, FULFILLED), its payment status, and a cancellation, whichever
 * the server stored. A word not here reads as itself, tidied.
 */
const EBAY_STATUS: Record<string, string> = {
  NOT_STARTED: "Ready to ship",
  IN_PROGRESS: "Partly shipped",
  FULFILLED: "Shipped",
  PAID: "Paid",
  PENDING: "Payment pending",
  FAILED: "Payment failed",
  FULLY_REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partly refunded",
  CANCELED: "Cancelled",
  CANCELLED: "Cancelled",
};

/**
 * The platform's order status word as a collector reads it ("READY_TO_SHIP"
 * → "Ready to ship"). Display only: nothing decides anything on it. A word
 * NB has not seen reads as itself, tidied.
 */
export function orderStatus(status: string, platform: ListingPlatform = "bsc"): string {
  const known = platform === "ebay" ? EBAY_STATUS : BSC_STATUS;
  const key = status.trim().toUpperCase();
  if (known[key]) return known[key];
  const words = status.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/** eBay sale lines carry NB's condition bucket; say it the way eBay's listing does. */
const EBAY_CONDITION: Record<string, string> = {
  NM: "Near Mint or better",
  EX: "Excellent",
  VG: "Very Good",
  PR: "Poor",
};

/** A sold line's condition, tidied for reading: "near_mint" → "Near mint", eBay's "NM" → "Near Mint or better". */
export function saleCondition(condition: string, platform: ListingPlatform = "bsc"): string {
  if (platform === "ebay" && EBAY_CONDITION[condition.trim().toUpperCase()]) {
    return EBAY_CONDITION[condition.trim().toUpperCase()];
  }
  const words = condition.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** What went wrong with one sold line, or null when it came out of the boxes cleanly. */
export function saleItemProblem(
  item: Pick<SaleItem, "problem" | "quantity" | "shortBy">,
  platform: ListingPlatform = "bsc",
): string | null {
  const name = PLATFORM_NAME[platform];
  switch (item.problem) {
    case undefined:
      return null;
    case "unmatched":
      return "We couldn't match this to a card in NeonBinder, so your boxes weren't touched. Pull it by hand.";
    case "linkMismatch":
      return `This sale points at a card whose ${name} link doesn't line up. We left your boxes alone; give it a look.`;
    case "oversold": {
      const short = item.shortBy ?? 0;
      const had = Math.max(0, item.quantity - short);
      return `Sold ${item.quantity} on ${name} but only ${had} in your boxes. We took ${had === 1 ? "that one" : had === 0 ? "none" : `those ${had}`}; ${short} more ${short === 1 ? "needs" : "need"} a look.`;
    }
  }
}

type StepWords = Pick<SyncStep, "kind" | "condition" | "conditions">;

/**
 * The NB conditions one step covers, said as a list: "Near Mint", "Mint and
 * Near Mint", "Mint, Near Mint and Excellent". None named: the step covers
 * the conditions NB lists nothing under.
 */
function conditionWords(step: StepWords): string {
  const named = step.conditions?.length ? step.conditions : step.condition ? [step.condition] : [];
  if (named.length === 0) return "the other conditions";
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * NEO-415 — a sync step in the collector's words, from its kind and NB's own
 * condition names (never a marketplace value): "Compare with your boxes",
 * "Read Near Mint", "Send changes to BuySportsCards", "Double-check Near
 * Mint"; eBay's "Upload photos" through "Take down cards at 0".
 */
function stepLabel(step: StepWords, platform: ListingPlatform): string {
  const condition = conditionWords(step);
  switch (step.kind) {
    case "check":
      return "Compare with your boxes";
    case "read":
      return `Read ${condition}`;
    case "send":
      return `Send changes to ${PLATFORM_NAME[platform]}`;
    case "confirm":
      return `Double-check ${condition}`;
    case "photos":
      return "Upload photos";
    case "items":
      return "List the cards";
    case "offers":
      return "Set prices";
    case "publish":
      return "Go live";
    case "withdraw":
      return "Take down cards at 0";
  }
}

/**
 * Every step's label, in run order, each one unique within the run (a list
 * item's name must tell it apart from its neighbours): a repeat, which a
 * well-formed plan never has, gets its count, "Read Good (2)".
 */
export function stepLabels(steps: ReadonlyArray<StepWords>, platform: ListingPlatform): string[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const label = stepLabel(step, platform);
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} (${n})`;
  });
}

/**
 * NEO-483 — Running now, while no sync can start because BuySportsCards hasn't
 * named the collector's seller account yet (NB keeps asking in the
 * background, and the first sync starts when it answers). The live line under
 * it, "Waiting on BuySportsCards…", is `WaitingOnMarketplace`'s.
 */
export function awaitingSellerLine(platform: ListingPlatform, readOnly = false): string {
  const name = PLATFORM_NAME[platform];
  return readOnly
    ? `${name} hasn't said which seller account this collector lists from yet. Syncing starts on its own once it answers.`
    : `${name} hasn't told us which seller account is yours yet. Hang tight: nothing is lost, and syncing kicks off on its own the moment it answers.`;
}

/** A set row's last run folds its compare and every read into this one line (the run going now keeps each). */
export const GATHERING_DATA = "Gathering data";

/** The line after it when a clean run read everything and had nothing to send (a finished row only). */
export const NOTHING_NEW_TO_SEND = "Nothing new to send";

/** A step's state, as its list item says it. */
export const STEP_STATE_WORD: Record<SyncStepStatus, string> = {
  waiting: "waiting",
  working: "working",
  done: "done",
  failed: "failed",
};

/** A step's accessible name: "Read Near Mint, done". */
export function stepName(label: string, status: SyncStepStatus): string {
  return `${label}, ${STEP_STATE_WORD[status]}`;
}

/** The running ledger's list name: "Sync steps for 1989 Upper Deck Base on BuySportsCards". */
export function runStepsName(setLabel: string | undefined, platform: ListingPlatform): string {
  return `Sync steps for ${setLabel ?? "this set"} on ${PLATFORM_NAME[platform]}`;
}

/** A set row's ledger list name: "Last sync steps for 1990 Score Base on BuySportsCards". */
export function lastStepsName(setLabel: string, platform: ListingPlatform): string {
  return `Last sync steps for ${setLabel} on ${PLATFORM_NAME[platform]}`;
}

/** "4 of 4 steps done.", or "1 of 1 step done." for a run with nothing to do. */
function stepTally(done: number, total: number): string {
  return `${done} of ${total} ${total === 1 ? "step" : "steps"} done.`;
}

/**
 * What the run's one polite line says when steps land: the newest one done
 * and the tally, or the step that hit a snag. Steps going from waiting to
 * working are not said (the spinner shows it; saying it doubles the chatter).
 */
/** The run's last word when it ends clean: "Synced 1989 Upper Deck Base with BuySportsCards. 4 of 4 steps done." */
export function runSyncedLine(setLabel: string, platform: ListingPlatform, done: number, total: number): string {
  return `Synced ${setLabel} with ${PLATFORM_NAME[platform]}. ${stepTally(done, total)}`;
}

/** The run's last word when it ended on a snag no step owns: "1991 Fleer Base hit a snag with BuySportsCards." */
export function runSnagLine(setLabel: string, platform: ListingPlatform): string {
  return `${setLabel} hit a snag with ${PLATFORM_NAME[platform]}.`;
}

export function stepLandedLine(label: string, status: "done" | "failed", done: number, total: number): string {
  return status === "failed" ? `${label} hit a snag.` : `${label}, done. ${stepTally(done, total)}`;
}
