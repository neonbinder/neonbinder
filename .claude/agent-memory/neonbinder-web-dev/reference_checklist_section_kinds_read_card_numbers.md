---
name: checklist-section-kinds-read-card-numbers
description: classifySections is number-aware once given first/last numbers — a test fixture that numbers each section 1,2,3… turns every "Base X" parallel into a base-subset; parallels must repeat the base's numbers
metadata:
  type: reference
---

`lib/checklists/classify-sections.ts` (NEO-496) takes names OR evidence
(`firstNumber`/`lastNumber`/`numbers`). With numbers, a section whose numbers
**continue** the base's ("101-150" after "1-100") is `base-subset` (the Base's
own: preselected in Map Base Set, never auto-matched, asks for no Parallels
type), and one that **repeats** them is `base-child` (a parallel).

The trap: once the server passes the stored section summaries' numbers in
(setReconciliation context, selectorOptions D16), every convex-test upload
fixture that gave section i the card number `${i + 1}` silently reclassifies
"Base Red" as a subset. Four tests went red in two files at once.

**How to apply:** in checklist upload fixtures, give a parallel the same
numbers as its base (every section's single row "1" is the simplest), and give
a subset numbers that run on from the base. To prove a change is the
number-aware path, keep a names-only contrast test beside it (no numbers →
the old name-only kinds). See [[gates-in-a-shared-worktree]].
