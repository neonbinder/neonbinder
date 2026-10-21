/**
 * NEO-350 prototype 1 — "Set Builder, Collector Edition".
 *
 * The class strings the admin Set Builder and Players screens use, copied
 * here with their light halves dropped (the collection side is dark only) and
 * the admin's orange swapped for Collection's neon blue. Keeping them in one
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

/** The set builder's column/panel surface (Tailwind gray-800). */
export const PANEL_HEX = "#1F2937";

export const FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";

/** EntitySelector's column card, dark half. */
export const COLUMN_CARD = "bg-gray-800 p-6 rounded-lg shadow";
export const COLUMN_WIDTH =
  "min-w-[260px] max-w-[min(340px,calc(100vw-80px))] flex-shrink-0";

export const ROW_IDLE = "bg-gray-700 border-gray-600 hover:bg-gray-600";
export const HIGHLIGHT_STROKE =
  "ring-2 ring-inset ring-[#00D558] shadow-[inset_0_0_14px_rgba(0,213,88,0.28)] outline-2 -outline-offset-2 outline-transparent";
export const HIGHLIGHT_TINT = "bg-[#00D558]/20 border-[#00D558]";
export const DESCRIPTION_TONE = "text-sm text-gray-300";

/** Each column's selected fill, as in the admin cascade (dark halves). */
export const SELECTED = {
  sport: "bg-pink-900 border-pink-700",
  year: "bg-blue-900 border-blue-700",
  brand: "bg-green-900 border-green-700",
  set: "bg-purple-900 border-purple-700",
  variantType: "bg-orange-900 border-orange-700",
  variant: "bg-teal-900 border-teal-700",
} as const;

/** CardChecklistItem's attribute badges, dark halves. */
export const FEATURE_BADGE: Record<CardFeature | "NUM", { label: string; cls: string }> = {
  RC: { label: "RC", cls: "bg-amber-900 text-amber-300 border-amber-700" },
  AU: { label: "AU", cls: "bg-purple-900 text-purple-300 border-purple-700" },
  Relic: { label: "RELIC", cls: "bg-pink-900 text-pink-300 border-pink-700" },
  SP: { label: "SP", cls: "bg-red-900 text-red-300 border-red-700" },
  NUM: { label: "#'d", cls: "bg-emerald-900 text-emerald-300 border-emerald-700" },
};

/** PlayerManagement's select. */
export const SELECT =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";
export const LABEL = "block text-sm font-medium mb-1 text-slate-300";

/** PlayerManagement's pill, used for filter chips and rule chips. */
export const CHIP =
  "min-h-6 rounded-full border px-2.5 py-1 text-sm transition-colors " + FOCUS;
export const CHIP_OFF = "border-slate-700 text-slate-200 hover:border-neon-blue hover:text-neon-blue";
export const CHIP_ON = "border-neon-blue bg-neon-blue text-black";

/** A quiet text button (the checklist row's Edit/Del). */
export const QUIET_BUTTON =
  "min-h-6 rounded px-2 py-1 text-xs text-slate-300 hover:text-neon-blue " + FOCUS;

/** Outline button on dark, for secondary actions beside a neon one. */
export const OUTLINE_BUTTON =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 " +
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
