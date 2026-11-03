// NEO-425 (Jason, 2026-11-03).
//
// R1 - ONE FEATURE: an insert's Sub-Variants column opens only when the insert
// HAS sub-variants. Sub-variants are NeonBinder's own rows (no marketplace has
// them), so the column carries no Sync button, and an insert with none is a
// leaf. Three sides of that one rule:
//
//   1. An insert with no sub-variants opens no column. It is the end of the
//      cascade, so the NEO-224 terminal focus rule applies: focus lands on its
//      empty checklist's "Fetch from Marketplaces".
//   2. Group Parallels is the door to an insert's first sub-variant. Once it is
//      saved the column appears on its own, with "+ Custom" and no Sync button,
//      and focus is left where the operator has it: rows arriving are not a
//      pick, so nothing moves.
//   3. Picking an insert that has sub-variants opens the column and leaves
//      focus on the insert just picked (its card), not in the new column's
//      search box: the one exception to the NEO-224 cascade focus rule.
//      Driven from the keyboard, the way that rule is used.
//   4. The column closes when its last sub-variant leaves: with the
//      sub-variant picked, Group Parallels sends it back to the top level and
//      the column goes, leaving the insert as a leaf with its own checklist.
//      Rows leaving are not a pick either, so focus is not pulled anywhere:
//      it is back on the "Group Parallels" button the dialog returns it to,
//      never dropped on <body>.
//
// R7/R7a - ISOLATION: every write lands in ONE per-attempt hand-made set,
// `svl<token>`, under `E2E Test Sport <worker>` > 2026 > Topps
// (drillToCustomSet; SET-REGISTRY.md, Custom sets). Hand-made, so no
// marketplace side is resolvable beneath it and nothing waits on BSC or
// SportLots: every wait is the 7 s budget. Per-attempt because the flow turns
// one of its inserts into a sub-variant (and back), and a rerun must start
// with three top-level inserts and a host with no sub-variant. Nothing is
// deleted; the set is the debris.
//
// MINTED NAMES are single tokens from env.ATTEMPT_TOKEN: `svl<token>` (set),
// `svlhost` / `svlsub` / `svlleaf` + token (inserts). None is a word-prefix of
// another, so Group Parallels suggests nothing and the move below is the only
// change.
//
// R9: the drill goes through drillToCustomSet; the inserts are made inline
// with "+ Custom", as the Group Parallels specs make theirs.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  addCustomEntry,
  columnOption,
  columnSearch,
  columnSelection,
  drillToCustomSet,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";

