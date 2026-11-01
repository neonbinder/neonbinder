---
name: local-validation-needs-a-pr-preview
description: A spec exercising a NEW Convex function cannot be validated locally against shared dev — it lacks the function (and may lag main too); validate against the PR's own Convex preview, never push to dev
metadata:
  type: project
---

When a spec exercises a Convex function that exists **only on the branch**, local
validation against shared dev is blocked; use the PR's own Convex preview (a
spare-port Vite, GUIDE "Running"). Verified 2026-09-01 on a resync branch.

**Why:**
- `apps/web/.env.local` points `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` at the
  shared dev deployment. Confirm what a deployment actually has with `npx convex
  function-spec | grep <fnName>`: the decisive check, and read-only.
- There is **no deploy key** in `.env.local`, so `--preview-create` cannot make an
  isolated deployment. With `CONVEX_DEPLOYMENT` set and no deploy key `npx convex
  deploy` targets the project's **production** deployment: never run it to work
  around this.
- `npm run dev:backend` is NOT a local backend: it is `npx convex dev` against the
  same shared dev deployment, so using it pushes unmerged branch code to the
  deployment every other local run (and every other agent on this machine) uses
  ([[feedback_never_push_a_branch_convex_to_shared_dev]]).
- The seed's global reset must never be pointed at shared dev (GUIDE), so a spec
  whose precondition is "this real set does not exist yet" fails on dev, where it
  usually already does.

**What the failure looks like at run time:** a missing function makes the
`useQuery` throw, the SPA falls to its error boundary and the page collapses to
`"An error occurred. Please refresh the page."`, so the spec dies on whatever
assertion follows, often reading like an unrelated locator bug.

**Run it anyway, and say where it stopped.** The client half of a feature (pure
derivations, meters, alerts, dialogs) ships in the LOCAL BUNDLE, so a run against
shared dev still validates every step BEFORE the first branch-only server call.
Report the exact step it reached; that is a far better disclosure than "cannot
run locally". Beware [[negative-asserts-pass-on-a-dead-page]] when reading the
result.

**How to apply:** before promising a local run for a spec on a backend-touching
branch, run the `function-spec` check ([[patterns_check_dev_function_spec_before_local_run]]).
If the function is missing, say so up front as a disclosure (CLAUDE.md: "an
unrunnable test is a disclosure, an unrun one is a defect"), name CI's per-PR
preview as the cover, and do NOT reach for `convex dev`/`convex deploy`.

**One unconditionally-mounted panel takes the WHOLE page down.** NEO-212 mounted a
panel with a `useQuery` inside `CardChecklist` with no gate, so on shared dev EVERY
set-selector spec died the instant the checklist opened, several steps before the
new feature. A drill helper failing with a blank "An error occurred" screenshot is
this, not a locator bug.

**Shared dev can lag **main**, not just your branch.** Merging to main deploys
PRODUCTION Convex, never dev (`release.yml`); shared dev only moves when a human
runs `convex dev`, so it drifts behind main indefinitely. On one branch EVERY
set-selector spec died at the sport level with `Could not find public function
for 'selectorOptions:getSelectorOptionHoldings'` (shipped in NEO-219, on main, not
on dev) inside a control in `SetAttributesPanel`'s header, which mounts once ANY
selector row is selected, so the page dies one click into the drill.
`git diff <base> -- <component>` came back EMPTY, which proved the crash was not the
branch's. When every set-selector spec fails identically and early, check
`function-spec` in BOTH directions (a function your branch added; a function `main`
added that dev never received). If it is the second, the fix is not yours: report
it and ask for dev to be refreshed or for the PR preview URL.

**Why a push to dev fails when another branch owns it.** Convex validates every
existing document against the incoming schema, so **whichever branch pushed last
owns dev**, and a branch that predates those fields cannot push at all (`Schema
validation failed ... extra field`). The only override is `schemaValidation: false`
in `schema.ts`, which is app source and must never be left in a branch.
