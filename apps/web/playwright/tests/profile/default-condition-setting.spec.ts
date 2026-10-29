// NEO-380 (R1): a collector sets their default card condition in Profile ->
// Settings -> Collection, and every new raw copy takes it: "I have this one"
// on a checklist stores it, and the card drawer's add form starts on it with
// no "Not set" to pick. Excellent is the default until they pick one.
//
// Proven by what the collector sees: the radio that reads as chosen (before and
// after a reload), the Have toggle's own name ("Have #N Player, Raw, Near
// Mint") and the add form's Condition field.
//
// R7: the account ends on Excellent again (the default every other spec reads
// on its copies, "Raw, Excellent"), in a finally block, and the one copy it
// adds is removed through the UI.
//
// R7a: writes only this user's `collectionCopies`, on the same card
// add-edit-remove-copy uses (the first ordinary 2024 Topps Chrome Base row,
// SET-REGISTRY.md "The collection spec's card"); copies are per account, so
// the two never meet.
//
// Not covered here: a failed save (no way to make the mutation fail from the
// UI); app/profile/settings/DefaultConditionSection.test.tsx pins it. A quick
// count writing the default is pinned by convex/defaultCondition.test.ts.
import { collectorCascade } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Settings default condition: a pick persists and every new raw copy takes it",
  { tag: ["@smoke", "@profile"] },
  async ({ page, signIn }) => {
    await signIn("/profile/settings");
    const collection = page.getByRole("heading", { level: 2, name: "Collection" });
    await expect(collection).toBeVisible({ timeout: LAUNCH_GATE });

    const group = page.getByRole("radiogroup", { name: "Default card condition" });
    const excellent = group.getByRole("radio", { name: "Excellent", exact: true });
    const nearMint = group.getByRole("radio", { name: "Near Mint", exact: true });
    const saved = page.getByRole("main").getByRole("status").filter({ hasText: "Saved." });

    try {
      // Never picked: Excellent.
      await expect(excellent).toBeChecked();
      await expect(group.getByRole("radio")).toHaveCount(6);
      await expectAccessible(page, { label: "Settings, Collection section" });

      // A pick saves, and a reload comes back the same.
      await expect(saved).toHaveCount(0);
      await nearMint.click();
      await expect(nearMint).toBeChecked();
      await expect(saved).toBeVisible();
      await page.reload();
      await expect(collection).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(nearMint).toBeChecked();
      await expect(excellent).not.toBeChecked();

      // --- "I have this one" stores the default --------------------------------
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("searchbox", { name: "Search every card" })).toBeVisible({ timeout: LAUNCH_GATE });
      const { drill } = collectorCascade(page);
      await drill("Sports", "Baseball", "Years");
      await drill("Years", "2024", "Brands");
      await drill("Brands", "Topps", "Sets");
      await drill("Sets", "Topps Chrome", "Variant Types");
      await drill("Variant Types", "Base");
      const checklist = page.getByRole("region", { name: "2024 Topps Chrome Base" });
      await expect(checklist.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeVisible();
      // All is a view (NEO-374): Have files into a picked binder, here Main.
      await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });

      // The first ordinary row (SET-REGISTRY.md), read off its own name.
      const ordinaryRow = checklist
        .getByRole("button", { name: /^Details for #(?!300 )\S+ [^,/\s]+ [^,/]+$/ })
        // "Any one" ordinary row: the first is the one SET-REGISTRY.md names.
        .first();
      await expect(ordinaryRow).toBeVisible();
      const short = /button "Details for ([^"]+)"/.exec(await ordinaryRow.ariaSnapshot())?.[1] ?? "";
      expect(short, "a Base row named \"#N First Last\"").toMatch(/^#\S+ .+$/);

      const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
      const haveOn = checklist.getByRole("button", { name: `Have ${short}, Raw, Near Mint`, exact: true, pressed: true });
      await expect(haveOff).toBeVisible();
      await haveOff.click();
      await expect(haveOn).toBeVisible();
      // The notice is the server's answer: the copy is stored, in Near Mint.
      await expect(page.getByRole("status").filter({ hasText: `Added ${short} to Main` })).toBeVisible();

      // --- The add form starts on the default, with no "Not set" ---------------
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      const drawer = page.getByRole("dialog");
      const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
      await expect(yourCopies.getByText("Raw, Near Mint", { exact: true })).toBeVisible();
      await drawer.getByRole("button", { name: `Add another copy of ${short}`, exact: true }).click();
      const addForm = drawer.getByRole("form", { name: "Add another copy" });
      const condition = addForm.getByRole("combobox", { name: "Condition" });
      await expect(condition).toHaveValue("Near Mint");
      await expect(condition.getByRole("option", { name: "Excellent" })).toHaveCount(1);
      await expect(condition.getByRole("option", { name: "Not set" })).toHaveCount(0);
      await expect(drawer).toBeInViewport({ ratio: 0.99 });
      await expectAccessible(page, { within: drawer, label: "Card drawer, add form on the default condition" });
      await addForm.getByRole("button", { name: "Cancel" }).click();
      await expect(addForm).toBeHidden();

      // Self-cleaning: the copy goes, and the card needs again.
      await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Near Mint`, exact: true }).click();
      await expect(drawer.getByRole("status").filter({ hasText: `Removed ${short}, Raw, Near Mint` })).toBeVisible();
      await expect(drawer.getByText("Need it")).toBeVisible();
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
      await expect(haveOff).toBeVisible();
    } finally {
      // R7: the account is back on Excellent, whatever happened above.
      await page.goto("/profile/settings");
      await expect(collection).toBeVisible({ timeout: LAUNCH_GATE });
      await excellent.click();
      await expect(excellent).toBeChecked();
      await expect(page.getByText("Saving…")).toHaveCount(0);
    }
  },
);
