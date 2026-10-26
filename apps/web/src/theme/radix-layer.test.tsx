/**
 * NEO-364 — Radix Themes' stylesheet lives in a cascade layer under
 * Tailwind's utilities.
 *
 * Imported unlayered (as it was, from src/main.tsx), Radix outranked every
 * Tailwind class on a Radix element: `.rt-reset:where(button)` sets
 * `all: unset`, so `min-h-11`, `w-9`, `flex-1` or `absolute` on a NeonButton
 * computed to nothing and only the `!` suffix got through. app/globals.css now
 * declares `@layer theme, base, radix, components, utilities;` and imports
 * Radix `layer(radix)`: above preflight (Radix keeps its padding over
 * `* { padding: 0 }`), below utilities (a class on a Radix element wins).
 *
 * These tests compile the real globals.css with Tailwind's own compiler and
 * read the layer order it emits. happy-dom does not resolve cascade layers,
 * so what a browser finally computes is proven by measurement (getComputedStyle
 * on the demo screens) and the E2E suite, not here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import NeonButton from "@/components/modules/NeonButton";

const root = join(__dirname, "../..");
const globalsCss = readFileSync(join(root, "app/globals.css"), "utf8");

const STYLESHEETS: Record<string, string> = {
  tailwindcss: join(root, "node_modules/tailwindcss/index.css"),
  "@radix-ui/themes/styles.css": join(root, "node_modules/@radix-ui/themes/styles.css"),
  "./theme.css": join(root, "app/theme.css"),
};

/** globals.css as the browser gets it, minus `@config` (the JS config holds no colours or layers). */
async function compileGlobals(candidates: string[]): Promise<string> {
  const source = globalsCss.replace(/^@config .*$/m, "");
  const compiler = await compile(source, {
    base: join(root, "app"),
    loadStylesheet: async (id: string) => {
      const path = STYLESHEETS[id];
      if (!path) throw new Error(`unexpected @import ${id}`);
      return { path, content: readFileSync(path, "utf8"), base: join(path, "..") };
    },
  });
  return compiler.build(candidates);
}

/** The source with comments removed, so a commented-out line never passes. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("Radix Themes sits in a cascade layer under Tailwind's utilities", () => {
  it("globals.css names the layer order before any import, radix between base and components", () => {
    const statements = stripComments(globalsCss)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(statements[0]).toBe("@layer theme, base, radix, components, utilities;");
    expect(statements[1]).toBe('@import "tailwindcss";');
    expect(statements).toContain('@import "@radix-ui/themes/styles.css" layer(radix);');
  });

  it("the compiled stylesheet ranks the layers theme < base < radix < components < utilities", async () => {
    const css = await compileGlobals(["min-h-11"]);
    // A layer's rank is fixed where its name first appears, statement or block.
    const firstSeen = (name: string) => {
      const match = new RegExp(`@layer\\s+(?:[\\w-]+\\s*,\\s*)*${name}\\b`).exec(css);
      expect(match, `layer ${name} never appears`).not.toBeNull();
      return match!.index;
    };
    const order = ["theme", "base", "radix", "components", "utilities"].map(firstSeen);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The statement itself survives compilation, ahead of Tailwind's own.
    expect(css.indexOf("@layer theme, base, radix, components, utilities;")).toBeGreaterThanOrEqual(0);
  });

  it("Radix's button reset lands inside the radix layer, never unlayered", async () => {
    const css = await compileGlobals([]);
    const radixStart = css.indexOf("@layer radix {");
    expect(radixStart).toBeGreaterThan(-1);
    // Walk the radix block to its closing brace.
    let depth = 0;
    let end = radixStart;
    for (let i = css.indexOf("{", radixStart); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const resets = [...css.matchAll(/\.rt-reset:where\(/g)].map((m) => m.index!);
    expect(resets.length).toBeGreaterThan(0);
    for (const at of resets) {
      expect(at).toBeGreaterThan(radixStart);
      expect(at).toBeLessThan(end);
    }
  });

  it("no source file imports Radix's stylesheet from JS (that would load it unlayered)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".") || name.startsWith("dist")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|mjs|jsx?)$/.test(name) && !name.endsWith(".test.tsx")) {
          if (/["']@radix-ui\/themes\/[\w-]+\.css["']/.test(readFileSync(path, "utf8"))) {
            offenders.push(relative(root, path));
          }
        }
      }
    };
    for (const dir of ["src", "app", "components", "lib"]) walk(join(root, dir));
    expect(offenders).toEqual([]);
  });
});

describe("NeonButton passes layout classes through to the Radix button", () => {
  it("keeps its own classes and adds the caller's, unchanged", () => {
    render(
      <NeonButton className="min-h-11 w-9 flex-1 absolute">
        Add
      </NeonButton>,
    );
    const button = screen.getByRole("button", { name: "Add" });
    for (const cls of ["rt-Button", "neon-button", "focus-outline", "min-h-11", "w-9", "flex-1", "absolute"]) {
      expect(button.classList).toContain(cls);
    }
  });

  it("the caller's utilities compile into the utilities layer (ranked above radix by the statement)", async () => {
    const css = await compileGlobals(["min-h-11", "w-9"]);
    const utilities = css.indexOf("@layer utilities {");
    expect(utilities).toBeGreaterThan(-1);
    const block = css.slice(utilities, css.indexOf("\n}", utilities));
    expect(block).toContain(".min-h-11");
    expect(block).toContain(".w-9");
  });
});
