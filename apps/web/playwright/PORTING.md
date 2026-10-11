# Porting Maestro flows to Playwright (NEO-338 bake-off)

The goal is a **timing comparison**, not a rewrite. Each spec must do what its
Maestro flow does, step for step, with the same waits and the same budgets, so
the per-flow seconds can be compared 1:1. Do not improve, shorten, or "fix" a
flow. If the flow has a dead wait, port the dead wait.

Read first: `apps/web/.maestro/README.md` (flow rules R1–R10), then the four
pilot ports, which show every pattern below:

- `tests/setup.spec.ts` (big: branches, repeat, relational selectors)
- `tests/set-selector/sets-base.spec.ts` (live marketplace, paused branch)
- `tests/admin/team-management-filter.spec.ts` (typing into the focused field)
- `tests/auth/sign-in.spec.ts`, `tests/auth/sign-out.spec.ts`

## Hard rules

1. **Selectors: only what a user can perceive.** Use the driver's `m.text()`,
   `m.id()`, `m.value()`, `m.below()`/`above()`/`leftOf()`/`rightOf()`,
   `m.within()`, or raw `page.getByRole / getByText / getByLabel /
   getByPlaceholder / getByAltText / getByTitle`. **Never** a CSS selector,
   XPath, DOM id, class, `data-testid`, `locator("...")`, `nth-child`, or
   `:has()` string. `locator.filter({ has, hasText, visible })` and `.nth(i)`
   on a user-facing locator are fine.
2. **No product code changes.** If a flow cannot be expressed under rule 1,
   mark it `test.fixme` (see "Untranslatable" below). Never touch anything
   outside `apps/web/playwright/`.
3. **Timeouts.** Pass the Maestro step's own `timeout:` number exactly. A step
   with no `timeout:` takes the helper default (7000, `DEFAULT_TIMEOUT`). Do not
   raise a number because a run was slow. No retries (config `retries: 0`).
4. **Do not edit `support/maestro.ts`, `support/fixtures.ts`, `support/env.ts`
   or `playwright.config.ts`.** If you need a driver feature, report it to the
   coordinator; work around it locally in the spec with a comment meanwhile.

## Files and names

| Maestro | Playwright |
|---|---|
| `.maestro/flows/<dir>/<name>.yaml` (a test flow) | `playwright/tests/<dir>/<name>.spec.ts`, one `test()` per file |
| `name: "..."` | the `test()` title, **verbatim** (copy-paste; keep `${...}` text literally, it is a join key) |
| `tags: [smoke, set-selector]` | `{ tag: ["@smoke", "@set-selector"] }` |
| a `util`-tagged flow `.maestro/flows/<dir>/util-x-y.yaml` | `playwright/support/subflows/<dir>/util-x-y.ts`, exporting `async function utilXY(m, opts)`; never a spec |
| `runFlow` with `env:` | the util's options object, same keys (`{ SET: "Topps Heritage" }`) |

Start every spec with `// Port of .maestro/flows/<dir>/<name>.yaml` and import
`test` from `support/fixtures` (never from `@playwright/test`):

```ts
import { test, expect } from "../../support/fixtures";

test("<flow name verbatim>", { tag: ["@set-selector"] }, async ({ m, env, page }) => {
  await m.launch(m.signInUrl("/set-selector"));
  await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
  // ...
});
```

Utils already ported (reuse, do not re-port): `util/util-login-to-bsc`,
`util/util-login-to-sportlots`, `util/util-paused-platforms`,
`set-selector/util-drill-to-2024-topps-chrome`,
`set-selector/util-drill-to-base-variant`,
`set-selector/util-drill-to-cold-real-set`, `profile/worker-bootstrap`.
Still to port (the coordinator assigns each to ONE agent; others wait or
inline temporarily): `admin/util-add-player-by-hand`,
`profile/util-fill-public-profile`, `set-selector/util-add-custom-card`,
`util-attach-pane-sportlots-twin-ids`, `util-cross-list-cards`,
`util-discard-resumed-review-batch`, `util-drill-to-custom-set`,
`util-drill-to-custom`, `util-fetch-real-set-checklist-to-wizard`,
`util-pick-cross-list-source`, `util-wizard-walk-to-player-row-creating-teams`,
`util-wizard-walk-to-player-row`.

## Matching semantics (why the helpers exist)

Decompiled from the pinned Maestro 2.8.0:

