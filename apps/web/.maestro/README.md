# Maestro E2E — local ↔ CI parity

This directory holds the Maestro web E2E suite. Flows under `flows/` are run
by `run-e2e-smoke.sh` (locally and in CI). This README covers the parts of
the system that are easy to drift between environments — what's pinned,
what's intentionally divergent, and how to reproduce CI conditions on a Mac.

## Pinned versions (single source of truth)

| File | What it pins | Read by |
| --- | --- | --- |
| `.maestro/version` | Maestro CLI version (e.g. `2.6.0`) | `setup-maestro.sh`, CI workflow |
| `.java-version` | Java major version (jenv-compatible) | `setup-maestro.sh`, CI's `actions/setup-java` |
| `.sdkmanrc` | Java + distribution (Temurin LTS) | sdkman auto-env |
| `.maestro/chrome-version` | Chrome for Testing version (**local only**) | `setup-maestro.sh`, `lib-e2e-chrome.sh`, `test:e2e:check` |

Bumping any pin is a single PR. After editing the pin file:

```bash
rm -f $HOME/.maestro/bin/maestro   # only if bumping Maestro
./setup-maestro.sh                  # reinstalls to the new pin
npm run test:e2e:check              # verifies installed = pinned
```

CI re-installs from scratch each run, so it always picks up the new pin
without a separate step.

### Why Chrome is pinned locally but not in CI

Local runs **must** drive Chrome for Testing, never branded Google Chrome.
Branded Chrome exposes `chrome://omnibox-popup.top-chrome/` CDP targets *ahead
of* the real tab, and Maestro's `CdpTarget` model carries no `type` field to
filter them out — so it navigates the omnibox popup widget instead of the tab.
Every flow then runs in a 1×1 viewport:

```
DeviceInfo(platform=WEB, widthPixels=830, heightPixels=1)
```

with 1×1 failure screenshots. Assertions on content at the very top of the page
still pass, so it reads exactly like a product bug (NEO-138). Chrome for Testing
exposes no such targets.

CI needs no pin: `browser-actions/setup-chrome` already installs a non-branded
build, which is why CI stayed green through the entire outage. The upshot is a
small deliberate divergence — local reports `1024×625`, CI `1024×629`.

`run-e2e-smoke.sh`, `run-e2e-queue.sh` and `e2e-local-up.sh` all resolve and
export `SE_BROWSER_PATH` via `lib-e2e-chrome.sh` and **refuse to start** without
it. Setting `SE_BROWSER_PATH` yourself overrides the pin, except that pointing
it at branded Chrome is rejected outright.

### The macOS renderer stall, and why local Chrome gets one extra flag (NEO-258)

On macOS, headless Chrome for Testing under maestro-web can stop producing
animation frames once the set-selector reveals a new column. maestro-web's only
scroll primitive is `window.scroll({behavior:'smooth'})`, which is frame-driven,
so from that moment every `scroll` / `swipe` / `scrollUntilVisible` moves 0px
and still reports `COMPLETED`, `takeScreenshot` hangs, and anything below the
fold is unreachable (element lookup is viewport-bounded). It is intermittent,
it reads exactly like a product bug, and CI (Linux) has never shown it.

`lib-e2e-chrome.sh` therefore points `SE_BROWSER_PATH` at a generated wrapper
(next to the pinned build in the puppeteer cache, never in the repo) that
launches the same binary with `--run-all-compositor-stages-before-draw`.
Measured: 9/9 screenshots and 8/8 scrolls on two runs with the flag, 0-1
screenshots without; `--headless=old` and
`--disable-new-content-rendering-timeout` do not help. Opt out with
`E2E_CHROME_COMPOSITOR_FLAG=0` (for a before/after comparison) or force it on
another platform with `=1`.

**Tell a stall apart from an app bug in ten seconds.** Attach any CDP client to
the running Maestro Chrome (its profile dir holds `DevToolsActivePort`) and run:

```js
await new Promise(r => { let raf = 0, ivl = 0;
  const a = () => { raf++; requestAnimationFrame(a); }; requestAnimationFrame(a);
  const t = setInterval(() => ivl++, 16);
  setTimeout(() => { clearInterval(t); console.log({ raf, ivl }); r(); }, 2000); });
```

`raf: 0` with `ivl` in the hundreds is the stall: JS runs, frames do not. An
app bug never looks like that. Full write-up:
`.claude/agent-memory/neonbinder-web-dev/reference_maestro_web_frame_stall_kills_scrolling.md`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup:e2e` | Install pinned Maestro + Java + Chrome for Testing (idempotent; safe to re-run) |
| `npm run test:e2e:check` | Verify installed Maestro + Java + Chrome match the pins; print actionable next steps if not |
| `npm run e2e:clean-chrome` | Kill Chrome/chromedriver processes a previous run left detached (never touches your real browser) |
| `npm run test:e2e` | **The full suite** — every flow, no tag filter (minus `util`/`wip`/`setup`) |
| `npm run test:e2e -- setup` | The seed track only (`flows/setup.yaml`) — the one entry point that runs it |
| `npm run test:e2e:smoke` | Smoke tag only — the fast subset |
| `npm run test:e2e:pick -- <selector>` | Run just a piece of the suite (by name / list / regex / tag) — see below |
| `npm run test:e2e:plan -- <selector>` | Dry-run: print exactly what `:pick` *would* run and exit |
| `npm run test:e2e:like-ci` | Run with CI-equivalent conditions — `MAESTRO_PARALLELISM=3`, no tag filter, pin gate enforced before start |
| `npm run test:e2e:single` | One-off invocation; see `package.json` for the wrapper |

`test:e2e:like-ci` is the closest you can get to CI on a Mac without
Dockerizing. It refuses to run if the pin gate fails.

## Running just a piece of the suite (`test:e2e:pick`)

`test:e2e:pick` (and its dry-run twin `test:e2e:plan`) take one **selector**
and run only the matching flows. Always preview first with `:plan`, which
prints the resolved schedule without launching Maestro.

| Selector | Matches |
| --- | --- |
| *(empty)* | all flows (minus `util`/`wip`) — same as `test:e2e` |
| `smoke` / `tag:NAME` | flows carrying that tag (bare word ⇒ tag, unchanged) |
| `name:set-attributes-edit` | flows whose **path** contains the substring |
| `name:features,team-picker` | comma list of substrings, OR-matched |
| `set-attributes-edit,team-picker` | bare comma list ⇒ name match |
| `grep:cards-.*custom` | case-insensitive regex over flow paths |
| `/cards-.*custom/` | regex, slash-wrapped shorthand |

```bash
npm run test:e2e:plan -- name:set-attributes-edit   # preview the plan
npm run test:e2e:pick -- name:set-attributes-edit   # run it
npm run test:e2e:pick -- /parallel-grouping/        # run all parallel-grouping flows
```

**`:pick` runs exactly what you named — it does not seed for you.** A
`set-selector` flow needs the DB seeded before it can run, so seed once, then
run whatever you want as often as you want:

```bash
npm run test:e2e -- setup    # runs e2e-baseline.sh reset + flows/setup.yaml
npm run test:e2e:pick -- name:<your-flow>
```

Only one env var affects what gets run:

| Env var | Effect |
| --- | --- |
| `MAESTRO_SKIP_BOOTSTRAP=1` | skip the Phase 0 per-worker credential bootstrap (use only when worker creds are already seeded) |

Typical fast local-iteration loop on one flow:

```bash
# Once: seed the deployment.
npm run test:e2e -- setup

