/**
 * NEO-356 — tokens.ts mirrors app/theme.css. These cases read the stylesheet
 * and fail on any drift, then hold the light palette to the contrast the
 * ticket promises (text 4.5:1, field and control edges 3:1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  cssColorToHex,
  SURFACE_ROLES,
  TEXT_NEVER_ON,
  tokenHex,
  TOKENS,
  type SurfaceRole,
  type TextRole,
  type TokenRole,
} from "./tokens";

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

describe("NeonButton's fills (NEO-356)", () => {
  // primary, secondary, tertiary and negative: green, blue, violet and pink.
  const FILLS = ["neon-green", "neon-blue", "neon-purple", "neon-pink"] as const;

  for (const [mode, css] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    it(`${mode}: black ink reads 4.5:1 on every button fill`, () => {
      for (const fill of FILLS) {
        const ratio = contrastRatio("#000000", tokenHex(fill, mode));
        expect({ fill, ok: ratio >= 4.5 }).toEqual({ fill, ok: true });
      }
    });

    it(`${mode}: black ink reads 4.5:1 on the violet fill under the pointer`, () => {
      // Opaque in both modes: an 85% fade over the black page drops it to ~3.9:1.
      const hover = cssColorToHex(css["neon-purple-hover"]);
      expect(contrastRatio("#000000", hover)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("violet as text reads 4.5:1 on the page and a card in both modes (the tertiary outline)", () => {
    for (const mode of ["dark", "light"] as const) {
      for (const bg of ["surface", "raised"] as TokenRole[]) {
        const ratio = contrastRatio(tokenHex("neon-purple-text", mode), tokenHex(bg, mode));
        expect({ mode, bg, ok: ratio >= 4.5 }).toEqual({ mode, bg, ok: true });
      }
    }
  });
});

describe("adversarial: every text and ink role, both modes", () => {
  const roles = (re: RegExp) => (Object.keys(TOKENS.dark) as TokenRole[]).filter((r) => re.test(r));
  const TEXT = roles(/(-text|^ink(-[23])?|^notice-.*-ink)$/) as TextRole[];

  for (const mode of ["dark", "light"] as const) {
    // Every surface in both modes. A pair under 4.5:1 must be in TEXT_NEVER_ON
    // (and so is never painted, see the scan below); a listed pair that now
    // passes must come off the list. The table can neither hide a new miss
    // nor go stale.
    it(`${mode}: every *-text and ink role reads 4.5:1 on every surface it may sit on`, () => {
      const misses: string[] = [];
      const stale: string[] = [];
      for (const fg of TEXT) {
        const never = TEXT_NEVER_ON[mode][fg] ?? [];
        for (const bg of SURFACE_ROLES) {
          const ratio = contrastRatio(tokenHex(fg, mode), tokenHex(bg, mode));
          if (ratio < 4.5 && !never.includes(bg)) misses.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
          if (ratio >= 4.5 && never.includes(bg)) stale.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect({ misses, stale }).toEqual({ misses: [], stale: [] });
    });

    it(`${mode}: every pick-*-ink role reads 4.5:1 on its own fill`, () => {
      const misses: string[] = [];
      for (const ink of roles(/^pick-.*-ink$/)) {
        const fill = ink.replace(/-ink$/, "") as TokenRole;
        const ratio = contrastRatio(tokenHex(ink, mode), tokenHex(fill, mode));
        if (ratio < 4.5) misses.push(`${ink} on ${fill}: ${ratio.toFixed(2)}`);
      }
      expect(misses).toEqual([]);
    });
  }

  it("both modes define exactly the same roles", () => {
    expect(Object.keys(TOKENS.light).sort()).toEqual(Object.keys(TOKENS.dark).sort());
  });
});

/**
 * The other half of TEXT_NEVER_ON: no element paints a listed text role on a
 * listed surface. Reads every class string in app/, components/, src/ and
 * lib/ and works out, per state (at rest, and under each variant such as
 * `hover:` or `disabled:`), which text and which surface that element ends up
 * with. It sees one element's own classes; text inherited from an ancestor
 * is out of its reach, so the table's comment is the rule for that case.
 */
