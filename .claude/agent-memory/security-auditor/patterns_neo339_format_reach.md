---
name: patterns-neo339-format-reach
description: Answer-reaches-children doors (NEO-339 autograph format to parallels) — flag written in the door txn, card walk in one serial action; strict trailing-token parse of a marketplace title; generated-text rebuild by equality
metadata:
  type: project
---

What to re-check when a node answer is made to "reach" related rows:

- **Flag in the door, walk in an action.** The door writes the answer onto up
  to N related rows in its own transaction (so their prompts clear), then one
  scheduled action walks every row's cards serially. A throw on row k (page
  cap, cursor guard) or the action time limit strands rows k+1..N: they read
  as answered, the prompt that would re-ask is hidden, and their cards stay
  unanswered. Ask for per-target isolation (try/continue with an ids+counts
  log, or one scheduled walk per target / chunk) and a test of it.
- **Bounds on the reach need their own test**: the budget, the truncated
  warning, and the sibling-count refusal are easy to ship untested.
- **"Move what still holds the previous answer"** cannot tell an operator's
  own same-valued answer from an inherited one; it overwrites it. Documented
  trade-off; say it in the report.
- **Marketplace title -> tokens**: safe shape is anchor on a suffix (`#<no>`),
  take only the trailing run, case-sensitive, every word from a closed set
  or a numeric pattern, stop at the first unknown word, require text before
  the run, length cap before parse, and the caller re-bounds the list.
  Then output can only be vocabulary, never a name. Invisible characters in
  a regex literal are a review hazard in a public repo; prefer `\u` escapes.
- **Generated-text rebuild**: only when stored text === generator(before);
  check the "both cut" truncation branch (an approved cut can become a
  different unseen cut without a flag).

Related: [[patterns-neo345-attribute-fill]], [[patterns-neo296-transaction-bounds]].
