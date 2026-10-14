# E2E suite: authoring and running guide

The NeonBinder web E2E suite is Playwright, in `apps/web/playwright/`. This is
THE guide: every spec is written to it, and the `playwright-e2e-author` agent
and the `test-coverage-auditor` read it first. The suite is web-only; the React
Native app is paused and has no E2E.

Layout:

| Path | What |
|---|---|
| `tests/<area>/<name>.spec.ts` | one `test()` per file |
| `support/` | shared helpers (see "Support") |
| `SET-REGISTRY.md` | every real set the suite touches, who provisions it, who may write |
| `shard-plan.mjs`, `timings.json` | how CI splits files across shards |
| `../playwright.config.ts` | projects `bootstrap`, `e2e` (desktop), `e2e-mobile` (phone); 7 s budget; no retries |
| `seed/` | the scripted seed's specs (NEO-339): `baseline.spec.json` (the global baseline), `parallel.spec.json` + `mcp-smoke.expect.json` (the one seeded base parallel), `oneshot.*.json` (the `setbuild-oneshot` CI job). Read by `npm run setbuild`, never by a spec |

Reference specs that show the patterns below:

| Spec | Shows |
|---|---|
| `tests/profile/worker-bootstrap.spec.ts` | the `bootstrap` project; an optional sub-step |
| `tests/home/landing-smoke.spec.ts` | signed-out page, reachability as the assertion |
| `tests/set-selector/admin-missing-both-shows-warning.spec.ts` | dedicated `account=`, role-scoped asserts, `toBeHidden` |
| `tests/set-selector/topps-chrome-add-feature.spec.ts` | the drill helper, a genuine "is it open?" branch |
| `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` | entity-review wizard, minted names |
| `tests/labels/scan-visibility.spec.ts` | scoping to one list item; hidden-then-shown text |
| `tests/admin/player-live-wikidata-enrichment.spec.ts` | a link whose name carries sr-only text; a sanctioned long wait |

## Hard rules

1. **Tests prove the product; they never bend to it.** If the product is
   wrong, assert the CORRECT behaviour (the test goes red) and report it;
   never weaken a test to pass. Never add app code whose only purpose is to
   appease a test.
2. **Locate only by what a user perceives:** `getByRole` (with `name`),
   `getByLabel`, `getByPlaceholder`, `getByText`, `getByTitle`,
   `getByAltText`. **Never** CSS, XPath, DOM ids, classes, `data-testid`,
   `page.locator("...")` or `nth-child`. Chaining and filtering are
   encouraged: `dialog.getByRole("button", { name: "Save" })`,
   `.filter({ hasText })`, `.filter({ has: page.getByText(x, { exact: true }) })`,
   `.or()`. `.first()` / `.nth()` only where the test means "any one of
   these" (e.g. "a card number is shown"). A control a test must drive by
   keyboard needs a distinct user-visible handle (an `aria-label`); if two
   siblings read the same, fix the product with distinct labels, not the test
   with an id.
3. **Budgets are UX budgets (R5).** The config gives every action and
   `expect` 7 s. Jason, 2026-09-09: the bar for any user-facing interaction
   is 7 s unless he has explicitly approved more. A slow non-marketplace
   response is a product finding to raise, never a timeout to inflate; a
   multi-transaction save of our own is still our server answering a user and
   gets 7 s (2026-09-25: "A real user will never wait 30 seconds"). The only
   longer waits, each passed on that one call as `toBeVisible({ timeout: 60_000 })`
   and commented at the site with which exception it is:
   - a step that directly drives a live BSC/SportLots round trip on data that
     is not pre-synced;
   - a cold sync a spec pays itself on data the seed does not provision
     (its ceiling is the measured COLD-path value; a measurement means
     nothing until you know which branch, warm or cold, it came from). The
     seed itself is a script (NEO-339), not a spec, so it has no budgets
     here;
   - the post-sign-in launch gate (`LAUNCH_GATE`, 45 s);
   - the one live Wikidata proof (`player-live-wikidata-enrichment`);
   - a ceiling Jason has signed off, with the date, the measurement and what
     would void it recorded in the spec's own comment.
   Never invent a number, never raise one because a run was slow.
4. **No sleeps, no settle waits (R10).** No `waitForTimeout`, no
   `waitForLoadState("networkidle")`, no polling loops around `isVisible`.
   Use web-first assertions (`toBeVisible`, `toBeHidden`, `toHaveText`,
   `toHaveValue`, `toHaveAttribute`, `toHaveCount`, `toBeInViewport`) and let
   actions auto-wait. Do not branch or wait on something that synchronises
   nothing.
5. **`retries: 0`, one worker per shard.** Each shard owns one test account
   (`TEST_EMAIL_<WORKER_INDEX>`). Tests must not depend on order.
6. **Public repo.** No secrets, account ids, internal URLs or deployment
   slugs in any file, comment, log line or artifact. Never `git add -A`,
   never `git stash` in a shared worktree.
7. **No real secret in a spec, and a revealed one-time secret never reaches
   an artifact.** Never type a real secret (password, token, API key) into a
   field. Any spec that reveals a live one-time secret (e.g. the Clerk API
   key shown once) wraps every step from the reveal to its dismissal in
   `try { ... } catch (e) { await page.goto("about:blank").catch(() => {}); throw e; }`
   so a failure screenshot and the ARIA snapshot capture a blank page, and
   sets `test.use({ screenshot: "off" })` for the file. Failure artifacts are
   published.