# Then re-run the target as often as you like; skip the bootstrap after the
# first pass, since the worker's credentials are already saved.
MAESTRO_SKIP_BOOTSTRAP=1 MAESTRO_PARALLELISM=1 \
  npm run test:e2e:pick -- name:set-attributes-edit
```

> ⚠️ The setup track **wipes the target Convex deployment's set-builder
> tables**. Since NEO-214 that wipe is a scripted command
> (`e2e-baseline.sh reset`, run by the smoke script's setup mode *before*
> `setup.yaml`) rather than a button the flow clicks — the Admin Tools panel it
> used to click is gone from `/admin/set-builder`. So point `VITE_CONVEX_URL` at
> a **disposable preview** (your PR's Convex preview), never shared `dev`. Only
> `test:e2e -- setup` resets; a `:pick` re-run never does, so iteration loops
> keep the baseline you seeded.

## What's intentionally divergent (cross-platform coverage)

Mac local ↔ Linux CI is a **feature**: it surfaces platform-specific
rendering and OS-level quirks that a single-platform pipeline would miss.
These differences are *not* bugs to fix:

| Axis | Local (Mac) | CI (Linux) | Why we keep both |
| --- | --- | --- | --- |
| Chromium build | macOS Chrome (system) | Linux Chrome via `browser-actions/setup-chrome@v1` | Different rendering engines surface different layout bugs |
| Scrollbar geometry | macOS overlay scrollbars (0 px width) | Linux WebKit-style (~15 px width) | Layout that hides under the macOS overlay can clip Linux content |
| Viewport | macOS Chrome default | Xvfb-driven Linux Chrome | Catches OS-specific font / DPI / animation timing differences |
| OS rendering | macOS Skia + Quartz | Linux Skia + libgbm | Subpixel anti-aliasing, font fallback, and animation easing differ |

A flow that passes on Mac but fails CI is *useful signal* — the bug exists,
just only on Linux Chrome. Don't chase Mac↔Linux divergence away; chase
which axis the divergence is on.

## What's pinned (must match)

These axes drift silently if not pinned. We treat any mismatch as a setup
bug, not a flow bug:

| Axis | Source of truth | Enforced by |
| --- | --- | --- |
| Maestro CLI version | `.maestro/version` | `setup-maestro.sh`, CI's install step, `test:e2e:check` |
| Java major version | `.java-version` | `setup-maestro.sh`, CI's `actions/setup-java`, `test:e2e:check` |
| Chrome build (local) | `.maestro/chrome-version` | `lib-e2e-chrome.sh` (hard gate in every local runner), `test:e2e:check` |
| Worker parallelism | `MAESTRO_PARALLELISM=3` | CI workflow, `test:e2e:like-ci` |
| Convex DB state at "setup-done" | scripted `e2e-baseline.sh reset`, then `setup.yaml` | `run-e2e-smoke.sh` setup mode |
| Flow ordering | seed first, then anything | CI's NEO-49 work queue; locally, `test:e2e -- setup` then everything else |

## Troubleshooting: "passes locally, fails CI" (or vice versa)

Work through these in order. Most local↔CI divergence falls into the first
two buckets.

1. **Pin drift.** Run `npm run test:e2e:check`. If it complains, fix that
   first; reproducing CI on a drifted environment is impossible by
   construction.
2. **Missing baseline.** The flow needs seeded data that isn't there — locally
   because `test:e2e -- setup` wasn't run (or was run against a different
   deployment), in CI because the pre-matrix `seed` job failed. Check the seed
   job / your own setup run before reading anything into the flow's failure.
3. **JVM crash on macOS (Maestro 2.6 + OpenJDK 23).** Symptom:
   `hs_err_pid*.log` in cwd, flow stops mid-execution with no failure
   assertion. Fix: switch to Java 21 (`.java-version` and `.sdkmanrc`
   already pin this; use jenv or sdkman to honor them). Note Java 21 gets
   flows to *start*, not to *pass* — item 3b is a separate fault.

3b. **Everything below the fold is "missing" locally (NEO-138).** Symptom:
   assertions near the top of the page pass, anything lower fails, and even
   `scrollUntilVisible` with a 20s budget can't find it. Before forming any
   hypothesis about the flow or the product, check the geometry:

   ```bash
   grep heightPixels= maestro-report/debug/<flow>/maestro.log
   sips -g pixelHeight maestro-report/debug/<flow>/screenshot-❌-*.png
   ```

   `heightPixels=1` and a 1×1 PNG mean Maestro is driving branded Chrome's
   omnibox popup instead of the tab. Fix: `npm run test:e2e:check`, then
   `./setup-maestro.sh`. The runners gate on this now, so it should only be
   reachable by overriding `SE_BROWSER_PATH` by hand.
4. **Convex preview state leaks across CI runs.** Per-PR Convex previews
   persist for the life of the PR. The scripted reset that runs before
   `setup.yaml` wipes `selectorOptions`, `cardChecklist`, `players`, and
   `teams`. If a flow expects truly fresh state in some other table, either add
   it to `selectorOptions:resetSetBuilderDataFromCli` (the internal action the
   script calls — there is no public reset any more) or use unique values per
   run (`${TEST_USERNAME}` is timestamp-based per CI run).

   Note what that wipe means for `teams` and `players`: they are **empty at the
   start of every run**, and no flow seeds a shared fixture into them (NEO-214
   deleted the "Seed Test Teams" button and the mutation behind it). A flow that
   needs a team or a player creates its own, named per **worker and attempt**,
   through the product's own screens — `/admin/players` for a player and its
   career stints, TeamPicker's "+ New team" row and the New Team dialog it
   opens for a team, `/admin/teams` for
   that team's colours. Worked examples:
   `admin/player-management-add-and-career-history.yaml`,
   `spine-label/player-team-colors-default-to-longest-tenure.yaml`,
   `set-selector/team-picker.yaml`. Per-attempt is not belt-and-braces: the
   picker offers "+ New team <name>" only while no team of that name exists, so a
   name a previous attempt left behind renders "Add <name>" instead and the
   create step reaches for a control that is not there.
5. **Intentional platform divergence.** If you've ruled out 1–4, you're
   probably looking at a real Mac↔Linux Chrome difference — that's the
   coverage we want. Reproduce by reading the bounds out of the CI
   artifacts (`maestro-report/debug/<flow>/maestro.log`) and comparing to
   what the same step does locally. Common culprits:
   - **Scrollbar occlusion.** Linux scrollbars are ~15 px wide and can sit
     over interactive elements. Anchor scroll on something below the
     scrollbar or use `centerElement: true`.
   - **Sticky-header occlusion.** The 64 px sticky `binder-header` (z-20)
     absorbs taps to elements at y < 64. Always center scroll targets
     mid-viewport, not at the top edge.

## Re-running a red E2E (NEO-187)

**`gh run rerun <id>` works.** The work-queue is keyed by run id **and run
attempt**, so a rerun seeds a fresh queue and genuinely re-executes every flow.

This was not always true. Before NEO-187 the queue was keyed by `github.run_id`
alone, which is *stable across attempts* — so a rerun re-entered the queue it
had already drained: `seedQueue` answered `alreadySeeded`, every row was already
terminal, no runner could claim anything, and the gate re-read the same
`failed: 1` and exited. It took about five seconds and re-ran nothing, which
looks exactly like a real, reproducible failure. If you are on a branch that
predates this fix, only a fresh push re-runs flows.

Two things worth knowing:

- **Use a full rerun, not `--failed`.** A failing *flow* is recorded in the
  queue, not in a job's exit code, so the runner job that executed it
  **succeeded**. `--failed` therefore re-runs only the aggregate `e2e` gate —
  which re-reads the queue and fails identically.
- **A rerun cannot fix a broken preview.** If the Convex preview or the Vercel
  preview is the problem, only a new commit forces fresh ones. See
  `.github/workflows/preview-cleanup.yml`.

**When the flow is genuinely broken rather than flaky.** A rerun re-executes,
it does not forgive: the gate still requires every queued flow to have passed
*and* the queue to be fully drained (`pending == 0`, `running == 0`, and no
hard-failed runner job). So a real failure just fails again, and a runner that
died holding a claimed flow still fails the gate rather than passing quietly.
Reruns are for flakes — if a flow fails twice, fix the flow. Reach for
`test:e2e:pick` to iterate on it locally (see above) rather than burning
further CI attempts.

## Flow rules R1–R10

Every flow satisfies all ten. Flows cite them by number in comments
(`# R8 …`), so the numbering is stable; a flow that violates one is not
done. They came out of the NEO-46/47/49 stabilisation and were restated in
NEO-239 vocabulary (rows either carry marketplace ids or they do not; there
is no "custom" concept).

