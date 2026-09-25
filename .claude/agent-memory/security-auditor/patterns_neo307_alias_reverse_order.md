---
name: patterns-neo307-alias-reverse-order
description: NEO-307 alias rule in both orders + resolver allowPastEra opt-in; how to audit a per-caller resolver option, the exact-object log pin, and why builder memory can go stale inside its own branch
metadata:
  type: project
---

NEO-307 made "an alias may never equal another team's primary name in the
sport" era-blind, and added the REVERSE order (a create/rename onto a name
another team holds as an alias). Every team writer needs BOTH checks: operator
surfaces throw (`assert*`), unattended paths (commit prelude, bulk loader)
report/drop. Rename checks run only when `nameNormalized` changes, so a legacy
pair cannot lock a team out of its own saves (the NEO-284 lock-out trap).

**Audit recipe for a resolver option (`allowPastEra`-style):** grep every caller
of the resolver and classify what its year MEANS (card set year vs stint year);
the option must default off so a new caller is forced to decide. Public entry
points that reach it (here `teams.findByNameAndSport`, signed-in only) inherit
the new behaviour and its log line.

**Log hygiene pin that works:** the structured log is asserted with `toEqual` on
the parsed object, so any extra field (e.g. the checklist string) turns it red.
Prefer this over `toContain` for "ids and years only" claims.

**Insert-site enumeration:** `grep -rn 'insert("teams"'` gives the complete
writer list (teams.ts findOrCreate, selectorOptions commit prelude, bulkLoad);
check each for both orders.

**Why:** a disjoint-era alias silently wins retro cards through era narrowing,
so "cannot lock anyone out" was the wrong test for allowing it.
**How to apply:** on any alias/name/era change, enumerate insert sites and
resolver callers first; check builder memory written mid-branch against the
final commit (NEO-307's builder note said the loader's reverse check was
missing after the last commit had added it). Related:
[[patterns-neo284-team-aliases]], [[patterns-public-function-auth-registry]].