## Rules every spec satisfies (R1-R4, R7, R7a, R9)

The numbers are stable: specs cite them in comments (`// R7a ...`).

**R1 - Prove one clear product feature.** The `test()` title and a top
comment state the single user-facing feature the spec proves. If it does not
fit one sentence, split it.

**R2 - Assert that, and only that; no silent fall-through.** The test must
fail if the feature is broken. A branch (`if`, `.or()`) that wraps the core
action needs a hard assertion of its precondition before it and a hard
assertion of the result after it; a test that can go green without exercising
its feature is a false positive. Every branch (paused or live marketplace,
panel open or closed) ends in hard asserts. Do not pile on unrelated
assertions either. A negative assert (`toBeHidden`, `toHaveCount(0)`) is
paired with a positive one nearby, since a negative passes on a dead page.

**R3 - Reuse shared logic; never duplicate another spec.** Drive navigation
through the `support/` helpers (R9) and confirm no existing spec already
proves the same thing. Deleting or merging a spec is propose-and-wait, never
autonomous, and retiring a spec requires replacement coverage first: removing
E2E coverage without a replacement is eliminating tests.

**R4 - Authenticated specs enter through `signIn(...)`, once.**
`signIn("/route")` opens `/testing/sign-in?redirect=<route>&worker=<n>`, the
per-test Clerk handshake, then the spec gates on the destination (below).
Banned is any in-test re-login, credential setup or re-seed: specs rely on
the `bootstrap` project. Public `home/*` specs enter signed out with
`page.goto("/")`.

**Gate every sign-in on the destination.** After `signIn`, the first
assertion is the destination's own marker with `{ timeout: LAUNCH_GATE }`
(the first navigation pays the cold launch and the Clerk handshake). Every
later assertion runs at 7 s.

**R7 - No destructive data actions.** Never clear credentials without
restoring them, never delete or overwrite shared data, never wipe. The global
reset is not a test step: it is the scripted `./e2e-baseline.sh reset` the CI
seed jobs (and `npm run test:e2e:seed`) run before the scripted seed. A
spec that leaves a worker's state degraded poisons every later spec that
worker runs.

**R7a - Sets that carry marketplace ids are read-only and sole-writer;
writes go to a per-worker hand-made set.** `SET-REGISTRY.md` is the
authority: it lists every real set the suite touches, who provisions it and
which single spec may write to it. No other spec may add, edit or delete
cards, players, teams or variants on a registered set. Shards run
concurrently against one Convex preview, so a write to a shared set is
visible to whatever else is running; `ATTEMPT_ID` protects against prior
runs, not concurrent workers. To write, create a hand-made set (no
marketplace ids, so it costs no sync) under real ancestors, suffixed
`-${env.WORKER_INDEX}`, and register the prefix in `SET-REGISTRY.md` in the
same commit. Never attach a marketplace to a hand-made row and never "Add as
New" on a real set's children. Adding a new real set needs explicit owner
approval every time: propose and wait. A constraint that seems to force a
write to a real set is a finding to raise, not a licence.

**R9 - All set-builder drilling goes through the drill helpers** in
`support/set-builder.ts` (`drillToSet`, `drillToBaseVariant`,
`drillToColdManufacturer`, `drillToCustom`, `drillToCustomSet`); never
hand-roll a Sport, Year, Manufacturer, Set, Variant drill inline. A spec
targeting a genuinely different set with unique picker asserts may diverge
and must say why. The pinned "All Brands" view at the top of the
Manufacturers column is selected through the cold-manufacturer helper, never
typed into "+ Custom" (the form refuses the name) and never searched for.

### Companion rules

- **Fixtures come from the UI.** A spec creates the data it needs through the
  product (New Team dialog, set builder, checklist). The scripted exceptions
  are the global reset and baseline, and `/testing/seed-credentials` (see
  "Worker-state seeding").
