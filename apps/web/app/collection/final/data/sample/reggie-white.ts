/**
 * NEO-464 — real Reggie White cards for the public demo's "All Reggie White"
 * smart binder, one card from each of thirteen sets (his 1989 Score cards,
 * #92, #296 and #321, come with that whole set in `./score-1989-football`).
 *
 * Sample data from SportLots' Reggie White card list
 * (sportlots.com/Football/Player_values/Reggie-White.tpl and its full
 * list), not NB data: year, set and card number as listed there. The team is
 * his team that season (Eagles 1985-1992, Packers from 1993). Best effort.
 *
 * Each set here holds only his card: the demo does not load the rest of a
 * checklist it only needs one card of.
 *
 * Demo only: `./index` adds these to the demo's catalog.
 */

import type { SetDef } from "@/app/collection/prototypes/_shared/data";

/** One Reggie White card: the set's year, brand and name, his number in it, and his team. */
function reggie(
  year: number,
  brandId: string,
  name: string,
  cardNumber: number,
  teamId: "eagles" | "packers",
  flags?: string,
): SetDef {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    set: { id: `${year}-${slug}-football`, sportId: "football", year, season: String(year), brandId, name },
    base: [[cardNumber, "Reggie White", teamId, flags]],
  };
}

/** Oldest first. */
export const REGGIE_WHITE_SETS: SetDef[] = [
  reggie(1986, "brand-topps", "Topps", 275, "eagles", "rc"),
  reggie(1987, "brand-topps", "Topps", 301, "eagles"),
  reggie(1988, "brand-topps", "Topps", 241, "eagles"),
  reggie(1989, "brand-topps", "Topps", 108, "eagles"),
  reggie(1989, "brand-pro-set", "Pro Set", 325, "eagles"),
  reggie(1990, "brand-topps", "Topps", 86, "eagles"),
  reggie(1990, "brand-fleer", "Fleer", 93, "eagles"),
  reggie(1990, "brand-pro-set", "Pro Set", 252, "eagles"),
  reggie(1991, "brand-upper-deck", "Upper Deck", 148, "eagles"),
  reggie(1991, "brand-score", "Score", 344, "eagles"),
  reggie(1992, "brand-topps", "Topps", 162, "eagles"),
  reggie(1994, "brand-topps", "Finest", 92, "packers"),
  reggie(1994, "brand-score", "Score", 51, "packers"),
];
