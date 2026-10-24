/**
 * NEO-358 — how the collection page names and orders things, over the
 * hydrated view model (`./types`). Pure: no store, no lookups, so the demo and
 * the real collection label a card the same way. Moved out of
 * `prototypes/_shared/data`, which keeps its own copies for the prototypes.
 */

import { contrastRatio } from "@/lib/print/contrast";
import { tokenHex } from "@/src/theme/tokens";
import type { Card, CardTeam, SetRef, VariantKind, VariantRef } from "./types";

/** "1996 Playoff Contenders", "1996-97 Upper Deck". */
export function setLabel(set: Pick<SetRef, "season" | "name">): string {
  return `${set.season} ${set.name}`;
}

/** "Base", "Pennant Flyers", "Gold Refractor", "Pennant Flyers Gold". */
export function variantLabel(variant: Pick<VariantRef, "kind" | "name" | "insertName">): string {
  if (variant.kind === "base" || !variant.name) return "Base";
  return variant.insertName ? `${variant.insertName} ${variant.name}` : variant.name;
}

/** "/50", "1/1", or null when unnumbered. */
export function printRunLabel(card: Pick<Card, "printRun">): string | null {
  if (card.printRun === null) return null;
  return card.printRun === 1 ? "1/1" : `/${card.printRun}`;
}

/** "Packers", "Red Wings / Whalers" for a multi-team card; "" when none is known. */
export function teamNames(card: Pick<Card, "teams">): string {
  return card.teams.map((t) => t.name).join(" / ");
}

/** "Reggie White", or "A / B" on a multi-player card; "" when none is known. */
export function playerNames(card: Pick<Card, "players">): string {
  return card.players.map((p) => p.name).join(" / ");
}

/** "RW" for Reggie White, "KG" for Ken Griffey Jr. (suffixes dropped); "?" for no name. */
export function playerInitials(name: string): string {
  const parts = name
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(jr|sr|ii|iii|iv)$/i.test(w));
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The card's accessible name, unique enough to tell two cards apart:
 *
 *   "1996 Playoff Contenders #4 Reggie White, Packers"
 *   "1996 Playoff Contenders Pennant Flyers #2 Reggie White, Packers"
 *   "2024 Topps Chrome #1 Shohei Ohtani, Dodgers, Gold Refractor /50"
 *   "2024 Topps Chrome #13 Elly De La Cruz, Reds, Sliding variation"
 *
 * Inserts (and variants of no kind, like "Promo") read as part of the set
 * name, how collectors say them; parallels,
 * print runs and variations trail after the team. A card with no player or
 * team known leaves that part out rather than printing a blank.
 */
export function cardLabel(card: Card): string {
  const { variant } = card;
  const insert =
    (variant.kind === "insert" || variant.kind === "other") && variant.name
      ? ` ${variant.name}`
      : variant.kind === "parallel" && variant.insertName
        ? ` ${variant.insertName}`
        : "";
  const players = playerNames(card);
  const head = `${setLabel(card.set)}${insert} #${card.cardNumber}${players ? ` ${players}` : ""}`;
  const parts = [head];
  const teams = teamNames(card);
  if (teams) parts.push(teams);
  const run = printRunLabel(card);
  if (variant.kind === "parallel" && variant.name) {
    parts.push(run ? `${variant.name} ${run}` : variant.name);
  } else if (run) {
    parts.push(`numbered ${run}`);
  }
  if (card.cardVariation) parts.push(`${card.cardVariation} variation`);
  return parts.join(", ");
}

/** "#4 Reggie White", "#13 Elly De La Cruz, Sliding variation": a card inside its own checklist. */
export function shortCardName(card: Card): string {
  const players = playerNames(card);
  const base = `#${card.cardNumber}${players ? ` ${players}` : ""}`;
  return card.cardVariation ? `${base}, ${card.cardVariation} variation` : base;
}

/** "2024 Topps Chrome" or "2024 Topps Chrome Gold Refractor": the checklist a card is on. */
export function setAndVariant(card: Card): string {
  const set = setLabel(card.set);
  return card.variant.kind === "base" ? set : `${set} ${variantLabel(card.variant)}`;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const KIND_ORDER: Record<VariantKind, number> = { base: 0, insert: 1, parallel: 2, other: 3 };

/** Natural card-number order: 2 < 13 < 13b. */
export function compareCardNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Checklist order: set year, set name, then the set's own variant order (Base,
 * inserts, parallels), then the checklist's own order inside a variant (card
 * number naturally when that ties), the regular card before its variation.
 */
export function compareCards(a: Card, b: Card): number {
  if (a.set.id !== b.set.id) {
    return a.set.year - b.set.year || a.set.name.localeCompare(b.set.name) || a.set.id.localeCompare(b.set.id);
  }
  if (a.variant.id !== b.variant.id) {
    return (
      KIND_ORDER[a.variant.kind] - KIND_ORDER[b.variant.kind] ||
      a.variant.order - b.variant.order ||
      variantLabel(a.variant).localeCompare(variantLabel(b.variant))
    );
  }
  return (
    a.sortOrder - b.sortOrder ||
    compareCardNumbers(a.cardNumber, b.cardNumber) ||
    Number(a.cardVariation !== null) - Number(b.cardVariation !== null)
  );
}

// ---------------------------------------------------------------------------
// Team livery
// ---------------------------------------------------------------------------

/** The app's dark panel surface (Tailwind slate-900). */
export const DARK_SURFACE = "#0F172A";
/** Readable fallback ink on that surface (Tailwind slate-300). */
export const LIVERY_FALLBACK = "#CBD5E1";
/** The fallback on a light surface (the `ink-2` role in light mode). */
export const LIVERY_FALLBACK_LIGHT = tokenHex("ink-2", "light");

/**
 * A team's colour for TEXT on a surface: the primary when it reaches 4.5:1
 * there, else the secondary when that does, else the label ink that reads on
 * it. Never a livery that fails contrast, and never a missing one: a team NB
 * has no colours for reads in the fallback ink.
 */
export function teamTextColor(team: Pick<CardTeam, "primary" | "secondary"> | undefined, surface: string = DARK_SURFACE): string {
  for (const hex of [team?.primary, team?.secondary]) {
    if (!hex) continue;
    const ratio = contrastRatio(hex, surface);
    if (ratio !== null && ratio >= 4.5) return hex;
  }
  return (contrastRatio(LIVERY_FALLBACK, surface) ?? 0) >= 4.5 ? LIVERY_FALLBACK : LIVERY_FALLBACK_LIGHT;
}

/** Black or white, whichever reads better ON a fill of this colour. */
export function inkOn(fill: string): "#000000" | "#FFFFFF" {
  const black = contrastRatio("#000000", fill) ?? 0;
  const white = contrastRatio("#FFFFFF", fill) ?? 0;
  return black >= white ? "#000000" : "#FFFFFF";
}
