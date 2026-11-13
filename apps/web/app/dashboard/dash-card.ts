/**
 * NEO-464 — one card as the dashboard draws and captions it. Shared by the
 * demo's fake data (`./fake-data`) and the signed-in dashboard
 * (`./real/useRealDashboard`): both hand `toDash` a collection `Card`, the
 * demo's from its fake catalog and the real page's from the store.
 */

import { brandedSetName, generateListingTitle, type ListingCardInputs } from "@/convex/features/generateListing";
import { printRunLabel, variantLabel } from "@/app/collection/final/data/labels";
import type { Card, CardId, SetId, SetRef, VariantKind } from "@/app/collection/final/data/types";

/**
 * One card, ready to draw and to caption. `card` goes to CardFace's `model`;
 * the rest is the caption a tile needs, already worded.
 */
export interface DashCard {
  /** The card id. Stable: use it as a React key. */
  id: CardId;
  /** The card itself: pass it as `<CardFace model={...} />`. */
  card: Card;
  /** Lead player as printed: "Reggie White". */
  player: string;
  /** Team on the card: "Packers". Empty when the card names none. */
  team: string;
  /** Year and set, as the title names them (`dashSetLabel`): "1993 Topps Finest", "1996-97 Upper Deck". */
  setLabel: string;
  setId: SetId;
  /** The card number as printed ("13", "13b", "GJ1"). A string, never unique on its own. */
  cardNumber: string;
  /** base | insert | parallel. */
  variantKind: VariantKind;
  /** The insert or parallel's name ("Gold Refractor", "Pennant Flyers"); null on a base card. */
  variantName: string | null;
  /** "/50", "1/1"; null when unnumbered. */
  printRun: string | null;
  /** Image variation ("Sliding"); null for the regular card. */
  variation: string | null;
  /**
   * The card's full listing title, at most 80 characters, built by NB's own
   * listing-title generator (`generateListingTitle`) from the card's fields:
   * "2024 Topps Chrome Gold Refractor Parallel #1 Shohei Ohtani /50 Dodgers".
   */
  title: string;
}

/**
 * A set as the dashboard names it: the season, then the brand and the set's
 * name the way the cards' listing titles put them (`brandedSetName`), so a
 * board headed "1993 Topps Finest" shows titles that start "1993 Topps
 * Finest". `brand` is the set's NB brand row's name; null or "" names the set
 * alone. The server's labels (`brandedSetLabel`, convex/lib/listingLabels.ts)
 * use the same rule.
 */
export function dashSetLabel(set: {
  season: string;
  name: string;
  brand: string | null | undefined;
  /**
   * NEO-527: true when the brand row is the year's brand-unknown row (its
   * flag, never its name). The set is then named alone, as its listing
   * title names it (NEO-272): a collector never sees that row.
   */
  brandUnknown?: boolean;
}): string {
  return `${set.season} ${brandedSetName({
    manufacturer: set.brand ?? undefined,
    manufacturerBrandUnknown: set.brandUnknown === true,
    setName: set.name,
  })}`.trim();
}

/** `dashSetLabel` for the collection's own `SetRef`. */
export function setRefLabel(set: Pick<SetRef, "season" | "name" | "brand" | "brandUnknown">): string {
  return dashSetLabel({ season: set.season, name: set.name, brand: set.brand.name, brandUnknown: set.brandUnknown });
}

/** The generator's inputs, from a card's own fields. Nothing here is marketplace data. */
function titleInputs(card: Card): ListingCardInputs {
  const { variant } = card;
  const insertName = variant.kind === "insert" ? (variant.insertName ?? variant.name ?? undefined) : (variant.insertName ?? undefined);
  return {
    cardNumber: card.cardNumber,
    playerNames: card.players.map((p) => p.nameOnCard ?? p.name),
    year: card.set.season,
    manufacturer: card.set.brand.name,
    // NEO-527: the brand-unknown row is never in a title (NEO-272).
    manufacturerBrandUnknown: card.set.brandUnknown === true,
    setName: card.set.name,
    insertName,
    parallelName: variant.kind === "parallel" && variant.name ? variant.name : "Base",
    parallelIsRole: variant.kind === "parallel",
    isRookie: card.features.includes("RC"),
    isRelic: card.features.includes("Relic"),
    autographed: card.features.includes("AU") ? "On Card" : "None",
    shortPrint: card.features.includes("SP") ? "SP" : "None",
    printRun: card.printRun ?? undefined,
    cardVariation: card.cardVariation ?? undefined,
    teamNames: card.teams.map((t) => (t.location ? `${t.location} ${t.name}` : t.name)),
    sport: card.set.sport.name,
  };
}

/** A collection card as a DashCard. */
export function toDash(card: Card): DashCard {
  return {
    title: generateListingTitle(titleInputs(card)),
    id: card.id,
    card,
    player: card.players[0]?.name ?? "",
    team: card.teams[0]?.name ?? "",
    setLabel: setRefLabel(card.set),
    setId: card.set.id,
    cardNumber: card.cardNumber,
    variantKind: card.variant.kind,
    variantName: card.variant.kind === "base" ? null : variantLabel(card.variant),
    printRun: printRunLabel(card),
    variation: card.cardVariation,
  };
}
