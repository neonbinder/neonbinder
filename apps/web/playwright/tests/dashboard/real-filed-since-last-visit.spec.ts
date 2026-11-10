// R1: a card filed into a binder between two dashboard visits shows on the
// signed-in dashboard as news: the summary line under the greeting reads
// "N cards filed since your last visit." and the binder's spine carries
// "1 new since your last visit" (NEO-464). Only filing and moving count, so the
// copy is added to Main first and then moved into a new binder.
//
// A new visit needs thirty minutes away from the dashboard, so the spec moves
// its last open back with /testing/backdate-dashboard-visit
// (`backdateMyDashboardVisit`, caller-scoped, refused off testing deployments).
// That puts the new visit's "new" thirty minutes back, so anything this account
// filed in that window counts too: the summary is read as a number, and the
// exact claim is made on this run's own binder.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`, the profile's dashboard visit) on one card of the seed's
// 2024 Topps Chrome Base, registered in SET-REGISTRY.md; never the set, its
// cards, players or teams. Self-cleaning: the copy is removed and the binder
// deleted through the UI. The binder's name is a single token minted from
// `env.ATTEMPT_TOKEN`.
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Dashboard: a card filed into a binder since the last visit is news on the next visit",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page, signIn, env }) => {
    const binder = `Filed${env.ATTEMPT_TOKEN}`;
    const greeting = page.getByRole("heading", { level: 1, name: "Welcome back, slugger." });

    // --- The visit before: open the dashboard (stamps the visit) ------------
    await signIn("/dashboard");
    await expect(greeting).toBeVisible({ timeout: LAUNCH_GATE });

    // --- A new binder, through the Collection's New binder dialog ----------
    await page.goto("/collection?tab=binders");
    const shelf = page.getByRole("list", { name: "Your binders" });
    await shelf.getByRole("button", { name: "New binder", exact: true }).click();
    const newDialog = page.getByRole("dialog", { name: "New binder", exact: true });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(binder);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: binder, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    await expect(shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true })).toBeVisible();

    // --- One copy into Main, then moved into the binder (the filing) --------
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const checklist = await drillToCollectorBase(page);
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    const row = ordinaryBaseRows(checklist).first();
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);

    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`),
    });
    await checklist.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: "Main" });
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${card.short}, Raw, Excellent` })).toBeVisible();

    await yourCopies.getByRole("button", { name: `Move ${card.short}, Raw, Excellent`, exact: true }).click();
    const moveForm = yourCopies.getByRole("form", { name: "Move Raw, Excellent", exact: true });
    await moveForm.getByRole("combobox", { name: "Move to" }).selectOption({ label: binder });
    await moveForm.getByRole("button", { name: "Move it", exact: true }).click();
    await expect(moveForm).toBeHidden();
    const line = yourCopies.getByRole("listitem").filter({ has: page.getByText("Raw, Excellent", { exact: true }) });
    await expect(line.getByText(binder)).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- Away for the visit gap, then back: the filing is news --------------
    await page.goto("/testing/backdate-dashboard-visit");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();
    await expect(page.getByText(/\b[\d,]+ cards? filed since your last visit\./)).toBeVisible();
    const spine = page
      .getByRole("list", { name: "Binders on the shelf" })
      .getByRole("button", { name: `${binder}, 1 card, 1 new since your last visit`, exact: true });
    await expect(spine).toBeVisible();
    await expectAccessible(page, { label: "Dashboard, a card filed since the last visit" });

    // --- Cleanup through the UI: remove the copy, delete the empty binder ---
    await page.goto("/collection?tab=checklists");
    const again = await drillToCollectorBase(page);
    await again.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    await again.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    await yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true }).click();
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
    await page.getByRole("button", { name: `Rename or delete ${binder}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Rename or delete ${binder}`, exact: true })
      .getByRole("button", { name: "Delete this binder" })
      .click();
    const confirm = page.getByRole("dialog", { name: `Delete ${binder}?`, exact: true });
    await confirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirm).toBeHidden();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binder)},`) })).toHaveCount(0);
  },
);
