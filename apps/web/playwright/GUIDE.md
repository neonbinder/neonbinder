# Idiomatic Playwright suite: authoring guide (NEO-338 bake-off)

This suite answers one question: how fast is the NeonBinder web E2E suite
when it is written the way an experienced Playwright engineer writes tests?
`apps/web/playwright/` already holds a line-by-line port onto a
Maestro-shaped driver; this is the other arm of the comparison.

The Maestro flows under `apps/web/.maestro/flows/` are the **specification**:
every test case, every assertion and every branch they cover must be covered
here. They are **not a script**. Do not translate step by step, do not
reproduce driver workarounds, and never import `playwright/support/maestro.ts`.

Read first: `apps/web/.maestro/README.md` (rules R1-R10, budgets), then the
pilots in this directory, which show every pattern below:

| Pilot | Shows |
|---|---|
| `tests/setup.spec.ts` | the seed: dialogs, app-state branches, a bounded loop, paused-SportLots branches |
| `tests/profile/worker-bootstrap.spec.ts` | the `bootstrap` project; an `optional: true` sub-flow |
| `tests/home/landing-smoke.spec.ts` | signed-out page, `scrollUntilVisible` that IS the assertion |
| `tests/set-selector/admin-missing-both-shows-warning.spec.ts` | dedicated `account=`, role-scoped asserts, `toBeHidden` |
| `tests/set-selector/topps-chrome-add-feature.spec.ts` | the drill helper, a genuine "is it open?" branch, asserting state Maestro could not see |
| `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` | entity-review wizard, minted names, `copyTextFrom` |
| `tests/labels/scan-visibility.spec.ts` | scoping to one list item; hidden-then-shown text |
| `tests/admin/player-live-wikidata-enrichment.spec.ts` | a link whose name carries sr-only text; a sanctioned long wait |

## Hard rules

1. **No product changes.** Only `apps/web/playwright/**` changes.
   If the product is wrong, assert the CORRECT behaviour (the test goes red)
   and report it; never weaken the test to pass.
2. **Locate only by what a user perceives:** `getByRole` (with `name`),
   `getByLabel`, `getByPlaceholder`, `getByText`, `getByTitle`,
   `getByAltText`. **Never** CSS, XPath, DOM ids, classes, `data-testid`,
   `page.locator("...")` or `nth-child`. Chaining and filtering are
   encouraged: `dialog.getByRole("button", { name: "Save" })`,
   `.filter({ hasText })`, `.filter({ has: page.getByText(x, { exact: true }) })`,
   `.or()`. `.first()` / `.nth()` only where the flow means "any one of
   these" (e.g. "a card number is shown").