test(
  "An insert's Sub-Variants column opens only when it has sub-variants — none is a leaf, Group Parallels' first one opens it with no Sync, and picking the insert leaves focus on it (NEO-425)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const SET = `svl${T}`;
    const HOST = `svlhost${T}`;
    const SUB = `svlsub${T}`;
    const LEAF = `svlleaf${T}`;

    const addSubVariant = page.getByRole("button", { name: "Add custom Sub-Variants" });
    const syncSubVariants = page.getByRole("button", { name: "Sync Sub-Variants" });
    const groupParallels = page.getByRole("button", { name: "Group Parallels" });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustomSet(page, env, { set: SET, variantType: "Insert" });
    for (const name of [HOST, SUB, LEAF]) {
      await addCustomEntry(page, "Inserts", name, { confirm: "required" });
    }

    // ── CLAIM 1: NO SUB-VARIANTS, NO COLUMN; THE INSERT IS A LEAF ──
    await columnOption(page, "Inserts", HOST).click();
    await expect(columnSelection(page, "Inserts", HOST)).toBeVisible();
    // Positive: the terminal rule ran, which it does only once the page knows
    // no column opens below the insert. Then the column's two handles are gone.
    await expect(syncChecklistButton(page)).toBeFocused();
    await expect(addSubVariant).toBeHidden();
    await expect(columnSearch(page, "Parallels")).toBeHidden();
    await expectAccessible(page, { label: "Insert with no sub-variants, a leaf" });

    // ── CLAIM 2: GROUP PARALLELS MAKES THE FIRST ONE; THE COLUMN APPEARS ──
    const grouping = page.getByRole("dialog", { name: "Group Parallels" });
    await groupParallels.click();
    await expect(grouping.getByText(/Drag inserts under a parent/)).toBeVisible();
    await expect(grouping.getByText("No changes yet")).toBeVisible();
    await grouping.getByRole("checkbox", { name: `Select ${SUB}` }).click();
    await grouping.getByText(`Parallels of "${HOST}"`).click();
    await expect(grouping.getByText("1 promotion, 0 demotions")).toBeVisible();
    await grouping.getByRole("button", { name: "Save 1 change" }).click();
    await expect(grouping).toBeHidden();

    // The column is there, listing the new sub-variant, with "+ Custom" ...
    await expect(columnOption(page, "Parallels", SUB)).toBeVisible();
    await expect(addSubVariant).toBeVisible();
    // ... and no Sync: no marketplace has sub-variants.
    await expect(syncSubVariants).toBeHidden();
    // Rows arriving are not a pick: focus is back on the button that opened
    // the dialog, never pulled into the new column or onto the insert.
    await expect(groupParallels).toBeFocused();
    await expectAccessible(page, { label: "Sub-Variants column after Group Parallels" });

    // ── CLAIM 3: PICKING AN INSERT WITH SUB-VARIANTS LEAVES FOCUS ON IT ──
    // Keyboard only from here. Re-open the Inserts column from its card (focus
    // goes into its search box), and pick the leaf first: the column goes.
    await columnSelection(page, "Inserts", HOST).click();
    await expect(columnSearch(page, "Inserts")).toBeFocused();
    await page.keyboard.type(LEAF);
    await expect(columnOption(page, "Inserts", LEAF)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(columnSelection(page, "Inserts", LEAF)).toBeVisible();
    await expect(syncChecklistButton(page)).toBeFocused();
    await expect(addSubVariant).toBeHidden();

    // Now the insert with a sub-variant.
    await columnSelection(page, "Inserts", LEAF).click();
    await expect(columnSearch(page, "Inserts")).toBeFocused();
    await page.keyboard.type(HOST);
    await expect(columnOption(page, "Inserts", HOST)).toBeVisible();
    await page.keyboard.press("Enter");
    // The column opened ...
    await expect(columnOption(page, "Parallels", SUB)).toBeVisible();
    await expect(addSubVariant).toBeVisible();
    // ... and focus stayed on the insert just picked, not in the new column.
    await expect(columnSelection(page, "Inserts", HOST)).toBeFocused();
    await expect(columnSearch(page, "Parallels")).not.toBeFocused();
    await expectAccessible(page, { label: "Insert with sub-variants, focus on the insert" });

    // ── CLAIM 4: THE COLUMN CLOSES WHEN ITS LAST SUB-VARIANT LEAVES ──
    // Pick the sub-variant, then send it back to the top level.
    await columnOption(page, "Parallels", SUB).click();
    await expect(columnSelection(page, "Parallels", SUB)).toBeVisible();
    await groupParallels.click();
    await expect(grouping.getByText(/Drag inserts under a parent/)).toBeVisible();
    await grouping.getByRole("button", { name: `Remove ${SUB} from parallels` }).click();
    await expect(grouping.getByText("0 promotions, 1 demotion")).toBeVisible();
    await grouping.getByRole("button", { name: "Save 1 change" }).click();
    await expect(grouping).toBeHidden();

    // Positive first: the host is still the pick, and its own checklist is up
    // (an empty one, so its fetch is what it offers) ...
    await expect(columnSelection(page, "Inserts", HOST)).toBeVisible();
    await expect(syncChecklistButton(page)).toBeVisible();
    // ... and the column is gone, with the sub-variant it held.
    await expect(columnSelection(page, "Parallels", SUB)).toBeHidden();
    await expect(columnSearch(page, "Parallels")).toBeHidden();
    await expect(addSubVariant).toBeHidden();
    // Rows leaving are not a pick: focus is where the dialog handed it back.
    await expect(groupParallels).toBeFocused();
    await expectAccessible(page, { label: "Insert whose last sub-variant left, a leaf again" });
  },
);
