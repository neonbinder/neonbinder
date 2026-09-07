---
name: workflow-sibling-crosscheck
description: Before calling something a new accessibility bug in one admin screen, grep the sibling *Management.tsx files — most patterns here are deliberately copy-pasted
metadata:
  type: feedback
---

components/admin/{League,Team,Player,Franchise}Management.tsx are near-identical siblings
by design — new screens are built by copying an existing one and adapting the entity. Several
things that look like fresh a11y issues turn out to be established, already-shipped repo
conventions (auto-focus the filter input on load with a `hasFocusedRef` one-shot guard,
`{status && <p role={isError?"alert":"status"}>}` conditionally-mounted feedback messages,
`disabled={busy!==null}` on sibling buttons — see [[pattern_aria_disabled_busy_buttons]]).

**Why this matters:** the project's own audit instructions explicitly say "note the house
rules this codebase already follows, so don't re-flag them as novel" — but that list is never
exhaustive. Before flagging something as a NEW issue introduced by the file under audit,
`grep` the same shape (state variable name, JSX pattern) across the other three
*Management.tsx files. If it's identical there too, it's a pre-existing convention: still
worth mentioning if directly asked about, but frame it as "matches an existing pattern,
worth fixing repo-wide" rather than a defect unique to the new code, and don't let it
inflate the new file's severity count.

Conversely, don't over-apply this and skip real findings — check the *specific* mechanism,
not just the surface shape. E.g. TeamManagement's inline "add franchise" reveal DOES restore
focus on Escape/cancel (`franchiseSelectRef.current?.focus()`), while FranchiseManagement's
own "Start a franchise" panel does NOT — same JSX shape, but one sibling has the fix and the
new file dropped it. That's a genuine regression worth flagging even though the *pattern*
(inline reveal with Enter/Escape) is shared.
