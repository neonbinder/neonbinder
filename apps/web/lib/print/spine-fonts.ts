/**
 * NEO-147 — the typefaces a spine label can be set in.
 *
 * All ten are self-hosted rather than loaded from a font CDN, for a reason
 * specific to printing: `lib/print/print-html.ts` renders into an iframe from
 * `srcdoc` and waits at most 3 seconds for `document.fonts.ready`. A CDN font
 * that loaded slowly would silently print in the fallback face, and you would
 * only discover it on paper. The chosen font is inlined into the print
 * document as a data URI so that document depends on nothing.
 *
 * ## Why all ten cost almost nothing
 *
 * Each is subset to Latin + Latin-1 + Latin Extended-A (enough for Martínez,
 * Peña, Šimek) and converted to WOFF2, and the three variable fonts are pinned
 * to a single heavy weight because a spine label is always bold. The raw TTFs
 * total 1.24MB; these total ~157KB. Teko alone goes 285KB → 7.7KB, because
 * pinning the weight axis discards everything a label cannot select.
 *
 * A name outside that subset — Japanese, Cyrillic — falls back to the system
 * face for the whole label. Real given NPB teams are in the data, and
 * deliberately accepted: widening the subset costs most of the saving back.
 *
 * ## `charWidthRatio` is measured, not guessed
 *
 * `fitFontSizeIn` estimates how long a name will be from its character count,
 * so it needs to know how wide a character is in each face. These values are
 * the mean advance width, in ems, over a sample of real player names, read
 * from each font's own `hmtx` table.
 *
 * They span 0.346 (Big Shoulders) to 0.623 (Bungee) — a 1.8× spread, so a
 * single shared constant is not an approximation, it is a bug. At the old
 * fixed 0.55 a Big Shoulders label would be set 37% smaller than it could be,
 * and Bungee would be UNDER-estimated and run past the end of the label.
 */

export interface SpineFont {
  id: string;
  /** Shown in the picker. */
  label: string;
  /** CSS font-family name, also used in the `@font-face` rule. */
  family: string;
  /** File under `public/fonts/`. */
  file: string;
  /**
   * Mean advance width in ems over sample name text, from the font's metrics.
   * Feeds `fitFontSizeIn`; see the note above on why this is per font.
   */
  charWidthRatio: number;
  /** Grouping for the picker. */
  group: "Athletic" | "Card shop" | "System";
  /** One-line character note, so the picker is not ten names with no guidance. */
  note: string;
}

/**
 * The system stack the designer used before NEO-147 added this picker.
 *
 * Kept as an option and given a real entry rather than special-cased: it needs
 * a `charWidthRatio` like everything else, and 0.55 is the value the fitter
 * assumed when this stack was the only choice.
 */
export const SYSTEM_SPINE_FONT: SpineFont = {
  id: "system",
  label: "System sans",
  family:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  file: "",
  charWidthRatio: 0.55,
  group: "System",
  note: "No download — whatever this machine already has.",
};

export const SPINE_FONTS: SpineFont[] = [
  {
    id: "anton",
    label: "Anton",
    family: "Anton",
    file: "anton.woff2",
    charWidthRatio: 0.398,
    group: "Athletic",
    note: "Heavy condensed. Jersey lettering.",
  },
  {
    id: "big-shoulders",
    label: "Big Shoulders",
    family: "Big Shoulders",
    file: "big-shoulders.woff2",
    charWidthRatio: 0.346,
    group: "Athletic",
    note: "The narrowest here — fits the longest names largest.",
  },
  {
    id: "teko",
    label: "Teko",
    family: "Teko",
    file: "teko.woff2",
    charWidthRatio: 0.395,
    group: "Athletic",
    note: "Condensed and squared off. Scoreboard.",
  },
  {
    id: "oswald",
    label: "Oswald",
    family: "Oswald",
    file: "oswald.woff2",
    charWidthRatio: 0.418,
    group: "Athletic",
    note: "Condensed, more restrained than Anton.",
  },
  {
    id: "squada-one",
    label: "Squada One",
    family: "Squada One",
    file: "squada-one.woff2",
    charWidthRatio: 0.368,
    group: "Athletic",
    note: "Condensed with a slight slant.",
  },
  {
    id: "graduate",
    label: "Graduate",
    family: "Graduate",
    file: "graduate.woff2",
    charWidthRatio: 0.592,
    group: "Athletic",
    note: "Collegiate slab. Varsity.",
  },
  {
    id: "archivo-black",
    label: "Archivo Black",
    family: "Archivo Black",
    file: "archivo-black.woff2",
    charWidthRatio: 0.563,
    group: "Athletic",
    note: "Heavy but not condensed. Blunt.",
  },
  {
    id: "luckiest-guy",
    label: "Luckiest Guy",
    family: "Luckiest Guy",
    file: "luckiest-guy.woff2",
    charWidthRatio: 0.509,
    group: "Card shop",
    note: "Cartoon comic lettering.",
  },
  {
    id: "titan-one",
    label: "Titan One",
    family: "Titan One",
    file: "titan-one.woff2",
    charWidthRatio: 0.543,
    group: "Card shop",
    note: "Chunky and rounded. Playful.",
  },
  {
    id: "bungee",
    label: "Bungee",
    family: "Bungee",
    file: "bungee.woff2",
    charWidthRatio: 0.623,
    group: "Card shop",
    note: "Designed for vertical signage — which is what a spine is.",
  },
  SYSTEM_SPINE_FONT,
];

/**
 * Anton is the default: the most condensed of the athletic faces that still
 * reads as lettering rather than a scoreboard, so it prints long names largest
 * — the constraint that actually bites on a 1in spine.
 */
export const DEFAULT_SPINE_FONT_ID = "anton";

export function spineFontById(id: string): SpineFont {
  return SPINE_FONTS.find((f) => f.id === id) ?? SYSTEM_SPINE_FONT;
}

/** Public URL of a font file. Empty for the system stack, which loads nothing. */
export function spineFontUrl(font: SpineFont): string {
  return font.file ? `/fonts/${font.file}` : "";
}
