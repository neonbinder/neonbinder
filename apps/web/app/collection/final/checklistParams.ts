import { EMPTY_DRILL, type Drill } from "./catalog/drill";

/**
 * NEO-350 / NEO-358 — the Checklists tab's place on the page URL, so each
 * step is a Back step and a refresh or a shared link reopens the same view.
 *
 * Every value is an id the store handed out, never a display name. Above a
 * set the URL names the levels picked so far (`sport`, `year`, `brand`);
 * from a set down it names only the `set`, since the set fixes its sport,
 * year and brand, then `type`, `variant` and `sub` (a parallel under an
 * insert):
 *
 *   ?tab=checklists&sport=<id>&year=<id>&brand=<id>
 *   ?tab=checklists&set=<id>&type=<id>
 *   ?tab=checklists&set=<id>&type=<id>&variant=<id>
 *
 * The demo's ids are its own slugs and words (`year=2024`, `type=Base`,
 * `variant=Gold+Refractor`), so a demo link from before NEO-358 still opens.
 *
 * Reading here is only parsing. The ids are checked against the catalog by
 * `useDrillState` (`./catalog/useDrillState`), which stops a drill quietly at
 * the deepest level that still makes sense.
 *
 * Besides the drill: `q` (the search box), `card` (a row a search jumped to;
 * on its own, a card whose checklist is still to be found), and a picked
 * search suggestion: `player`, or `team` (with `franchise=<id>` when it has
 * one, and `whole=1` to take in every team of it).
 */

/** Every param the drill writes. */
export const DRILL_PARAMS = ["sport", "year", "brand", "set", "type", "variant", "sub"] as const;
/** The search box's text. */
export const QUERY_PARAM = "q";
/** The row a search jumped to, ringed on the checklist. */
export const CARD_PARAM = "card";
/** A picked player suggestion: all his cards. */
export const PLAYER_PARAM = "player";
/** A picked team suggestion: the cards that team is printed on. */
export const TEAM_PARAM = "team";
/** With `team`: its franchise, when it has one (what makes the franchise option show). */
export const FRANCHISE_PARAM = "franchise";
/** With `team` and `franchise`: every team of the franchise, not just this one. */
export const WHOLE_PARAM = "whole";

/** The params a drill writes: the levels above a set, or the set and below. */
export function drillToParams(drill: Drill): Record<string, string> {
  const out: Record<string, string> = {};
  if (drill.set) {
    out.set = drill.set;
    if (drill.type) out.type = drill.type;
    if (drill.type && drill.variant) out.variant = drill.variant;
    if (drill.type && drill.variant && drill.sub) out.sub = drill.sub;
    return out;
  }
  if (drill.sport) out.sport = drill.sport;
  if (drill.sport && drill.year) out.year = drill.year;
  if (drill.sport && drill.year && drill.brand) out.brand = drill.brand;
  return out;
}

/** True when two drills stand for the same place. */
export function sameDrill(a: Drill, b: Drill): boolean {
  return new URLSearchParams(drillToParams(a)).toString() === new URLSearchParams(drillToParams(b)).toString();
}

/** The drill a URL names, unchecked (see the module comment). */
export function drillFromParams(params: URLSearchParams): Drill {
  const set = params.get("set");
  if (set) {
    const type = params.get("type") || null;
    const variant = type ? params.get("variant") || null : null;
    const sub = variant ? params.get("sub") || null : null;
    return { ...EMPTY_DRILL, set, type, variant, sub };
  }
  const sport = params.get("sport") || null;
  const year = sport ? params.get("year") || null : null;
  const brand = year ? params.get("brand") || null : null;
  return { ...EMPTY_DRILL, sport, year, brand };
}

/** A picked search suggestion on the URL, or null. */
export type EntityParam =
  | { kind: "player"; id: string }
  | { kind: "team"; id: string; franchiseId: string | null; wholeFranchise: boolean };

export function entityFromParams(params: URLSearchParams): EntityParam | null {
  const player = params.get(PLAYER_PARAM);
  if (player) return { kind: "player", id: player };
  const team = params.get(TEAM_PARAM);
  if (team) {
    const franchiseId = params.get(FRANCHISE_PARAM) || null;
    return { kind: "team", id: team, franchiseId, wholeFranchise: !!franchiseId && params.get(WHOLE_PARAM) === "1" };
  }
  return null;
}

export function entityToParams(entity: EntityParam): Record<string, string> {
  if (entity.kind === "player") return { [PLAYER_PARAM]: entity.id };
  const out: Record<string, string> = { [TEAM_PARAM]: entity.id };
  if (entity.franchiseId) out[FRANCHISE_PARAM] = entity.franchiseId;
  if (entity.franchiseId && entity.wholeFranchise) out[WHOLE_PARAM] = "1";
  return out;
}
