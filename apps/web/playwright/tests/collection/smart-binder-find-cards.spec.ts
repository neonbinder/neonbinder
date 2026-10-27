// NEO-362 (R1): a smart binder is a real binder whose rule helps fill it. The
// collector has two cards of the seed's 2024 Topps Chrome in Main, makes a
// smart binder whose rule is that set, and Find cards (it opens on its own)
// lists both: nothing moved by itself. They Add one (it lands in the binder),
// turn the other down (it leaves the list for "Turned down") and take that
// back. Then Binder settings keeps the binder sorted by checklist with empty
// slots: the card they turned down, still in Main, shows as an empty slot
// that says they have it in another binder. Checklists, looking through the
// smart binder, offers "Fits <binder>". The layout toggle is gone.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`, `collectionBinderDeclines`) on two cards of the seed's
// 2024 Topps Chrome Base (registered in SET-REGISTRY.md); never the set, its
// cards, players or teams. Self-cleaning: the binder is deleted (its card
// goes back to Main; deleting it forgets its declines) and both copies are
// removed through the UI.
//
// R3: the cascade is drilled through `support/collection.ts`. The minted
// binder name is a single token from `env.ATTEMPT_TOKEN`.
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Collection: a smart binder's rule finds cards you have; add one, turn one down and back, keep it sorted with empty slots",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const name = `Smart${env.ATTEMPT_TOKEN}`;

    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    const toChecklists = async () => {
      await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
    };
    const toBinders = async () => {
      await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=binders/);
    };

    // --- Two cards into Main -------------------------------------------------
    await toChecklists();
    const checklist = await drillToCollectorBase(page);
    const lookThroughEverything = async () => {
      await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    };
    await lookThroughEverything();
    const rows = ordinaryBaseRows(checklist);
    await expect(rows.nth(1)).toBeVisible(); // "any two": the first two ordinary rows
    const one = await shortNameOf(rows.first());
    const two = await shortNameOf(rows.nth(1));
    expect(one.short, "two different cards").not.toBe(two.short);
    for (const card of [one, two]) {
      await checklist.getByRole("button", { name: `Have ${card.short}`, exact: true }).click();
      await expect(checklist.getByRole("button", { name: new RegExp(`^Have ${escapeRegExp(card.short)}, `) })).toBeVisible();
    }
    const label = (card: typeof one) => `2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`;

    // --- A smart binder: the rule is the set ---------------------------------
    await toBinders();
    const shelf = page.getByRole("list", { name: "Your binders" });
    await shelf.getByRole("button", { name: "New binder", exact: true }).click();
    const newDialog = page.getByRole("dialog", { name: "New binder", exact: true });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(name);
    await newDialog.getByRole("radio", { name: /^Smart: a rule helps fill it/ }).check();
    await newDialog.getByRole("combobox", { name: "Line 1" }).selectOption({ label: "Set" });
    const sets = newDialog.getByRole("combobox", { name: "Sets" });
    await sets.fill("2024 Topps Chrome");
    await newDialog.getByRole("option", { name: "2024 Topps Chrome", exact: true }).click();
    await expect(newDialog.getByRole("button", { name: "Remove 2024 Topps Chrome" })).toBeVisible();
    await expectAccessible(page, { within: newDialog, label: "New smart binder, its rule" });
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();

    // --- Find cards opens by itself, and nothing moved on its own ------------
    const find = page.getByRole("dialog", { name: `Find cards for ${name}`, exact: true });
    const addOne = find.getByRole("button", { name: new RegExp(`^Add ${label(one)}\\b.* from Main$`) });
    const addTwo = find.getByRole("button", { name: new RegExp(`^Add ${label(two)}\\b.* from Main$`) });
    await expect(addOne).toBeVisible();
    await expect(addTwo).toBeVisible();
    await expectAccessible(page, { within: find, label: "Find cards for a smart binder" });

    await addOne.click();
    await expect(addOne).toHaveCount(0);
    await expect(addTwo).toBeVisible();

    // Turn the second down: it leaves the list, and waits under Turned down.
    await find.getByRole("button", { name: new RegExp(`^Not for this binder: ${label(two)}\\b.*, in Main$`) }).click();
    await expect(addTwo).toHaveCount(0);
    await find.getByRole("tab", { name: "Turned down (1)" }).click();
    const again = find.getByRole("button", { name: new RegExp(`^Look at it again: ${label(two)}\\b`) });
    await expect(again).toBeVisible();
    await again.click();
    await expect(again).toHaveCount(0);
    await find.getByRole("tab", { name: "To look at" }).click();
    await expect(addTwo).toBeVisible();
    await find.getByRole("button", { name: "Done" }).click();
    await expect(find).toBeHidden();

    // The added card sits in the binder; the other is still in Main.
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(`^${label(one)}\\b`) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Lay out like my real binder" })).toHaveCount(0);

    // --- Binder settings: keep it sorted by checklist, with empty slots ------
    await page.getByRole("button", { name: "Binder settings" }).click();
    const settings = page.getByRole("dialog", { name: `${name} settings`, exact: true });
    await expect(settings.getByRole("radio", { name: /^Where I put them/ })).toBeChecked();
    await expect(settings.getByRole("heading", { name: "Smart rule" })).toBeVisible();
    await expectAccessible(page, { within: settings, label: "Binder settings" });
    await settings.getByRole("radio", { name: /^Keep sorted by checklist/ }).check();
    await expect(settings.getByRole("radio", { name: /^Keep sorted by checklist/ })).toBeChecked();
    const emptySlots = settings.getByRole("checkbox", { name: /^Include empty slots/ });
    await emptySlots.check();
    await expect(emptySlots).toBeChecked();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toBeHidden();

    // The card still in Main is an empty slot that says where it is.
    await expect(
      page.getByRole("button", { name: new RegExp(`^${label(two)}\\b.*, in another binder\\. Move it here$`) }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(`^${label(one)}\\b`) })).toBeVisible();
    await expect(page.getByText(/Keeps itself sorted by checklist, with empty slots/).first()).toBeVisible();

    // --- Checklists, looking through the smart binder ------------------------
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    const spine = shelf.getByRole("button", { name: `${name}, 1 card`, exact: true });
    await expect(spine).toBeVisible();
    await toChecklists();
    const fits = checklist.getByRole("radio", { name: `Fits ${name}`, exact: true });
    await fits.click();
    await expect(fits).toHaveAttribute("aria-checked", "true");
    await expect(checklist.getByRole("button", { name: `Details for ${one.short}`, exact: true })).toBeVisible();

    // --- Cleanup: delete the binder, remove both copies ----------------------
    await toBinders();
    await spine.click();
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Rename or delete ${name}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Rename or delete ${name}`, exact: true })
      .getByRole("button", { name: "Delete this binder" })
      .click();
    const confirm = page.getByRole("dialog", { name: `Delete ${name}?`, exact: true });
    await expect(confirm.getByText("Its 1 card goes back to Main. You can't undo this.")).toBeVisible();
    await confirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirm).toBeHidden();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(name)},`) })).toHaveCount(0);

    await toChecklists();
    await lookThroughEverything();
    for (const card of [one, two]) {
      await checklist.getByRole("button", { name: new RegExp(`^Have ${escapeRegExp(card.short)}, `) }).click();
      await expect(checklist.getByRole("button", { name: `Have ${card.short}`, exact: true })).toBeVisible();
    }
  },
);
