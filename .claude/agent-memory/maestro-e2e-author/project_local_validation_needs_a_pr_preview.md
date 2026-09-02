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

**How to apply:** before promising a local run for a flow on a backend-touching
branch, run the `function-spec` check. If the function is missing, say so up
front as a disclosure (CLAUDE.md: "an unrunnable test is a disclosure, an unrun
one is a defect"), name CI's per-PR preview as the cover, and do NOT reach for
`convex dev`/`convex deploy` to force it. See
[[speaking-conch-run-serialization]] — no run means no lock to take.
