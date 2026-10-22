/**
 * NEO-356 — tokens.ts mirrors app/theme.css. These cases read the stylesheet
 * and fail on any drift, then hold the light palette to the contrast the
 * ticket promises (text 4.5:1, field and control edges 3:1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, cssColorToHex, tokenHex, TOKENS, type TokenRole } from "./tokens";

// Read from disk: vitest stubs CSS imports (even `?raw`) to an empty string.
const themeCss = readFileSync(join(__dirname, "../../app/theme.css"), "utf8");

/** The custom properties declared directly in the first block whose selector starts with `head`. */
function block(head: string): Record<string, string> {
  const start = themeCss.indexOf(head);
  if (start < 0) throw new Error(`theme.css has no block "${head}"`);
  const open = themeCss.indexOf("{", start);
  const close = themeCss.indexOf("\n}", open);
  const body = themeCss
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const dark = block(':root,\n[data-theme="dark"]');
const light = { ...dark, ...block('[data-theme="light"] {') };

describe("tokens.ts mirrors app/theme.css", () => {
  for (const [mode, css] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    it(`every ${mode} role matches the stylesheet`, () => {
      for (const [role, value] of Object.entries(TOKENS[mode])) {
        expect({ role, value: css[role] }).toEqual({ role, value });
      }
    });
  }

  it("every role a component can paint with has a Tailwind colour", () => {
    for (const role of Object.keys(TOKENS.dark)) {
      expect(themeCss).toContain(`--color-${role}: var(--${role});`);
    }
  });
});

describe("cssColorToHex", () => {
  it("converts the notations theme.css uses", () => {
    expect(cssColorToHex("#ABC")).toBe("#aabbcc");
    expect(cssColorToHex("#00D558")).toBe("#00d558");
    // Tailwind's own hex for these steps.
    expect(cssColorToHex("oklch(27.8% 0.033 256.848)")).toBe("#1e2939"); // gray-800
    expect(cssColorToHex("oklch(20.8% 0.042 265.755)")).toBe("#0f172b"); // slate-900
  });

  it("refuses anything else rather than guess", () => {
    expect(() => cssColorToHex("rebeccapurple")).toThrow();
  });
});

describe("light palette contrast (NEO-356 spec)", () => {
  const on = (fg: TokenRole, bg: TokenRole) => contrastRatio(tokenHex(fg, "light"), tokenHex(bg, "light"));
  const textRoles: TokenRole[] = [
    "ink",
    "ink-2",
    "ink-3",
    "neon-green-text",
    "neon-pink-text",
    "neon-blue-text",
    "neon-yellow-text",
    "neon-orange-text",
    "neon-teal-text",
    "neon-purple-text",
  ];

  it("text roles reach 4.5:1 on the page, a sheet and a hovered row", () => {
    for (const fg of textRoles) {
      for (const bg of ["surface", "raised", "hover"] as TokenRole[]) {
        expect({ fg, bg, ok: on(fg, bg) >= 4.5 }).toEqual({ fg, bg, ok: true });
      }
    }
  });

  it("field and control edges, focus and the selection line reach 3:1", () => {
    for (const fg of ["field-rule", "control", "focus", "selection", "pip-owned", "pip-want", "spot"] as TokenRole[]) {
      for (const bg of ["surface", "raised"] as TokenRole[]) {
        expect({ fg, bg, ok: on(fg, bg) >= 3 }).toEqual({ fg, bg, ok: true });
      }
    }
  });

  it("black ink reads on every neon fill", () => {
    for (const fill of ["neon-green", "neon-pink", "neon-blue", "neon-yellow", "neon-orange", "neon-teal", "neon-purple"] as TokenRole[]) {
      expect({ fill, ok: contrastRatio("#000000", tokenHex(fill, "light")) >= 4.5 }).toEqual({ fill, ok: true });
    }
  });
});