**R1 — Validate one clear product feature.** The `name:` and a top comment
state the single user-facing feature the flow proves. If it does not fit one
sentence, split the flow.

**R2 — Assert that, and only that; no silent fall-through.** The flow must
fail if the feature is broken. A `when:` branch or conditional `runFlow`
that wraps the core action needs a hard `assertVisible` of its precondition
before it and a hard assert of the result after it; a flow that can go green
without exercising its feature is a false positive. Do not pile on
unrelated assertions either.

**R3 — Reuse shared logic; never duplicate another flow.** Drive navigation
through the shared utils (R9) and confirm no existing flow already proves
the same thing. Deleting or merging a flow is propose-and-wait, never
autonomous, and retiring a flow requires replacement coverage first:
removing E2E flows without a replacement is eliminating tests.

**R4 — Flows never log in in-body, but keep the sign-in entry URL.**
Authenticated flows enter through the top-level `url:`
`/testing/sign-in?redirect=<route>&worker=${WORKER_INDEX}`; that is the
per-flow Clerk handshake and it stays. Banned is any in-body re-login,
credential setup or re-seed step: flows rely on the Phase-0 worker bootstrap.
Public `home/*` flows enter signed out (`launchApp: { clearState: true }`);
`util-*` sub-flows run inside a parent's session and enter directly.

**R5 — Everything reacts within Maestro's 7 s default.** The only longer
waits: a step that directly drives a live BSC/SportLots round-trip on data
that is not pre-synced, the setup track's cold sync, and the post-`launchApp`
heading gate (see "Launching a flow" below). A slow non-marketplace response
is a product finding to raise, never a timeout to inflate.

**`flows/setup.yaml` is exempt as a class, and that is not a loophole.** R5
already names "the setup track's cold sync" as a sanctioned exception, and the
seed is the one flow that reseeds from empty — so every step in it runs the COLD
path, behind a live marketplace round-trip, on data no earlier flow has warmed.
It is a data-loading track, not a user-facing interaction, so the 7s bar does
not apply to it and its timeouts stay at their measured cold-path values.

NEO-260 learned this the hard way: the suite-wide 7000 sweep took the seed with
it and the seed then failed at `.*Re-map Base.*` in CI runs 34394655674 and
34400136389. The sweep had measured that step at "worst 0.5-4s" from green runs
where the mapping had **already** landed, i.e. it measured the warm branch and
applied the number to the cold one. **Measuring a step tells you nothing until
you know which branch the measurement came from.** Every seed timeout is now
back at its pre-sweep value.

**But the timeout was not what failed that step, and the record should say so.**
The first reading of run 34394655674 — that the tap on `Confirm Base Set`
completed at 19:37:50 and the button "had still not flipped" fourteen seconds
later — is wrong, and both failure hierarchy dumps disprove it. Each shows root
bounds `[0,-680][1009,625]`, i.e. the page pinned at MAXIMUM SCROLL, with
`Set attributes panel` as the first thing on screen at y=49 and its
`Clear base set from Base` control present: the mapping had landed, the button
read `Re-map Base`, and it was simply ABOVE the top of the viewport. The step
scrolls DOWN, and `scrollUntilVisible` with `direction: DOWN` only ever travels
away from an anchor that sits above the current position — so it burned all
60s in 29 `ElementNotFound` retries on an element that was rendered the whole
time. The seed's exemption and its 60000 stand; the *direction* was the bug, and
that step now scrolls UP. See the next rule.