describe("no class string paints text on a surface it fails on", () => {
  const webRoot = join(__dirname, "../..");
  const STATE_VARIANTS = new Set(["hover", "focus", "focus-visible", "focus-within", "active", "disabled", "group-hover", "aria-disabled", "aria-selected", "aria-checked", "aria-pressed"]);
  const RESPONSIVE = new Set(["sm", "md", "lg", "xl", "2xl", "max-sm", "max-md", "max-lg"]);
  // Every text role, not just the listed ones: `text-ink-3 hover:text-ink`
  // must read as ink under the pointer.
  const textRoles = new Set<string>((Object.keys(TOKENS.dark) as TokenRole[]).filter((r) => /(-text|^ink(-[23])?|^notice-.*-ink)$/.test(r)));
  const surfaces = new Set<string>(SURFACE_ROLES);

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(join(webRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...sourceFiles(rel));
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(rel);
    }
    return out;
  }

  /** `[state, kind, role]` for each text/bg role token in one class string. */
  function parse(chunk: string) {
    const found: Array<{ state: string; kind: "text" | "bg"; role: string }> = [];
    for (const token of chunk.split(/[\s"'`{}]+/)) {
      const parts = token.split(":");
      const utility = parts.pop()!.replace(/^!/, "").replace(/\/[\w.]+$/, "");
      const variants = parts.filter((v) => !RESPONSIVE.has(v));
      if (variants.length > 1 || (variants.length === 1 && !STATE_VARIANTS.has(variants[0]))) continue;
      const state = variants[0] ?? "";
      const text = /^text-(.+)$/.exec(utility);
      const bg = /^bg-(.+)$/.exec(utility);
      if (text && textRoles.has(text[1])) found.push({ state, kind: "text", role: text[1] });
      if (bg && surfaces.has(bg[1])) found.push({ state, kind: "bg", role: bg[1] });
    }
    return found;
  }

  it("finds none", () => {
    const hits: string[] = [];
    for (const file of ["app", "components", "src", "lib"].flatMap(sourceFiles)) {
      const src = readFileSync(join(webRoot, file), "utf8");
      for (const m of src.matchAll(/"([^"\n]*)"|`([^`]*)`/g)) {
        const tokens = parse(m[1] ?? m[2] ?? "");
        if (!tokens.some((t) => t.kind === "bg") || !tokens.some((t) => t.kind === "text")) continue;
        const states = new Set(["", ...tokens.map((t) => t.state)]);
        for (const state of states) {
          const pick = (kind: "text" | "bg") =>
            tokens.find((t) => t.kind === kind && t.state === state)?.role ??
            tokens.find((t) => t.kind === kind && t.state === "")?.role;
          const fg = pick("text") as TextRole | undefined;
          const bg = pick("bg") as SurfaceRole | undefined;
          if (!fg || !bg) continue;
          for (const mode of ["dark", "light"] as const) {
            if (TEXT_NEVER_ON[mode][fg]?.includes(bg)) {
              hits.push(`${file}: ${state || "rest"} text-${fg} on bg-${bg} (${mode})`);
            }
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("shadow-offset's hairline (Jason, 2026-10-22)", () => {
  const start = themeCss.indexOf("@utility shadow-offset {");
  const utility = themeCss.slice(start, themeCss.indexOf("\n}", start));

  it("draws a 1px inset left and top edge in light, layered with the offset", () => {
    expect(utility).toContain('[data-theme="light"] & {\n    --offset-edge: inset 1px 1px 0 var(--rule-strong);');
    expect(utility).toContain("--tw-shadow: 5px 5px 0 var(--offset-shadow), var(--offset-edge);");
    expect(utility).toContain("--tw-shadow: 5px 5px 0 var(--offset-shadow-complete), var(--offset-edge);");
  });

  it("skips it on a sheet with its own full border", () => {
    expect(utility).toContain('[data-theme="light"] &:is([class~="border"], [class~="border-2"]) {\n    --offset-edge: 0 0 #0000;');
  });

  it("does nothing in dark", () => {
    // Every selector in the utility is scoped to light.
    const selectors = utility.split("\n").filter((l) => /^ {2}\S.*[{,]$/.test(l));
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.filter((l) => !l.includes('[data-theme="light"]'))).toEqual([]);
  });
});
