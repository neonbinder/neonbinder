/**
 * NEO-147 — WCAG contrast, for the spine label designer's readout.
 *
 * This is deliberately INFORMATIONAL, not a gate. Real team color pairs are
 * often low contrast (navy on black, gold on white), and a collector choosing
 * their own team's livery is making a legitimate choice that an accessibility
 * threshold has no business overriding — this is ink on paper, not a UI. The
 * readout exists so the user can see the problem before spending ink, with
 * invert one click away as the remedy.
 *
 * Implements WCAG 2.x relative luminance and contrast ratio exactly, so the
 * numbers shown match any other checker the user might compare against.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse `#rgb` or `#rrggbb` (with or without the hash). Returns null for
 * anything else — the designer's manual-entry field accepts free text, so
 * "not a color yet" is a normal state during typing, not an error.
 */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

/** Normalize any accepted form to `#rrggbb`, or null if unparseable. */
export function normalizeHexColor(value: string): string | null {
  const rgb = parseHexColor(value);
  if (!rgb) return null;
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`;
}

/** WCAG relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio, 1 (identical) to 21 (black on white). Returns null when
 * either color is unparseable, so callers show "—" rather than a fake number.
 */
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return null;

  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

export type ContrastGrade = "excellent" | "good" | "poor";

/**
 * Bucket a ratio for the readout.
 *
 * The thresholds are WCAG's AA/AAA boundaries for LARGE text (3:1 and 4.5:1),
 * which is the right pair here — a name set down a 10-inch spine is very large
 * text indeed. Read as advice on legibility at arm's length, not as compliance.
 */
export function gradeContrast(ratio: number): ContrastGrade {
  if (ratio >= 4.5) return "excellent";
  if (ratio >= 3) return "good";
  return "poor";
}
