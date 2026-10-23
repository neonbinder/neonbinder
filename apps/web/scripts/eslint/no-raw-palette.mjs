/**
 * NEO-356 — `theme/no-raw-palette`: components paint with colour ROLES
 * (app/theme.css), never with palette steps, raw hex or `dark:`.
 *
 * A palette class (`bg-gray-900`, `text-white`, `ring-[#00C2FF]`) is one fixed
 * colour, so it cannot follow the light/dark mode; `dark:` is how the old
 * bi-themed pairs were written, and their light halves were never maintained.
 * DESIGN.md (Colors) names the role to use instead.
 *
 * Checked: every string literal and template-literal chunk in app/,
 * components/, src/ and lib/ (.ts and .tsx, tests excluded), split into
 * class-like tokens. That covers `className="..."`, class constants in `.ts`
 * files and `${cond ? "a" : "b"}` branches alike.
 *
 * Banned, after any variant prefix (`hover:`, `md:`, `[&>svg]:`...):
 *   - `dark:` as a variant;
 *   - a gray/slate/zinc/neutral/stone STEP on a colour utility (`bg-slate-900`,
 *     `border-t-gray-700`, `placeholder:text-slate-400`, `ring-gray-500/50`);
 *   - `white` / `black` as paint (`text-white`, `bg-black/60`; a black
 *     shadow or gradient stop is depth and is allowed);
 *   - an arbitrary hex (`bg-[#00D558]`, `text-[color:#fff]`).
 *
 * Why a small custom rule and not `no-restricted-syntax`: ESLint replaces a
 * rule's options per matching config block, so a second `no-restricted-syntax`
 * block for the same files would silently drop NEO-44's raw-input selectors.
 *
 * Allowlist (scripts/eslint/theme-allowlist.mjs): PERMANENT, physical
 * objects and print, plus the forced-dark NEO-350 prototypes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPermanent } from "./theme-allowlist.mjs";

/** apps/web, the root every allowlist path is relative to. */
export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const COLOUR_UTILITY =
  "(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|divide(?:-[xy])?|placeholder|outline|fill|stroke|from|via|to|accent|caret|decoration|shadow|inset-shadow|inset-ring)";

// White and black as PAINT. A black drop shadow or a black-to-transparent
// scrim over a photo is depth, not paint, and reads the same in both modes, so
// shadow and gradient stops are left alone here.
const PAINT_UTILITY =
  "(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|divide(?:-[xy])?|placeholder|outline|fill|stroke|accent|caret|decoration)";

const NEUTRAL_STEP = new RegExp(`^-?${COLOUR_UTILITY}-(?:gray|slate|zinc|neutral|stone)-\\d`);
const WHITE_BLACK = new RegExp(`^-?${PAINT_UTILITY}-(?:white|black)(?:\\/[\\w.\\[\\]]+)?$`);
const ARBITRARY_HEX = /-\[(?:color:)?#[0-9a-fA-F]/;

/**
 * Splits a class token into its variants and the utility. Colons inside
 * brackets (`[&:hover]:`, `bg-[color:red]`) do not split.
 */
export function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  return { variants: parts, utility: current.replace(/^!/, "").replace(/!$/, "") };
}

/**
 * The banned tokens in one string, each with the reason. Pure, so the rule,
 * the allowlist generator and the tests share it.
 */
export function findPaletteViolations(text) {
  const found = [];
  for (const token of text.split(/[\s"'`{}]+/)) {
    if (!token) continue;
    const { variants, utility } = splitVariants(token);
    if (variants.includes("dark")) {
      found.push({ token, reason: "`dark:` (a role already follows the mode)" });
    } else if (NEUTRAL_STEP.test(utility)) {
      found.push({ token, reason: "a gray/slate palette step" });
    } else if (WHITE_BLACK.test(utility)) {
      found.push({ token, reason: "white/black" });
    } else if (ARBITRARY_HEX.test(utility)) {
      found.push({ token, reason: "a raw hex" });
    }
  }
  return found;
}

/** Repo-relative (apps/web) path of the file being linted, `/`-separated. */
function relativePath(filename) {
  return path.relative(WEB_ROOT, filename).split(path.sep).join("/");
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Paint with colour roles (app/theme.css), not palette classes, raw hex or dark:",
    },
    schema: [],
    messages: {
      banned:
        "`{{token}}` is {{reason}}, which cannot follow light/dark mode. Use a colour role (bg-surface, bg-raised, text-ink-2, border-rule, text-neon-pink-text, ...); DESIGN.md lists them.",
    },
  },
  create(context) {
    const rel = relativePath(context.filename ?? context.getFilename());
    if (isPermanent(rel)) return {};
    const check = (node, text) => {
      for (const { token, reason } of findPaletteViolations(text)) {
        context.report({ node, messageId: "banned", data: { token, reason } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export const themePlugin = { rules: { "no-raw-palette": rule } };
export default themePlugin;