**A `scrollUntilVisible` must never depend on the document bottoming out.** That
seed step passed for months only because the page ran out of scroll before the
anchor left the viewport — measured at y=4 in green run 34361627641, four pixels
of slack that no flow states and nothing defends. NEO-260's 208px spacer gave
every page exactly 208px more travel and the slack was gone. So: before you
write a `direction:`, say where the PREVIOUS step leaves the page and where the
anchor sits relative to it in DOM order — `components/modules/SetSelector.tsx`
renders selector columns → base-mapping button → `MultiSourcePanel` →
`SetAttributesPanel` → `CardChecklist`, and `EntityColumn` puts each column's
`Add custom …` button below every row in it. An anchor above the current
position takes `direction: UP`; it is not a style choice. A DOWN scroll toward
an anchor above the page's position cannot fail *safely* either: it drives the
page to the bottom and then accepts whatever is still on screen, after paying
the full six-iteration give-up path on every run.

**`scrollUntilVisible` is the trap: its own default is 20000, not 7000.**
`ScrollUntilVisibleCommand.DEFAULT_TIMEOUT_IN_MILLIS` is the string `"20000"`
in the pinned `maestro-orchestra-models.jar` — verified by decompiling it,
not by reading the docs. So a scroll step with no `timeout:` is running at
**twenty seconds**, the loosest setting in the file, not the 7 s default the
rest of this rule describes. Every `scrollUntilVisible` therefore states
`timeout: 7000` explicitly; omitting the key is a violation of R5, not a way
of complying with it. Before NEO-260 most of the suite was getting 20 s by
omission.

**Anything above 7000 needs Jason's sign-off, recorded at the site.** Jason,
2026-09-09: "our rule is the 10s default on any user facing interaction
unless I've explicitly ok'd it. We need to be strict about that rule. That is
what ensures our UI is actually usable not just functional." Asked which
number was canonical he chose 7 s — R5's existing one. A longer ceiling is
allowed only for the three exceptions above; the comment at the step names
which one and why. Anything else that will not fit in 7 s is a bug report,
not a bigger number.

**A sign-off recorded AT THE SITE is the only sanctioned way for an in-app
step to exceed 7000.** Not a number chosen because it passed, not one
inherited by omission, and not a rule in this file: the step's own comment
carries the date, that Jason approved it, the measurement that justifies the
figure, and what would void it. Jason signed off the first such budgets on
2026-09-09 (NEO-260) — twelve steps whose cost is page-length TRAVEL rather
than UI response: a `scrollUntilVisible` walking a seven- or eight-screen
marketing page pays the driver's fixed ~2.2 s per swipe + view-hierarchy read
before the target is ever seen, never enters the centring give-up path, and
waits on nothing the product could make faster. Read one of those comments
(`home/easypost-setup.yaml`, `home/landing-smoke.yaml`) before writing a new
one; each says that shortening the page brings the budget back to 7000 and
that raising it further is a new decision, not a tuning knob. A step that is
merely slow still does not qualify — that is the bug report.

**Where a step really does wait on one of those exceptions, split it.** The
wait and the scroll are different jobs and want different ceilings: put a long
`extendedWaitUntil` GATE above, named for what it is waiting on, and leave the
`scrollUntilVisible` under it at 7000 to do nothing but centre. The gate fails
loudly on the thing that was actually slow, and the scroll goes on measuring
the UI. Keep the long ceiling on the scroll itself only when the target can be
scroll-clipped — `extendedWaitUntil: visible` never scrolls, so it cannot
recover an element under the fold — and say so at the step.

**7 s across the board on every centred scroll — there is no holding pen.**
Jason, 2026-09-09, on the sites this audit had parked at 10000 pending his
sign-off: *"lets make 7s across the board. I don't think there should be
anything hitting a give up on a regular basis, if there is then its not
really doing anything is it?"* That is the whole rule, and it is a statement
about the product, not about a number. A centred scroll that fails to centre
does not run slow — it runs a fixed give-up path and then accepts the element
it could already see (R8 has the mechanism), so a step that reaches that path
on every run has been paying for centring that never centres. Raising its
ceiling buys nothing: the step still does not centre, the suite still pays
for the attempt, and the UI is exactly as unusable as it was.

So a centred scroll has exactly two honest states, and both are `timeout:
7000`:

1. **It centres.** Either it always did, or a product fix gave the document
   the scroll headroom it was missing (R8 case 1). Name the dependency in the
   comment at the step, so whoever touches the layout knows what rides on it.
2. **It cannot centre, and centring buys nothing there.** Remove
   `centerElement` (R8 case 2, with the measurement it demands). Uncentred,
   the step settles in well under a second.

There is no third state. An explicit 10000 "until the product fix lands" is
not a compromise, it is the give-up path with a bigger allowance, and it is
what this rule now forbids. If a centred step cannot be put into one of those
two states, it is a bug report.

**The measurement behind that.** Across the 83 give-up steps in green CI run
34361627641 the minimum was 7.007 s and none finished under 7 s, with or
without `waitToSettleTimeoutMs`. `timeout: 7000` is therefore a binary canary
rather than a stopwatch: a centred step either centres or fails. That is the
property that makes it worth having.

**R6 — No redundant `assertVisible` after `scrollUntilVisible`.** The scroll
already asserts the element; a trailing assert of the same element is dead
time. Asserting a different element is fine.

**R7 — No destructive data actions.** Never clear credentials without
restoring them, never delete or overwrite shared data, never wipe. The
global reset is not a flow step: since NEO-214 it is the scripted
`e2e-baseline.sh reset` the smoke script runs before `setup.yaml`, and
`setup.yaml` documents its removal. A flow that leaves a worker's state
degraded poisons every later flow that worker claims off the queue.

