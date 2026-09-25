---
name: wizard-headings-include-staged-career-teams
description: A `New Team:` heading in the entity-review wizard is NOT proof a name is on the checklist; career teams staged from Wikidata stints get the same heading. Verify a "club on this set" from a committed card row or a saved alias before building a fixture on it.
metadata:
  type: feedback
---

Before a flow pre-creates a team to match a CHECKLIST string, prove the string
is on a CARD. A `New Team: <name>` heading, or a registry note listing "the
wizard's headings", does not prove it.

**Why:** NEO-307 built the retro-rule proof on "Homestead Grays". SET-REGISTRY
listed it among the Rickwood set's clubs because the wizard had shown it as a
heading. It was a career team staged from Josh Gibson's Wikidata stint. No
card carries it, so the proof could never pass. The first presented team row
is often a staged career team too (CI saw "Montreal Royals" first).

**How to apply:** read the committed checklist. A linked card's sub-line
prints its team's full name, and an unlinked one shows only the attention "!".
Or read the alias a team link saved in Team Management ("Also known as"),
which is the raw checklist string. A scratch probe flow under
`.maestro/flows/<area>/zz-probe-*.yaml` tagged `util`, run with bare
`maestro test` and deleted afterwards, does this in about a minute. Related:
[[neo307-league-combobox]], [[neo284-team-alias-fixture]].
