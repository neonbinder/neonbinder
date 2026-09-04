---
name: external-ids-must-be-verified-live
description: Wikidata/ESPN QIDs and other external identifiers shipped as constants must be checked against the live source before merge — four sportConfig hallOfFameQid values were wrong from the day they were written
metadata:
  type: feedback
---

Any external identifier hard-coded as a constant (a Wikidata QID, an ESPN
league path, a marketplace facet id) must be resolved against the live source
before it ships, and the verification recorded in a comment next to the value.

**Why:** NEO-235 found that all four `hallOfFameQid` values in
`convex/sportConfig.ts` — shipped by NEO-96 — pointed at unrelated Wikidata
entities: a Polish village, a beetle species, "creator deity", and a Serbian
footballer. `isHallOfFame` therefore could never be true for any player in any
sport, and nothing caught it: the unit tests used the same wrong QID as both
the sport config and the fixture, so they passed while agreeing on a value that
matches nothing in the real world. A test that supplies both sides of a
comparison proves consistency, not correctness.

**How to apply:** When writing or reviewing a constant that names an external
entity, resolve it (`curl` Special:EntityData, the vendor API, whatever the
source of truth is) and paste the resolved label into a comment. In tests,
prefer the REAL identifier over a placeholder for anything asserting a match
against external data — a fixture that uses the production value would have
failed loudly here.

A second confirmed instance, NEO-240 (2026-09-04): the work-package brief
named Q1734 as the NHL's Wikidata id. Q1734 is `volleyball` — the sport. The
NHL is Q1215892 (no English label at all, only a description and a P1813 short
name "NHL"). MLB/NFL/NBA in the same brief were right. So a plausible-looking
QID handed over in a ticket, a spec, or another agent's prompt is not evidence:
resolve it before you write it down, even when the rest of the list checks out.

Related: identifiers persisted onto rows do not update when the constant
changes — see [[sport-config-is-copied-onto-rows]].
