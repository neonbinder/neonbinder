import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import playwright from "eslint-plugin-playwright";
import themePlugin from "./scripts/eslint/no-raw-palette.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * NEO-44 — raw text inputs must go through the shared primitive.
 *
 * `components/primitives/Input` / `Textarea` carry the app's field styling and
 * behaviour in one place, so every text field looks and acts the same. This
 * rule keeps that true for code written from now on — without it the
 * consistency decays the moment somebody types `<input`.
 *
 * History: the rule was introduced for the retired Maestro web driver, whose
 * `inputText` re-found the focused field by an XPath built from `id` → `class`
 * → position, so two identical raw inputs sent keystrokes to the first one on
 * the page (mobile-dev-inc/maestro#1083). The primitives still add a
 * document-unique marker class from that era (useFieldTestClass); the
 * Playwright suite does not use it.
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
  "Use `<Input bare>` from components/primitives/Input instead of a raw <input>, " +
  "so the field gets the app's shared styling and behaviour. See NEO-44.";

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

/**
 * NEO-259 — jsx-a11y recommended, scoped to JSX files and placed BEFORE the
 * project's own rule blocks so any house rule below still wins on conflict.
 * Rule-level opt-outs live in the block after it, each with its reason.
 */
const jsxA11yRecommended = {
  ...jsxA11y.flatConfigs.recommended,
  files: ["**/*.{jsx,tsx}"],
  // Test harnesses render deliberately-minimal scaffolding (bare clickable
  // divs, raw markup) to isolate the component under test. They are not
  // product UI; auditing them for a11y is noise.
  ignores: ["**/*.test.tsx", "**/*.test.jsx"],
};

/**
 * Per-rule decisions on top of jsx-a11y recommended. Every entry here is a
 * deliberate, documented house pattern — NOT a shortcut. If a rule below is
 * turned off, the components it would have flagged carry their own comments
 * explaining the audited a11y decision; read those before flipping it back on.
 */
const jsxA11yHouseRules = {
  files: ["**/*.{jsx,tsx}"],
  // Flat config resolves `jsx-a11y/*` rule names against the plugins declared
  // in the SAME config object, so re-declare the plugin here.
  plugins: jsxA11y.flatConfigs.recommended.plugins,
  rules: {
    // Field controls are the shared primitives (`<Input bare>` etc. — see
    // NEO-44 above) and the pickers, not raw <input>s, so tell the rule which
    // components count as controls. `depth` covers labels whose text sits in
    // a <span> inside the label (print-run's radio cards). The two files
    // exempted in the block below use a different, documented pattern.
    "jsx-a11y/label-has-associated-control": [
      "error",
      {
        controlComponents: [
          "Input",
          "Textarea",
          "Autocomplete",
          "PlayerAutocomplete",
          "PlayerPicker",
          "TeamPicker",
        ],
        depth: 5,
      },
    ],
    // Escape/Enter/focus-trap handlers live on `role="dialog"` backdrops and on
    // form containers; backdrops close on click with the inner panel calling
    // `stopPropagation()`; list rows are click-to-open with a real button
    // inside for keyboard users. Every one of these is an audited decision and
    // the only rule-compliant edit is to add roles, tabindex or keyboard
    // handlers, which change the focus order and the accessible tree that
    // keyboard users and the E2E suite's role-based locators both depend on.
    // Reviewed per component, never as a blind sweep.
    "jsx-a11y/no-static-element-interactions": "off",
    "jsx-a11y/click-events-have-key-events": "off",
    "jsx-a11y/no-noninteractive-element-interactions": "off",
    // Roving-tabindex radiogroups: the GROUP is intentionally not focusable —
    // focus lands on the checked radio and arrow keys move it (CardPairingModal,
    // NewTeamForm, sync-review-modal). The rule wants a tabIndex on the group,
    // which would add a dead tab stop.
    "jsx-a11y/interactive-supports-focus": "off",
    // Deliberate: the dialogs and inline add/rename forms that mount an input
    // as the primary action focus it on open (EntityColumn's custom-entry
    // keyboard flow depends on it — see the comment there).
    "jsx-a11y/no-autofocus": "off",
    // `<ul role="list">` is the Safari + VoiceOver fix for `list-style: none`
    // stripping list semantics (TitleFixer.tsx). Allow exactly that pairing.
    "jsx-a11y/no-redundant-roles": ["error", { ul: ["list"], ol: ["list"] }],
    // A `role="group"` scroll container is focusable on purpose so a keyboard
    // user can pan an overflowing print preview (print/shipping). Allow the
    // role; everything else non-interactive still may not take a tabIndex.
    "jsx-a11y/no-noninteractive-tabindex": ["error", { roles: ["group"] }],
  },
};

/**
 * The SetSelector card panels render `<label>` as a purely VISUAL caption and
 * put the accessible name on the control's own `aria-label`. They were never
 * associated (`id` + `htmlFor`) because the retired Maestro driver used a
 * field's `id` in place of its aria-label as the selector handle — see the
 * "Variation of" note in CardDetailPanel.tsx. The Playwright suite has no such
 * constraint. The rule-compliant cleanup is to demote those captions to
 * <span>/<div>, a markup change across two files tracked separately (NEO-259
 * report).
 * Until then the rule is off for exactly these files; it stays on everywhere
 * else so new forms are held to it.
 */
const visualCaptionLabels = {
  files: [
    "components/SetSelector/CardDetailPanel.tsx",
    "components/SetSelector/CardChecklist.tsx",
  ],
  plugins: jsxA11y.flatConfigs.recommended.plugins,
  rules: {
    "jsx-a11y/label-has-associated-control": "off",
  },
};

/**
 * NEO-341 — the Playwright E2E suite (apps/web/playwright/**). These are plain
 * `.ts` files, which nothing else here gives a parser, so the block names its
 * own. playwright/GUIDE.md is the authority; the rules below enforce the parts
 * of it a linter can see.
 *
 * Locators (GUIDE hard rule 2): a spec finds things only by what a user
 * perceives — getByRole/getByLabel/getByText and friends. `.locator(...)`
 * takes CSS or XPath, `getByTestId` reads a test-only attribute, and
 * `$`/`$$`/`waitForSelector` are CSS element handles; all are banned.
 *
 * Waits (hard rule 4): no `waitForTimeout`, no `networkidle`. The plugin's own
 * `no-wait-for-timeout` and `no-networkidle` rules are used for these instead
 * of a hand-written selector because they also catch the option forms
 * (`goto(url, { waitUntil: "networkidle" })`), raised to errors.
 *
 * `test` comes from support/fixtures.ts, which extends Playwright's `test` with
 * the worker-scoped env and `signIn`; importing the bare one skips both.
 */
const PLAYWRIGHT_FILES = ["playwright/**/*.ts"];

const playwrightRecommended = {
  ...playwright.configs["flat/recommended"],
  files: PLAYWRIGHT_FILES,
};

const playwrightHouseRules = {
  files: PLAYWRIGHT_FILES,
  languageOptions: {
    parser: tsParser,
    parserOptions: { sourceType: "module" },
  },
  plugins: playwright.configs["flat/recommended"].plugins,
  rules: {
    "no-restricted-properties": [
      "error",
      {
        property: "locator",
        message:
          "Locate by what a user perceives (getByRole/getByLabel/getByText/...), never CSS or XPath. playwright/GUIDE.md hard rule 2.",
      },
      {
        property: "getByTestId",
        message:
          "No data-testid: locate by role, label or text. playwright/GUIDE.md hard rule 2.",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@playwright/test",
            importNames: ["test"],
            message:
              "Import `test` from playwright/support/fixtures.ts (it carries the worker env and signIn).",
          },
        ],
      },
    ],
    "playwright/no-wait-for-timeout": "error",
    "playwright/no-networkidle": "error",
    "playwright/no-element-handle": "error",
    "playwright/no-wait-for-selector": "error",
    "playwright/no-force-option": "error",
    "playwright/no-page-pause": "error",
    "playwright/no-skipped-test": "error",
    // Off: GUIDE rule R2 sanctions a genuine branch (paused vs live
    // marketplace, panel already open or not) provided every branch ends in
    // hard asserts. These two rules flag every `if` and every expect inside
    // one (300+ warnings on the suite at NEO-341) whether or not it is that
    // shape, so they cannot tell a silent fall-through from a correct
    // branch. R2 review is where that judgement lives.
    "playwright/no-conditional-in-test": "off",
    "playwright/no-conditional-expect": "off",
  },
};

