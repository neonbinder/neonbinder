---
name: playerids-key-pin-reads-any-line
description: cardChecklist.playerLinksPin.test.ts flags ANY line in selectorOptions.ts that starts with `playerIds:` (a type field, a runQuery arg) unless "playerLinks" appears within 60 lines; keep such keys inline
metadata:
  type: reference
---

The NEO-254 pin splits `convex/selectorOptions.ts` into trimmed lines and
treats every line matching `^playerIds:` (not `v.optional`/`v.array`) as a
card write that must have `playerLinks` within the next 60 lines. It cannot
tell a write from a TypeScript type member or a `ctx.runQuery(..., {
playerIds: ... })` argument, so new gate code in that file goes red there
while every behaviour test passes.

**Why:** NEO-424's gate added `historyCandidates: Array<{ name; playerIds }>`
and a `historyPlayersByIds` call; both tripped it.

**How to apply:** in selectorOptions.ts, put a non-card `playerIds` key on the
same line as something before it (`{ name: string; playerIds: ... }`,
`{ playerIds: slice }`), with a one-line comment naming the pin. Run
`npx vitest run convex/cardChecklist.playerLinksPin.test.ts` whenever that
file gains a `playerIds` key. Related: [[pin-tests-need-a-bypass-plant]].
