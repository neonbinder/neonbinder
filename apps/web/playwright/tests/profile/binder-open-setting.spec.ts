// NEO-374 (R1): Profile -> Settings -> Binders says where My Collection opens:
// on All (the default; a view of every binder that adds nothing) or on the
// binder the collector picked last. Under "Remember the last binder" a pick in
// the Binder picker is saved to the profile, so the next visit to
// /collection opens on it, and picking All is remembered as All.
//
// R7/R7a: writes only this worker account's own profile preference. It ends
// with "Open on All" saved again, in a finally block, so no later spec on this
// account opens on a remembered binder. It reads the account's Main binder and
// writes no copies.
//
// R3: add-edit-remove-copy proves All's lock (the note under the picker, Have
// and Mark as Have refused until a binder is picked); this spec owns the
// setting and the reopen.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Settings Binders: open on All by default, or reopen My Collection on the binder picked last",
  { tag: ["@profile"] },
  async ({ page, signIn }) => {
    await signIn("/profile/settings");
    const binders = page.getByRole("region", { name: "Binders" });
    await expect(binders.getByRole("heading", { level: 2, name: "Binders" })).toBeVisible({ timeout: LAUNCH_GATE });
    const opens = binders.getByRole("radiogroup", { name: "When you open your collection" });
    const onAll = opens.getByRole("radio", { name: /^Open on All/ });
    const remember = opens.getByRole("radio", { name: /^Remember the last binder/ });
    const saved = binders.getByRole("status").filter({ hasText: "Saved." });

    // R2: the account opens on All until it says otherwise.
    await expect(onAll).toBeChecked();
    await expectAccessible(page, { label: "Settings, Binders on All" });

    /** My Collection, fresh, and the Binder picker on My Cards. */
    const picker = page.getByRole("combobox", { name: "Binder" });
    const note = page.getByText("Choose a binder to add cards.", { exact: true });
    const openCollection = async () => {
      await page.goto("/collection");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(picker).toBeEnabled();
    };

    try {
      // --- Open on All: a pick is not carried to the next visit --------------
      await openCollection();
      await expect(picker.getByRole("option", { selected: true })).toHaveText("All");
      await expect(note).toBeVisible();
      await picker.selectOption({ label: "Main" });
      await expect(note).toHaveCount(0);
      await openCollection();
      await expect(picker.getByRole("option", { selected: true })).toHaveText("All");

      // --- Remember the last binder -------------------------------------------
      await page.goto("/profile/settings");
      await remember.click();
      await expect(remember).toBeChecked();
      await expect(saved).toBeVisible();

      await openCollection();
      await picker.selectOption({ label: "Main" });
      // The pick saves in the background: the next visit opens on Main once it lands.
      await expect(async () => {
        await page.goto("/collection");
        await expect(picker).toBeEnabled();
        await expect(picker.getByRole("option", { selected: true })).toHaveText("Main", { timeout: 1_000 });
      }).toPass({ timeout: 7_000 });
      await expect(page).toHaveURL(/[?&]scope=/);
      await expect(note).toHaveCount(0);

      // Picking All is remembered as All.
      await picker.selectOption({ label: "All" });
      await expect(note).toBeVisible();
      await expect(async () => {
        await page.goto("/collection");
        await expect(picker).toBeEnabled();
        await expect(picker.getByRole("option", { selected: true })).toHaveText("All", { timeout: 1_000 });
      }).toPass({ timeout: 7_000 });
    } finally {
      // R7: the account opens on All again, whatever happened above.
      await page.goto("/profile/settings");
      await expect(onAll).toBeVisible({ timeout: LAUNCH_GATE });
      if (!(await onAll.isChecked())) {
        await onAll.click();
        await expect(saved).toBeVisible();
      }
      await expect(onAll).toBeChecked();
    }
  },
);
