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
      for (const bg of ["surface", "raised", "hover", "row", "row-hover", "hover-raised", "list-hover"] as TokenRole[]) {
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

  it("ink reads on a neutral chip and a neutral button", () => {
    for (const fg of ["ink", "ink-2", "ink-3"] as TokenRole[]) {
      for (const bg of ["chip", "chip-strong", "button-neutral", "button-neutral-hover"] as TokenRole[]) {
        expect({ fg, bg, ok: on(fg, bg) >= 4.5 }).toEqual({ fg, bg, ok: true });
      }
    }
  });

  it("the selection line reaches 3:1 on every pick fill and on a row", () => {
    for (const bg of ["row", ...PICK_HUES.map((h) => `pick-${h}` as TokenRole)]) {
      expect({ bg, ok: on("selection-line", bg as TokenRole) >= 3 }).toEqual({ bg, ok: true });
    }
  });

  it("black ink reads on every neon fill", () => {
    for (const fill of ["neon-green", "neon-pink", "neon-blue", "neon-yellow", "neon-orange", "neon-teal", "neon-purple"] as TokenRole[]) {
      expect({ fill, ok: contrastRatio("#000000", tokenHex(fill, "light")) >= 4.5 }).toEqual({ fill, ok: true });
    }
  });
});

const PICK_HUES = ["pink", "blue", "green", "purple", "orange", "teal", "amber", "red", "emerald"] as const;

describe("hued picks and badges, both modes", () => {
  for (const mode of ["dark", "light"] as const) {
    it(`${mode}: each hue's ink reads 4.5:1 on its fill`, () => {
      for (const hue of PICK_HUES) {
        const ratio = contrastRatio(tokenHex(`pick-${hue}-ink`, mode), tokenHex(`pick-${hue}`, mode));
        expect({ hue, ok: ratio >= 4.5 }).toEqual({ hue, ok: true });
      }
    });
  }

  it("light: each hue's edge reaches 3:1 on its fill and on a sheet", () => {
    for (const hue of PICK_HUES) {
      for (const bg of [`pick-${hue}`, "raised"] as TokenRole[]) {
        const ratio = contrastRatio(tokenHex(`pick-${hue}-rule`, "light"), tokenHex(bg, "light"));
        expect({ hue, bg, ok: ratio >= 3 }).toEqual({ hue, bg, ok: true });
      }
    }
  });
});

describe("paper", () => {
  it("is white with black ink in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      expect([TOKENS[mode].paper, TOKENS[mode]["on-paper"]]).toEqual(["#ffffff", "#000000"]);
    }
  });
});
