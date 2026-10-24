---
name: card-fixtures-insert-through-insert-test-card
description: Test fixtures write cardChecklist rows through lib/testing/card-row.ts insertTestCard (fills required listingTitle + sportId); a required-field flip fails every raw insert at runtime, and t.run drops closures from its result
metadata:
  type: reference
---

`cardChecklist.listingTitle` and `cardChecklist.sportId` are required (NEO-363).
convex-test validates every insert against the schema, so a raw
`ctx.db.insert("cardChecklist", {...})` in a test without them fails at
runtime, not at the typecheck gate ([[reference-convex-typecheck-excludes-test-files]]).

House pattern: fixtures call `insertTestCard(ctx, row)` from
`lib/testing/card-row.ts`. It defaults the title to `#<cardNumber>` and walks
the row's chain for the sport, and **throws** when the chain has no sport row,
because production refuses such a card (`requireCardSport`). A fixture with a
sportless chain gets a sport parent; a test whose point is a chain that LOST
its sport after birth passes an explicit `sportId` (a detached sport row).

When a future change makes another `cardChecklist` field required, add its
default to `insertTestCard` rather than editing ~110 sites. The flip itself
was done with a regex codemod (`X.db.insert("cardChecklist",` →
`insertTestCard(X, `) plus an import; it also catches the `ctx.db\n.insert(`
split form.

Quirk hit on the way: `t.run(async (ctx) => ({ ..., fn: async () => id }))`
returns the object WITHOUT the function (the result is serialised), so build
any closure (e.g. a `CardRowIndexing`) outside `t.run`.
