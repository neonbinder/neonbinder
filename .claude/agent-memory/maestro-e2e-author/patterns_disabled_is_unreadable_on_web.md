---
name: disabled-is-unreadable-on-web
description: maestro-web never reports enabled/disabled — `enabled: true|false` matches NOTHING (TreeNode.enabled is always null); prove a disabled button by a user-visible reason it carries (a `title` tooltip becomes its resource-id) or by a tap that is safe if the premise fails
metadata:
  type: reference
---

`maestro-web.js` builds each node from `text`, `bounds`, `resource-id`,
`is-loading` (body) and `selected` only. `CdpWebDriver` constructs every
`TreeNode` with the default mask for clickable/enabled/focused/checked/
selected, so `enabled` is `null`, and `Filters.enabled(expected)` keeps a
node only when `node.enabled == expected` — so **`enabled: true` and
`enabled: false` both match nothing on web** (verified by `javap` on
maestro-client.jar, CLI 2.8.0). No flow in the suite uses `enabled:`.

Two honest ways to assert "this button is disabled":

1. **Tap it and prove nothing happened** — the house pattern
   (`checklist-wizard-career-team-entry`'s "+ Add"), valid ONLY when a
   wrongly-enabled press is harmless (client state, a hand-made set). Never on
   a Save that writes a shared real set: a regression would write the
   fixture other flows read (R7a).
2. **Read the reason the button carries.** maestro-web's resource-id is
   `id || ariaLabel || name || title || htmlFor || data-testid`; a Radix /
   NeonButton has no id or aria-label, so a `title` tooltip set ONLY while
   blocked becomes its `id`. `{text: "Save [0-9]+ sets", id: "<reason>"}` on
   one node is the blocked Save; `assertNotVisible` of the same pair after the
   fix proves it unblocked. This needs product code (ask the coordinator; the
   a11y auditor weighs in). NEO-325's same-title block is the first use.

**Why:** NEO-325 asked for "assert Save is disabled" on a read-only flow over
the shared Topps Chrome anchor; option 1 would have written two parallels to
it the moment the block regressed.

Related: [[maestro-web-driver-primitives]], [[input-primitive-has-no-resource-id]],
[[prove-focus-by-what-enter-does]].
