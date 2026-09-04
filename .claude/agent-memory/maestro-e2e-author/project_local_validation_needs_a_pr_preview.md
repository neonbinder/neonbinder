---
name: local-validation-needs-a-pr-preview
description: A flow exercising a NEW Convex function cannot be validated locally until the branch has a PR — shared dev lacks the function and there is no local deploy key
metadata:
  type: project
---

When a Maestro flow exercises a Convex function that exists **only on the
branch**, local validation is blocked until the branch has an open PR with a
built Convex preview. Verified 2026-09-01 on `neo-203-nb-owned-resync`.

**Why:**
- `apps/web/.env.local` sets `CONVEX_DEPLOYMENT=dev:focused-fox-53` and
  `VITE_CONVEX_URL` at that same shared dev deployment. Confirm what a
  deployment actually has with `npx convex function-spec | grep <fnName>` —
  that is the decisive check, and it is read-only.
- There is **no `CONVEX_DEPLOY_KEY`** in `.env.local`, so `--preview-create`
  cannot make an isolated deployment. And `npx convex deploy --help` states
  that with `CONVEX_DEPLOYMENT` set and no deploy key the target is the
  project's **production** deployment — never run it to work around this.
- `npm run dev:backend` / `dev-backend.sh` is NOT a local backend: it is
  `npx convex dev` against that same shared dev deployment, so using it pushes
  unmerged branch code to the deployment every other local E2E run (and every
  other agent on this machine) is using.
- Flows that need `setup.yaml`'s global "Reset Set Builder Data" compound this:
  `.maestro/README.md` forbids pointing that at shared dev, and `test:e2e:pick`
  does not pull `setup.yaml` in for a flow with no `requires:` tag anyway — so
  a flow whose precondition is "this real set does not exist yet" will fail on
  shared dev, where it usually already does.

**What the failure looks like at run time:** a missing function makes the
`useQuery` throw, the SPA falls to its error boundary, and the hierarchy
collapses to one node — `"An error occurred. Please refresh the page."` — so the
flow dies on whatever assertion follows, often reading like an unrelated
selector bug. Confirmed again 2026-09-02 (NEO-101, `previewListingTitle`).

**Run it anyway, and say where it stopped.** The client half of a feature
(pure derivations, meters, alerts, dialogs) ships in the LOCAL BUNDLE, so a run
against shared dev still validates every step BEFORE the first branch-only
server call — on NEO-101 that was the drill, the add-card form, the drawer, the
80-char alert and the blocked Save, i.e. most of the new selectors. Report the
exact step it reached; that is a far better disclosure than "cannot run
locally". Beware [[negative-asserts-pass-on-a-dead-page]] when reading the
result.

**How to apply:** before promising a local run for a flow on a backend-touching
branch, run the `function-spec` check. If the function is missing, say so up
front as a disclosure (CLAUDE.md: "an unrunnable test is a disclosure, an unrun
one is a defect"), name CI's per-PR preview as the cover, and do NOT reach for
`convex dev`/`convex deploy` to force it. See
[[speaking-conch-run-serialization]] — no run means no lock to take.

**One unconditionally-mounted panel takes the WHOLE page down.** The blast
radius is not limited to the feature under test: NEO-212 mounted
`SkippedNamesPanel` (a `useQuery(api.entityReviewSkips.listForSet)`) inside
`CardChecklist` with no gate, so on shared dev EVERY set-selector flow died the
instant the checklist opened — including `util-drill-to-custom`'s own return
contract, several steps before the new feature. A drill util failing its final
assert with a blank "An error occurred. Please refresh the page." screenshot is
this, not a selector bug.

**Finding WHICH call is missing** — diff the components' call sites against the
deployment, rather than guessing:

```bash
grep -rhoE "api\.[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+" components/SetSelector/*.tsx | sort -u
npx convex function-spec   # .functions[].identifier is "module.js:name"
```
Anything in the first list absent from the second is a branch-only call; then
grep for its call site to see whether it is gated or mounted unconditionally.
## Update 2026-09-04 — NEVER push a branch's Convex functions to shared dev

Rule (coordinator, NEO-239): local validation of a branch runs a spare-port
Vite against the PR's own Convex preview (`VITE_CONVEX_URL` at the preview,
seed it with the `setup` track — it starts empty exactly as CI does). Shared
dev is never a target for branch code, and "the tree is clean at main" is not
an exemption. `e2e-local-stack.sh`'s opening push predates this rule and is
not a licence. The 2026-09-03 note below is kept only for what it explains
about WHY a push fails; it is not a workflow.

## (superseded) 2026-09-03 — why a push to shared dev fails when another branch owns it

`apps/web/e2e-local-stack.sh` now opens with "push THIS branch's Convex
functions to dev" (`npx convex dev --once --typecheck disable`), which is NOT a sanctioned workflow for branch code (see above) — and it
fails anyway when another branch owns dev:

> ✖ Schema validation failed. Document … in table `labelPurchases` does not
> match the schema: Object contains extra field `estDeliveryAt` …

Another in-flight worktree had already pushed ITS schema and written fixture
rows carrying fields this branch's `schema.ts` (branched off an older `main`)
does not declare. Convex validates every existing document against the incoming
schema, so **whichever branch pushed last owns dev**, and a branch that predates
those fields cannot push at all until that data or that branch is gone. There is
no per-push override short of editing `schema.ts` (`schemaValidation: false`),
which is app source and must not be left in a branch.

**Consequence for NEO-211:** `EntityColumn` subscribes to
`getSelectorSyncSuggestions` on EVERY column unconditionally, so with shared dev
lacking the function the whole `/set-selector` page falls to its error boundary
and NO set-selector flow can run locally — not just the new ones. Hierarchy dump
confirms it: one node, `"An error occurred. Please refresh the page."`.

**What still works, and is worth doing:** run the flow's pre-feature steps
against the OTHER checkout's bundle. `main/apps/web` has its own `node_modules`
and `.env.local`; start it on a spare port (`VITE_DEV_DISABLE_HTTPS=1 npx vite
--port 3002 --strictPort --host`) and point a truncated scratchpad copy of the
flow at it. That validated NEO-211's whole cold drill, set selection, rename
control and attributes-panel assertions for real — everything except the steps
that call the missing functions. Add `--host`: Chrome resolves `localhost` to
`::1` and Vite binds IPv4 only by default.
