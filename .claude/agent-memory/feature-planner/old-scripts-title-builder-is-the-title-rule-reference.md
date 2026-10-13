---
name: old-scripts-title-builder-is-the-title-rule-reference
description: Jason's pre-NB script app's getTitles/xs_setName rules are the reference for NB listing titles; a per-leaf operator short set name is his accepted overflow mechanism (NEO-335)
metadata:
  type: project
---

Jason's pre-NB script app (outside this repo; ask him for it — its title
builder and its per-set short-name prompts) is the reference ruleset for NB listing
titles: insert and parallel names are part of the set identity (never dropped),
the words "Insert"/"Parallel" and the teams drop first, RC-type features next,
and a per-LEAF short set name (`xs_setName`, asked once at leaf creation,
default `<set> <variant>`) rescues the title before asking the operator.

**Why:** Jason, 2026-10-11 (NEO-335): "pretty complex rules, we should be
following those"; he typed short names like "1990 Upper Deck Hologram" by hand
and wants NB to ask once per set, reused for every card.

**How to apply:** any title-rule change cites those rules and lists the
disagreements for Jason (he froze the RC/variation trim order 2026-10-10; the
old rules drop RC BEFORE shortening names). A short name is an NB fact on the
leaf row (metadata, narrow mutation), never a features key and never derived
silently; a suggestion is a placeholder the operator accepts. Token gating
reads NB roles (`isInsert`/`isParallel`), never level or name, so role-less
custom fixtures keep byte-identical titles. See [[listing-title-inputs-are-server-assembled]].
