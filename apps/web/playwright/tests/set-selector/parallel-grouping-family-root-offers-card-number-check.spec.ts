// NEO-339, R1: Group Parallels offers to check card numbers when a suggested
// parallel has parallels of its own. On a hand-made set whose inserts are
// X, X Red, X Autographs and X Autographs Red, the dialog opens with all three
// longer names placed under X (the plain prefix rule), and a strip says that
// "X Autographs" might be an insert and that its card numbers will tell, with a
// "Check card numbers" button. The check itself is NOT pressed here: it previews
// marketplace checklists, and a hand-made set has none, so there is nothing for
// it to read. Its rule is unit-tested (lib/set-build/family-roots.ts).
//
// Hand-made set, per-attempt, no marketplace ids (R7a): `pg-family-` in
// SET-REGISTRY.md. Row names are single tokens built from ATTEMPT_TOKEN.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, addCustomEntry, drillToCustom } from "../../support/set-builder";

test(
  "Group Parallels — a suggested parallel that has parallels of its own offers a card-number check (NEO-339)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const x = `${env.ATTEMPT_TOKEN}Kite`;
    const red = `${x} Red`;
    const autographs = `${x} Autographs`;
    const autographsRed = `${x} Autographs Red`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: `E2E Test Sport ${env.WORKER_INDEX}`,
      year: "2026",
      manufacturer: "Topps",
      set: `pg-family-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`,
      variantType: "Insert",
    });
    for (const name of [x, red, autographs, autographsRed]) {
      await addCustomEntry(page, "Inserts", name, { confirm: "required" });
    }
    await expect(page.getByText(autographsRed)).toBeVisible();

    const dialog = page.getByRole("dialog", { name: "Group Parallels" });
    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();

    // The plain prefix rule: all three longer names open placed under X.
    await expect(dialog.getByRole("button", { name: "Accept all suggestions (3)" })).toBeVisible();
    await expect(dialog.getByText("3 promotions, 0 demotions")).toBeVisible();
    for (const child of [red, autographs, autographsRed]) {
      await expect(dialog.getByRole("button", { name: `Remove ${child} from parallels` })).toBeVisible();
    }

    // The strip: one suggested parallel roots a family, and the way to check it.
    await expect(
      dialog
        .getByRole("status")
        .filter({
          hasText:
            "1 suggested parallel has parallels of its own, so it might be an insert. Its card numbers will tell.",
        }),
    ).toBeVisible();
    const check = dialog.getByRole("button", { name: "Check card numbers" });
    await check.scrollIntoViewIfNeeded();
    await expect(check).toBeInViewport();
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog offering the card-number check" });

    // Out without saving: nothing was changed on the set.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: /^Discard .*pending move/ }).click();
    await expect(dialog).toBeHidden();
  },
);
