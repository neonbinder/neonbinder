import {
  cards,
  getBrand,
  getSport,
  sets,
  setLabel,
  variantLabel,
  type CardId,
  type VariantType,
} from "../prototypes/_shared/data";
import { brandItems, EMPTY_DRILL, sportItems, variantTypeItems, yearItems, type Drill } from "../prototypes/p1/drill";

/**
 * NEO-350 — the Checklists tab's drill on the page URL, so each step is a
 * Back step and a refresh or a shared link reopens the same checklist.
 *
 * Every value is an id from the catalog, never a display name. Above a set
 * the URL names the levels picked so far (`sport`, `year`, `brand`); from a
 * set down it names only the `set`, since the set fixes its sport, year and
 * brand, then `type` and `variant`:
 *
 *   ?tab=checklists&sport=baseball&year=2024&brand=brand-topps
 *   ?tab=checklists&set=2024-topps-chrome-baseball&type=Base
 *   ?tab=checklists&set=2024-topps-chrome-baseball&type=Parallels&variant=Gold+Refractor
 *
 * Reading is forgiving: an unknown id stops the drill at the deepest level
 * above it that still makes sense, and says nothing.
 */

/** Every param the drill writes. */
export const DRILL_PARAMS = ["sport", "year", "brand", "set", "type", "variant"] as const;
/** The search box's text. */
export const QUERY_PARAM = "q";
/** The row a search jumped to, ringed on the checklist. */
export const CARD_PARAM = "card";

/** The params a drill writes: the levels above a set, or the set and below. */
export function drillToParams(drill: Drill): Record<string, string> {
  const out: Record<string, string> = {};
  if (drill.set) {
    out.set = drill.set;
    if (drill.variantType) out.type = drill.variantType;
    if (drill.variantType && drill.variantType !== "Base" && drill.variant) out.variant = drill.variant;
    return out;
  }
  if (drill.sport) out.sport = drill.sport;
  if (drill.sport && drill.year !== null) out.year = String(drill.year);
  if (drill.sport && drill.year !== null && drill.brand) out.brand = drill.brand;
  return out;
}

/** True when two drills stand for the same place. */
export function sameDrill(a: Drill, b: Drill): boolean {
  return new URLSearchParams(drillToParams(a)).toString() === new URLSearchParams(drillToParams(b)).toString();
}

/** The drill a URL stands for. Unknown ids fall back to the level above them. */
export function drillFromParams(params: URLSearchParams): Drill {
  const setId = params.get("set");
  if (setId !== null) {
    const set = sets.find((s) => s.id === setId);
    if (!set) return EMPTY_DRILL;
    const drill: Drill = {
      sport: set.sportId,
      year: set.year,
      brand: set.brandId,
      set: set.id,
      variantType: null,
      variant: null,
    };
    const type = params.get("type");
    if (!type || !variantTypeItems(set).some((item) => item.id === type)) return drill;
    drill.variantType = type as VariantType;
    const variant = params.get("variant");
    if (type !== "Base" && variant && set.variants.some((v) => v.path.type === type && v.path.name === variant)) {
      drill.variant = variant;
    }
    return drill;
  }

  const drill: Drill = { ...EMPTY_DRILL };
  const sport = params.get("sport");
  if (!sport || !sportItems().some((item) => item.id === sport)) return drill;
  drill.sport = sport;
  const year = params.get("year");
  if (!year || !yearItems(sport).some((item) => item.id === year)) return drill;
  drill.year = Number(year);
  const brand = params.get("brand");
  if (!brand || !brandItems(sport, drill.year).some((item) => item.id === brand)) return drill;
  drill.brand = brand;
  return drill;
}

/** The ringed row: a known card on the checklist the drill points at, else none. */
export function cardFromParams(params: URLSearchParams, drill: Drill): CardId | null {
  const id = params.get(CARD_PARAM);
  if (!id || !drill.set || !drill.variantType) return null;
  const card = cards.find((c) => c.id === id);
  if (!card || card.setId !== drill.set || card.variantPath.type !== drill.variantType) return null;
  if (drill.variantType !== "Base" && card.variantPath.name !== drill.variant) return null;
  return card.id;
}

/**
 * What the drill points at, for the page title: the checklist ("2024 Topps
 * Chrome Base"), or the deepest level picked so far, or null at the top.
 */
export function drillTitle(drill: Drill): string | null {
  if (drill.set) {
    const set = sets.find((s) => s.id === drill.set);
    if (!set) return null;
    const label = setLabel(set);
    if (drill.variantType === "Base") return `${label} ${variantLabel({ type: "Base", name: null })}`;
    if (drill.variantType && drill.variant) {
      return `${label} ${variantLabel({ type: drill.variantType, name: drill.variant })}`;
    }
    return drill.variantType ? `${label} ${drill.variantType}` : label;
  }
  if (!drill.sport) return null;
  const sport = getSport(drill.sport).name;
  if (drill.year === null) return sport;
  const season = yearItems(drill.sport).find((item) => item.id === String(drill.year))?.name ?? String(drill.year);
  if (!drill.brand) return `${season} ${sport}`;
  return `${season} ${getBrand(drill.brand).name}`;
}
