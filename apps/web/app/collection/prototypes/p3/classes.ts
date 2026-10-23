/** NEO-350 prototype 3 — shared class strings (colour roles: NEO-356). */

export const FOCUS =
  "focus-outline";

/** Quiet outline button: 44px tall on phones, 36px from sm up. */
export const QUIET_BUTTON = `inline-flex min-h-11 items-center gap-2 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink sm:min-h-9 ${FOCUS}`;

/** The neon-green primary action. */
export const PRIMARY_BUTTON = `inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-neon-green px-4 text-sm font-bold text-on-neon-green hover:bg-neon-green-hover disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 ${FOCUS}`;

export const SELECT =
  "min-h-11 rounded-md border border-field-rule bg-field px-3 text-sm text-ink focus-outline sm:min-h-9";

export const LABEL = "mb-1 block text-sm font-medium text-ink-2";
