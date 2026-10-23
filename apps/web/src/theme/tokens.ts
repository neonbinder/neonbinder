import type { ThemeMode } from "./theme-mode";

/**
 * NEO-356 — the colour roles as data, for code that must compute with a colour
 * rather than paint with a class: team livery picked for contrast against the
 * surface it sits on (`teamTextColor(team, surfaceHex("raised", mode))`),
 * canvas drawing, Clerk's appearance.
 *
 * This is a MIRROR of app/theme.css, value for value (the CSS strings are
 * copied verbatim, oklch included). tokens.test.tsx reads theme.css and fails
 * on any drift, so change a colour in both places. Components never import
 * this to paint: they use the Tailwind role classes (`bg-raised`).
 */

export type TokenRole =
  | "surface"
  | "raised"
  | "raised-deep"
  | "sheet"
  | "field"
  | "hover"
  | "rule"
  | "rule-strong"
  | "field-rule"
  | "control"
  | "ink"
  | "ink-2"
  | "ink-3"
  | "foreground"
  | "focus"
  | "selection"
  | "neon-green"
  | "neon-pink"
  | "neon-blue"
  | "neon-yellow"
  | "neon-orange"
  | "neon-teal"
  | "neon-purple"
  | "neon-green-text"
  | "neon-pink-text"
  | "neon-blue-text"
  | "neon-yellow-text"
  | "neon-orange-text"
  | "neon-teal-text"
  | "neon-purple-text"
  | "notice-info-ink"
  | "notice-warn-ink"
  | "notice-danger-ink"
  | "notice-success-ink"
  | "pip-owned"
  | "pip-want"
  | "spot"
  | "row"
  | "row-rule"
  | "row-hover"
  | "hover-raised"
  | "list-hover"
  | "chip"
  | "chip-strong"
  | "button-neutral"
  | "button-neutral-hover"
  | "selection-line"
  | "panel"
  | "panel-hover"
  | "panel-rule"
  | "wash-green"
  | "wash-blue"
  | "wash-pink"
  | "wash-rule-green"
  | "wash-rule-pink"
  | "paper"
  | "on-paper"
  | "pick-pink"
  | "pick-pink-rule"
  | "pick-pink-ink"
  | "pick-blue"
  | "pick-blue-rule"
  | "pick-blue-ink"
  | "pick-green"
  | "pick-green-rule"
  | "pick-green-ink"
  | "pick-purple"
  | "pick-purple-rule"
  | "pick-purple-ink"
  | "pick-orange"
  | "pick-orange-rule"
  | "pick-orange-ink"
  | "pick-teal"
  | "pick-teal-rule"
  | "pick-teal-ink"
  | "pick-amber"
  | "pick-amber-rule"
  | "pick-amber-ink"
  | "pick-red"
  | "pick-red-rule"
  | "pick-red-ink"
  | "pick-emerald"
  | "pick-emerald-rule"
  | "pick-emerald-ink";

/** The surfaces a piece of text can sit on. */
export type SurfaceRole =
  | "surface"
  | "raised"
  | "raised-deep"
  | "sheet"
  | "field"
  | "hover"
  | "row"
  | "row-hover"
  | "hover-raised"
  | "list-hover"
  | "chip"
  | "chip-strong"
  | "button-neutral"
  | "button-neutral-hover";

/** Every surface a piece of text can sit on, for the contrast checks. */
export const SURFACE_ROLES: readonly SurfaceRole[] = [
  "surface",
  "raised",
  "raised-deep",
  "sheet",
  "field",
  "hover",
  "row",
  "row-hover",
  "hover-raised",
  "list-hover",
  "chip",
  "chip-strong",
  "button-neutral",
  "button-neutral-hover",
];

/** The roles that paint text. */
export type TextRole =
  | "ink"
  | "ink-2"
  | "ink-3"
  | "neon-green-text"
  | "neon-pink-text"
  | "neon-blue-text"
  | "neon-yellow-text"
  | "neon-orange-text"
  | "neon-teal-text"
  | "neon-purple-text"
  | "notice-info-ink"
  | "notice-warn-ink"
  | "notice-danger-ink"
  | "notice-success-ink";

