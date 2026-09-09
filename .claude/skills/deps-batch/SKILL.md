---
name: deps-batch
description: Consolidate all open Dependabot PRs in the NeonBinder monorepo into one maintainer-authored, locally-validated batch PR — triage the bumps, integrate them one at a time in a fresh worktree with a validation gate after each, run the full local test + E2E suite, push, watch CI, and on approval merge and close out every Dependabot artifact (PRs, branches, Linear ticket, worktree). Use when Dependabot PRs have piled up (e.g. "deal with the dependabot PRs", "batch the dependency updates", "run the deps batch"). Never merges a Dependabot PR directly; never adds secrets to the Dependabot secret store; requires explicit approval before merging the batch.
argument-hint: [--repo <dir>] [--exclude <pr#>[,<pr#>...]] [--skip-e2e]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, ToolSearch, AskUserQuestion, WebFetch, mcp__linear-server__get_issue, mcp__linear-server__list_issues, mcp__linear-server__save_issue, mcp__linear-server__list_issue_statuses, mcp__linear-server__list_teams
---

# deps-batch — one tested batch instead of N doomed Dependabot PRs

**A Dependabot PR is never merged directly.** Those PRs are *screening*: they prove a
bump resolves and they carry the changelog. What ships is a **maintainer-authored batch
branch** — combine the bumps, validate locally one at a time, one full CI run, one
squash-merge, then close the Dependabot PRs.

This is not a preference. `.github/workflows/pr-pipeline.yml` encodes it in the
`deps_only` gate (NEO-87/NEO-103/NEO-108), and it has shipped twice: **PR #70**
(NEO-86, 13 bumps) and **PR #109** (7 bumps). Read either PR body for a worked example.

## Why the batch exists at all

GitHub deliberately withholds repo **Actions secrets** from Dependabot-triggered runs
(supply-chain protection). So on any `dependabot/**` PR, `secrets.GCP_WIF_PROVIDER_DEV`,
the Vercel bypass, and `E2E_QUEUE_SECRET` are all empty → the per-PR browser deploy,
the browser-URL wiring, and the whole E2E gate hard-fail **regardless of the bump**.
Proven on #24 (2026-06-29): `Secret source: Dependabot`, `google-github-actions/auth`
dead. A Dependabot PR *cannot* satisfy the required `CI Gate` as authored.

The batch branch is authored by the maintainer, so secrets are granted and the real
gate runs. It is also **not** `dependabot[bot]`-authored, so the `deps_only` carve-out
does not apply to it and it correctly gets the **full 8-worker E2E matrix** — which is
exactly the point: the thing that ships gets the full suite.

## Environment (resolved 2026-08-02 — re-verify if anything 404s)
- **Repo dir** (default, override with `--repo`): the monorepo checkout (`git rev-parse
  --show-toplevel`; `<workspace>/main` in the standard layout)
  (the active monorepo; GitHub `neonbinder/neonbinder`). Packages: `apps/web`,
  `services/browser`. There is no root `package.json` — these are **not** npm workspaces.
- **Worktree parent**: `<workspace>/worktrees`, i.e. `$(git rev-parse --show-toplevel)/../worktrees`
- **Dependabot config**: `.github/dependabot.yml` — weekly; three ecosystems
  (`github-actions` at `/` and `/apps/web/.github/actions/maestro-runner`, npm at
  `/apps/web`, npm at `/services/browser`). **Minor/patch are grouped; majors arrive
  as individual PRs, by design.** Do not "simplify" by grouping all versions — that
  broke E2E once already (closed PR #9).
- **Linear**: single team "Neonbinder", tickets `NEO-###`.

---

## Step 0 — Toolchain preflight (do this FIRST, every run)

Skipping this produces failures that look exactly like a bump broke something.

```bash
# apps/web — needs Node 24.3.0 (root .nvmrc). On 22.5.1: build dies with
# "Vite requires Node.js 20.19+ or 22.12+" and vitest silently drops ~31 tests.
export PATH="$HOME/.nvm/versions/node/v24.3.0/bin:$PATH"
node --version   # must print v24.3.0

# services/browser — needs Node >= 22.12. On 22.5.1 ~30 tests fail ERR_REQUIRE_ESM
# (compiled CJS requires ESM-only puppeteer; unflagged require(ESM) landed in 22.12).
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.12.0
```

**Re-check `node --version` whenever results change unexpectedly** — the version can
drift between shells inside a single session.

In a fresh worktree, `apps/web` also hits the npm optional-dependency bug (`Cannot find
native binding` for `@rolldown/binding-darwin-arm64`, breaking vitest at startup).
`npm ci` does **not** fix it. Install the binding directly — this leaves
`package.json`/`package-lock.json` untouched, so it creates no diff:

```bash
v=$(node -p "require('./node_modules/rolldown/package.json').version")
npm i "@rolldown/binding-darwin-arm64@$v" --no-save
```

---

## Step 1 — Inventory and triage

```bash
cd <repo>
git fetch origin --prune
gh pr list --state open --search "author:app/dependabot" --limit 50 \
  --json number,title,headRefName,createdAt
```

Honour `--exclude` by dropping those PR numbers. Then **classify every remaining PR**
into one of four buckets — the bucket decides where it lands in the commit order:

| Bucket | Examples | Handling |
|---|---|---|
| **A. npm grouped minor/patch** | `web-minor-patch`, `browser-minor-patch` | One commit per package. Safe together. |
| **B. GitHub Actions** | `github-actions` group, individual action bumps | One commit for all of them. |
| **C. npm major (dev-only)** | `typescript` 6→7, `eslint` 9→10 | **One commit each, last.** Read the changelog. |
| **D. npm major (runtime)** | `qrcode-generator` 1→2, `react-router` 7→8 | **One commit each, last, most scrutiny.** Read the changelog *and* grep the repo for every call site of the changed API. |

**Commit order is: A → B → C → D.** Rationale: a break in a major is attributable to
its own commit rather than bisected out of a 30-package lockfile regeneration.

For every bucket-C and bucket-D bump, read the upstream release notes (WebFetch the
GitHub releases page or the PR body — Dependabot embeds the changelog) and state in the
PR body **why the major is safe**, citing the actual call sites. "Tests pass" is not an
argument for a runtime major; PR #70 said *"sole usage uses the stable factory API,
unchanged in v2"* — that is the standard.

Present the triage table to the user before starting work.

---

## Step 2 — Linear ticket

Search first, create only if absent. **Never invent a NEO number.**

- `list_issues` (team "Neonbinder") for an existing open deps-batch ticket.
- None → create one: title `chore(deps): batch the N open Dependabot PRs (<YYYY-MM>)`,
  body listing the triage table from step 1. Record the returned ID.

---

## Step 3 — Fresh worktree off latest main

Every ticket starts in a fresh worktree off **latest** main — stale-local is the default
assumption, so fetch and verify rather than trusting the checkout.

```bash
cd <repo>
git fetch origin
git rev-parse origin/main            # confirm you are branching from this
BR="chore/deps-batch-$(date +%Y-%m-%d)"
git worktree add -b "$BR" \
  "$(git rev-parse --show-toplevel)/../worktrees/deps-batch-$(date +%Y-%m-%d)" \
  origin/main
```

Then `cd` into the worktree and **verify you landed in the right repo** —
`pwd && git remote -v` — before touching anything. Worktree creation has previously
mis-rooted into a sibling repo.

Install deps in the worktree (`apps/web` and `services/browser`), then apply the
rolldown fix from step 0.

---

## Step 4 — Integrate one bump at a time, with a gate after each

### The lockfile rule (non-negotiable)

**Edit `package.json` and regenerate the lockfile with `npm install`. Do NOT merge,
rebase, or cherry-pick the `dependabot/**` branches.**

Two reasons, both observed on PR #109: (a) separate Dependabot branches touching the
same `package-lock.json` conflict against each other; (b) a regenerated lockfile
resolves the whole set **coherently**, instead of stitching together N independent
resolutions that were each computed against a different base.

For each npm bump, in bucket order:

```bash
cd apps/web        # or services/browser
# edit package.json to the target version(s) from the Dependabot PR title/body
npm install        # regenerates package-lock.json
```

Then **verify every resolved version matches the intended bump** — `npm ls <pkg>` per
package. A regenerated lockfile can silently resolve differently than Dependabot did.

### `npm install` does NOT lift broad-range deps — this WILL bite you

**Observed 2026-08-02, and it is the single most likely way this skill ships a lie.**
Four of PR #122's eight bumps silently did not move: `@tailwindcss/vite` (`"^4"`),
`@types/node` (`"^26"`), `@types/react` / `@types/react-dom` (`"^19"`). npm honours an
**existing lockfile entry that still satisfies its range** and will not upgrade it, so
`npm install` was a no-op for all four while the batch claimed "8 updates".

Dependabot's own PR shows the same signature: those packages appear in the PR *body
table* but have **no `package.json` diff**, because there is no manifest edit to make.
That is the tell — **any bump listed in the body but absent from the manifest diff is a
lockfile-only lift and needs `npm update`:**

```bash
npm update <pkg> [<pkg>...]   # moves within the existing range, manifest untouched
```

Confirm afterwards that `git diff --stat package.json` shows only the lines you
deliberately edited. If `npm update` rewrote the manifest, you used `npm install <pkg>@x`
by mistake and have introduced a range change Dependabot never proposed.

### Resolved versions legitimately land AHEAD of Dependabot's target

`^` admits anything published since the PR opened, so `@clerk/backend` resolved to
3.15.0 against a 3.14.0 target, `posthog-js` to 1.409.5 against 1.408.1, `@vercel/node`
to 5.9.3 against 5.9.2. This is fine and desirable — but **report what landed, not what
was screened.** Never write "bumped to 3.14.0" when the tree has 3.15.0; the PR body
table must carry both columns. A version ahead of the screened one also means Dependabot
will find nothing to re-raise, which is the outcome you want.

### GitHub Actions bumps

Dependabot rewrites both the SHA pin and the trailing version comment. Apply the same
edit by hand, then — for **every** new SHA — confirm it resolves to the tag its comment
claims:

```bash
gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq .object.sha
# ...and if that returns a tag object rather than a commit, deref it:
gh api repos/<owner>/<action>/git/tags/<sha> --jq .object.sha
```

**The whole point of SHA-pinning (NEO-77) is not trusting the supplier's SHA.**
Dependabot provides it; you verify it. Any mismatch → stop and report; do not commit it.

Afterwards confirm no pin regressed to a floating tag:
`grep -rn "uses:" .github/ apps/web/.github/ | grep -v "@[0-9a-f]\{40\}"` should return
nothing.

### The gate — run after EVERY bump, before committing

```bash
# apps/web  (Node 24.3.0)
cd apps/web && npm run lint && npm run test:unit && npm run build \
  && npx tsc -p convex/tsconfig.json --noEmit

# services/browser  (Node 22.12+)
cd services/browser && npm run build && npm test
```

If workflows or the maestro-runner action changed, also run `actionlint` and diff its
output against unmodified `origin/main` — this repo has pre-existing shellcheck
advisories, and the only meaningful signal is a **new** one.

Record the actual numbers (`539/539 unit`, `107/107`) — they go in the PR body.

**Green → commit that bump alone**, with a message naming the Dependabot PR it replaces:
`chore(deps): bump the web-minor-patch group (9 updates) — replaces #122`.

### Red → bisect by drop, park the offender

Do **not** let one bad bump block the other N.

1. Revert that single bump (its `package.json` edit + `npm install`).
2. Re-run the gate to confirm the batch is green again.
3. Create a Linear ticket for the parked bump with the failure output.
4. **Leave that Dependabot PR open** — it must not be closed in step 9.
5. Note it in the PR body under "Not in this batch" with the reason.

Never mark a real failure as flaky, load-related, or a cold start. Read the failure
output, read the source, and attribute it.

---

## Step 5 — Security pass

1. **Audit delta.** `npm audit --json` in each package before and after the batch;
   report which advisories the bumps *closed*.

   **Read `fixAvailable` before calling anything blocked or fixed.** `fixAvailable: true`
   means a real in-range fix exists and is worth taking. An object with
   `isSemVerMajor: true` naming a *lower* version (`@vercel/node@4.0.0`,
   `@google-cloud/storage@5.18.3`, `localtunnel@1.8.3`) is a **downgrade**, not a fix —
   that is the NEO-88 set, leave it.

   **A direct bump can land correctly while its advisory persists on a different copy.**
   On 2026-08-02 `axios` still showed `[high]` after the bump; the direct dep *was* at
   1.19.0 and the vulnerable copy was `localtunnel@2.0.2 → axios@0.21.4`, dev-only and
   untouched by the PR. Run `npm ls <pkg> --all` before attributing an unchanged count to
   a failed bump — and say which copy is flagged, or the audit table reads as though the
   bump did nothing.
2. **Known upstream-blocked — do not re-litigate** (NEO-88, re-verified 2026-07-26):
   `undici` (via `@vercel/node`), `uuid` (via `@google-cloud/storage`), and
   `brace-expansion` (via `@google-cloud/secret-manager` → `google-gax`). If these show
   up, just re-check npm dist-tags for those three parents; if no major shipped, it is
   still blocked. Do not run `npm audit fix --force` — it proposes downgrading
   `@vercel/node` to 4.0.0 and `@google-cloud/storage` to 5.18.3, which are not fixes.
3. **Review the full diff** — lockfile + any workflow changes — for anything beyond the
   declared bumps (new postinstall scripts, changed registries, new transitive
   maintainers on runtime deps).

---

## Step 6 — Full local test suite, including E2E

Unit/lint/build gates from step 4 are per-bump. Now run the **whole** suite against the
final combined tree.

Never invoke `maestro` directly (a second Chrome crashes the laptop and contends
globally) — always the npm scripts, which pass `--headless` and so use CI's 1024×629
viewport. Never run two local stacks at once.

**A dependency-only batch changes no Convex code**, so you do NOT need `npm run
dev:backend` — the dev deployment already has the functions. Vite against the existing
dev deployment is sufficient, which removes most of the setup cost. (If a batch ever
does touch `convex/`, push it first.)

Worktree setup, in order — each of these cost time on 2026-08-02:

1. **`.env.local` does not exist in a fresh worktree.** Copy it from the main checkout:
   `cp <repo>/apps/web/.env.local <worktree>/apps/web/.env.local`. It is gitignored
   (`.env*.local`), so this leaves the tree clean — verify with `git status --short`.
2. **Java must be 21, and `openjdk@21` is keg-only** — it does not appear in
   `/usr/libexec/java_home -V`, so a bare `java -version` reports 23 and Maestro hits a
   JVM SIGSEGV. Run `npm run test:e2e:check` first, then
   `export JAVA_HOME=/opt/homebrew/opt/openjdk@21`.
3. **Free port 3000.** A Vite from a previous worktree is often still holding it; that
   stack serves the *other* checkout's code, so reusing it validates nothing. Stopping
   Vite is sanctioned — tell the user which one you stopped.
4. **Vite serves `https://localhost:3000` (mkcert), not http.** An `http://` readiness
   poll never fires and looks like a hung startup. Poll with `curl -skf https://…`.
   Run it under a keeper loop — Node 24.3.0 SIGSEGVs intermittently.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$HOME/.nvm/versions/node/v24.3.0/bin:$PATH"
MAESTRO_PARALLELISM=1 npm run test:e2e:smoke     # 3 crashes Chrome locally
```

**Determine the smoke set from the `tags:` block, never by grepping for the word.**
`grep -rl smoke .maestro/flows/` matches comments ("NEO-6 phase 1 smoke test", "no
separate `smoke` variant") and reports roughly double the real count — which then looks
like the runner silently skipped flows. As of 2026-08-02 the real set is **7 tagged
flows**, and the runner also pulls in `profile/worker-bootstrap` via the dependency
graph, so a complete run reports **8 passed**.

Run the smoke suite at minimum; run regression too if any bucket-D (runtime major) bump
is in the batch. `--skip-e2e` is available but is a deliberate, reported downgrade —
say so explicitly in the PR body and to the user, do not quietly skip.

Any E2E failure here is config/secrets/env or a real bug — diagnose from evidence
(screenshot + log + persist check) before touching anything.

---

## Step 7 — Push and open the batch PR

```bash
git push -u origin "$BR"
```

PR body must contain:
- **`Closes #N.`** on its own for **every** Dependabot PR being superseded (this is what
  auto-closes them on merge — see step 9). Omit any bump parked in step 4.
- The NEO-86 pattern sentence, so a future reader knows why this PR exists.
- A bump table by bucket, with **the toolchain each was validated on** and the real test
  counts.
- For every major: the changelog-backed reason it is safe, citing call sites.
- For Actions: the re-pinned SHA table and the statement that each was verified against
  the GitHub API.
- The audit delta.
- A "Not in this batch" section for anything parked, with its Linear ticket.

Label it `dependencies` (and `github_actions` if Actions were bumped).

**Then launch `/pr-watch <PR>` in the background and tell the user** — this is required
after every push to a PR branch.

---

## Step 8 — Wait for approval

CI green is **not** authorization to merge. Report the verdict and stop. Merging
requires the user's explicit per-PR approval, every time.

While waiting: if CI goes red, diagnose from the actual failure log before pushing any
fix. Note that `gh run rerun` is a **no-op** on the E2E queue (keyed by `E2E_RUN_ID`) —
push a fresh commit instead. Also note that `main`'s ruleset requires branches be
up to date, so every trailing PR merged ahead of this one costs a branch update and a
full ~25-minute re-run — another reason the batch is one PR, not N.

---

## Step 9 — Close out EVERY Dependabot artifact

Run `/pr-close <PR> <NEO-###>` for the merge → prod-verify → smoke-test → Linear →
worktree gates. That skill handles the batch PR itself. **This step covers what it does
not know about: the Dependabot fleet.**

After `/pr-close` reports the production deploy `READY`:

1. **Verify each superseded PR actually closed.** The `Closes #N.` lines fire on merge,
   but only for PRs in the same repo and only if the line parsed.
   ```bash
   gh pr list --state open --search "author:app/dependabot" --json number,title
   ```
   Anything still open that this batch shipped → close it with a pointer:
   ```bash
   gh pr close <N> --comment "Superseded by #<batch> — this bump shipped there, validated in a batch. See the NEO-86 pattern."
   ```
   **Do not close a PR that was parked in step 4.** Confirm the parked list before
   closing anything, and report both lists separately.

2. **Sweep the `dependabot/**` remote branches.** In practice GitHub deletes them itself
   when the PR closes — on 2026-08-02 a `git fetch --prune` reported all four gone and
   there was nothing to sweep. Verify rather than assume, in either direction:
   ```bash
   git fetch origin --prune
   git branch -r | grep 'origin/dependabot/' || echo "(none — all cleaned up)"
   ```
   For anything that remains, confirm its PR is `CLOSED`/`MERGED`, then **ask the user
   before deleting** — a remote ref is a remote mutation, not local hygiene. Never delete
   `origin/chore/flow-timings-refresh` (a scheduled workflow force-pushes to it), and
   grep `.github/` for any branch name before deleting it, to catch other such cases.
   **Do not raise a deletion question when the list is empty** — say there was nothing to
   do and move on.

3. **Do not re-run `npm audit fix`, and do not touch `.github/dependabot.yml`** as part
   of close-out. Config changes are their own PR.

4. **Confirm Dependabot does not immediately re-open.** Since the batch landed the same
   versions Dependabot proposed, the next scheduled run should find nothing. If a bump
   reappears next week for a package the batch supposedly updated, the lockfile
   regeneration resolved to a different version than intended — go back to step 4's
   `npm ls` verification.

5. **Linear**: **check the ticket's state before trying to close it.** Linear's GitHub
   integration auto-closes the ticket on merge whenever the PR title carries the
   `NEO-###` — which this skill's title format always does, so the normal outcome is that
   `/pr-close` finds it already `Done`. Report that it closed automatically; do not claim
   you closed it. Leave any parked-bump tickets open.

   If the Linear MCP token has expired mid-run (`requires re-authorization`), you cannot
   verify or set the state. Do **not** report the ticket closed on the assumption the
   integration handled it — finish everything else, tell the user to run `/mcp` →
   `linear-server` → Authenticate, and check afterwards.

---

## Step 10 — Final report

One consolidated summary: how many Dependabot PRs went in, the commit-per-bump list,
test counts per toolchain, E2E result, audit delta, the merge commit and prod deployment
that went `READY`, which Dependabot PRs/branches were closed or deleted, what was
**parked** and why (with its ticket), and anything deliberately left alone.

---

## Hard rules

- **Never merge a Dependabot PR directly.** They are screening. The batch is what ships.
- **Never add repo secrets to the Dependabot secret store** to "fix" the failing gate.
  That hands a malicious dependency update access to GCP WIF, Vercel, and the queue
  secret — the exact risk GitHub's withholding exists to prevent. A maintainer push to
  the branch is the sanctioned way to flip the actor and grant secrets.
- **Never merge/cherry-pick `dependabot/**` branches into the batch.** Edit
  `package.json`, regenerate the lockfile.
- **Never trust `npm install` to have applied a bump.** Verify every package with
  `npm ls`; anything on a broad range (`"^4"`, `"^19"`) needs `npm update` or it silently
  does not move. This is the failure that ships a PR whose body is a lie.
- **Never report the screened version as the shipped one.** `^` admits newer releases;
  state what actually resolved.
- **Never trust a Dependabot-supplied Action SHA.** Verify it resolves to its claimed
  tag, or the pinning is theatre.
- **Never judge results before checking `node --version`.** Wrong Node produces
  ~30 phantom browser failures and ~31 silently-dropped web tests.
- **Never batch a major in with the grouped minors.** Majors go last, one commit each.
- **Never let one failing bump block the batch** — drop it, park it, ticket it, and say
  so. And never call a failure flaky.
- **Never merge without the user's explicit per-PR approval**, no matter how green.
- **Never close a parked bump's Dependabot PR.** It is still the tracking artifact.
- **Never delete a remote branch without asking**, and never remove a worktree with
  uncommitted changes.
