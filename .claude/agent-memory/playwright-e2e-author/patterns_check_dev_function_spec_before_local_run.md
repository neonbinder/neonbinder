---
name: patterns_check_dev_function_spec_before_local_run
description: Before a local run against a stale dev Convex, diff the page's `api.x.y` refs against `npx convex function-spec` — a `useQuery` on a missing function drops the SPA to "An error occurred. Please refresh the page." and reads as a missing locator; `npx convex dev --once` cannot always refresh dev (schema validation on stale rows)
metadata:
  type: reference
---

# Know which surfaces will render BEFORE you run locally against dev

A branch's local Vite runs against whatever functions the dev deployment last
received. Any component that `useQuery`s a function dev lacks throws during render
and the WHOLE SPA falls to its boundary: the failure screenshot is one line, `An
error occurred. Please refresh the page.`, and the step reads as "locator not
found" (the NEO-102 wall). `useMutation` / `useAction` / imperative `convex.query`
refs are harmless until invoked.

## The 30-second check (verified 2026-09-14, NEO-279)

```bash
cd apps/web
npx convex function-spec > <scratch>/devspec.json     # read-only: {url, functions:[{identifier:"mod.js:fn",...}]}
grep -oh "api\.[A-Za-z]*\.[A-Za-z]*" components/SetSelector/*.tsx components/modules/SetSelector.tsx | sort -u
# compare `api.mod.fn` -> `mod.js:fn`; anything missing that a component
# useQuery's is a surface the local run cannot reach.
```

Then grep the missing names for `useQuery(` to know exactly which step will die.
On 2026-09-14 the New Team dialog (`useQuery(api.teams.erasByNameAndSport)`) was
behind the wall, so EVERY spec that creates a team through the dialog is
CI-preview-only while dev lags; everything before that step validated fine
locally.

## `npx convex dev --once` is not a guaranteed fix, and not yours to run

Pushing the branch's functions to dev also pushes its SCHEMA, and the push is
refused when any stored row carries a field the new schema no longer has (`Schema
validation failed ... extra field`). Cleaning shared dev data is not a spec
author's call: stop, report the partial validation and let the coordinator
validate against the PR's Convex preview
([[project_local_validation_needs_a_pr_preview]],
[[feedback_never_push_a_branch_convex_to_shared_dev]]).

## Read the partial run for what it DID prove
Report which steps passed before the wall; that is evidence worth putting in the
report even when the spec went red later for an environment reason.