/**
 * Text that does NOT reach 4.5:1 on a surface, per mode, so the two are never
 * put together. tokens.test.tsx holds this table to the palette exactly (every
 * failing pair is listed, nothing else is) and scans the class strings for any
 * element that paints one of these text roles on one of these surfaces.
 *
 * Dark is the pre-NEO-356 look, value for value, and its neutral steps are
 * close together: the gray-700/-600 tiles (rows, chips, a hover on a card,
 * neutral buttons) are too light for the dimmer inks. On them, quiet text is
 * `ink-2` and a destructive hover is a pink FILL with black ink, never pink
 * text. Light's -text hues are cut for white and the page; the one-step-up
 * grey (chip-strong, button-neutral-hover) is the only place they miss.
 *
 * `neon-pink-text` on `raised`/`hover` in dark (4.27:1) is origin/main's own
 * pairing (pink copy on a graphite card) and is listed so the table is
 * honest, not because it is fine: lifting it means a new dark pink, which is
 * a design decision, not a token fix.
 */
export const TEXT_NEVER_ON: Record<ThemeMode, Partial<Record<TextRole, readonly SurfaceRole[]>>> = {
  dark: {
    "ink-3": ["row", "row-hover", "hover-raised", "chip", "chip-strong", "button-neutral", "button-neutral-hover"],
    "neon-green-text": ["row-hover", "chip-strong", "button-neutral-hover"],
    "neon-pink-text": [
      "raised",
      "hover",
      "row",
      "row-hover",
      "hover-raised",
      "chip",
      "chip-strong",
      "button-neutral",
      "button-neutral-hover",
    ],
    "neon-blue-text": ["row-hover", "chip-strong", "button-neutral-hover"],
    "neon-orange-text": ["row-hover", "chip-strong", "button-neutral-hover"],
    "neon-purple-text": ["row", "row-hover", "hover-raised", "chip", "chip-strong", "button-neutral", "button-neutral-hover"],
  },
  light: {
    "neon-green-text": ["chip-strong", "button-neutral-hover"],
    "neon-pink-text": ["chip-strong", "button-neutral-hover"],
    "neon-blue-text": ["chip-strong", "button-neutral-hover"],
    "neon-yellow-text": ["chip-strong", "button-neutral-hover"],
  },
};

const NEON_FILLS = {
  "neon-green": "#00d558",
  "neon-pink": "#ff2e9a",
  "neon-blue": "#00c2ff",
  "neon-yellow": "#ffe600",
  "neon-orange": "#ff9e00",
  "neon-teal": "#00e5c0",
  "neon-purple": "#a44aff",
} as const;