- **Minted names are single tokens**, built from `env.ATTEMPT_TOKEN`, never
  hyphenated and never rebuilt by hand. `teams.search` is a Convex SEARCH
  index matching TOKENS split at non-alphanumerics, so `TLF-9351` tokenises to
  ["TLF","9351"] and collides with every persisted team starting `TLF`. This
  holds for EVERY minted name without exception. There is no delete-team
  affordance in the app (the picker's `Remove team <name>` unlinks a team from
  a card; the row survives), so nothing a spec creates is removed within the
  run that created it, and shards share one preview: every minted team is
  visible to every other spec for the whole run. `ATTEMPT_ID` is spelled
  `pw<worker><d|m>-a1-<random>` (`d` desktop, `m` mobile; see "Desktop and
  mobile") and `ATTEMPT_TOKEN` is that with hyphens stripped; anything that
  reconstructs a prefix from `WORKER_INDEX` by hand is wrong.
- **Committing specs are sole writers and self-cleaning.** A spec that
  commits data (wizard flows, set builds) owns what it commits, uses minted
  names, and leaves nothing a later spec or the same worker's next run
  trips on. Fresh-only specs are listed under Gotchas.
- **Tags.** `{ tag: ["@smoke", "@<area>"] }`: `@smoke` (the fast subset) plus
  one grouping tag such as `@set-selector` or `@profile`. There is no
  `@regression` tag (it drifted into a set disjoint from smoke and was
  deleted) and never a `wip` tag: fix the bug instead. Run a subset with
  `--grep @smoke`.
- **Run only what you changed, against the PR's Convex preview.** Never the
  full suite locally unless the change is to the harness itself, and never
  against shared dev (the seed resets its target).
- **Timing is never the first diagnosis.** "Looks like timing or a flake"
  means look harder, not raise a number. Get the failure screenshot and
  `error-context.md` (an ARIA snapshot of the page at failure) before
  theorising. An environment stall is not a spec bug: one timeboxed check,
  then push and let CI validate; never change app or spec code to appease the
  local machine.
- **A green suite can mean the test stopped testing.** After restructuring a
  shared helper or path, install a deliberate throw (or a wrong expectation)
  in it and confirm the specs covering it go RED; restore it byte-exact.

## Files, names, tags

- `tests/<area>/<kebab-name>.spec.ts`, exactly one `test()`.
- The `test()` title states the feature; keep titles unique and stable (CI
  timings and the report join on them).
- A helper used by several specs lives in `support/`, never as a spec. Name
  helpers for what they do.
- Import `test`/`expect` from `support/fixtures` (never `@playwright/test`
  directly in a spec).

```ts
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet } from "../../support/set-builder";

test("<title states the feature>", { tag: ["@set-selector"] }, async ({ page, signIn, env }) => {
  await signIn("/set-selector");
  await expect(page.getByText("Build set parameters using marketplace APIs")).toBeVisible({ timeout: LAUNCH_GATE });
  await drillToSet(page, env);
  // ...
});
```

## Support (use these, keep the set small)

- `support/fixtures.ts`: `test` with `env` (`WORKER_INDEX`, `WORKER_KEY`,
  `ATTEMPT_ID`, `ATTEMPT_TOKEN`, `TEST_USERNAME`, `PAUSED_PLATFORMS`,
  `SL_PAUSED`) and `signIn(redirect, { account? })`, which opens
  `/testing/sign-in?redirect=<redirect>[&account=<a>]&worker=<n>` (a nested
  `?` stays literal and a nested `&` is written `%26`). `LAUNCH_GATE` (45 s).
  `expectAccessible(page, { within?, label? })`, the axe check (see
  "Accessibility checks").
- `support/a11y.ts`: what `expectAccessible` runs: the WCAG tags, the one
  list of excluded third-party regions (each with its reason), the failure
  summary and the attachment. Specs never import it directly.
- `support/env.ts`: how `env` is built (`makeEnv`, `isSlPaused`); import types
  from here, do not re-derive.
- `support/credentials.ts`: `loginToBsc(page)`, `loginToSportLots(page, env)`,
  `LIVE_LOGIN`.
- `support/set-builder.ts`: the cascade. `setBuilderReady`, `columnHeading`,
  `columnSearch`, `columnOption`, `columnSelection`, `pick`,
  `addCustomEntry`, `addCustomManufacturer`, `selectOrCreate`,
  `syncChecklistButton`, and the drills `drillToSet` (2024 Topps Chrome),
  `drillToBaseVariant`, `drillToColdManufacturer`, `drillToCustom`,
  `drillToCustomSet`, `customSport`, `readAttachedTwinId`. Overrides are an
  options object: `drillToSet(page, env, { set: "Topps Big League" })`.
- `support/cards.ts`: hand-made card helpers for a worker's own subtree
  (`addCustomCard`, `addCardViaForm`, `openVariant`, `ensureAndSelect`,
  edit/delete button locators).
- `support/cross-list.ts`: cross-release import (`openCrossListForm`,
  `pickCrossListSource`, `crossListCards`).
- `support/players.ts`: `/admin/players` (`expectPlayersLoaded`,
  `emptyListAndPickSport`, `addPlayerByHand`).
- `support/profile.ts`: `fillPublicProfile`.
- `support/wizard.ts`: entity-review wizard (`reviewWizard`, `stepCounter`,
  `readStep`, `expectStepLeft`, `fetchChecklistToWizard`,
  `fetchOneMarketplaceSetChecklistToWizard`, `cancelAndDiscard`,
  `discardResumedReviewBatch`, `personSkip`, `walkToPlayerRow`,
  `advanceToSave`, `readBackDecision`, `confirmSaveButton`). Each helper's
  contract is in its doc comment; see "The entity-review wizard" under Gotchas.
- `support/bypass-proxy.mjs`: CI-only proxy that injects the preview's
  deployment-protection header; started by the config's `webServer` when
  `PREVIEW_URL` is set. Never logs the secret.

A helper used by several specs gets ONE implementation in `support/`; read
the existing ones before adding another.

## Locators: names, substrings and scope

Playwright's string `name`/`text` matching is a case-insensitive SUBSTRING
unless `exact: true`:

| Intent | Locator |
|---|---|
| a button named "Sign In" | `page.getByRole("button", { name: "Sign In" })` (add `exact: true` if another name contains it) |
| text containing "Saved Reprint" | `page.getByText(/Saved Reprint/)` |
| exact text "0 matches" | `page.getByText("0 matches", { exact: true })` |
| a named control with a minted name | `page.getByRole("button", { name: \`Create player ${name}\` })` |
| a family of options | `dialog.getByRole("option", { name: /^BSC base candidate: / }).first()` |
| "the option inside the Years list" | scope, not geometry: `page.getByRole("listbox", { name: "Years" }).getByRole("option")` |
| "X above or below Y" | find the container both live in (dialog, region, list item, row) and scope to it |

Watch the substring trap with names that prefix others: `"Select All-America
Game Autos"` also matches `"Select All-America Game Autos Red Ink"`; use
`exact: true` (strict mode will tell you, loudly).

**Find the role and name before writing a locator.** Run the spec once and
read `error-context.md` (an ARIA snapshot of the page) in the failure output,
or call `await page.getByRole("main").ariaSnapshot()` in a scratch run. Do
not guess from the markup.

Playwright's visibility is the user's: `hidden` content, collapsed
`<details>` and the like are not visible, while `sr-only` text counts as
visible and as part of an accessible name. Examples:
- `labels/scan-visibility`: the collapsed scan list is `hidden`, so
  `toBeHidden()` is the honest assertion.
- `admin/player-live-wikidata-enrichment`: the link's name is
  `Wikidata Q123 (opens in new tab)` (sr-only suffix), so a full-match
  regex never matches; `getByRole("link", { name: /^Wikidata Q\d+/ })` does.

Idioms:
- A native `<select>`: `selectOption`, not click-then-click.
- `fill` replaces; `clear()` empties; `press("Enter")` on the field.
- A page branches on APP STATE (a panel is open or not): first wait until the
  app has settled into ONE of the states, then branch for free:
  `await expect(a.or(b)).toBeVisible(); if (await a.isVisible()) {...}`.
  A branch that only papers over timing is dropped: assert the end state.
- A bounded `for` loop that waits for the next state with `.or()` and
  `break`s on the exit state, never an open-ended poll.
- Read a value with `await x.textContent()` / `innerText()`, then plain TS.
- Reachability ("the user can get to the CTA"): `await x.scrollIntoViewIfNeeded();
  await expect(x).toBeInViewport()`; otherwise `click()` scrolls by itself.
- Screenshots on failure are configured; do not add `screenshot()` calls.

## Gotchas (read before your first spec)

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
- **The entity-review wizard ("Tidy up this set", NEO-335).** The dialog is
  named `Tidy up this set` (it was "Confirm New Players & Teams"); the old
  "N of M reviewed" line and its "N still being looked up" tail are gone (the
  footer still says "N still looking up"). Header facts a spec may assert:
  the subtitle (`New league`, `New team`, `New player`, `Which player is
  this?`, `Cards with no team`, `Card titles`, `Ready to save`) and the ONE
  `Step x of y` counter (`stepCounter`, `readStep`). On a NAME step x is the
  decided count plus one, so `Step 1 of N` is a batch with nothing decided and
  one decision reads `Step 2 of N`; y grows as staged steps arrive, so pin x,
  never y. "Every name is decided" is the footer state `Next (Enter)` or
  `Confirm & Save`: past the names come `Cards with no team` and `Card titles`
  (each only when needed, each with `Next (Enter)` and NO Confirm & Save),
  then `Ready to save` (heading `Save N cards?`), always `Step y of y` and the
  only step with Confirm & Save. A spec whose feature is a name decision calls
  `advanceToSave` to reach Save (Next leaves every line on its default); a
  spec whose feature is the teams or titles step drives that step itself. A
  sync with no unknown names opens the wizard only when a post-name step is
  needed, straight onto it (`Step 1 of 2`). The wizard only opens for names
  the reference catalogue does not know, so a wizard spec needs a registered
  fixture set (SET-REGISTRY.md). The post-save attention walker wears the same
  title, subtitles and counter: tell them apart by the walker's `Skip for now,
  card <number>`. To prove WHAT a decision was, read it back with
  `readBackDecision` (the footer Back opens the most recent decision read-only
  in the group `Decision for <name>`); the "Decided (N)" list is batch-ordered
  and collapses past five entries, so it is no read-back. A Maestro-era scroll
  or drag to bring a form above the footer has no Playwright counterpart:
  click() scrolls and refuses to click through an overlapping control.
- **Option names include their badges.** A set-builder row reads
  "Base SL BSC" to a screen reader; pick rows by their own visible text with
  `columnOption()` (`.filter({ has: getByText(name, { exact: true }) })`).
- **Fresh-only specs** (wikidata live proof, the committing wizard flows) pass
  once per seed. A second local run fails at its "nothing exists yet"
  precondition; that is correct, not flaky. Re-seed.

## Desktop and mobile

Every spec runs twice: on `e2e` (desktop Chromium, 1024x629) and on
`e2e-mobile` (Chromium with the Pixel 7 descriptor: 412x839, touch,
`isMobile`, a mobile user agent). CI runs them as two passes, each on a
freshly seeded preview: the desktop pass (seed, 8 shards on `--project=e2e`),
then a re-seed (reset + the scripted seed again), then the mobile pass (8
shards on `--project=e2e-mobile`). A spec that is fresh-only or the sole
writer of a real marketplace set passes once per seed, so each project
gets its own; a spec never runs on both projects in one seed. Mobile starts
only after every desktop shard finished (the reset wipes the shared
preview), and still runs when desktop has reds. The `e2e` gate needs a
passing result for every planned spec on BOTH projects and a successful
seed job for each pass, and a skipped test counts as a failure.

- **Write one spec for both.** Role, label and text locators do not care
  about the viewport, and `click()` scrolls by itself. Most specs need no
  change at all.
- **Branch only where the mobile layout genuinely differs** (a menu behind a
  toggle, a panel that becomes a sheet), and branch on the project, never on
  what the screen happens to show: Playwright's own `isMobile` fixture
  (`async ({ page, isMobile }) => ...`) or `test.info().project.name ===
  "e2e-mobile"`. Each branch still locates only by what a user perceives and
  ends in hard asserts that prove the same feature (R2). A difference you did
  not expect is a finding to report, not a branch to add.
- **Never skip mobile without a stated reason.** `test.skip` is a lint error
  and the gate fails on a skip. A spec that truly cannot run on a phone is
  an owner decision: propose it with the reason; never quietly ignore a
  project.
- **Minted names differ per project.** The `env` fixture folds the project
  into every name it mints: `ATTEMPT_ID` is `pw3d-a1-…` on desktop and
  `pw3m-a1-…` on mobile, so `ATTEMPT_TOKEN`s never collide and the mobile run
  never meets a row the desktop run made (nothing deletes a minted row
  mid-run). CI runs the two projects in separate passes, each on its own
  reset and seed, so a per-worker name built from `env.WORKER_INDEX` never
  meets the other project's row there. New specs should still prefer
  `env.WORKER_KEY` (`3d` / `3m`), which also keeps a local run of both
  projects without a re-seed apart. `WORKER_INDEX` stays the bare account number, shared by both projects:
  it is what `signIn` passes as `worker=`, and it names what the account's
  bootstrap seeded.
- **Local runs** pass the project you are debugging; to run both, re-seed
  between them, because a fresh-only or sole-writer spec passes once per
  seed: `npx playwright test --project=e2e --no-deps <spec>`, then
  `CONVEX_NAME=<preview> APP_URL=<your Vite> npm run test:e2e:seed`,
  then `npx playwright test --project=e2e-mobile --no-deps <spec>`.

## Accessibility checks

`expectAccessible(page)` runs axe-core against the page and fails the test
on any WCAG 2.0, 2.1 or 2.2 level A or AA violation, one line per violated
rule (impact, rule id, what to fix, how many elements, the first element's
selector, the rule's help link). The result, without any node's HTML, is
attached to the test as JSON (`axe <label> (<project>)` in the report).

```ts
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
await expectAccessible(page, { label: "Profile settings" });

const dialog = page.getByRole("dialog", { name: "New Team" });
await expect(dialog.getByRole("textbox", { name: "Location" })).toBeVisible();
await expectAccessible(page, { within: dialog, label: "New Team dialog" });
```

- **Call it at every new screen or state a spec reaches**, after the
  assertion that proves the screen is showing and after any transition has
  finished (a dialog's open animation, a page flip, a list still filling):
  axe checks whatever is in the DOM at that moment, and a half-faded element
  measures as a contrast failure that no user sees. A dialog opening, a
  wizard step, an error state and an empty state are each a state. It runs on both projects
  with the same call, so the phone layout is checked too.
- **Helpers.** A `support/` helper whose product is a screen, dialog or
  wizard it opens and returns with showing (`fetchChecklistToWizard`,
  `openCrossListForm`) runs `expectAccessible` itself on arrival, so every
  spec that uses it covers that state; do not repeat it in the spec. Helpers
  that only drive through intermediate states (the `drillTo*` cascade,
  `walkToPlayerRow`, login warm-ups, form fillers) never call it: the spec
  checks the state it stops on.
- **Whole page by default.** `within` takes a Locator (role, label or text,
  like any other locator; it must resolve to exactly one element) for a
  region whose page the spec already checked. `label` names what the user
  sees; it defaults to the URL path.
- **Violations are product bugs.** Fix them in the product (contrast, names,
  roles, landmarks), never in the spec. There is no option to disable a rule,
  and `EXCLUDED_REGIONS` in `support/a11y.ts` holds only UI that is not
  NeonBinder's and that NeonBinder cannot change, each entry with its reason.
  Never add NeonBinder's own UI to it, and never exclude something to make a
  spec pass.
- The browser runs in Playwright's default light colour scheme. The app
  renders dark whatever the OS setting (`dark:` keys off `<html
  class="dark">`, NEO-341), so this is what every user sees; never force a
  colour scheme in a spec.
- `incomplete` results in the attachment (axe could not decide, e.g. text
  over an image or gradient) never fail a test; read them when changing a
  screen's colours.

A green axe run is not WCAG conformance. axe reads one DOM snapshot, so it
cannot see keyboard traps, focus order or focus lost to `<body>` (2.1.2,
2.4.3), whether a status change is announced (4.1.3), contrast in hover,
focus and disabled states, or reflow at 320 CSS px (1.4.10; the Pixel 7
project is 412 px wide). Those stay with the spec's own keyboard and
live-region assertions and with the accessibility-auditor's review.

## Worker-state seeding

The **seed** is `e2e-seed-reset.sh` (`e2e-baseline.sh reset`, a scripted
global wipe, plus on CI the NEO-330 reference catalogue) followed by the
scripted baseline (NEO-339): `npm run setbuild -- apply` of
`playwright/seed/baseline.spec.json`, which signs in as worker 0's test admin
and drives the same public admin Convex functions the Set Builder UI calls
(credential save, 2024 Topps Chrome's Base, Insert and Parallel, Big League,
2026 Bowman's SportLots review: the real sets marked **seed** in
`SET-REGISTRY.md`), then the one seeded base parallel (`parallel.spec.json`).
Runbook: `docs/operations/neo339-setbuild.md`. It runs once per pass,
deliberately, never as one thread among many, and it is not a spec: a UI
behaviour is proved by a spec, never by the seed. Players are those the
baseline's reviews create (on a catalogue preview only the names the
catalogue lacks); a spec still makes its own per-worker rows. Then the `bootstrap` project
(`tests/profile/worker-bootstrap.spec.ts`) resets and seeds ITS shard's
account (public profile, marketplace credentials), and `e2e` depends on it.
Nothing schedules around the seed: run it first (`npm run test:e2e:seed`),
then run whatever specs you want. To seed another worker's account locally,
set `WORKER_INDEX` and run the `bootstrap` project for it.

### Seeding a fixture that no UI can create (`/testing/seed-credentials`)

Some states cannot be reached by driving the product in test time, because
reaching them costs real money, real minutes or a real third party. A
purchase row with USPS scans needs a label bought with live postage and then
three days of USPS sorting; a `needsReauth` credential needs a session that
genuinely exists and is dead. For those, `/testing/seed-credentials` is the
generic "seed, then land" hop, and its `sites` query param selects what to
seed:

| `sites` value | What it seeds |
| --- | --- |
| *(omitted)* | BSC + SportLots credentials (+ the EasyPost key, when configured) |
| `sportlots` / `buysportscards` | just that platform's credentials (credential-gate fixtures) |
| `label-scans` | one `labelPurchases` row plus a four-scan tracker snapshot, for `labels/scan-visibility` |

A fixture selector is handled before the credential loop, so asking for it
alone performs no marketplace login. The handler (`convex/testing.ts`) writes
only through the product's own internal writers, so the seeded row is
sanitised and guarded as production data is. Every helper is caller-scoped,
idempotent and fails closed in production. Nest the inner query string with
`%26` for its `&`:

```ts
await signIn("/testing/seed-credentials?sites=label-scans%26redirect=/print/labels");
```

**Mind which account a fixture lands on.** The per-user reset clears three
per-user tables and `labelPurchases` is not one of them, so a purchase seeded
onto an account stays. `scan-visibility` seeds the worker's MAIN account while
`label-history-empty-state` asserts the empty state on the isolated
`new-profile` account: two accounts, two states, neither able to disturb the
other.

## Operator switches (`PAUSED_PLATFORMS`, NEO-287)

One operator switch changes what the suite can prove: the Convex env var
`NEONBINDER_PAUSED_PLATFORMS` (comma-separated credential site keys, today
`sportlots`) stops all contact with that marketplace (no sign-ins, session
checks, selector or checklist fetches on that side) while every link and
stored session stays put. Specs are **never skipped** under it: every spec
that needs the paused marketplace has a paused branch asserting the paused
behaviour (copy in `lib/marketplace/pause-notice.ts`), and live coverage
returns by itself when the variable is unset.

**Today the switch is OFF.** SportLots was unpaused on 2026-09-21 (the
automated-access handshake, NEO-288, replaced the reason), so every CI run
passes `PAUSED_PLATFORMS` empty and every spec takes its LIVE branch. The
paused branches stay: they are what the suite does the day an operator
pauses a marketplace again, and both branches end in hard asserts (R2).
Never write a comment, registry entry or memory saying the suite "is"
paused; check the run you are reading:

```bash
gh run view <run-id> --log | grep -m1 "PAUSED_PLATFORMS: "
```

An empty value after the colon means live. A failure diagnosed on the paused
branch of a live run (or the reverse) is a misread, not a finding.

**How a spec knows.** `env.SL_PAUSED` is derived from `PAUSED_PLATFORMS` in
the process environment (`support/env.ts`, unset reads as not paused). CI
(`e2e.yml`) exports the shell variable from the repository variable of the
same name and writes the same value onto the PR's Convex preview before
seeding, so flag and deployment agree by construction; locally set it by hand
to match whatever deployment you point at. A spec branches on the flag, never
on the notice: `if (env.SL_PAUSED) { ...paused asserts } else { ...live }`.
A runner whose flag disagrees with its deployment fails on the first hard
assert, by name.

**What the pause changes on screen** (so you recognise it in a failure
screenshot). Paused-specific UI exists at exactly three places: the Profile
SportLots tab shows the amber "SportLots is on pause" card instead of the
connected/re-auth card; `/admin/set-builder` opens for a BSC-only admin (a
paused platform is not a required credential) with an amber "SportLots is on
pause." strip above its heading; and the ROOT Sports column's "done" notice
carries "SportLots is on pause: nothing from SportLots was asked for or
changed." (stored per column, shown to every worker; never dismiss it from a
shared helper). **Below the root, on a fresh deployment, the pause is
indistinguishable from a BSC-only tree**: a side counts as paused only where
it is served AND its ids are complete, and because the Sports sync never
asked SportLots, `Baseball` is written with no SportLots id, so every level
beneath skips SportLots for want of ids. Years reads "SportLots skipped: no
SportLots ids on this path."; Manufacturers syncs to nothing with NO notice
and its idle text ("No manufacturers available. Sync from marketplaces to
populate."); the base picker's SportLots pane shows "SportLots returned no
base set for <set>"; checklist fetches take the one-marketplace path ("Kept
all N cards from BSC. Nothing to match, no other marketplace attached.").
Paused branches below the root assert THAT state, never the paused sentence.
Consequences for drills: the Manufacturers column holds only the pinned "All
Brands" view entry on a fresh deployment (see `SET-REGISTRY.md` -> "When
SportLots is paused"), a brand's Sets column ends "done" with "SportLots
skipped: no SportLots ids on this path." (a notice, not an error; the seed's
strict asserts key on failure copy), and a BSC-only Base still reads as
unmapped, so its picker re-opens on every visit and read-only drills leave it
with Cancel then Close.

## SportLots never rejects a password in E2E (NEO-288)

SportLots sign-in goes through an owner-issued automated-access handshake
(`services/browser/src/adapters/sportlots-adapter.ts`), and the key is scoped
to ONE SportLots account: the one the seed and the login probes use. For any
other account, including a deliberately fake one, SportLots never evaluates
the password: it answers with its refusal body, the browser service's login
diagnostic classifies that as a challenge (`error_class: challenge`,
`credentialRejected: false`), and Convex renders the per-site `siteMessage`
("SportLots wouldn't let us in the door...", `SITE_SIDE_ERROR_CLASSES` in
`convex/credentials.ts`) and stores nothing. So the bad-password copy ("Could
not sign in to SportLots. Nothing was saved...") is **unreachable** for
SportLots from a spec, and a step asserting it asserts a state the product
cannot produce. Assert the site-side copy (a stable, platform-named
substring such as `/SportLots wouldn't let us in the door/`) plus the
"nothing stored" state, as `profile/credentials-lifecycle` does; the
transient "Could not reach SportLots..." copy must not match, since that is
the browser service not answering (R2). BSC is unaffected and still produces
a genuine credential rejection.

## Enrichment fixtures (NEO-289)

The entity-review wizard enriches players, teams and leagues from Wikidata
(and ESPN) as before, but on **dev and PR previews** the names the seed set
surfaces (2024 Topps Chrome, Baseball) are answered from a committed
recording (`convex/adapters/__fixtures__/enrichment-lookups.json`) instead of
a live round trip. The switch is the Convex env var
`NEONBINDER_ENRICHMENT_FIXTURES=1`, honoured only where
`TESTING_RESET_SECRET` is also set; `e2e.yml` writes it onto the PR's preview
before seeding, every run, and production has neither. A name not in the
recording still goes live, so the fixture is a cache in front of the adapter,
never a stub of it. What that changes:

- **The seed no longer proves the live lane.** Its Base review's lookups
  are fixture-backed hits when the recording covers them, network time only
  for names it does not; a slow seed with the recording in place is a
  coverage gap, not a slow Wikidata. CI prints the coverage report to the
  seed job summary after the seed; read it before reading anything into a
  slow seed.
- **The live lane is proved by ONE spec:**
  `tests/admin/player-live-wikidata-enrichment.spec.ts`. It adds a real Hall
  of Famer by hand on `/admin/players` (a name absent from the recording and
  from every checklist the suite commits) and waits for the `Wikidata Q...`
  link in the detail header. It carries the suite's one in-spec wait above
  7 s on an external round trip, recorded at the site with its arithmetic,
  and it is **expected to go red during a genuine Wikidata outage**. A
  transport failure (timeout, network error, 5xx, 429) is "unavailable", not
  a miss: the attempt writes nothing and `wikidataPool` retries on its
  backoff ladder (`WIKIDATA_POOL_RETRY`), while a real no-match is final. The
  spec's ceiling outlasts the first three pool attempts, so a red means
  Wikidata stayed unavailable through all of them. Confirm from the run's
  `convex-logs-runner-0` artifact (the preview's Convex logs for the whole
  run): each unavailable attempt logs `wikidata_lookup_unavailable` (kind,
  row id, reason, never a name). Then rerun. A red with no such lines, or a
  repeat with `query.wikidata.org` healthy, is a product finding.
- **Do not add the live-proof name to the recording.** The capture reads the
  deployment's `players` rows, so a capture taken after the suite has run
  would sweep it in; `convex/adapters/enrichmentFixtureFile.test.ts` refuses
  a recording that contains it.
- The wizard specs on the Cubs / Orioles / Brooklyn fixtures get partial hits
  from the recording and stay live for the rest.

Fresh-only: the live proof passes once per seed. A second local run against
the same preview finds the row the first run created, the add form demotes
`Create player ...` to `Open ...`, and the spec fails on that button by
name. That is correct (an existing row is adopted, never re-enqueued, so a
re-run on the same row would pass on the previous run's QID and prove
nothing live). Re-seed before re-running.

## Running

All commands run from `apps/web`.

| Command | What |
|---|---|
| `npm run test:e2e` | `playwright test`: everything (CI's job; not for your laptop) |
| `npm run test:e2e:list` | list tests; `-- --project=e2e` to check a new spec is listed once |
| `npm run test:e2e:typecheck` | `tsc -p playwright/tsconfig.json` |
| `npm run test:e2e:seed` | `./e2e-seed.sh`: reset, then `setbuild apply` of `playwright/seed/baseline.spec.json` and `parallel.spec.json`; seeds `CONVEX_NAME` (required) through the Vite at `APP_URL` |
| `npx eslint playwright` | lint the suite |

**Locally: only the specs covering your change, against the PR preview,
never shared dev** (the seed resets its target). Run a second Vite on a spare
port wired to the PR's Convex preview, and point Playwright at it:

```bash
# shell 1: local Vite on a spare port, wired to the PR's Convex preview
#   (TESTING_ENDPOINT_SECRET and the Clerk keys come from .env.local)
VITE_CONVEX_URL=<the PR's Convex preview URL> VITE_DEV_DISABLE_HTTPS=1 \
  npx vite --port 3002 --strictPort
# shell 2: seed once, then one spec at a time
CONVEX_NAME=<the preview's deployment name> APP_URL=http://localhost:3002 \
  npm run test:e2e:seed
APP_URL=http://localhost:3002 WORKER_INDEX=0 \
  npx playwright test --project=e2e --no-deps <path-substring>
# for the phone project, re-seed first (npm run test:e2e:seed), then:
#   ... npx playwright test --project=e2e-mobile --no-deps <path-substring>
```

`TESTING_ENDPOINT_SECRET` must be exported into the Vite process itself (its
dev-server middleware checks the `x-testing-auth` header the sign-in hop
sends); use the worktree's existing value. `VITE_DEV_DISABLE_HTTPS=1` avoids
the mkcert HTTPS plugin. Drop `--no-deps` once per session so the `bootstrap`
project seeds the account's credentials. `PAUSED_PLATFORMS` must match the
deployment (see the switch above). Fresh-only specs need a re-seed before a
second run. A protected preview may need `VERCEL_AUTOMATION_BYPASS_SECRET` /
`PREVIEW_URL` (the bypass proxy). If the local machine stalls, do one
timeboxed check and then push; CI validates.

**CI shape.** `pr-pipeline.yml` calls `.github/workflows/e2e.yml` on every
PR in two passes, each on a freshly seeded preview:

```
setup -> seed -> shard-desktop x8 -> seed-mobile -> shard-mobile x8 -> e2e (gate) -> report
              \-> setbuild-oneshot (once) --/
```

`seed` is the scripted reset plus the scripted seed (`setbuild apply` +
`setbuild mcp-smoke`, worker 0; no browser); the desktop shards run
`--project=e2e`. `setbuild-oneshot` (NEO-339, worker 8) runs once, beside the
desktop shards: the MCP one-shot build of a set no spec touches, checked
against `seed/oneshot.expect.json`. `seed-mobile` needs every desktop shard
and `setbuild-oneshot` (the reset wipes the shared preview), runs even when
desktop has reds, and repeats the same Convex env steps, reset and scripted
seed; the mobile shards run
`--project=e2e-mobile`. Each shard gets an explicit file list from
`node playwright/shard-plan.mjs 8 <i> --project <e2e|e2e-mobile>`
(longest-processing-time-first over that project's entry in `timings.json`,
not `--shard`) and runs the `bootstrap` project for its own account first, so
each pass re-bootstraps its workers after its reset (workers 0-7 are used;
accounts 0-11 exist). Expected wall clock is about 20 minutes: seed ~4 min,
longest shard ~5 min (the longest spec), twice. The `e2e` gate fails on any
failed spec, any missing result on either project, a seed job or
`setbuild-oneshot` that did not succeed, or a shard that died before reporting. A `report` job publishes the
"Playwright E2E" check and a sticky PR comment. `e2e-repeat.yml` runs the
suite N times (flake sampling); `refresh-flow-timings.yml` refreshes
`timings.json` from CI. Refresh by hand from a run's merged results with
`node playwright/shard-plan.mjs --from-results <results.json>`: `seconds` is
each spec's desktop time and `byProject["e2e-mobile"]` its mobile time (a
project with no value for a spec falls back to the desktop one, so a
desktop-only file still plans both passes).

**Reading a red run.**
1. Find which spec failed in the "Playwright E2E" check or the sticky comment.
2. Download the artifacts BEFORE any rerun: `pw-report-desktop-<n>` or
   `pw-report-mobile-<n>` (the shard's screenshots and report),
   `pw-report-seed` / `pw-report-seed-mobile` (a pass's seed), and `pw-merged`
   (both passes' merged report and results).
   `gh run download <run-id> -n pw-merged` (and the shard).
3. Open the failure screenshot and the spec's `error-context.md` (the ARIA
   snapshot of the page at failure). The role and name you expected is
   usually visibly different from what is there.
4. Check the run's `PAUSED_PLATFORMS: ` line and, for enrichment, the
   `convex-logs-*` artifacts, before deciding which branch the spec took.
5. Reproduce that one spec locally against the PR preview (above); fix; push
   only once it passes. A full rerun (`gh run rerun`) is for suspected infra
   problems; a real failure just fails again. A rerun cannot fix a broken
   preview: only a new commit forces fresh ones.
Published artifacts are failure screenshots plus the blob/HTML report, which
embeds each failure's `error-context.md` (an ARIA snapshot, input values in
plaintext) and the sanitised axe JSON. That is accepted: real marketplace
passwords never reach the browser. **Never traces**: a trace records network
traffic including Clerk testing tokens, and artifacts on a public repo are
public. Traces are only on locally (`retain-on-failure`).

## Coverage checklist (per spec, before you hand it back)

- [ ] Title states one feature (R1); path mirrors the area; tags set.
- [ ] Every user-visible claim the feature makes is an `expect`; branches
      (paused/live marketplace, app state) end in hard asserts (R2).
- [ ] Every explicit long timeout that waits on the app or a marketplace is
      justified at the site and on that call only. Nothing else exceeds 7 s.
- [ ] No sleeps, no CSS/XPath/test ids; locators are role/label/text.
- [ ] Minted names come from `env.ATTEMPT_TOKEN` / `env.ATTEMPT_ID` as single
      tokens; new per-worker names prefer `env.WORKER_KEY`.
- [ ] `expectAccessible` runs at every new screen or state the spec reaches.
- [ ] The spec passes on `e2e` AND `e2e-mobile`; any mobile branch keys on
      `isMobile` and ends in hard asserts.
- [ ] Writes go to a per-worker hand-made set, or the spec is the registered
      sole writer (R7a); nothing destructive (R7).
- [ ] If the spec drives a shared helper you changed, a deliberate throw in
      the helper turns the covering specs red.
- [ ] `npm run test:e2e:typecheck` and `npx eslint playwright` pass;
      `npm run test:e2e:list -- --project=e2e --project=e2e-mobile` lists
      the test once per project.
