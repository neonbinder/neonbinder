// NEO-343 (R1): the checklist's search box narrows a set's card list to the
// cards a query names and says how many it found; clearing it (the button or
// Escape) brings the whole list back; a query that finds nothing says so.
//
// A checklist runs to hundreds of rows in a virtualised list, so a card far
// down it cannot be reached by scrolling, by an operator or by a spec; this box
// is how it is reached. What a query matches is lib/cards/card-search.ts's rule
// (unit-tested there and in CardChecklist.search.test.tsx); this spec proves
// the control on a real committed checklist: the field, its count, its clear
// button, its empty state.
//
// FIXTURE: 2024 Topps Chrome > Insert > Future Stars, provisioned by the seed
// (`#FS-1` … `#FS-20`). READ-ONLY (SET-REGISTRY.md -> "Read-only consumers of
// the shared real set"): searching is client-side filtering and writes
// nothing. The rows exist whether SportLots is live or paused (paused they are
// BSC-only), so the spec needs no paused branch.
//
// R3: checklist-team-leader-cards-pair-and-picked-name-saves uses the search
// to reach two rows of a ~440-card set; this spec owns the control itself.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { editCardButton } from "../../support/cards";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToSet,
  pick,
  setBuilderReady,
} from "../../support/set-builder";

test(
  "Checklist — the search box narrows the card list and counts the matches, clearing restores every card, and a query with no match says so (NEO-343)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── Drill to the pre-synced 2024 Topps Chrome > Insert > Future Stars
    // (R9: the drill helper, then the same Insert pick the cancel spec makes).
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Insert", { search: false });
    await expect(columnHeading(page, "Inserts")).toBeVisible();
    await columnSearch(page, "Inserts").fill("Future Stars");
    await columnOption(page, "Inserts", "Future Stars").click();

    // The field appears once the checklist has rows; nothing is searched yet,
    // so the count line is empty and there is nothing to clear.
    const search = page.getByRole("searchbox", { name: "Search cards" });
    const clear = page.getByRole("button", { name: "Clear card search" });
    const count = page.getByText(/^[0-9]+ of [0-9]+ cards?$/);
    const cardRows = page.getByRole("button", { name: /^Edit card FS-[0-9]+(, .*)?$/ });
    await expect(search).toBeVisible();
    await expect(cardRows.first()).toBeVisible();
    await expect(count).toHaveCount(0);
    await expect(clear).toHaveCount(0);

    // ── Typing narrows. A card number is a PREFIX match, so "FS-5" is #FS-5
    // alone on a set of fewer than 50 cards (not #FS-15). The count says one
    // of all of them.
    await search.fill("FS-5");
    const narrowed = page.getByText(/^1 of [0-9]+ cards$/);
    await expect(narrowed).toBeVisible();
    const total = Number(((await narrowed.textContent()) ?? "").match(/of ([0-9]+) cards/)?.[1]);
    expect(total, "Future Stars holds more than the one card found").toBeGreaterThan(1);
    await expect(editCardButton(page, "FS-5")).toBeVisible();
    await expect(cardRows).toHaveCount(1);
    await expectAccessible(page, { label: "Future Stars checklist, searched to #FS-5" });

    // ── The clear button empties the field, keeps focus in it, drops the
    // count and brings every row back.
    await clear.click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(count).toHaveCount(0);
    await expect(clear).toHaveCount(0);
    // More than one row again (the list is virtualised, so only the rows in
    // view are counted; two prove the narrowing is gone).
    await expect(cardRows.nth(1)).toBeVisible();

    // ── A query that matches nothing says so, by the query, and lists no row.
    await search.fill("zzqxnomatch");
    await expect(page.getByText('No cards match "zzqxnomatch".')).toBeVisible();
    await expect(page.getByText(new RegExp(`^0 of ${total} cards$`))).toBeVisible();
    await expect(cardRows).toHaveCount(0);
    await expectAccessible(page, { label: "Future Stars checklist, search with no match" });

    // ── Escape in the field clears it too (the keyboard path).
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.getByText('No cards match "zzqxnomatch".')).toHaveCount(0);
    await expect(cardRows.nth(1)).toBeVisible();
  },
);