/** The CSS value of every role, per mode, exactly as app/theme.css writes it. */
export const TOKENS: Record<ThemeMode, Record<TokenRole, string>> = {
  dark: {
    surface: "#0a0a0a",
    raised: "oklch(27.8% 0.033 256.848)",
    "raised-deep": "oklch(21% 0.034 264.665)",
    sheet: "oklch(12.9% 0.042 264.695)",
    field: "oklch(20.8% 0.042 265.755)",
    hover: "oklch(27.8% 0.033 256.848)",
    rule: "oklch(27.9% 0.041 260.031)",
    "rule-strong": "oklch(37.2% 0.044 257.287)",
    "field-rule": "oklch(37.2% 0.044 257.287)",
    control: "oklch(55.4% 0.046 257.417)",
    ink: "#ffffff",
    "ink-2": "oklch(86.9% 0.022 252.894)",
    "ink-3": "oklch(70.4% 0.04 256.788)",
    foreground: "#ededed",
    focus: "#00c2ff",
    selection: "#00c2ff",
    ...NEON_FILLS,
    "neon-green-text": "#00d558",
    "neon-pink-text": "#ff2e9a",
    "neon-blue-text": "#00c2ff",
    "neon-yellow-text": "#ffe600",
    "neon-orange-text": "#ff9e00",
    "neon-teal-text": "#00e5c0",
    "neon-purple-text": "#b56bff",
    "notice-info-ink": "oklch(88.2% 0.059 254.128)",
    "notice-warn-ink": "oklch(87.9% 0.169 91.605)",
    "notice-danger-ink": "oklch(88.5% 0.062 18.334)",
    "notice-success-ink": "oklch(87.1% 0.15 154.449)",
    "pip-owned": "#00c2ff",
    "pip-want": "#ffe600",
    spot: "#ffe600",
    "row": "oklch(37.3% 0.034 259.733)",
    "row-rule": "oklch(44.6% 0.03 256.802)",
    "row-hover": "oklch(44.6% 0.03 256.802)",
    "hover-raised": "oklch(37.3% 0.034 259.733)",
    "list-hover": "oklch(20.8% 0.042 265.755)",
    "chip": "oklch(37.3% 0.034 259.733)",
    "chip-strong": "oklch(44.6% 0.03 256.802)",
    "button-neutral": "oklch(37.2% 0.044 257.287)",
    "button-neutral-hover": "oklch(44.6% 0.043 257.281)",
    "selection-line": "transparent",
    panel: "color-mix(in oklab, oklch(20.8% 0.042 265.755) 40%, transparent)",
    "panel-hover": "oklch(20.8% 0.042 265.755)",
    "panel-rule": "oklch(27.9% 0.041 260.031)",
    "wash-green": "color-mix(in oklab, #00d558 10%, transparent)",
    "wash-blue": "color-mix(in oklab, #00c2ff 10%, transparent)",
    "wash-pink": "color-mix(in oklab, #ff2e9a 10%, transparent)",
    "wash-rule-green": "color-mix(in oklab, #00d558 30%, transparent)",
    "wash-rule-pink": "color-mix(in oklab, #ff2e9a 40%, transparent)",
    "paper": "#ffffff",
    "on-paper": "#000000",
    "pick-pink": "oklch(40.8% 0.153 2.432)",
    "pick-pink-rule": "oklch(52.5% 0.223 3.958)",
    "pick-pink-ink": "oklch(82.3% 0.12 346.018)",
    "pick-blue": "oklch(37.9% 0.146 265.522)",
    "pick-blue-rule": "oklch(48.8% 0.243 264.376)",
    "pick-blue-ink": "oklch(80.9% 0.105 251.813)",
    "pick-green": "oklch(39.3% 0.095 152.535)",
    "pick-green-rule": "oklch(52.7% 0.154 150.069)",
    "pick-green-ink": "oklch(87.1% 0.15 154.449)",
    "pick-purple": "oklch(38.1% 0.176 304.987)",
    "pick-purple-rule": "oklch(49.6% 0.265 301.924)",
    "pick-purple-ink": "oklch(82.7% 0.119 306.383)",
    "pick-orange": "oklch(40.8% 0.123 38.172)",
    "pick-orange-rule": "oklch(55.3% 0.195 38.402)",
    "pick-orange-ink": "oklch(83.7% 0.128 66.29)",
    "pick-teal": "oklch(38.6% 0.063 188.416)",
    "pick-teal-rule": "oklch(51.1% 0.096 186.391)",
    "pick-teal-ink": "oklch(85.5% 0.138 181.071)",
    "pick-amber": "oklch(41.4% 0.112 45.904)",
    "pick-amber-rule": "oklch(55.5% 0.163 48.998)",
    "pick-amber-ink": "oklch(87.9% 0.169 91.605)",
    "pick-red": "oklch(39.6% 0.141 25.723)",
    "pick-red-rule": "oklch(50.5% 0.213 27.518)",
    "pick-red-ink": "oklch(80.8% 0.114 19.571)",
    "pick-emerald": "oklch(37.8% 0.077 168.94)",
    "pick-emerald-rule": "oklch(50.8% 0.118 165.612)",
    "pick-emerald-ink": "oklch(84.5% 0.143 164.978)",
  },
  light: {
    surface: "#f7f8fc",
    raised: "#ffffff",
    "raised-deep": "#ffffff",
    sheet: "#ffffff",
    field: "#ffffff",
    hover: "#f0f2f9",
    rule: "#dde0ea",
    "rule-strong": "#bcb9cf",
    "field-rule": "#757090",
    control: "#757090",
    ink: "#18122b",
    "ink-2": "#322b48",
    "ink-3": "#57516e",
    foreground: "#18122b",
    focus: "#7a2bd9",
    selection: "#006da6",
    ...NEON_FILLS,
    "neon-green-text": "#007a3b",
    "neon-pink-text": "#c40068",
    "neon-blue-text": "#006da6",
    "neon-yellow-text": "#7a6400",
    "neon-orange-text": "#9a4d00",
    "neon-teal-text": "#007060",
    "neon-purple-text": "#7a2bd9",
    "notice-info-ink": "#005f8f",
    "notice-warn-ink": "#6b4e00",
    "notice-danger-ink": "#a8005a",
    "notice-success-ink": "#006632",
    "pip-owned": "#006da6",
    "pip-want": "#a36a00",
    spot: "#b86a00",
    "row": "#ffffff",
    "row-rule": "#bcb9cf",
    "row-hover": "#f0f2f9",
    "hover-raised": "#f0f2f9",
    "list-hover": "#f0f2f9",
    "chip": "#e8eaf2",
    "chip-strong": "#dde0ea",
    "button-neutral": "#e8eaf2",
    "button-neutral-hover": "#dde0ea",
    "selection-line": "#006da6",
    panel: "#ffffff",
    "panel-hover": "#f0f2f9",
    "panel-rule": "#bcb9cf",
    "wash-green": "#ffffff",
    "wash-blue": "#ffffff",
    "wash-pink": "#ffffff",
    "wash-rule-green": "#bcb9cf",
    "wash-rule-pink": "#bcb9cf",
    "paper": "#ffffff",
    "on-paper": "#000000",
    "pick-pink": "oklch(94.8% 0.028 342.258)",
    "pick-pink-rule": "oklch(52.5% 0.223 3.958)",
    "pick-pink-ink": "oklch(45.9% 0.187 3.815)",
    "pick-blue": "oklch(93.2% 0.032 255.585)",
    "pick-blue-rule": "oklch(48.8% 0.243 264.376)",
    "pick-blue-ink": "oklch(42.4% 0.199 265.638)",
    "pick-green": "oklch(96.2% 0.044 156.743)",
    "pick-green-rule": "oklch(52.7% 0.154 150.069)",
    "pick-green-ink": "oklch(44.8% 0.119 151.328)",
    "pick-purple": "oklch(94.6% 0.033 307.174)",
    "pick-purple-rule": "oklch(49.6% 0.265 301.924)",
    "pick-purple-ink": "oklch(43.8% 0.218 303.724)",
    "pick-orange": "oklch(95.4% 0.038 75.164)",
    "pick-orange-rule": "oklch(55.3% 0.195 38.402)",
    "pick-orange-ink": "oklch(47% 0.157 37.304)",
    "pick-teal": "oklch(95.3% 0.051 180.801)",
    "pick-teal-rule": "oklch(51.1% 0.096 186.391)",
    "pick-teal-ink": "oklch(43.7% 0.078 188.216)",
    "pick-amber": "oklch(96.2% 0.059 95.617)",
    "pick-amber-rule": "oklch(55.5% 0.163 48.998)",
    "pick-amber-ink": "oklch(47.3% 0.137 46.201)",
    "pick-red": "oklch(93.6% 0.032 17.717)",
    "pick-red-rule": "oklch(50.5% 0.213 27.518)",
    "pick-red-ink": "oklch(44.4% 0.177 26.899)",
    "pick-emerald": "oklch(95% 0.052 163.051)",
    "pick-emerald-rule": "oklch(50.8% 0.118 165.612)",
    "pick-emerald-ink": "oklch(43.2% 0.095 166.913)",
  },
};

/** The role's CSS value in a mode (a hex or an `oklch(...)` string). */
export function tokenCss(role: TokenRole, mode: ThemeMode): string {
  return TOKENS[mode][role];
}

/** The role's colour in a mode as `#rrggbb`, for contrast arithmetic. */
export function tokenHex(role: TokenRole, mode: ThemeMode): string {
  return cssColorToHex(TOKENS[mode][role]);
}

/** Shorthand for the surface a piece of livery text is measured against. */
export function surfaceHex(surface: SurfaceRole, mode: ThemeMode): string {
  return tokenHex(surface, mode);
}

/**
 * `#rgb`, `#rrggbb` or `oklch(L% C H)` to `#rrggbb` (sRGB, clipped). Covers
 * the opaque notations theme.css uses; anything else throws (a translucent
 * `color-mix(...)` role such as `panel` or `wash-*` has no colour of its own
 * until it sits on something), so a new notation cannot slip into the
 * mirror unconverted.
 */
export function cssColorToHex(value: string): string {
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (!ok) throw new Error(`tokens: cannot convert colour "${value}"`);
  const L = Number(ok[1]) / 100;
  const C = Number(ok[2]);
  const h = (Number(ok[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channel = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${linear.map(channel).join("")}`;
}

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
