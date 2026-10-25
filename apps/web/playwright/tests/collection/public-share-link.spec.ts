// NEO-360 (R1): public share links. A signed-in collector picks a public name,
// builds a binder holding one graded copy with a cost, a location, notes and a
// cert, flags it Up for trade, and opens Share: the binder says it is private.
// They rename the link's readable part, switch the binder public and read the
// link off the panel. A visitor (a fresh, signed-out context on the same
// device) opens it and sees the binder's name, the card and its grade, and
// none of the private strings anywhere on the page. A one-character change to
// the key reads as not found; the Want List (never switched public) reads as
// not found; Up for Trade, public by default, lists the card. The collector
// switches the binder private and the visitor's link reads as not found.
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
  "Collection: share a binder publicly, a visitor sees it without the private details, a wrong key and a private binder are not found",
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

    // --- Share: private at first; rename the link, switch it public ---------
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) }).click();
    await expect(heading).toBeVisible();
    await page.getByRole("button", { name: `Share ${binderName}`, exact: true }).click();
    const sw = page.getByRole("switch", { name: /^Private: only you can see it$/ });
    await expect(sw).not.toBeChecked();
    await expect(page.getByText("This binder is private. Switch it on to share the link below.")).toBeVisible();
    const linkName = page.getByRole("textbox", { name: "Link name" });
    await linkName.fill(readable);
    await linkName.press("Enter");
    const linkRe = new RegExp(`/u/${escapeRegExp(username)}/binders/${escapeRegExp(readable)}-[a-z0-9]{6}$`);
    const linkText = page.getByText(linkRe);
    await expect(linkText).toBeVisible();
    await sw.check();
    await expect(page.getByRole("switch", { name: /^Public: anyone with the link can look$/ })).toBeChecked();
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
    await expect(visitor.getByRole("region", { name: "Not in a pocket yet" }).getByText("PSA 10")).toBeVisible();
    await expect(visitor.getByText(card.player).first()).toBeVisible();
    for (const value of Object.values(secret)) await expect(visitor.getByText(value)).toHaveCount(0);
    await expectAccessible(visitor, { label: "Public binder page" });

    // A one-character change to the key: not found, the same screen as private.
    const key = link.pathname.slice(-6);
    const flipped = `${key.slice(0, 5)}${key[5] === "a" ? "b" : "a"}`;
    await visitor.goto(`${link.pathname.slice(0, -6)}${flipped}`);
    await expectNotFound(visitor);
    await expectAccessible(visitor, { label: "Public page not found" });

    // The Want List was never switched public.
    await visitor.goto(`/u/${username}/want-list`);
    await expectNotFound(visitor);

    // Up for Trade is public by default.
    await visitor.goto(`/u/${username}/up-for-trade`);
    await expect(visitor.getByRole("heading", { level: 1, name: "Up for Trade" })).toBeVisible();
    await expect(visitor.getByText("PSA 10")).toBeVisible();
    await expectAccessible(visitor, { label: "Public Up for Trade page" });

    // --- Back to private: the link reads as not found ----------------------
    await page.getByRole("switch", { name: /^Public: anyone with the link can look$/ }).uncheck();
    await expect(page.getByRole("switch", { name: /^Private: only you can see it$/ })).not.toBeChecked();
    await visitor.goto(link.pathname);
    await expectNotFound(visitor);
    await visitorContext.close();
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // --- Cleanup through the UI: remove the copy, delete the empty binder ---
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
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
