/**
 * NEO-358 — how a card from the real catalog is DRAWN: its finish (refractor,
 * foil, gold, superfractor) and colour cast, read best-effort from its
 * variant's title (Jason, 2026-10-23).
 *
 * Presentational only. It picks CardFace's sheen and tint and nothing else:
 * no count, filter, sort, search or write may ever read it (product invariant
 * 4). A title it does not recognise still gets a finish: the generic sheen
 * for an insert or parallel, the plain card for Base.
 *
 * Reading the words, whole and case-insensitive:
 * - "Superfractor" (or "Super Fractor") is the superfractor.
 * - "Gold" is gold ("Gold Refractor", "Gold Zone", "Gold Wave").
 * - A colour word tints it ("Aqua Refractor", "Red", "Black Foil").
 * - A refractor word ("Refractor", "Prizm", "X-Fractor", "Mojo", "Wave",
 *   "Shimmer", "Atomic") makes it a refractor; anything else is foil.
 */

import type { Finish, VariantKind } from "./types";

/** The colour casts collectors name, `#rrggbb`. First match in the title wins. */
const COLOUR_TINTS: Record<string, string> = {
  red: "#E0242B",
  ruby: "#E0115F",
  orange: "#FF9E00",
  lava: "#FF6A13",
  yellow: "#FFE600",
  green: "#00D558",
  emerald: "#50C878",
  lime: "#9BE22D",
  aqua: "#00E5C0",
  teal: "#00A3A3",
  blue: "#1E6BFF",
  sapphire: "#0F52BA",
  sky: "#00C2FF",
  purple: "#8B3DFF",
  violet: "#8B3DFF",
  pink: "#FF4FA3",
  magenta: "#FF00A8",
  black: "#1A1A1A",
  white: "#F4F4F6",
  silver: "#C0C7D0",
  platinum: "#E5E4E2",
  bronze: "#B87333",
  copper: "#B87333",
  sepia: "#A27B5C",
  negative: "#3A3A44",
  prism: "#E8E8F0",
};

/** Words that make a coloured parallel a refractor rather than a foil. */
const REFRACTOR_WORDS = new Set(["refractor", "refractors", "prizm", "prizms", "xfractor", "mojo", "wave", "shimmer", "atomic"]);

/** The generic sheen: a non-Base card the title says nothing more about. */
const GENERIC_SHEEN: Finish = { kind: "foil" };
const STANDARD: Finish = { kind: "standard" };

/** The title as whole lower-case words; "X-Fractor" reads as "xfractor", "Super Fractor" as "superfractor". */
function words(title: string): string[] {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/x-fractor/g, "xfractor")
    .replace(/super[\s-]*fractor/g, "superfractor")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The finish for a variant. `name` is the insert or parallel's own name;
 * `insertName` is a sub-parallel's insert (read too, after the name, so
 * "Pennant Flyers Gold" is gold).
 */
export function finishForVariant(variant: { kind: VariantKind; name: string | null; insertName?: string | null }): Finish {
  if (variant.kind === "base" || !variant.name) return STANDARD;
  const said = [...words(variant.name), ...(variant.insertName ? words(variant.insertName) : [])];
  if (said.includes("superfractor")) return { kind: "superfractor" };
  if (said.includes("gold") || said.includes("golden")) return { kind: "gold" };
  const tint = said.map((w) => COLOUR_TINTS[w]).find((hex) => hex !== undefined);
  const refractor = said.some((w) => REFRACTOR_WORDS.has(w));
  if (refractor) return tint ? { kind: "refractor", tint } : { kind: "refractor" };
  if (tint) return { kind: "foil", tint };
  return GENERIC_SHEEN;
}