**R7a — Sets that carry marketplace ids are read-only and sole-writer;
writes go to a per-worker hand-made set.** `SET-REGISTRY.md` is the
authority: it lists every real set the suite touches, who provisions it and
which single flow may write to it. No other flow may add, edit or delete
cards, players, teams or variants on a registered set. Runners drain one
shared queue concurrently against one Convex preview, so a write to a shared
set is visible to whatever else is running; `ATTEMPT_ID` protects against
prior runs, not concurrent workers. To write, create a hand-made set (no
marketplace ids, so it costs no sync) under real ancestors, suffixed
`-${WORKER_INDEX || 0}`, and register the prefix in `SET-REGISTRY.md` in the
same commit. Never attach a marketplace to a hand-made row and never "Add as
New" on a real set's children. Adding a new real set needs explicit owner
approval every time: propose and wait. A constraint that seems to force a
write to a real set is a finding to raise, not a licence.

**R8 — `centerElement: true` on every scroll that precedes a tap.** The
headless viewport is 1024×629; a target left at a viewport edge shifts out
from under captured coordinates on re-render. There is no app footer and no
"footer-steal zone"; the real occluders are the sticky binder header at the
top and the `BinderTabs` rail on the right edge. A dropped tap is diagnosed,
never attributed to a footer. Centring is still the default and still the
goal.

**What centring costs when it works, and when it doesn't.** With
`centerElement` on, `Orchestra.scrollUntilVisible` re-reads the view
hierarchy up to six times (`Scrolling try count: 0`..`5`), swiping between
reads, then gives up and accepts the element it can already see. The
`timeout` is checked at the *bottom* of that loop, so a ceiling shorter than
the give-up cost turns a graceful give-up into `No visible element found` on
an element Maestro just logged at `Visibility Percent: 1.0`. A target that
centres exits at try 0 or 1 and costs 0.5–2.9 s. A target that cannot centre
costs the whole budget: measured across the 83 give-up steps in green CI run
34361627641, minimum 7.007 s, median 7.19 s, maximum 9.48 s — and
`waitToSettleTimeoutMs` made no difference, because the cost is five swipes
at `scrollDuration=601` plus six hierarchy reads either way.

**A centred step that runs long is a product finding, never a bigger
ceiling.** There are exactly two legitimate remedies.

1. **Make it centre.** A target parked at maximum scroll and still below the
   band is missing scroll headroom: the document cannot scroll far enough.
   That is the product's bug and the product's fix. `id: "Edit attributes"`
   (the collapsed `SetAttributesPanel` summary bar) is the worked example —
   the panel is the last thing on the page, maximum scroll left it at y=518
   in the 625px viewport while the centre band ends at ~375, so every one of
   those steps burned the full give-up budget on every run.

   It was never a set-builder problem. Every page in the app bottomed out
   with its primary action jammed against the fold, between y=469 and y=569
   at rest, which is why the same signature showed up on the first
   `EntityColumn`'s `+ Custom` (y=514), on an empty checklist's `Fetch from
   Marketplaces` (y=497) and on a `Rename …` control (y=516-518). The fix is
   one 208px spacer below every page in the signed-in shell
   (`src/layouts/binder-layout.tsx`), sized from that window: it needs
   `H >= 569 - 375 = 194` to lift the lowest-parking control into the band
   and `H <= 469 - 250 = 219` not to push the highest one out the top. Read
   the note on that component before changing it — overshooting fails
   exactly as hard as undershooting, and a `vh` value re-creates NEO-255
   (50vh is 313px here, one whole driver swipe). Do not add a second helping
   in a page: it stacks. The flows then centre in one or two swipes, inside
   R5's 7000, and every such step says in its comment that it depends on the
   spacer.
2. **Stop centring where centring cannot work.** If a swipe cannot move the
   target *at all*, centring buys literally nothing and only spends the
   budget. SHOW that before claiming it: `Element bounds` identical from
   `Scrolling try count: 0` through `5` with no first-swipe movement, plus a
   structural reason — the element sits outside the page's scroller, e.g. a
   footer in a `fixed inset-0` dialog whose body is the only thing that
   scrolls (`ReconciliationModal`, `ParallelGroupingModal`, `BaseSetPicker`,
   `CardDetailPanel` and the `CardFeaturesEditor` inside it), or a page with
   no scrollable overflow at all. Record the measurement in a comment citing
   this rule. Uncentred, those steps settle in well under a second.
   `multi-source-panel-opens-dialog.yaml`'s dialog-footer `Cancel` is the
   original worked example (`y=529`, unmoved across five swipes).

Frozen bounds alone do not prove case 2 — a target already at maximum scroll
shows the same signature. If any other sample of the same element moves on
the first swipe, it is case 1. So does a target inside a *second* scroller:
maestro-web's only scroll is `window.scroll`, so an element in a nested
`overflow` box (react-virtuoso's fixed-height list in `CardChecklist`, which
has no `customScrollParent`) never moves because the driver asked its list to
move — it moves, or does not, because the window did. That still makes it
case 1: give the window headroom and the whole box travels with it. Case 2 is
only for an element the window cannot move at all, which in practice means
`position: fixed`.

**The band Maestro will actually accept is wider than the ~312 midpoint
suggests — measured, not assumed.** Across the 2,396 centred DOWN scrolls in
four green CI runs (34304943765, 34349299679, 34361627641 and its rerun), the
lowest give-up sat at an element *centre* of y=464, with clean accepts spread
right across 130-432. So the working test for "will this centre" is the
element's centre against ~460, not against the ~250-375 window a strict
reading of "centre band" implies. It matters at the deep end: the NEO-260
spacer leaves `spine-label`'s "Add to sheet" at centre 377 — outside the
narrow window, but 87px clear of the nearest observed give-up, and therefore
safe rather than marginal. Measure the centre (`y + height/2`), not the top
that `Element bounds` logs.

**An earlier NEO-260 revision of this rule got this wrong, and the record
should say so.** It read "**And when you do centre, give the step
`timeout: 20000` or more**", and 46 sites across nine flow files were raised
to 20000 on that basis. It was wrong twice over. It contradicted R5, which
sits fifty lines above it and sets 7 s as the bar. And it treated the give-up
cost as a budget to fund rather than as the symptom of a page that cannot
scroll far enough: raising the ceiling hid the give-up path instead of fixing
it, so the suite paid ~7.2 s per affected step on every run and the UI stayed
as unusable as before. Jason ruled on 2026-09-09 that R5 as written is
canonical. The mechanism that revision described was right; only its remedy
was wrong.

One more measurement worth knowing before you tune a number:
`visibilityPercentage` is effectively **boolean** in Maestro 2.8 —
`visibilityPercentageNormalized` integer-divides by 100, so `50` and `10`
behave identically to `1`.

