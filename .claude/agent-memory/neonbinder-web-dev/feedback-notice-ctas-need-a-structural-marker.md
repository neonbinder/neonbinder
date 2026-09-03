---
name: feedback-notice-ctas-need-a-structural-marker
description: Extra affordances on a shared status banner must key off an explicit marker on the notice state, never the tone bucket or the message text
metadata:
  type: feedback
---

When a shared status/notice banner grows an extra affordance (a CTA, a link, a
count), gate it on an explicit marker set at the ONE place that composes that
notice — e.g. `syncNotice.kind: "committed"` set only by `setCommittedMessage`
in `runCommit` — not on the notice's tone/severity bucket and never on string
matching the message text. Add a dedicated setter for the marked case so no
future call site can opt in by accident.

**Why:** on NEO-102 the post-commit attention CTA in `CardChecklist.tsx` was
gated on `syncNotice.tone === "status"`. That bucket is *every* routine notice,
not just a landed commit, so "Fetch cancelled — no cards saved." grew
"1 need attention — Fix them one at a time" on any set holding a flagged card —
offering to fix cards the operator had just declined to save. It also broke the
Maestro flow `checklist-fetch-cancel-dialog`, which asserts that banner's text
with an exact (whole-string) match. Jason's instruction was explicit: structured
marker, not text detection.

**How to apply:** any time one element renders several different messages and
only some of them earn an extra control. Before shipping, enumerate every
setter of that state and confirm none but the intended path sets the marker.
Then check `.maestro/flows` for assertions on the element: `assertVisible: "…"`
with a bare string is a whole-string match and will fail on ANY appended text,
while `.*…*`-wrapped `text:` regexes tolerate it. Related:
[[feedback-no-self-opening-modals]] — same feature, same principle of not
surprising the operator with an affordance they did not ask for.
