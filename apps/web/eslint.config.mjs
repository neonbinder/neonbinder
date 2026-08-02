import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * NEO-44 — raw text inputs must go through the shared primitive.
 *
 * maestro-web's `inputText` does not type into the field it tapped: it reads
 * `document.activeElement`, re-derives an XPath from it (unique `id` → `class` →
 * positional), then sends keys to whatever that XPath resolves to. Two inputs
 * with no `id` and the same Tailwind `className` produce a non-unique XPath, so
 * Selenium types into the FIRST one on the page. That produced a long tail of
 * "is it a product bug or a test bug?" E2E failures; upstream
 * (mobile-dev-inc/maestro#1083) closed it as not-planned, so the fix lives here.
 *
 * `components/primitives/Input` applies a document-unique marker class
 * internally, so anything rendered through it is immune with no per-call work.
 * This rule is what keeps that true for code written from now on — without it
 * the fix decays the moment somebody types `<input`.
 *
 * Scope: only text-ish inputs. Checkboxes, radios, file and colour pickers are
 * genuinely different controls (some have their own primitives) and are left
 * alone. The selector allows an `<input>` whose literal `type` is one of those,
 * and flags everything else — including an input with a computed `type={...}`,
 * which cannot be shown to be non-text at lint time and should use the
 * primitive anyway (it forwards `type` through).
 */
const NON_TEXT_INPUT_TYPES = [
  "checkbox",
  "radio",
  "file",
  "color",
  "range",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
];

const rawInputSelector = `JSXOpeningElement[name.name="input"]:not(:has(JSXAttribute[name.name="type"][value.value=/^(${NON_TEXT_INPUT_TYPES.join("|")})$/]))`;

const RAW_FIELD_MESSAGE =
  "Use `<Input bare>` from components/primitives/Input instead of a raw <input>. " +
  "It applies the document-unique class maestro-web's inputText needs to target " +
  "the right field, plus the app's field styling. See NEO-44.";

const RAW_TEXTAREA_MESSAGE =
  "Use `<Textarea bare>` from components/primitives/Textarea instead of a raw " +
  "<textarea> — same reason as <input>. See NEO-44.";

/**
 * Pinned to the file types this actually linted before NEO-44b.
 *
 * Flat config only visits `.js`/`.mjs`/`.cjs` unless some config block names
 * other extensions in `files`. Nothing did, so despite being configured, these
 * rules had never run against a single `.tsx` file — `npm run lint` was
 * effectively a no-op for every component in the app.
 *
 * The block below brings `.tsx` into scope for the raw-input rule, which would
 * incidentally switch these on for the whole codebase too: ~53 errors, led by
 * `react-hooks/set-state-in-effect` (25) and `react-hooks/refs` (21). That
 * first rule is the NEO-39 reactive-form bug family — it flags
 * PublicProfileEditor's hydration effect, the exact defect NEO-41 fixed by
 * hand — so these need judgement, not a blind sweep inside a lint-rule PR.
 *
 * Tracked in NEO-111. Widening this back to `.tsx` is step one of that work.
 */
const reactHooksLegacyScope = compat
  .extends("plugin:react-hooks/recommended")
  .map((config) => ({ ...config, files: ["**/*.{js,mjs,cjs,jsx,tsx}"] }));

const eslintConfig = [
  ...reactHooksLegacyScope,
  {
    ignores: ["dist/", "convex/_generated/"],
  },
  // Parser for EVERY .tsx path, including the primitives and tests. It has to be
  // unscoped: react-hooks now covers .tsx, and any file it visits without a
  // parser fails as a syntax error rather than being skipped.
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
  },
  {
    files: ["**/*.tsx"],
    // The primitives are where the real elements live, and tests assert on raw
    // markup on purpose (e.g. EntityColumn.field-class.test.tsx renders a bare
    // <input> to prove the class collision the primitive fixes). Only the
    // raw-input rule is scoped away from them — the parser above is not.
    ignores: ["components/primitives/**", "**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: rawInputSelector, message: RAW_FIELD_MESSAGE },
        {
          selector: 'JSXOpeningElement[name.name="textarea"]',
          message: RAW_TEXTAREA_MESSAGE,
        },
      ],
    },
  },
];

export default eslintConfig;
