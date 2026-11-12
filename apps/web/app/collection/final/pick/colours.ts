/**
 * NEO-500 — the Pick List's divider colours, as class strings (the roles live
 * in app/theme.css: `--sport-*`, `--variant-*`). Sampled from the physical
 * dividers a seller files cards behind, so the list on screen matches the box
 * on the table: sport by the divider's colour, variant by the stripe.
 *
 * Colour is never the only cue: every sport and variant is also written out.
 * The sport colour is keyed on NB's own sport code (the sport row's SKU code),
 * never on the sport's name. Pink (the insert parallel) only ever marks a row,
 * never a control: pink is the negative button colour.
 */

import type { VariantRole } from "./model";

export type SportHue = "football" | "baseball" | "basketball" | "hockey" | "other";

const HUE_BY_CODE: Record<string, SportHue> = {
  FB: "football",
  BB: "baseball",
  BK: "basketball",
  HK: "hockey",
};

/** The divider a sport files behind: anything without a known code is the black Non-Sport / Misc one. */
export function sportHue(code: string | null | undefined): SportHue {
  return (code && HUE_BY_CODE[code.toUpperCase()]) || "other";
}

/** The sport tab on a set's divider: fill, ink, and (black only) an edge so it never sinks into a dark page. */
export const SPORT_TAB: Record<SportHue, string> = {
  football: "bg-sport-football text-on-sport-football",
  baseball: "bg-sport-baseball text-on-sport-baseball",
  basketball: "bg-sport-basketball text-on-sport-basketball",
  hockey: "bg-sport-hockey text-on-sport-hockey",
  other: "bg-sport-other text-on-sport-other ring-1 ring-inset ring-sport-other-rule",
};

/** The divider line the tab sits on. */
export const SPORT_LINE: Record<SportHue, string> = {
  football: "border-sport-football",
  baseball: "border-sport-baseball",
  basketball: "border-sport-basketball",
  hockey: "border-sport-hockey",
  other: "border-sport-other-rule",
};

/** The variant's text chip: the divider's colour, black ink, and an edge that reads on white. */
export const VARIANT_CHIP: Record<VariantRole, string> = {
  base: "bg-variant-base text-on-variant border-variant-base-rule",
  parallel: "bg-variant-parallel text-on-variant border-variant-parallel-rule",
  insert: "bg-variant-insert text-on-variant border-variant-insert-rule",
  insertParallel: "bg-variant-insert-parallel text-on-variant border-variant-insert-parallel-rule",
};

/** The stripe down a row's left edge, with the same edge so a white Base stripe shows on a white row. */
export const VARIANT_STRIPE: Record<VariantRole, string> = {
  base: "bg-variant-base border-variant-base-rule",
  parallel: "bg-variant-parallel border-variant-parallel-rule",
  insert: "bg-variant-insert border-variant-insert-rule",
  insertParallel: "bg-variant-insert-parallel border-variant-insert-parallel-rule",
};
