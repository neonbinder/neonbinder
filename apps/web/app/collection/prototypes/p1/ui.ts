/**
 * NEO-350 prototype 1 — "Set Builder, Collector Edition".
 *
 * The class strings the admin Set Builder and Players screens use, copied
 * here with their light halves dropped (the collection side is dark only) and
 * the admin's orange swapped for Collection's neon blue. NEO-356: colour
 * roles, so the demo (which shares these) follows the light/dark mode. Keeping them in one
 * place is what makes this prototype read as the same app as the admin tools.
 */

import {
  getSet,
  getTeam,
  playerNames,
  printRunLabel,
  setLabel,
  teamTextColor,
  variantLabel,
  type Card,
  type CardFeature,
  type Copy,
} from "../_shared/data";
import "./ui.css";
import { useTheme } from "@/src/theme/ThemeProvider";
import { surfaceHex, type SurfaceRole } from "@/src/theme/tokens";

/** The set builder's column/panel surface (Tailwind gray-800): the `raised`
 * role in dark. Livery on a raised panel in either mode: `liveryOn(card,
 * surfaceHex("raised", mode))`. */
export const PANEL_HEX = "#1F2937";

export const FOCUS =
  "focus-outline";

/** EntitySelector's column card, dark half. */
export const COLUMN_CARD = "bg-raised p-6 rounded-lg shadow shadow-offset";
export const COLUMN_WIDTH =
  "min-w-[260px] max-w-[min(340px,calc(100vw-80px))] flex-shrink-0";

export const ROW_IDLE = "cx-row";
export const HIGHLIGHT_STROKE =
  "ring-2 ring-inset ring-neon-green-text shadow-[inset_0_0_14px_rgba(0,213,88,0.28)] outline-2 -outline-offset-2 outline-transparent";
export const HIGHLIGHT_TINT = "bg-neon-green/20 border-neon-green-text";
export const DESCRIPTION_TONE = "text-sm text-ink-2";

/** Each column's selected fill, as in the admin cascade (./ui.css draws both
 * modes: the dark `*-900` fill, or a pale tint of the hue in light). */
export const SELECTED = {
  sport: "cx-pick cx-hue-pink",
  year: "cx-pick cx-hue-blue",
  brand: "cx-pick cx-hue-green",
  set: "cx-pick cx-hue-purple",
  variantType: "cx-pick cx-hue-orange",
  variant: "cx-pick cx-hue-teal",
} as const;

/** CardChecklistItem's attribute badges (./ui.css draws both modes). */
export const FEATURE_BADGE: Record<CardFeature | "NUM", { label: string; cls: string }> = {
  RC: { label: "RC", cls: "cx-badge cx-hue-amber" },
  AU: { label: "AU", cls: "cx-badge cx-hue-purple" },
  Relic: { label: "RELIC", cls: "cx-badge cx-hue-pink" },
  SP: { label: "SP", cls: "cx-badge cx-hue-red" },
  NUM: { label: "#'d", cls: "cx-badge cx-hue-emerald" },
};

/** PlayerManagement's select. */
export const SELECT =
  "w-full rounded-md border border-field-rule bg-field px-3 py-2 text-base text-ink focus-outline";
export const LABEL = "block text-sm font-medium mb-1 text-ink-2";

/** PlayerManagement's pill, used for filter chips and rule chips. */
export const CHIP =
  "min-h-6 rounded-full border px-2.5 py-1 text-sm transition-colors " + FOCUS;
export const CHIP_OFF = "border-field-rule text-ink-2 hover:border-neon-blue hover:text-neon-blue-text";
export const CHIP_ON = "border-selection bg-neon-blue text-on-neon-blue";

/** A quiet text button (the checklist row's Edit/Del). */
export const QUIET_BUTTON =
  "min-h-6 rounded px-2 py-1 text-xs text-ink-2 hover:text-neon-blue-text " + FOCUS;

/** Outline button on dark, for secondary actions beside a neon one. */
export const OUTLINE_BUTTON =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md border border-control px-3 py-1.5 text-sm font-medium text-ink-2 hover:border-ink-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 " +
  FOCUS;

// ---------------------------------------------------------------------------
// Names a collector reads
// ---------------------------------------------------------------------------

/** "#13 Elly De La Cruz, Sliding variation": unique inside one checklist. */
export function shortCardName(card: Card): string {
  const base = `#${card.cardNumber} ${playerNames(card)}`;
  return card.variation ? `${base}, ${card.variation} variation` : base;
}

/** "1996 Playoff Contenders" or "1996 Playoff Contenders Pennant Flyers". */
export function setAndVariant(card: Card): string {
  const set = setLabel(getSet(card.setId));
  return card.variantPath.name ? `${set} ${variantLabel(card.variantPath)}` : set;
}

/** The lead team's colour for text on the set builder's gray-800 panel. */
export function liveryOn(card: Card, surface: string = PANEL_HEX): string {
  return teamTextColor(getTeam(card.teamIds[0]), surface);
}

/**
 * NEO-356 — the surface a piece of livery sits on, as `#rrggbb` in the
 * current mode, so `teamTextColor` picks a team colour that reads there
 * (`teamTextColor(team, useLiverySurface("sheet"))`).
 */
export function useLiverySurface(surface: SurfaceRole = "raised"): string {
  const { mode } = useTheme();
  return surfaceHex(surface, mode);
}

/** "Qty 2 · PSA 10 · Near Mint · 23/50 · $12.00 · Box 3 · For sale $40". */
export function copySummary(copy: Copy): string {
  const parts: string[] = [`Qty ${copy.quantity}`];
  if (copy.graded) {
    parts.push(`${copy.graded.grader} ${copy.graded.grade || "?"}`.trim());
    if (copy.graded.cert) parts.push(`cert ${copy.graded.cert}`);
  } else {
    parts.push(copy.condition ? `Raw, ${copy.condition}` : "Raw");
  }
  if (copy.serialNumber) parts.push(copy.serialNumber);
  if (copy.costBasis !== undefined) parts.push(`paid ${money(copy.costBasis)}`);
  if (copy.location) parts.push(copy.location);
  if (copy.forSale) parts.push(copy.askPrice !== undefined ? `For sale ${money(copy.askPrice)}` : "For sale");
  return parts.join(" · ");
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function printRunText(card: Card): string | null {
  const run = printRunLabel(card);
  return run;
}

/** "Mar 4, 2025" from `YYYY-MM-DD`, read as a calendar date (no time zone). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** Natural card-number order (2 < 13 < 13b < 301). */
export function compareNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** The admin cascade's row order (EntitySelector.compareOptionNames, copied:
 * that module imports Convex, so it is not pulled into this bundle). */
const ALL_DIGITS = /^\d+$/;
export function compareOptionNames(nameA: string, nameB: string): number {
  const numericA = ALL_DIGITS.test(nameA);
  const numericB = ALL_DIGITS.test(nameB);
  if (numericA !== numericB) return numericA ? -1 : 1;
  if (numericA) {
    const byValue = Number(nameB) - Number(nameA);
    if (byValue !== 0) return byValue;
  }
  return nameA.localeCompare(nameB);
}
