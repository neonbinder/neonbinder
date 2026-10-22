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
  | "spot";

/** The surfaces a piece of text can sit on. */
export type SurfaceRole = "surface" | "raised" | "raised-deep" | "sheet" | "field" | "hover";

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
 * exactly the notations theme.css uses; anything else throws, so a new
 * notation cannot slip into the mirror unconverted.
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