**R9 — All set-builder drilling goes through the drill utils.** Use
`util-drill-to-2024-topps-chrome`, `util-drill-to-base-variant`,
`util-drill-to-custom`, `util-drill-to-custom-set` or
`util-drill-to-cold-real-set` via `runFlow`; never hand-roll a
Sport → Year → Manufacturer → Set → Variant drill inline. A flow targeting a
genuinely different set with unique picker asserts may diverge and must say
why.

**R10 — No waits that synchronise nothing.** A `when: { notVisible: X }`
guard on an element that is normally present polls the full 7 s every run; a
create-or-fallback branch that runs when the entity already exists and a
settle right after an action are the same dead time. Remove them. The
residual ~2 s per tap is the driver's hierarchy wait and is not tunable
from YAML.

### Companion rules

Each of these has its own section in this file or a memory entry; they are
listed here so a flow author meets them in one place.

- **Fixtures come from the UI.** A flow creates the data it needs through
  the product (New Team dialog, set builder, checklist). The one scripted
  exception is `/testing/seed-credentials` (see "Worker-state seeding").
- **Minted names are single tokens** built with `${ATTEMPT_ID}`, never
  `output.ATTEMPT_ID` and never hyphenated: `teams.search` is a Convex SEARCH
  index matching TOKENS split at non-alphanumerics, so `TLF-9351` tokenises to
  ["TLF","9351"] and collides with every persisted team starting `TLF`. This
  holds for **every** minted name without exception. There is no delete-team
  affordance in the app — the picker's `Remove team <name>` *unlinks* a team
  from a card and the row survives — so nothing a flow creates is removed
  within the run that created it. `e2e-baseline.sh reset` wipes teams once at
  the START of each run, which is no help against the run they were minted in:
  a pool of runners drains one shared queue against one Convex preview, so
  every minted team is visible to every other flow for the whole run. That is
  what broke CI run 34050688656. Derive the token with the blessed idiom —
  `evalScript: '${output.ATTEMPT_TOKEN = String(ATTEMPT_ID || Date.now()).split("-").join("")}'`
  — which folds the runner index inside the single token. **The two runners
  spell `ATTEMPT_ID` differently**: CI's queue runner builds
  `r<n>-a<attempt>-<random>` (`run-e2e-queue.sh`), the local smoke runner builds
  `w<worker>-a<attempt>-<random>` (`run-e2e-smoke.sh`). The hyphen-strip idiom
  is indifferent to that, but anything that RECONSTRUCTS a prefix from
  `${WORKER_INDEX}` matches nothing in CI — so never rebuild the token by hand. (`output.ATTEMPT_TOKEN` is a value the
  flow sets itself, which is fine; the banned one is `output.ATTEMPT_ID`, a
  binding the runner never populates.)
- **`pressKey` needs a unique, user-visible handle** on its target — an
  accessible name, never a DOM `id` (own section below).
- **Prefer `openLink` over tapping a link** to reach a page (own section).
- **Gate flow launch on the destination heading** (own section).
- **Tags** are `smoke` (the fast subset), a grouping tag such as
  `set-selector` or `profile`, and the three the runner treats specially:
  `util`, `wip` and `setup`. There is no smoke-plus-feature pair per flow.
  **There is no `regression` tag** — it was deleted suite-wide in NEO-260
  because `smoke` and `regression` had drifted into disjoint sets with 38
  flows in neither, while `npm run test:e2e` already runs everything. The
  full suite is `test:e2e`; `smoke` is the only subset. Never add `wip`: fix
  the bug instead (`config.yaml` excludes `util` and `wip`).
- **Run only the flows you changed, against the PR's Convex preview**, with
  `npm run test:e2e:plan -- name:<flow>` then `test:e2e:pick`. Never the
  full suite locally unless the change is to the harness itself, and never
  against shared dev (see the wipe warning under `test:e2e:pick`).
- **An environment stall is not a flow bug.** One timeboxed check with the
  renderer test in "The macOS renderer stall" (NEO-258), then stop: push and
  let CI validate, and report what you measured. Never change app or flow
  code to appease local Maestro.
- **A red CI flow** is re-run per "Re-running a red E2E (NEO-187)"; a full
  rerun, not `--failed`, when the failing flow lived in a runner job that
  succeeded.

## Navigation in flows: prefer `openLink` over tapping links