- Every Maestro pattern is a **regex, full-matched, case-insensitive, dot-all**.
  `m.text("Sign out")` and `m.id(".*Search.*")` build exactly that (`^(?:p)$`,
  flags `is`). Pass the Maestro pattern string unchanged; do not add `^`/`$`.
- `text:` (and a bare string) matches an element's own text, or an input's
  value / placeholder / aria-label. `m.text()` covers text, placeholder and
  textbox accessible name. **Input VALUE is separate:** to assert something the
  flow typed, use `m.value("zzzznotateam")`.
- `id:` is the accessible name in this suite (aria-label). `m.id()` resolves via
  getByLabel / getByTitle. If the flow's `id:` targets a real DOM `id`
  attribute (check the component), it cannot be ported: `test.fixme`.
- Every driver locator is filtered to visible elements and takes the first
  match, as Maestro does.

Regex escaping: a YAML double-quoted `"BSC only \\([0-9]+\\)"` is the TS string
`"BSC only \\([0-9]+\\)"` (identical). A YAML single-quoted `'\('` becomes
`"\\("` in TS. Unquoted YAML: write the same characters, then escape
backslashes for TS.

## Command mapping

`m` is the `Maestro` driver fixture (`support/maestro.ts`); `env` is the
per-test variables (`support/env.ts`).

| Maestro | Playwright |
|---|---|
| top-level `url: ${APP_URL}/testing/sign-in?redirect=<R>&worker=${WORKER_INDEX}` + `launchApp` | `await m.launch(m.signInUrl("<R>"))` — R exactly as written, nested `?` and `%26` included |
| `...&account=<A>&worker=...` | `m.signInUrl("<R>", { account: "<A>" })` |
| bare `url: ${APP_URL ...}` (signed-out `home/*`) | `await m.launch("/")` |
| `launchApp: { clearState: true }` | `await m.launch(...)`; every test already gets a fresh browser context |
| `openLink: ${APP_URL}/path` | `await m.openLink("/path")` |
| `tapOn: "X"` / `tapOn: { text: "X" }` | `await m.tapOn("X")` |
| `tapOn: { id: "X" }` | `await m.tapOn(m.id("X"))` |
| `tapOn: { text: "X", below: { id: "Y" } }` | `await m.tapOn(m.below("X", m.id("Y")))` (also `above`, `leftOf`, `rightOf`) |
| `tapOn: { ..., optional: true }` | `await m.tapOn(sel, { optional: true })` |
| `tapOn: { point: "5%, 50%" }` | `await m.tapPoint("5%, 50%")` |
| `retryTapIfNoChange`, `waitToSettleTimeoutMs`, `visibilityPercentage` | drop (no equivalent; Playwright clicks are actionability-checked) |
| `tapOn` with `index: N` | `await m.tapOn(m.text("X").nth(N))` |
| `childOf: { id: "P" }` | `m.within(m.id("P"), "X")` |
| `containsChild` / `containsDescendants` | `m.text("X").filter({ has: m.text("Child") })` (or `page.getByRole(...).filter({ has })`) |
| `assertVisible: X` | `await m.assertVisible(X)` (7000) |
| `assertNotVisible: X` | `await m.assertNotVisible(X)` (7000) |
| `extendedWaitUntil: { visible: X, timeout: T }` | `await m.waitVisible(X, T)` |
| `extendedWaitUntil: { notVisible: X, timeout: T }` | `await m.waitNotVisible(X, T)` |
| `scrollUntilVisible: { element: { text: X }, centerElement: true, timeout: T, direction: UP }` | `await m.scrollUntilVisible(X, { centerElement: true, timeout: T, direction: "UP" })` |
| `inputText: "abc"` | `await m.inputText("abc")` — types into the FOCUSED element; keep the preceding `tapOn` exactly as the flow has it (or its absence) |
| `inputText: ${ATTEMPT_ID}` | `` await m.inputText(`${env.ATTEMPT_ID}`) `` |
| `eraseText: N` / `eraseText` | `await m.eraseText(N)` / `await m.eraseText()` (50) |
| `pressKey: Enter` | `await m.pressKey("Enter")` |
| `swipe: { start: "50%, 70%", end: "50%, 30%" }` | `await m.swipe({ start: "50%, 70%", end: "50%, 30%" })` |
| `runFlow: { file: util-x.yaml }` | `await utilX(m)` |
| `runFlow: { file: util-x.yaml, env: { SET: "..." } }` | `await utilX(m, { SET: "..." })` |
| `runFlow: { file: ..., optional: true }` | `try { await utilX(m) } catch (e) { console.warn(...) }` |
| `runFlow: { when: { visible: X }, commands }` | `if (await m.isVisible(X)) { ... }` (true at once, false after 7000 — same cost as Maestro) |
| `runFlow: { when: { notVisible: X }, commands }` | `if (await m.isNotVisible(X)) { ... }` |
| `when: { true: "${!output.SL_PAUSED}" }` | `if (!env.SL_PAUSED) { ... }` |
| `when: { true: "${output.SL_PAUSED}" }` | `if (env.SL_PAUSED) { ... }` |
| `runFlow: util/util-paused-platforms.yaml` | nothing (or `const SL_PAUSED = utilPausedPlatforms(m)`); read `env.SL_PAUSED` |
| `evalScript: '${output.X = ...}'` | `const X = ...` (plain TS) |
| `evalScript: '${output.ATTEMPT_TOKEN = String(ATTEMPT_ID \|\| Date.now()).split("-").join("")}'` | `const ATTEMPT_TOKEN = env.ATTEMPT_TOKEN` |
| `${ATTEMPT_ID}` / `${WORKER_INDEX}` / `${TEST_USERNAME}` / `${PAUSED_PLATFORMS}` | `env.ATTEMPT_ID` / `env.WORKER_INDEX` / `env.TEST_USERNAME` / `env.PAUSED_PLATFORMS` |
| `copyTextFrom: { text: X }` then `maestro.copiedText` | `const copied = await m.copyTextFrom(X)` |
| `assertTrue: ${cond}` | `expect(cond).toBe(true)` (or a more specific `expect`) |
| `retry: { maxRetries: N, commands }` | `await m.retry(N, async () => { ... })` |
| `repeat: { times: N, commands }` | `for (let i = 0; i < N; i++) { ... }` |
| `repeat: { times: N, while: { notVisible: X }, commands }` | `for (let i = 0; i < N; i++) { if (!(await m.isNotVisible(X))) break; ... }` |
| `repeat: { while: { visible: X } }` | `for (...) { if (!(await m.isVisible(X))) break; ... }` |
| `takeScreenshot` | drop (Playwright screenshots on failure) |
| `# comments` | keep only the ones that explain a non-obvious step; the YAML stays the reference |

