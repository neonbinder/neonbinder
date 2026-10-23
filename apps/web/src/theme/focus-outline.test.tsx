/**
 * NEO-356 — the focus outline draws on `:focus-visible` only.
 *
 * `focus-outline` is the one focus style the app uses (DESIGN.md, Signature
 * utilities). A mouse click must not leave a ring on a button, so it may only
 * ever match `:focus-visible`, never plain `:focus` or `:focus-within`. The
 * same goes for the primitives whose real input is visually hidden (Switch,
 * RadioButton): their track draws the outline through a `peer-focus-visible`
 * variant.
 *
 * happy-dom does not evaluate `:focus-visible`, so this compiles the real
 * stylesheet with Tailwind's own compiler and reads the rules it emits: what
 * is tested is the CSS the browser gets, not the source's spelling of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
const themeCss = readFileSync(join(root, "app/theme.css"), "utf8");

async function build(candidates: string[]): Promise<string> {
  const compiler = await compile(`@tailwind utilities;\n${themeCss}`, {
    base: root,
    loadStylesheet: async (id: string) => ({ path: id, content: "", base: root }),
  });
  return compiler.build(candidates);
}

/** Every `selector { body }` rule in flat CSS whose selector mentions `needle`. */
function rulesFor(css: string, needle: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.includes(needle)) rules.push({ selector, body: m[2].trim() });
  }
  return rules;
}

describe("focus-outline", () => {
  it("draws a 2px focus-colour outline, 2px clear, on :focus-visible", async () => {
    const rules = rulesFor(await build(["focus-outline"]), ".focus-outline");
    expect(rules.map((r) => r.selector)).toEqual([".focus-outline:focus-visible"]);
    expect(rules[0].body).toContain("outline: 2px solid var(--focus)");
    expect(rules[0].body).toContain("outline-offset: 2px");
  });

  it("has no rule on plain :focus, :focus-within or at rest", async () => {
    const rules = rulesFor(await build(["focus-outline"]), ".focus-outline");
    for (const { selector } of rules) {
      expect(selector).toMatch(/:focus-visible$/);
      expect(selector).not.toMatch(/:focus(?!-visible)/);
    }
  });
});

describe("a visually hidden input's focus (Switch, RadioButton)", () => {
  const SOURCES = ["components/primitives/Switch.tsx", "components/primitives/RadioButton.tsx"];
  const PEER_CLASSES = [
    "peer-focus-visible:outline-2",
    "peer-focus-visible:outline-offset-2",
    "peer-focus-visible:outline-focus",
  ];

  it.each(SOURCES)("%s marks its input as the peer and outlines the track from it", (file) => {
    const src = readFileSync(join(root, file), "utf8");
    expect(src).toMatch(/className="peer sr-only"/);
    for (const cls of PEER_CLASSES) expect(src).toContain(cls);
    expect(src).not.toMatch(/peer-focus:/);
  });

  it("the peer variants compile to :focus-visible on the peer only", async () => {
    const css = await build(PEER_CLASSES);
    const rules = rulesFor(css, "peer-focus-visible");
    expect(rules).toHaveLength(PEER_CLASSES.length);
    for (const { selector } of rules) {
      expect(selector).toContain(":where(.peer):focus-visible ~ *");
      expect(selector).not.toMatch(/:focus(?!-visible)/);
    }
    expect(rules.map((r) => r.body).join("\n")).toContain("outline-color: var(--focus)");
  });
});