3. **Budgets are UX budgets.** The config gives every action and `expect` 7 s.
   A step for which the YAML states a longer `timeout:` (a live marketplace
   round trip, the 45 s launch gate, the seed's cold syncs) passes **that same
   number** on that one call: `toBeVisible({ timeout: 60_000 })`. Never
   invent a number, never raise one because a run was slow.
4. **No sleeps, no settle waits.** No `waitForTimeout`, no
   `waitForLoadState("networkidle")`, no polling loops around `isVisible`.
   Use web-first assertions (`toBeVisible`, `toBeHidden`, `toHaveText`,
   `toHaveValue`, `toHaveAttribute`, `toHaveCount`, `toBeInViewport`) and let
   actions auto-wait.
5. **`retries: 0`, one worker per shard.** Each shard owns one test account
   (`TEST_EMAIL_<WORKER_INDEX>`). Tests must not depend on order.
6. **Never** `git add -A`, never `git stash`; do not commit. The repo is
   public: no secrets, account ids or internal URLs in any file.

## Files, names, tags (results join 1:1 with Maestro's)

| Maestro | Here |
|---|---|
| `.maestro/flows/<dir>/<flow>.yaml` | `tests/<dir>/<flow>.spec.ts`, exactly one `test()` |
| `name: "..."` | the `test()` title, **verbatim**, copy-pasted (keep `${...}` literally) |
| `tags: [smoke, set-selector]` | `{ tag: ["@smoke", "@set-selector"] }` |
| a `util`-tagged flow | a plain async function in `support/`, never a spec |

First line of every spec: `// Origin: .maestro/flows/<dir>/<flow>.yaml (Maestro suite retired in NEO-341; see git history)`.
Import `test`/`expect` from `support/fixtures` (never `@playwright/test`).

```ts
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet } from "../../support/set-builder";

test("<flow name verbatim>", { tag: ["@set-selector"] }, async ({ page, signIn, env }) => {
  await signIn("/set-selector");
  await expect(page.getByText("Build set parameters using marketplace APIs")).toBeVisible({ timeout: LAUNCH_GATE });
  await drillToSet(page, env);
  // ...
});
```

## Support (use these, keep the set small)

- `support/fixtures.ts`: `test` with `env` (`WORKER_INDEX`, `ATTEMPT_ID`,
  `ATTEMPT_TOKEN`, `TEST_USERNAME`, `PAUSED_PLATFORMS`, `SL_PAUSED`) and
  `signIn(redirect, { account? })`, which opens
  `/testing/sign-in?redirect=<redirect>[&account=<a>]&worker=<n>` exactly as
  the flow's `url:` spells it (nested `?` and `%26` included). `LAUNCH_GATE`
  (45 s).
- `support/credentials.ts`: `loginToBsc(page)`, `loginToSportLots(page, env)`
  (`util-login-to-*`).
- `support/set-builder.ts`: the cascade. `setBuilderReady`, `columnHeading`,
  `columnSearch`, `columnOption`, `columnSelection`, `pick(page, column,
  name)`, `addCustomManufacturer`, `syncChecklistButton`, and the drill utils
  `drillToSet` (util-drill-to-2024-topps-chrome), `drillToBaseVariant`
  (util-drill-to-base-variant), `drillToColdManufacturer`
  (util-drill-to-cold-real-set). Env overrides become an options object:
  `drillToSet(page, env, { set: "Topps Big League" })`.

A util flow used by several specs gets ONE helper, written by whichever agent
the coordinator assigns; others wait or inline temporarily. Read the util's
YAML as its spec. Name helpers for what they do, not for the YAML file.

## Mapping Maestro concepts

| Maestro | Idiomatic Playwright |
|---|---|
| `url: .../testing/sign-in?redirect=/x&worker=...` + `launchApp` | `await signIn("/x")`, then the destination gate |
| `...&account=admin-no-credentials&...` | `await signIn("/x", { account: "admin-no-credentials" })` |
| signed-out `url: ${APP_URL}` / `launchApp: { clearState: true }` | `await page.goto("/")` (every test has a fresh context) |
| `openLink: ${APP_URL}/path` | `await page.goto("/path")` |
| post-launch `extendedWaitUntil` (45000) | `await expect(<destination marker>).toBeVisible({ timeout: LAUNCH_GATE })` |
| `tapOn: X` | `await <locator>.click()` |
| `tapOn` on a native `<select>` then its option | `await page.getByLabel("Sport").selectOption("Baseball")` |
| `inputText` after a `tapOn` on a field | `await field.fill("text")` (one call; drop the preceding tap) |
| `eraseText` then `inputText` | `await field.fill("new")` (fill replaces); `eraseText` alone → `await field.clear()` |
| `pressKey: Enter` on a field | `await field.press("Enter")` |
| `assertVisible: X` | `await expect(x).toBeVisible()` |
| `assertNotVisible: X` | `await expect(x).toBeHidden()`, paired with a positive assert nearby (a negative passes on a dead page) |
| `extendedWaitUntil: { visible/notVisible, timeout: T }` | the same assertion with `{ timeout: T }` |
| `scrollUntilVisible` before a tap | nothing: `click()` scrolls into view itself |
| `scrollUntilVisible` that is the assertion ("it is on the page") | `await expect(x).toBeVisible()`; only when the point is that the user can REACH it on screen (landing CTA), `await x.scrollIntoViewIfNeeded(); await expect(x).toBeInViewport()` |
| `centerElement`, `visibilityPercentage`, `waitToSettleTimeoutMs`, `retryTapIfNoChange`, `swipe` used to move the page | drop (driver workarounds) |
| `retry: { maxRetries: 1, commands: [tap, wait] }` (re-tap a dropped tap) | drop the retry: one `click()` then the assert |
| `runFlow: { when: { true: "${output.SL_PAUSED}" } }` | `if (env.SL_PAUSED) { ... } else { ... }` (both branches end in hard asserts, R2) |
| `runFlow: { when: { visible: X } }` that branches on **app state** | first wait until the app has settled into ONE of the states, then branch for free: `await expect(a.or(b)).toBeVisible(); if (await a.isVisible()) {...}` |
| `runFlow: { when: { visible/notVisible: X } }` that only papers over timing | drop the branch: just assert the end state |
| `runFlow: { file: util-x.yaml, optional: true }` | `await helper(page).catch((e) => console.warn(...))` |
| `repeat: { times: N, while: ..., commands }` | a bounded `for` loop that waits for the next state with an `.or()` and `break`s on the exit state |
| `copyTextFrom: X` then `maestro.copiedText` | `const text = await x.textContent()` (or `innerText()`), then plain TS |
| `assertTrue: ${cond}` | `expect(value).toBe(...)`, or better a web-first assert on the element itself |
| `evalScript: output.X = ...` | a `const` |
| `${ATTEMPT_ID}` / `output.ATTEMPT_TOKEN` | `env.ATTEMPT_ID` / `env.ATTEMPT_TOKEN` (never rebuild a token by hand) |
| `takeScreenshot` | drop (screenshot on failure is configured) |

### Translating a Maestro selector

Maestro patterns are **full-match, case-insensitive regexes**; `id:` is the
accessible name (aria-label). Playwright's string `name`/`text` matching is a
**case-insensitive SUBSTRING** unless `exact: true`. So:

| Maestro | Playwright |
|---|---|
| `"Sign In"` on a button | `page.getByRole("button", { name: "Sign In" })` (add `exact: true` if another name contains it) |
| `".*Saved Reprint.*"` | `page.getByText(/Saved Reprint/)` |
| `"0 matches"` (exact text) | `page.getByText("0 matches", { exact: true })` |
| `id: "Create player ${NAME}"` | `page.getByRole("button", { name: \`Create player ${name}\` })` |
| `id: "BSC base candidate: .*"` | `dialog.getByRole("option", { name: /^BSC base candidate: / }).first()` |
| `text: X, below: { id: "Search years" }` | scope instead of geometry: `page.getByRole("listbox", { name: "Years" }).getByRole("option")...` |
| `text: X, above: / below: { text: Y }` | find the container both live in (dialog, region, list item, row) and scope to it |
| `childOf` / `containsChild` | `parent.getBy...()` / `.filter({ has })` |

Watch the substring trap with names that prefix others: `"Select All-America
Game Autos"` also matches `"Select All-America Game Autos Red Ink"`; use
`exact: true` (strict mode will tell you, loudly).

**Find the role and name before writing a locator.** Run the spec once and
read `error-context.md` (an ARIA snapshot of the page) in the failure output,
or call `await page.getByRole("main").ariaSnapshot()` in a scratch run. Do
not guess from the YAML: the YAML says what Maestro could see, which is
often less than (and sometimes different from) the accessible tree.

Text Maestro saw that a user cannot: `hidden` content, `sr-only` text inside
a name, collapsed `<details>`. Playwright's visibility is the user's, so the
idiomatic test is often MORE correct than the flow:
- `labels/scan-visibility`: the collapsed scan list is `hidden`, so
  `toBeHidden()` passes where the first port's driver still "saw" the text.
- `admin/player-live-wikidata-enrichment`: the link's name is
  `Wikidata Q123 (opens in new tab)` (sr-only suffix), so a full-match
  regex never matched; `getByRole("link", { name: /^Wikidata Q\d+/ })` does.

## Gotchas the pilots hit (read before your first spec)

- **`aria-disabled` buttons.** Much of the app disables with `aria-disabled`
  (the wizard's "Add as New Team" while a lookup is in flight, between rows).
  Playwright treats that as disabled, so `click()` waits and times out at 7 s.
  When the flow waits for a button to become usable, locate only the enabled
  one: `getByRole("button", { name, disabled: false })`. When the flow taps a
  refused control to prove nothing happens, assert `toBeDisabled()` instead.
- **Live regions duplicate status text.** A status shown on screen is often
  ALSO announced in an `sr-only` `aria-live` node, and `sr-only` counts as
  visible. `getByText(status)` then resolves to 2 elements (strict-mode
  error). Scope to the visible container, or for "it went away" use
  `toHaveCount(0)`.
- **Roles are not always the obvious one.** `<input type="search">` is
  `searchbox`, not `textbox`; the set builder's column search is a
  `combobox`; the player page's "Search teams" is a `textbox` in a portal
  (outside `main`); native `<select>` is `combobox` with `option`s (use
  `selectOption`, assert with `sel.getByRole("option", { selected: true })`).
  Dialogs (`role="dialog"`, named by their heading) are portaled to `body`;
  locate them from `page`, not from `main`.
- **Sections that only exist sometimes.** The pairing dialog's "BSC only (n)"
  section is absent when everything paired. Branch on the thing the YAML
  branches on (`heading /^BSC only \([1-9]/` visible), not on a control
  inside it.
- **Loops over wizard steps.** After acting on step N, wait for step N's own
  control to go (`getByRole("button", { name: skipName, exact: true })`
  `.toBeHidden()`) before looking for step N+1, or the next iteration can
  act on the same step twice.
- **Option names include their badges.** A set-builder row reads
  "Base SL BSC" to a screen reader; pick rows by their own visible text with
  `columnOption()` (`.filter({ has: getByText(name, { exact: true }) })`).
- **Fresh-only specs** (wikidata live proof, the committing wizard flows) pass
  once per seed. A second local run fails at its "nothing exists yet"
  precondition; that is correct, not flaky. Re-seed.

## Coverage checklist (per spec, before you hand it back)

- [ ] Title verbatim, path mirrors the YAML, tags kept, `// Origin:` header.
- [ ] Every `assertVisible`, `assertNotVisible`, `extendedWaitUntil`,
      `assertTrue` and every value read by `copyTextFrom` maps to an
      `expect`. A `scrollUntilVisible` whose target is never tapped is an
      assertion too.
- [ ] Every branch the flow takes on `SL_PAUSED` exists here, both ending in
      hard asserts. Every app-state branch exists, behind an `.or()` settle.
- [ ] Every explicit long `timeout:` that waits on the app or a marketplace
      is carried over, on that call only. Nothing else exceeds 7 s.
- [ ] No sleeps, no CSS/XPath/test ids, no `maestro.ts`.
- [ ] Minted names come from `env.ATTEMPT_TOKEN` / `env.ATTEMPT_ID` exactly
      where the flow uses them, as single tokens.
- [ ] `npm run test:e2e:typecheck` and `npx eslint playwright` pass;
      `npm run test:e2e:list -- --project=e2e` lists the test once.

## Running

From `apps/web`. Never against shared dev; only a PR preview (the seed
resets the target deployment).

```bash
# shell 1: local Vite on a spare port, wired to the PR's Convex preview
#   (TESTING_ENDPOINT_SECRET and the Clerk keys come from .env.local)
VITE_CONVEX_URL=https://<preview>.convex.cloud VITE_DEV_DISABLE_HTTPS=1 \
  npx vite --port 3002 --strictPort
# shell 2: one spec, skipping the per-shard bootstrap after the first run
APP_URL=http://localhost:3002 WORKER_INDEX=0 \
  npx playwright test --project=e2e --no-deps <path-substring>
```

Drop `--no-deps` once per session so the `bootstrap` project seeds the
account's marketplace credentials. Some specs are fresh-only (they mint a
fixed name, e.g. the Wikidata live proof): they need a re-seed
(`./e2e-baseline.sh reset --deployment <preview>` then `--project=setup`)
before a second run.

CI: `.github/workflows/e2e-playwright-idiomatic.yml`, triggered by a
`pwi-run-<n>` tag. Shards get files from `shard-plan.mjs` (longest-first over
`timings.json`); refresh the timings from a run's merged report with
`node playwright/shard-plan.mjs --from-results <results.json>`.