## Minted names

`ATTEMPT_ID` is `pw<worker>-a1-<random>` here (Maestro CI: `r<n>-a<k>-<random>`),
so Playwright and Maestro runs can never mint the same token. Build every
minted name from `env.ATTEMPT_TOKEN` (hyphens already stripped) exactly where
the flow uses `${output.ATTEMPT_TOKEN}`, and from `env.ATTEMPT_ID` where the flow
uses `${ATTEMPT_ID}`. Never rebuild a token from `WORKER_INDEX` by hand.

## Untranslatable steps

If any step cannot be expressed under the selector rule or with the driver,
do not approximate it: mark the whole test, so a partial port never produces
a misleading time.

```ts
test("<flow name verbatim>", { tag: ["@set-selector"] }, async ({ m }) => {
  test.fixme(true, "NEO-338: step 14 targets a DOM id (id=\"foo\") with no accessible name");
  // ...port the rest anyway, so the gap is the only thing left
});
```

Put `// UNPORTED: <the Maestro step> — <why>` at the exact spot.

## Check your work

From `apps/web`:

```bash
npm run test:pw:typecheck                 # tsc over playwright/
npx eslint playwright                     # lint
npm run test:pw:list -- --project=e2e     # your spec is listed, title correct
```

Do **not** run specs against shared dev, and do not run the setup project
anywhere except a disposable PR preview (it resets the deployment). Running a
read-only spec locally against a PR preview, if you are told to:

```bash
# shell 1: local Vite on a spare port, wired to the PR's Convex preview
TESTING_ENDPOINT_SECRET=<from .env.local> VITE_CONVEX_URL=<PR preview .convex.cloud> \
  VITE_DEV_DISABLE_HTTPS=1 npx vite --port 3002 --strictPort
# shell 2
APP_URL=http://localhost:3002 WORKER_INDEX=5 npx playwright test --project=e2e --no-deps <path-substring>
```

`--no-deps` skips the per-shard bootstrap (which resets the worker's account).