**Tapping an element that triggers a page navigation can crash maestro-web
intermittently** — upstream bug
[mobile-dev-inc/maestro#2944](https://github.com/mobile-dev-inc/maestro/issues/2944)
(open as of 2026-06). After every `tapOn`, maestro-web re-parses the DOM to
confirm the UI settled; if the tap kicked off a client-side navigation that
tears down the page mid-parse, an unguarded cast in `CdpWebDriver` throws
(`LinkedHashMap cannot be cast to String`, or our variant
`null cannot be cast to non-null type kotlin.Int`) and the flow dies with a
generic **"Unknown error"**. It's a *race* — passes most of the time, fails
intermittently. Example: `profile/fill-profile-data` passed 7/8 overnight, then
crashed on `tapOn "View your profile"` (CI run 27905676068).

| Intent | Do | Why |
|---|---|---|
| Navigate to reach a page (most cases) | `openLink: ${APP_URL …}/path` | Deterministic, faster, no post-tap DOM-parse race |
| Verify a link points to the right place | `assertVisible` its href/text, then `openLink` to the target | Tests "wired correctly" + "target renders" without the racy click |
| Exercise a click *handler* with real logic (guards, side effects, modals) | actually `tapOn` | Here the click IS the behaviour under test — accept retry / mitigate |

Navigation is usually a *means*, not the thing under test — when it's a means,
`openLink` is strictly better. You only need a real click when the handler does
something beyond plain navigation; for a plain `<a href>` you lose nothing by
navigating directly. **Watch #2944**: once it's fixed and we bump maestro, real
click-navigation becomes reliable and this convention can relax.

## Anything a flow drives with `pressKey` needs a unique, user-visible handle

## Asserting inside a dialog: header and footer only, never the body

**`maestro-web` scrolls with `window.scrollTo`, which cannot drive an inner
`overflow-y-auto` box — so anything below the fold inside one is unreachable by
any scroll a flow can perform.** The entity-review wizard is the shape that
bites: a fixed-height flex column of a `shrink-0` header, a
`flex-1 min-h-0 overflow-y-auto` body, and a pinned footer. The header and the
footer are always on screen; the body is whatever height the current step wants,
and on a tall step (a Possible-matches panel plus a whole New Team form) its
lower half is simply gone.

So: **assert only on the pinned header and footer.** They carry everything a
flow needs — `Confirm New Players & Teams`, the `N of M reviewed` counter, and
every decision control. Body content is for the operator to read.

Two runs paid for this rule. CI 34007264279 killed a `tapOn` outright
(`null cannot be cast to non-null type kotlin.Int`) when a step's primary action
grew past the dialog's own bottom edge — which is why the decision controls now
live in the footer. CI 34071657961 then failed
`inserts-1996-score-one-nb-set-two-bsc-sources` on `Decided (1)`, a disclosure at
the bottom of the body, with a count that was entirely correct; the header's
`1 of N reviewed` is the same number (`decided` and `decidedRows` are the same
`rows.filter(r => r.decision)`) and cannot move.

The same rule applies to any inner scroller — a `max-h-*` picker group, the
admin master lists — with the softer conclusion that you must get the target
into the box's own visible slice (filter or narrow it) rather than scroll to it.

## Anything a flow drives with `pressKey` needs a unique DOM id

**maestro-web does not send the key to `document.activeElement`.** It runs
`createXPathFromElement(document.activeElement)`, then RE-FINDS the element by
that XPath and dispatches to whatever the XPath matches. The generator uses
`id("…")` when the element has a DOM id and otherwise falls back to
`tag[@class="…"]` for each ancestor.

So two identically-classed siblings collapse into one XPath, Selenium returns
the **first**, and the key lands on the wrong control — with the app's own focus
perfectly correct, which is what makes it so confusing to read from a
screenshot. NEO-220 hit exactly this: the wizard's `Confirm & Save` and its
`Cancel (Esc)` sibling are both `NeonButton`s with the IDENTICAL class string
(the neon colour is a `data-accent-color` attribute and an inline style, not a
class), so `pressKey: Enter` aimed at Confirm pressed Cancel, and the failure
screenshot showed "Discard 1 decision?" while focus was on Confirm.

**The rule — and it is not what this section used to say.** Jason, 2026-09-09
(NEO-260), verbatim: *"NEVER USE AN ID VALUE, USE ONLY THINGS VISIBLE TO USER. I
do consider an aria label visible to the user."*

So the remedy is **never** a DOM `id`. A DOM id is invisible to a sighted user
and to a screen reader alike; targeting one lets a flow pass while the real
experience stays broken, which is the opposite of what these tests are for. Note
that most `id:` selectors in this suite are already matching an **aria-label**,
not a DOM id — the driver resolves `resource-id = node.id || node.ariaLabel`, so
`id: "Search teams"` is the accessible name. That is correct and stays. Adding a
real DOM id to such an element *replaces* the handle every flow targets by, and
silently breaks them.

When two identically-classed siblings collapse into one XPath, fix it in
**product code**, two changes together:

1. **Give them distinct accessible names**, so a screen-reader user can tell
   which button they are on — `aria-label="Create team"` and
   `aria-label="Back to team search"`, not two bare `Create`/`Back`. Then target
   the accessible name from the flow.
2. **Make the control genuinely keyboard-operable** — real Enter handling at the
   level that makes sense (form or column submit), so the right thing happens
   regardless of which node an XPath re-find resolves.

Both are product requirements already: CLAUDE.md's UI section says every flow
must be fully operable from the keyboard. The collision is the test telling you
the app has an accessibility gap, so close the gap rather than routing around
it.

**What makes the XPath itself resolve is a marker class, not an id.**
`src/hooks/useFieldTestClass()` returns a document-unique class
(`mb-field-<useId>-btn-confirm-save`); spread it onto each colliding sibling's
`className` and each generated XPath names exactly one node. A class never
touches `resource-id`, so the accessible name stays the handle. See
`components/SetSelector/EntityColumn.tsx` for the worked pair — one marker class
plus one distinct `aria-label` per button.

`components/SetSelector/EntityReviewWizard.tsx`'s `Confirm & Save (Enter)` used
to carry a real DOM id (`entity-review-confirm-save`) as its handle. NEO-260
**converted it**: it and its `Cancel (Esc)` sibling now each carry a
`useFieldTestClass` marker class and their own `aria-label`, and no DOM id. No
flow changed — both were always targeted by `text:`, which reads the button's
visible words.

Two corollaries worth knowing before you write the selector:

* **A synthetic KeyboardEvent has no default action.** `dispatchEvent` runs the
  listeners and stops, so a focused `<button>` is NOT activated by
  `pressKey: Enter` the way a real keypress activates it. Something has to
  handle Enter explicitly. Every other Enter in this suite is aimed at an
  `<input>` whose own handler does the work, which is why this only ever bites
  on buttons — and it is a second reason the fix belongs in product code.
* **Two controls whose labels share a prefix are a hazard — but anchor the
  matcher, do not assume the match is loose.** This bullet used to say `id:`
  selectors are unanchored FINDS, so that `id: "Remove Topps"` also matched
  `Remove Topps Chrome`. That is not what the pinned CLI does: decompiling
  `maestro.Filters` out of `~/.maestro/lib/maestro-client.jar` (2.8.0, the
  version CI runs) shows `idMatches` and `textMatches` both calling Kotlin's
  `Regex.matches(CharSequence)` — a FULL match of the whole attribute — and
  `Orchestra` hands the pattern to `StringUtils.toRegexSafe` with no `.*`
  wrapping. `id:` is checked twice, against the raw `resource-id` and against
  its `substringAfterLast('/')`, and both are full matches. So `Remove Topps`
  does NOT match `Remove Topps Chrome` on this version.

  Something evidently bit whoever wrote the original — a different CLI version,
  or another filter in the same selector — so treat the HAZARD as real and the
  MECHANISM as the decompiled one: when a screen can hold two instances of the
  same control, give them labels that share no substring, or write the matcher
  anchored (`^…$`), which is a no-op under full-match semantics and correct
  under either. Do not reach for `.*…*` defensively; that genuinely is loose.

## Launching a flow: always gate on the destination heading

Almost every flow's `url:` is **not** the page under test — it's
`/testing/sign-in?redirect=…&worker=N`, which renders only
`[testing] <status>` while it completes a Clerk testing-token round-trip and
*then* redirects. So the first command after `launchApp` must be an
`extendedWaitUntil` on the destination heading, never a bare `assertVisible`
and never a `tapOn`:

```yaml
- launchApp
- extendedWaitUntil:
    visible: ".*Build set parameters using marketplace APIs.*"   # the destination panel, not the bootstrap
    timeout: 45000
```

> **NEO-155 note.** This example used to gate on `"Set Builder"`, the `<h1>` of
> the old `/set-selector` page. That route now redirects to
> `/admin/set-builder`, whose `<h1>` is the section shell's **"Admin"** and
> whose panel is headed **"Set Builder"** — and *that* string is ALSO the
> sub-tab NavLink, which the layout paints before the panel mounts, so gating on
> it would pass early and race. Every flow now gates on the panel's own subtitle
> instead (`Build set parameters using marketplace APIs …`), which the `/admin`
> hub does not share — its card for the same tool reads "Build set parameters
> **from marketplace data**".

**Pick a marker unique to the destination.** The `[testing]` bootstrap screen
renders nothing else, so *any* app text clears it — but that's a weak gate. The
`"Neon Binder"` header also renders on the signed-out landing page
(`app/landing.tsx`), so gating on it passes even if Clerk bounced you back out;
you then fail on the *next* assertion with only the default timeout. Gate on
something the destination alone has: `"COMING SOON"` for `/dashboard`,
`"Sign out"` for "we are authenticated", `"Profile Settings"` for `/profile`.

**Why 45 s** — `app/testing/sign-in/page.tsx` can, worst case, burn ~22 s
before it even navigates: up to 2 s of anti-thundering-herd jitter, then up to
four `signIn.create` attempts whose rate-limit backoff is
`attempt * 2000 + jitter(0-1000)` (≈3 s + 5 s + 7 s), plus the token fetch and
the Clerk round-trips themselves. Only then does the destination page mount and
run its Convex queries. A bare `assertVisible` gets Maestro's default — measured
at 17.8 s on the NEO-106 failure — which the bootstrap alone can exceed. 45 s
leaves roughly 23 s for the destination to render.

This is the sanctioned exception to the 7 s rule: **short waits everywhere,
long waits only for external fetch/auth.** It is specifically *not* licence to
inflate later in-app steps — once you're past this gate there's no auth
round-trip left, so subsequent navigations keep their normal short timeouts.
`profile/credentials-lifecycle` is the worked example: its post-`launchApp`
gate is 45 s, and its eight in-app `/profile` returns stay at 30 s.

Flows that genuinely launch signed-out (`home/*`, which use a bare `APP_URL` or
`clearState: true`) have no bootstrap and are exempt.

Failures here are easy to misattribute — the flow dies on an unrelated-looking
heading assertion, so on PR #78 it first read as an `actions/setup-java` 4→5
regression. If a flow fails on its very first assertion, check the failure
screenshot for `[testing] …` before suspecting anything else.

## Worker-state seeding

The **setup track** is the seeding infrastructure: the scripted
`e2e-baseline.sh reset` first, then `flows/setup.yaml` for credential save +
drill to 2024 Topps Chrome + Variant Types sync. `run-e2e-smoke.sh` excludes
`setup`-tagged flows from every mode except `test:e2e -- setup`, so the seed
runs once, deliberately, and never as one thread among many (NEO-46). Note that
neither step seeds a team or a player: those tables stay empty until a flow
makes its own per-worker rows (see troubleshooting item 4 above).

Nothing schedules around the seed: run `test:e2e -- setup` first, then run
whatever flows you want.

If you need to manually seed a particular worker's state for a local
repro, just run `setup.yaml` first:

```bash
PATH=$HOME/.maestro/bin:$PATH \
  APP_URL=http://localhost:3000 \
  WORKER_INDEX=0 \
  TEST_USERNAME=neontester-$(date +%s) \
  maestro test --platform web --config .maestro/config.yaml --headless \
    .maestro/flows/setup.yaml
```

Then run the flow you're debugging. If you need a different worker's
state (worker 2 has accumulated state from running parallel-safe flows),
loop the bootstrap + setup + intermediate flows with that `WORKER_INDEX`.
`run-e2e-smoke.sh` automates this when you pass `MAESTRO_PARALLELISM>1`.

### Seeding a fixture that no UI can create (`/testing/seed-credentials`)

Some states cannot be reached by driving the product in test time — not because
the UI is missing, but because reaching them costs real money, real minutes, or
a real third party. A purchase row with USPS scans on it (NEO-121) needs a
label bought with live postage and then three days of USPS sorting; a
`needsReauth` credential needs a session that genuinely exists and is dead.

For those, `/testing/seed-credentials` is the suite's generic **"seed, then
land"** hop, and its `sites` query param is the **selector for what to seed**:

| `sites` value | What it seeds |
| --- | --- |
| *(omitted)* | BSC + SportLots credentials (+ the EasyPost key, when configured) |
| `sportlots` / `buysportscards` | just that platform's credentials — the credential-gate fixtures |
| `label-scans` | one `labelPurchases` row plus a four-scan tracker snapshot, for `labels/scan-visibility.yaml` |

A fixture selector is handled before the credential loop, so asking for it
alone performs **no marketplace login**. The handler lives in
`convex/testing.ts` and writes exclusively through the product's own internal
writers (`shipping.recordLabelPurchase`, `shipmentTracking.applyTrackerSnapshot`),
so the seeded row is sanitised and guarded exactly as production data is — a
flow asserting against it is asserting against what the product would really
render. Every one of these helpers is caller-scoped, idempotent, and fails
closed in production (`TESTING_RESET_SECRET` is unset there).

Nesting the inner query string needs `%26` for its `&`, so the sign-in page
reads the whole thing as one `redirect` value:

```
/testing/sign-in?redirect=/testing/seed-credentials?sites=label-scans%26redirect=/print/labels&worker=${WORKER_INDEX}
```

**Mind which account a fixture lands on.** `resetMyTestState` clears three
per-user tables and `labelPurchases` is not one of them, so a purchase seeded
onto an account is there for good. `scan-visibility` therefore seeds the
worker's MAIN account while `label-history-empty-state` asserts the empty state
on the isolated `new-profile` account — two accounts, two states, neither flow
able to disturb the other.

## Flow ordering

There isn't any, beyond the seed. In CI, the pre-matrix `seed` job establishes
the baseline and the NEO-49 work queue hands flows to a homogeneous runner pool
in no particular order. Locally, `npm run test:e2e -- setup` establishes the
same baseline and then flows run in whatever order the lanes hand them out.

That is a constraint on flows, not a gap in the runner: **a flow must be
self-contained** — it creates and uses its own per-worker data, or reads the
seeded baseline without mutating it. A flow that only passes when some other
flow ran first is a broken flow. Seed, then run whatever you want.
