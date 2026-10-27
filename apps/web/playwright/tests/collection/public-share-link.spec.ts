// NEO-360 (R1): public share links. A signed-in collector picks a public name,
// builds a binder holding one graded copy with a cost, a location, notes and a
// cert, flags it Up for trade, and opens Share: Private is picked. They
// rename the link, pick Public and read the plain link
// (`/u/<username>/binders/<link name>`) off the panel. A visitor (a fresh,
// signed-out context on the same device) opens it and sees the binder's name,
// the card and its grade, and none of the private strings anywhere on the
// page. A wrong link name reads as not found; the profile's shelf lists the
// binder and Up for Trade; the Want List (never switched public) reads as not
// found; Up for Trade, public by default, lists the card. The collector picks
// Private again and the visitor's link reads as not found. Up for Trade
// switched private reads as not found and leaves the profile's shelf; the
// Want List switched public opens. A second binder can't take the first
// one's link name. Both shelves are put back as they were.
//
// Not covered here: the for-sale page. Boxes are made only in the demo until
// Inventory reaches the real collection (NEO-364); unit tests in
// convex/publicCollection.test.ts cover it.
//
// R7/R7a: writes only the signed-in user's own rows (`publicProfiles`,
// `collectionContainers`, `collectionCopies`; the bootstrap reset clears the
// account) on one card of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md. Never writes the set, its cards, players or teams.
// Self-cleaning: the copy is removed and the binder deleted through the UI.
// The username is `env.TEST_USERNAME`, fresh per test.
//
// R3: the collector's cascade is drilled through `support/collection.ts`.
import type { Page } from "@playwright/test";
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Collection: share a binder publicly, a visitor sees it without the private details, a wrong link name and a private binder are not found",
  { tag: ["@smoke", "@collection"] },
  async ({ page, browser, baseURL, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN.toLowerCase();
    const binderName = `Share${env.ATTEMPT_TOKEN}`;
    const readable = `pub-${token}`;
    const secret = {
      cert: `9${token.replace(/[^0-9]/g, "").padEnd(7, "7").slice(0, 7)}`,
      cost: "12.34",
      location: `Closet${token}`,
      notes: `Secret${token}`,
    };
    const username = env.TEST_USERNAME;

    // --- A public name: every link carries it -------------------------------
    await signIn("/profile/public");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByLabel(/^Username/).fill(username);
    await page.getByRole("button", { name: "Save Public Profile" }).click();
    // Past the 7 s budget: the save is a server round trip that first checks the name is free.
    await expect(page.getByText(/^Profile saved/)).toBeVisible({ timeout: 10_000 });

    // --- A binder ------------------------------------------------------------
    await page.goto("/collection?tab=binders");
    const shelf = page.getByRole("list", { name: "Your binders" });
    await expect(shelf).toBeVisible({ timeout: LAUNCH_GATE });
    await shelf.getByRole("button", { name: "New binder", exact: true }).click();
    const newDialog = page.getByRole("dialog", { name: "New binder", exact: true });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(binderName);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    const heading = page.getByRole("heading", { level: 2, name: binderName, exact: true });
    await expect(heading).toBeVisible();

    // --- One graded copy with every private detail, up for trade ------------
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    const checklist = await drillToCollectorBase(page);
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    const row = ordinaryBaseRows(checklist).first();
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`),
    });
    await checklist.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: binderName });
    await addForm.getByRole("radio", { name: "Graded" }).check();
    await addForm.getByRole("combobox", { name: "Grader" }).selectOption("PSA");
    await addForm.getByRole("textbox", { name: "Grade" }).fill("10");
    await addForm.getByRole("textbox", { name: "Cert number" }).fill(secret.cert);
    await addForm.getByRole("spinbutton", { name: "Cost" }).fill(secret.cost);
    await addForm.getByRole("textbox", { name: "Location" }).fill(secret.location);
    await addForm.getByRole("textbox", { name: "Notes" }).fill(secret.notes);
    await addForm.getByRole("switch", { name: "Up for trade" }).check();
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: new RegExp(`^Added ${escapeRegExp(card.short)}`) })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- Share: private at first; rename the link, pick Public --------------
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) }).click();
    await expect(heading).toBeVisible();
    await page.getByRole("button", { name: `Share ${binderName}`, exact: true }).click();
    const visibility = page.getByRole("group", { name: "Who can see this binder" });
    const privateChoice = visibility.getByRole("radio", { name: /^Private/ });
    const publicChoice = visibility.getByRole("radio", { name: /^Public/ });
    await expect(privateChoice).toBeChecked();
    await expect(page.getByText("Nobody else can open the link below until you pick Public.")).toBeVisible();
    await expectAccessible(page, { label: "Share panel, a private binder" });
    const linkName = page.getByRole("textbox", { name: "Link name" });
    await linkName.fill(readable);
    await linkName.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Link name saved. The old link no longer works." })).toBeVisible();
    const linkRe = new RegExp(`/u/${escapeRegExp(username)}/binders/${escapeRegExp(readable)}$`);
    const linkText = page.getByText(linkRe);
    await expect(linkText).toBeVisible();
    await publicChoice.check();
    await expect(publicChoice).toBeChecked();
    await expectAccessible(page, { label: "Share panel, a public binder" });
    const link = new URL((await linkText.textContent())!.trim());

    // --- A visitor: signed out, same device as this project -----------------
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
    const visitorContext = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
    const visitor = await visitorContext.newPage();
    const expectNotFound = async (p: Page) => {
      await expect(p.getByRole("heading", { level: 1, name: "Nothing to see here" })).toBeVisible();
    };

    await visitor.goto(link.pathname);
    await expect(visitor.getByRole("heading", { level: 1, name: binderName })).toBeVisible({ timeout: LAUNCH_GATE });
    // Added from its details, the copy still went into a pocket: the first open one.
    await expect(visitor.getByRole("heading", { level: 2, name: "Page 1" })).toBeVisible();
    await expect(visitor.getByText("PSA 10")).toBeVisible();
    await expect(visitor.getByText("Not in a pocket yet")).toHaveCount(0);
    await expect(visitor.getByText(card.player).first()).toBeVisible();
    for (const value of Object.values(secret)) await expect(visitor.getByText(value)).toHaveCount(0);
    await expectAccessible(visitor, { label: "Public binder page" });

    // A wrong link name: not found, the same screen as private.
    await visitor.goto(`${link.pathname}-nope`);
    await expectNotFound(visitor);
    await expectAccessible(visitor, { label: "Public page not found" });

    // The profile's shelf lists the public binder and Up for Trade.
    await visitor.goto(`/u/${username}`);
    const profileShelf = visitor.getByRole("region", { name: "Collection" });
    await expect(profileShelf.getByRole("link", { name: new RegExp(`^${escapeRegExp(binderName)}`) })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expect(profileShelf.getByRole("link", { name: "Up for Trade" })).toBeVisible();
    await expectAccessible(visitor, { label: "Public profile with its shelf" });

    // The Want List was never switched public.
    await visitor.goto(`/u/${username}/want-list`);
    await expectNotFound(visitor);

    // Up for Trade is public by default.
    await visitor.goto(`/u/${username}/up-for-trade`);
    await expect(visitor.getByRole("heading", { level: 1, name: "Up for Trade" })).toBeVisible();
    await expect(visitor.getByText("PSA 10")).toBeVisible();
    await expectAccessible(visitor, { label: "Public Up for Trade page" });

    // --- Back to private: the link reads as not found ----------------------
    await privateChoice.check();
    await expect(privateChoice).toBeChecked();
    await visitor.goto(link.pathname);
    await expectNotFound(visitor);
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // --- Up for Trade switched private, then public again -------------------
    // An open binder replaces the shelf; go back to it.
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    const special = page.getByRole("list", { name: "Special places" });
    await special.getByRole("button", { name: /^Up for Trade, / }).click();
    await page.getByRole("button", { name: "Share Up for Trade", exact: true }).click();
    const tradeVisibility = page.getByRole("group", { name: "Who can see this shelf" });
    await expect(tradeVisibility.getByRole("radio", { name: /^Public/ })).toBeChecked();
    await tradeVisibility.getByRole("radio", { name: /^Private/ }).check();
    await expect(tradeVisibility.getByRole("radio", { name: /^Private/ })).toBeChecked();
    await visitor.goto(`/u/${username}/up-for-trade`);
    await expectNotFound(visitor);
    await visitor.goto(`/u/${username}`);
    await expect(visitor.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Up for Trade" })).toHaveCount(0);
    await tradeVisibility.getByRole("radio", { name: /^Public/ }).check();
    await expect(tradeVisibility.getByRole("radio", { name: /^Public/ })).toBeChecked();
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // --- The Want List switched public, then private again ------------------
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    await special.getByRole("button", { name: /^Want List, / }).click();
    await page.getByRole("button", { name: "Share your Want List", exact: true }).click();
    const wantVisibility = page.getByRole("group", { name: "Who can see this Want List" });
    await wantVisibility.getByRole("radio", { name: /^Public/ }).check();
    await expect(wantVisibility.getByRole("radio", { name: /^Public/ })).toBeChecked();
    await visitor.goto(`/u/${username}/want-list`);
    await expect(visitor.getByRole("heading", { level: 1, name: "Want List" })).toBeVisible();
    await wantVisibility.getByRole("radio", { name: /^Private/ }).check();
    await expect(wantVisibility.getByRole("radio", { name: /^Private/ })).toBeChecked();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await visitorContext.close();

    // --- A second binder can't take the first one's link name ---------------
    const twinName = `Twin${env.ATTEMPT_TOKEN}`;
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    await shelf.getByRole("button", { name: "New binder", exact: true }).click();
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(twinName);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: twinName, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Share ${twinName}`, exact: true }).click();
    await linkName.fill(readable);
    await linkName.press("Enter");
    await expect(
      page.getByRole("alert").filter({ hasText: `Another of your binders already uses ${readable}. Pick a different link name.` }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: `Rename or delete ${twinName}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Rename or delete ${twinName}`, exact: true })
      .getByRole("button", { name: "Delete this binder" })
      .click();
    const confirmTwin = page.getByRole("dialog", { name: `Delete ${twinName}?`, exact: true });
    await confirmTwin.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirmTwin).toBeHidden();
    // The delete lands back on the shelf once it is done; wait for that before opening anything.
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(twinName)}, `) })).toHaveCount(0);
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) })).toBeVisible();

    // --- Cleanup through the UI: remove the copy, delete the empty binder ---
    // A fresh load of Checklists: the trips above leave the tab's remembered
    // drill and scope behind, so start it from a known place.
    await page.goto("/collection?tab=checklists");
    await drillToCollectorBase(page);
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    await checklist.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
    await yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRegExp(card.short)}, `) }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) }).click();
    await page.getByRole("button", { name: `Rename or delete ${binderName}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Rename or delete ${binderName}`, exact: true })
      .getByRole("button", { name: "Delete this binder" })
      .click();
    const confirm = page.getByRole("dialog", { name: `Delete ${binderName}?`, exact: true });
    await confirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirm).toBeHidden();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) })).toHaveCount(0);
  },
);
