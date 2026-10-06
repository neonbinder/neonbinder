---
name: patterns-neo327-pair-decision-log-and-ocr-parse
description: NEO-327 placeholder pairing — what a per-pair Convex decision log may carry (filenames/players ok, cap length, no userId), and the quadratic Vision-word scan in preprocess vision_card_number
metadata:
  type: project
---

Two reusable checks from the NEO-327 audit (2026-10-05).

**Per-decision diagnostic log lines (Convex `console.log(JSON.stringify(...))`).**
Acceptable content for placeholder pairing: jobId (not a bearer — every
reader re-checks `findOwnedJob`), entry indexes, printed player names and card
numbers (public card text), classifier labels, text counts, and the user's
scan filename. JSON.stringify closes log-line injection. What to check each
time: (1) no userId / Clerk subject beside the filename (jobId already links
to the owner in the DB; do not make the log self-attributing); (2) the
filename is length-capped where it is logged — the stream path caps
`originalName` at MAX_FIELD_CHARS, the zip path (`registerExtractedImages`,
`entry.name`) does NOT and a zip member name can be a long path; (3) logging
from inside a mutation (`finalizePairingInline`) is emitted even if a later
statement throws and the transaction rolls back — "logged after the writes
landed" is only true in the action path.

**Geometric OCR parsers over Vision words.** `card_number_from_words` calls a
full-word-list scan (`_next_on_line`) for every prefix-shaped word, so cost is
O(prefix words x words) with a fat per-iteration constant (measured ~10 s at
1000 "No" words, ~40-80 s at 2000, unbuffered stdlib Python). Benign card backs
have a handful of prefixes; a crafted upload from any signed-in user does not.
Rule: any per-candidate full scan on user-image OCR output needs a bound —
early exit once the "exactly one" rule is already broken, a cap on
prefix-shaped words, a cap on total words, frames computed once.
Related: [[patterns-preprocess-service]], [[patterns-neo149-zip-ingest]].