/** The one file allowed to import Playwright's own `test`: it extends it. */
const playwrightFixturesFile = {
  files: ["playwright/support/fixtures.ts"],
  rules: {
    "no-restricted-imports": "off",
  },
};

/**
 * NEO-356 — colours are roles (app/theme.css), so light and dark both work.
 * `theme/no-raw-palette` bans palette steps, white/black paint, raw hex and
 * `dark:` in the app's own source; the replacement for each is in
 * src/theme/MIGRATION.md. Its allowlists (PERMANENT: print, physical objects,
 * the forced-dark prototypes; PENDING: not migrated yet) live in
 * scripts/eslint/theme-allowlist.mjs, which the rule reads itself. `.ts` files
 * are in scope because class constants live in them too, so this block gives
 * them the TypeScript parser.
 */
const themeColourRoles = {
  files: ["{app,components,src,lib}/**/*.{ts,tsx}"],
  ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
  },
  plugins: { theme: themePlugin },
  rules: {
    "theme/no-raw-palette": "error",
  },
};

/**
 * `.ts` hooks carry `eslint-disable` comments for react-hooks rules, and
 * themeColourRoles is the first block to lint `.ts` app files, so the plugin
 * has to be known there or those comments error as unknown rules. Registered
 * only (no rules switched on): widening react-hooks to `.ts` is NEO-111's
 * call, not this one.
 */
const reactHooksKnownInTs = {
  files: ["{app,components,src,lib}/**/*.ts"],
  ignores: ["**/*.test.ts", "**/*.d.ts"],
  plugins: { "react-hooks": reactHooks },
  // Those comments target rules this block leaves off; do not report them.
  linterOptions: { reportUnusedDisableDirectives: "off" },
};

const eslintConfig = [
  ...reactHooksLegacyScope,
  playwrightRecommended,
  playwrightHouseRules,
  playwrightFixturesFile,
  jsxA11yRecommended,
  jsxA11yHouseRules,
  visualCaptionLabels,
  themeColourRoles,
  reactHooksKnownInTs,
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
