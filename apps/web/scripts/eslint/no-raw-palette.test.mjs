/**
 * NEO-356 — theme/no-raw-palette: what it bans, what it lets through, and
 * that the allowlists switch it off per file.
 */
import path from "node:path";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import { findPaletteViolations, splitVariants, themePlugin, WEB_ROOT } from "./no-raw-palette.mjs";
import { PENDING } from "./theme-allowlist.mjs";

const tokens = (text) => findPaletteViolations(text).map((v) => v.token);

describe("findPaletteViolations", () => {
  it("bans gray/slate steps on every colour utility, with or without variants", () => {
    expect(
      tokens(
        "bg-gray-900 text-slate-400 border-t-slate-700 hover:bg-gray-800 placeholder:text-slate-400 ring-gray-500/50 md:hover:divide-zinc-700 -from-neutral-800",
      ),
    ).toEqual([
      "bg-gray-900",
      "text-slate-400",
      "border-t-slate-700",
      "hover:bg-gray-800",
      "placeholder:text-slate-400",
      "ring-gray-500/50",
      "md:hover:divide-zinc-700",
      "-from-neutral-800",
    ]);
  });

  it("bans white and black as paint, not as depth", () => {
    expect(tokens("text-white bg-black/60 border-white hover:text-black")).toEqual([
      "text-white",
      "bg-black/60",
      "border-white",
      "hover:text-black",
    ]);
    expect(tokens("shadow-black/40 from-black/70 to-transparent")).toEqual([]);
  });

  it("bans raw hex in arbitrary values", () => {
    expect(tokens("ring-[#00C2FF] hover:bg-[#33e07c] text-[color:#fff]")).toEqual([
      "ring-[#00C2FF]",
      "hover:bg-[#33e07c]",
      "text-[color:#fff]",
    ]);
  });

  it("bans the dark: variant anywhere in the chain", () => {
    expect(tokens("dark:bg-raised md:dark:text-ink")).toEqual(["dark:bg-raised", "md:dark:text-ink"]);
  });

  it("lets roles, neon and ordinary hues through", () => {
    expect(
      tokens(
        "bg-surface bg-raised/80 text-ink-2 border-rule text-neon-pink-text bg-neon-green text-on-neon-green ring-selection focus-outline bg-red-600 text-amber-300 shadow-offset w-[170px] grid-cols-[1fr_2fr]",
      ),
    ).toEqual([]);
  });

  it("does not split on colons inside brackets", () => {
    expect(splitVariants("[&:hover]:bg-gray-800")).toEqual({ variants: ["[&:hover]"], utility: "bg-gray-800" });
    expect(tokens("[&:hover]:bg-gray-800")).toEqual(["[&:hover]:bg-gray-800"]);
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
const pending = path.join(WEB_ROOT, PENDING[0]);
const permanent = path.join(WEB_ROOT, "lib/print/a-new-label.ts");

tester.run("theme/no-raw-palette", themePlugin.rules["no-raw-palette"], {
  valid: [
    { filename: fresh, code: `const a = <div className="bg-raised text-ink-2 border-rule" />;` },
    { filename: fresh, code: "const c = `p-4 ${on ? \"bg-hover\" : \"text-ink-3\"}`;" },
    // Allowlisted files are not checked.
    { filename: pending, code: `const a = <div className="bg-gray-900" />;` },
    { filename: permanent, code: `const ink = "text-black bg-white";` },
    // A forced-dark prototype page.
    { filename: path.join(WEB_ROOT, "app/collection/prototypes/p4/Counter.tsx"), code: `const a = "bg-gray-900";` },
  ],
  invalid: [
    {
      filename: fresh,
      code: `const a = <div className="bg-gray-900 text-white" />;`,
      errors: [{ messageId: "banned" }, { messageId: "banned" }],
    },
    {
      filename: fresh,
      code: "const c = `p-4 ${on ? \"dark:bg-gray-800\" : \"\"} ring-[#00C2FF]`;",
      errors: [{ messageId: "banned" }, { messageId: "banned" }],
    },
    {
      // A prototype module the shipped demo imports is never PERMANENT: once
      // it is off PENDING (types.ts never needed to be on it), it is checked.
      filename: path.join(WEB_ROOT, "app/collection/prototypes/_shared/types.ts"),
      code: `const x = "text-white";`,
      errors: [{ messageId: "banned" }],
    },
  ],
});
