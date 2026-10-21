/**
 * NEO-350 prototype 4 (Dealer's Counter) — the class strings every panel
 * shares, so one quiet control language runs through the page and the
 * omnibox stays the only loud thing on it.
 */

/** Focus ring: Collection's neon blue on every control. */
export const RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black";

/** A quiet bordered button on the dark page. 32px tall; 44px on a phone. */
export const QUIET_BTN = `inline-flex min-h-11 sm:min-h-8 items-center justify-center gap-1.5 rounded-md border border-slate-600 bg-slate-900 px-3 text-sm font-medium text-slate-100 hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 ${RING}`;

/** The primary action: neon green, black ink. */
export const GO_BTN = `inline-flex min-h-11 sm:min-h-8 items-center justify-center gap-1.5 rounded-md bg-neon-green px-3 text-sm font-semibold text-black hover:bg-neon-green/85 disabled:cursor-not-allowed disabled:opacity-50 ${RING}`;

/** Destructive: neon pink, black ink. */
export const STOP_BTN = `inline-flex min-h-11 sm:min-h-8 items-center justify-center gap-1.5 rounded-md bg-neon-pink px-3 text-sm font-semibold text-black hover:bg-neon-pink/90 disabled:cursor-not-allowed disabled:opacity-50 ${RING}`;

/** A small icon-only button (24px+ target, 44px on a phone). */
export const ICON_BTN = `inline-flex h-11 w-11 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white ${RING}`;

/** Native select on the dark surface. */
export const SELECT = `rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 min-h-11 sm:min-h-8 ${RING}`;

/** A toggle chip; pair with aria-pressed. The check glyph carries "on", not colour alone. */
export function chipClass(on: boolean): string {
  return `inline-flex min-h-11 sm:min-h-7 items-center gap-1 rounded-full border px-3 text-xs font-medium ${RING} ${
    on
      ? "border-neon-blue bg-neon-blue text-black"
      : "border-slate-600 bg-slate-900 text-slate-200 hover:border-slate-400"
  }`;
}

/** Panels: rounded-lg, slate-800 border. */
export const PANEL = "rounded-lg border border-slate-800 bg-slate-950";

/** Dollars, no cents when whole: $4, $0.50, $2,800. */
export function money(n: number | undefined): string {
  if (n === undefined) return "";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** "1 card", "3 cards". */
export function cardsWord(n: number): string {
  return `${n} card${n === 1 ? "" : "s"}`;
}
