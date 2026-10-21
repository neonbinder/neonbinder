/** NEO-350 prototype 3 — shared class strings (dark surfaces only). */

export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black";

/** Quiet outline button: 44px tall on phones, 36px from sm up. */
export const QUIET_BUTTON = `inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-600 px-3 text-sm text-slate-200 hover:border-neon-blue hover:text-white sm:min-h-9 ${FOCUS}`;

/** The neon-green primary action. */
export const PRIMARY_BUTTON = `inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-neon-green px-4 text-sm font-bold text-black hover:bg-neon-green/85 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 ${FOCUS}`;

export const SELECT =
  "min-h-11 rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-9";

export const LABEL = "mb-1 block text-sm font-medium text-slate-300";
