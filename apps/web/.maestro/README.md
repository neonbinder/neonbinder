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

Bumping any pin is a single PR. After editing the pin file:

```bash
rm -f $HOME/.maestro/bin/maestro   # only if bumping Maestro
./setup-maestro.sh                  # reinstalls to the new pin
npm run test:e2e:check              # verifies installed = pinned
```

CI re-installs from scratch each run, so it always picks up the new pin
without a separate step.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup:e2e` | Install pinned Maestro + Java (idempotent; safe to re-run) |
| `npm run test:e2e:check` | Verify installed Maestro + Java match the pins; print actionable next steps if not |
| `npm run test:e2e` | Run the full suite (smoke + regression) |
| `npm run test:e2e:smoke` | Smoke tag only |
| `npm run test:e2e:regression` | Regression tag only |
| `npm run test:e2e:pick -- <selector>` | Run just a piece of the suite (by name / list / regex / tag) — see below |
| `npm run test:e2e:plan -- <selector>` | Dry-run: print exactly what `:pick` *would* run (incl. pulled-in prerequisites) and exit |
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
| `smoke` / `regression` / `tag:NAME` | flows carrying that tag (bare word ⇒ tag, unchanged) |
| `name:set-attributes-edit` | flows whose **path** contains the substring |
| `name:features,team-picker` | comma list of substrings, OR-matched |
| `set-attributes-edit,team-picker` | bare comma list ⇒ name match |
| `grep:cards-.*custom` | case-insensitive regex over flow paths |
| `/cards-.*custom/` | regex, slash-wrapped shorthand |

```bash
npm run test:e2e:plan -- name:set-attributes-edit   # preview the plan
npm run test:e2e:pick -- name:set-attributes-edit   # run it (+ its cascade)
npm run test:e2e:pick -- /parallel-grouping/        # run all parallel-grouping flows
```

**Prerequisite closure (default ON).** Most `set-selector` flows are tagged
`requires:cards-loaded` (or `requires:setup-done`) and can't run standalone —
they need the `setup → sets → cards` cascade to seed the DB first. `:pick`
automatically pulls in the transitive `provides:` producers for whatever you
select, so a single targeted flow still runs with its data seeded. Controls:

| Env var | Effect |
| --- | --- |
| `MAESTRO_MINIMAL_DEPS=1` | pull only **one** producer per required state (prefers the `cascade`-tagged one) — fastest correct run, e.g. `setup → sets-base → cards-base → target` |
| `MAESTRO_NO_DEPS=1` | pull **no** prerequisites; treat `requires:` as already-satisfied (use only when the DB is already seeded from a prior run) |
| `MAESTRO_SKIP_BOOTSTRAP=1` | skip the Phase 0 per-worker credential bootstrap (use only when worker creds are already seeded) |

Typical fast local-iteration loop on one flow:

```bash
# First run: seed everything, run the target (minimal cascade, single worker)
MAESTRO_MINIMAL_DEPS=1 MAESTRO_PARALLELISM=1 \
  npm run test:e2e:pick -- name:set-attributes-edit

# Re-runs while iterating: skip the cascade + bootstrap, just re-run the flow
MAESTRO_NO_DEPS=1 MAESTRO_SKIP_BOOTSTRAP=1 MAESTRO_PARALLELISM=1 \
  npm run test:e2e:pick -- name:set-attributes-edit
```

> ⚠️ `setup.yaml` calls **Reset Set Builder Data**, wiping the target Convex
> deployment's set-builder tables. Point `VITE_CONVEX_URL` at a **disposable
> preview** (your PR's Convex preview), never shared `dev`. `MAESTRO_NO_DEPS=1`
> skips `setup.yaml`, so re-run loops don't reset between attempts.

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
| Worker parallelism | `MAESTRO_PARALLELISM=3` | CI workflow, `test:e2e:like-ci` |
| Convex DB state at "setup-done" | `setup.yaml` calls `Reset Set Builder Data` | Cascade flow itself |
| Cascade dependency ordering | `requires:` / `provides:` tags | `run-e2e-smoke.sh` topo-sort + cascade-prerequisite check (NEO-23) |

## Troubleshooting: "passes locally, fails CI" (or vice versa)

Work through these in order. Most local↔CI divergence falls into the first
two buckets.

1. **Pin drift.** Run `npm run test:e2e:check`. If it complains, fix that
   first; reproducing CI on a drifted environment is impossible by
   construction.
2. **Cascade flake.** A level-N flow failed (or SIGSEGV'd) and downstream
   flows ran with stale state. Look at the JUnit report for any `FAIL`
   marked `skipped: prerequisite "X" not satisfied` — those are flows that
   were correctly skipped because a producer failed. The actual bug is in
   the producer.
3. **JVM crash on macOS (Maestro 2.6 + OpenJDK 23).** Symptom:
   `hs_err_pid*.log` in cwd, flow stops mid-execution with no failure
   assertion. Fix: switch to Java 21 (`.java-version` and `.sdkmanrc`
   already pin this; use jenv or sdkman to honor them).
4. **Convex preview state leaks across CI runs.** Per-PR Convex previews
   persist for the life of the PR. `setup.yaml` clicks "Reset Set Builder
   Data" which wipes `selectorOptions`, `cardChecklist`, `players`, and
   `teams`. If a flow expects truly fresh state in some other table,
   either add it to `resetSetBuilderData` or use unique values per run
   (`${TEST_USERNAME}` is timestamp-based per CI run).
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

## Worker-state seeding

The cascade's `requires:` / `provides:` dependency graph IS the seeding
infrastructure. `setup.yaml` (level 0) does the heavy lift — DB reset +
credential save + drill to 2024 Topps Chrome + Variant Types sync. Every
subsequent flow declares what state it needs (`requires:`) and produces
(`provides:`).

If you need to manually seed a particular worker's state for a local
repro, just run `setup.yaml` first:

```bash
PATH=$HOME/.maestro/bin:$PATH \
  APP_URL=http://localhost:3000 \
  WORKER_INDEX=0 \
  TEST_USERNAME=neontester-$(date +%s) \
  maestro test --platform web --config .maestro/config.yaml --headless \
    .maestro/flows/set-selector/cascade/setup.yaml
```

Then run the flow you're debugging. If you need a different worker's
state (worker 2 has accumulated state from running parallel-safe flows),
loop the bootstrap + setup + intermediate flows with that `WORKER_INDEX`.
`run-e2e-smoke.sh` automates this when you pass `MAESTRO_PARALLELISM>1`.

## Cascade prerequisite check (NEO-23)

`run-e2e-smoke.sh` now tracks which `provides:` states have at least one
PASSing producer. When iterating each cascade level, it skips any flow
whose `requires:` set isn't fully satisfied and records the skip as a
FAIL with `skipped: prerequisite "X" not satisfied`. This prevents the
"flaked producer → downstream flows run with stale state → result depends
on whether the producer flaked" failure mode that bit us in PR #33.

Opt out via `MAESTRO_CASCADE_PERMISSIVE=true ./run-e2e-smoke.sh` if you
need the old run-anyway behavior to debug a single level-0 flow without
the rest of the cascade interfering.
