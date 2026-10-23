/**
 * NEO-356 — theme/neon-button-only: a neon-filled raw <button> is refused,
 * everything that is not an action button's fill is let through.
 */
import path from "node:path";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import rule, { findNeonFills } from "./neon-button-only.mjs";
import { WEB_ROOT } from "./no-raw-palette.mjs";

describe("findNeonFills", () => {
  it("finds a bare neon fill and its hover role, for any hue", () => {
    expect(findNeonFills("px-3 bg-neon-green text-on-neon-green")).toEqual(["bg-neon-green"]);
    expect(findNeonFills("bg-neon-purple-hover bg-neon-orange")).toEqual(["bg-neon-purple-hover", "bg-neon-orange"]);
  });

  it("ignores a variant-gated fill, a wash, text and edges", () => {
    expect(
      findNeonFills(
        "hover:bg-neon-pink focus:bg-neon-pink aria-pressed:bg-neon-green bg-neon-pink/10 text-neon-pink-text border-neon-blue text-on-neon-green",
      ),
    ).toEqual([]);
  });
});

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
  },
});

const fresh = path.join(WEB_ROOT, "components/modules/a-new-file.tsx");

tester.run("theme/neon-button-only", rule, {
  valid: [
    // NeonButton itself, and anything that is not a raw <button>.
    { filename: fresh, code: `const a = <NeonButton variant="negative">Cancel</NeonButton>;` },
    { filename: fresh, code: `const a = <span className="bg-neon-green text-on-neon-green">New</span>;` },
    // A raw button with no neon fill: a quiet link, an outline, a hover fill.
    { filename: fresh, code: `const a = <button className="text-ink-3 hover:text-neon-pink-text">Remove</button>;` },
    { filename: fresh, code: `const a = <button className="border border-control hover:border-neon-blue">Back</button>;` },
    { filename: fresh, code: `const a = <button className="hover:bg-neon-pink hover:text-on-neon-pink">×</button>;` },
    { filename: fresh, code: `const a = <button className="bg-neon-pink/10 text-neon-pink-text">Clear</button>;` },
    // A lit selected state behind a condition: a chip, not a button colour.
    { filename: fresh, code: "const a = <button className={`px-2 ${on ? \"bg-neon-green\" : \"bg-chip\"}`}>All</button>;" },
    // Toggles and choices declare themselves.
    { filename: fresh, code: `const a = <button aria-pressed={on} className="bg-neon-green">Owned</button>;` },
    { filename: fresh, code: `const a = <button role="tab" className="bg-neon-blue">Cards</button>;` },
    // The one place a button's colour is decided, and the frozen prototypes.
    {
      filename: path.join(WEB_ROOT, "components/modules/NeonButton.tsx"),
      code: `const a = <button className="bg-neon-green">Go</button>;`,
    },
    {
      filename: path.join(WEB_ROOT, "app/collection/prototypes/p2/PackTray.tsx"),
      code: `const a = <button className="bg-neon-green">Go</button>;`,
    },
  ],
  invalid: [
    {
      filename: fresh,
      code: `const a = <button className="rounded-md bg-neon-green px-3 text-on-neon-green">Save</button>;`,
      errors: [{ messageId: "neonFill", data: { token: "bg-neon-green" } }],
    },
    {
      filename: fresh,
      code: "const a = <button className={`${ACT} bg-neon-blue hover:bg-neon-blue-hover`}>Preview</button>;",
      errors: [{ messageId: "neonFill" }],
    },
    {
      filename: fresh,
      code: `const a = <button className={cn("bg-neon-pink", big && "px-8")}>Delete</button>;`,
      errors: [{ messageId: "neonFill" }],
    },
    {
      // A module constant holding the fill.
      filename: fresh,
      code: `const PRIMARY = "min-h-9 bg-neon-purple text-on-neon-purple";\nconst a = <button className={PRIMARY}>Go</button>;`,
      errors: [{ messageId: "neonFill" }],
    },
    {
      filename: fresh,
      code: `const a = <button className={"px-3 " + "bg-neon-yellow"}>Go</button>;`,
      errors: [{ messageId: "neonFill" }],
    },
  ],
});
