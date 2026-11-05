// NEO-360, NEO-444 (R1): public share links. A signed-in collector picks a
// public name, builds a binder holding one graded copy with a cost, a location,
// notes and a cert, flagged Up for trade, plus a raw copy aimed at the first
// pocket of page 2, and opens Share: Private is picked. They rename the link,
// pick Public and read the plain link (`/u/<username>/binders/<link name>`) off
// the panel.
//
// A visitor (a fresh, signed-out context on the same device) opens it and sees
// the real binder, read-only: its name, the card in its pocket on page 1 with
// the grade on the sleeve, and none of the private strings anywhere on the
// page. Nothing an owner can do is on offer, and an empty pocket is not a
// button. A pocket pops its card into a top loader: a dialog named by the card's
// title, with the title showing and the details below it. Escape, the close
// button, the backdrop and browser Back all put it down, and focus goes back to
// the pocket. Pages turn with the buttons and PageUp / PageDown, on a phone one
// page at a time. The URL holds the place: a reload or a pasted link opens the
// same `?page=` and the same `?card=`, and a link that asks for more than there
// is never breaks the page.
//
// Then the rest of the sharing: a wrong link name reads as not found; the
// profile's shelf lists the binder and Up for Trade, and from there Back leaves
// the binder in one step however many pages were turned and cards were opened;
// the Want List (never switched public) reads as not found; Up for Trade, public
// by default, lists the card. The collector picks Private again and the
// visitor's link, card link included, reads as not found. Up for Trade switched
// private reads as not found and leaves the profile's shelf; the Want List
// switched public opens. A second binder can't take the first one's link name.
// Both shelves are put back as they were.
//
// Not covered here: the for-sale page. Boxes are made only in the demo until
// Inventory reaches the real collection (NEO-364); unit tests in
// convex/publicCollection.test.ts cover it. Also left to unit tests, in
// Pocket.test.tsx: a shared Need sleeve (it takes a sorted binder with shared
// empty slots) and a card with a collector's photos (the top loader's flip).
//
// R7/R7a: writes only the signed-in user's own rows (`publicProfiles`,
// `collectionContainers`, `collectionCopies`; the bootstrap reset clears the
// account) on two cards of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md. Never writes the set, its cards, players or teams.
// Self-cleaning: the copies are removed and the binder deleted through the UI.
// The username is `env.TEST_USERNAME`, fresh per test.
//
// R3: the collector's cascade is drilled through `support/collection.ts`.
import type { Locator, Page } from "@playwright/test";
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Collection: share a binder publicly, a visitor sees it without the private details, a wrong link name and a private binder are not found",
  { tag: ["@smoke", "@collection"] },
  async ({ page, browser, baseURL, signIn, env, isMobile }) => {
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
    // Read before any write: a card with two lines drops out of the ordinary rows.
    const raw = await shortNameOf(ordinaryBaseRows(checklist).nth(1));
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

    // --- A raw copy on page 2, so the shared binder has a page to turn to ----
    // The owner's binder always keeps a fresh page at the back: aim its first pocket.
    const nextName = isMobile ? "Next page" : "Next pages";
    const previousName = isMobile ? "Previous page" : "Previous pages";
    await page.getByRole("button", { name: nextName, exact: true }).click();
    await page.getByRole("button", { name: "Empty pocket 1 on page 2. Fill it from the pack", exact: true }).click();
    await page.getByRole("searchbox", { name: "Hunt for one of your cards" }).fill(`${raw.player} ${raw.number}`);
    await page
      .getByRole("button", {
        // The hunt finds the base card and its parallels: the base card's name stops at the team.
        name: new RegExp(`^Put here: 2024 Topps Chrome #${escapeRegExp(raw.number)} ${escapeRegExp(raw.player)}, [^,]+$`),
      })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: `Added ${raw.short} to ${binderName}, page 2, pocket 1` }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();

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
    const { viewport, userAgent, deviceScaleFactor, hasTouch } = test.info().project.use;
    const visitorContext = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
    const visitor = await visitorContext.newPage();
    const expectNotFound = async (p: Page) => {
      await expect(p.getByRole("heading", { level: 1, name: "Nothing to see here" })).toBeVisible();
    };

    await visitor.goto(link.pathname);
    await expect(visitor.getByRole("heading", { level: 1, name: binderName })).toBeVisible({ timeout: LAUNCH_GATE });

    /** The binder's own handles, for a page or tab of the visitor's. */
    const binder = (p: Page) => {
      const pageOne = p.getByRole("group", { name: "Page 1", exact: true });
      const pageTwo = p.getByRole("group", { name: "Page 2", exact: true });
      return {
        pageOne,
        pageTwo,
        graded: pageOne.getByRole("button", {
          name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}, .*, PSA 10, up for trade, pocket 1 on page 1$`),
        }),
        rawCopy: pageTwo.getByRole("button", {
          name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(raw.number)} ${escapeRegExp(raw.player)}, [^,]+, pocket 1 on page 2$`),
        }),
        next: p.getByRole("button", { name: nextName, exact: true }),
        previous: p.getByRole("button", { name: previousName, exact: true }),
      };
    };
    const { pageOne, pageTwo, graded, rawCopy, next, previous } = binder(visitor);
    const whereFirst = isMobile ? "Page 1 of 2" : "Inside cover and page 1 of 2";
    const onFirstPage = async (p: Page) => {
      await expect(binder(p).pageOne).toBeVisible();
      await expect(binder(p).pageTwo).toHaveCount(0);
      await expect(p.getByText(whereFirst, { exact: true })).toBeVisible();
      await expect(p).not.toHaveURL(/[?&]page=/);
    };
    /** Page 2 of 2, and on a wide screen the back cover beside it. Pass `url: false` when the link asked for another number. */
    const onSecondPage = async (p: Page, { url = true }: { url?: boolean } = {}) => {
      await expect(binder(p).pageTwo).toBeVisible();
      await expect(binder(p).pageOne).toHaveCount(0);
      await expect(p.getByText("Page 2 of 2", { exact: true })).toBeVisible();
      if (url) await expect(p).toHaveURL(/[?&]page=2(&|$)/);
    };
    const expectNoCardInUrl = async (p: Page) => {
      await expect(p).not.toHaveURL(/[?&]card=/);
    };
    /** Not a word of the private details, on screen or in any name a screen reader would read. */
    const expectNoSecrets = async (p: Page, region: Locator) => {
      for (const value of Object.values(secret)) await expect(p.getByText(value)).toHaveCount(0);
      const tree = await region.ariaSnapshot();
      for (const value of Object.values(secret)) expect(tree, "the accessibility tree holds no private detail").not.toContain(value);
    };
    /** Nothing an owner can do reaches a visitor. Paired with the positive asserts around each call (R2). */
    const expectNoOwnerAction = async (p: Page) => {
      await expect(p.getByRole("button", { name: /Fill it from the pack/ })).toHaveCount(0);
      await expect(p.getByText("Fill", { exact: true })).toHaveCount(0);
      await expect(p.getByRole("button", { name: /Add it/ })).toHaveCount(0);
      await expect(p.getByText(/Outside the rule/i)).toHaveCount(0);
      await expect(p.getByRole("button", { name: /Binder settings|^Share |Back to the shelf|^Move |^Edit |^Remove / })).toHaveCount(0);
      await expect(p.getByRole("searchbox", { name: "Hunt for one of your cards" })).toHaveCount(0);
    };

    // --- The real binder, read-only ------------------------------------------
    await onFirstPage(visitor);
    await expect(visitor.getByText(isMobile ? "Tap a card to pop it out." : /PageUp and PageDown turn the pages/)).toBeVisible();
    // Added from its details, the copy still went into a pocket: the first open one.
    await expect(graded).toBeVisible();
    await expect(graded.getByText("PSA 10", { exact: true })).toBeVisible();
    await expect(graded.getByText("Trade", { exact: true })).toBeVisible();
    await expect(graded.getByText(card.player).first()).toBeVisible();
    await expect(visitor.getByText("Not in a pocket yet")).toHaveCount(0);
    // The card is the page's one button: its eight empty pockets say so, and do nothing.
    await expect(pageOne.getByRole("button")).toHaveCount(1);
    await expect(pageOne.getByText("Empty pocket", { exact: true })).toHaveCount(8);
    await expectNoOwnerAction(visitor);
    await expectNoSecrets(visitor, visitor.getByRole("main"));
    await expectAccessible(visitor, { label: "Public binder page" });

    // --- The top loader: its dialog, its title, its details ------------------
    // The title is whatever the pocket's name starts with, up to what the pocket adds.
    const gradedName = /button "(.+), PSA 10, up for trade, pocket 1 on page 1"/.exec(await graded.ariaSnapshot())?.[1];
    expect(gradedName, "the pocket's name starts with the card's title").toBeTruthy();
    const dialog = visitor.getByRole("dialog", { name: gradedName, exact: true });
    const title = dialog.getByRole("heading", { level: 2, name: gradedName, exact: true });
    const about = dialog.getByRole("group", { name: "About this card", exact: true });
    const closeButton = dialog.getByRole("button", { name: "Close the top loader", exact: true });
    const putDown = async () => {
      await expect(dialog).toBeHidden();
      await expectNoCardInUrl(visitor);
    };

    await graded.click();
    await expect(dialog).toBeVisible();
    await expect(visitor).toHaveURL(/[?&]card=[^&]+/);
    await expect(title).toBeVisible();
    await expect(title).toBeFocused();
    await expect(about.getByText("PSA 10", { exact: true })).toBeVisible();
    await expect(about.getByText("Trade", { exact: true })).toBeVisible();
    await expectNoOwnerAction(visitor);
    await expectNoSecrets(visitor, dialog);
    await expectAccessible(visitor, { label: "Public binder page, a card in its top loader" });
    // Tab stays in the dialog. Nothing in it but the close button takes focus here.
    await visitor.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await visitor.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    // The card and its words catch a press; only the space around them closes.
    await title.click();
    await expect(dialog).toBeVisible();

    // Escape: opened and put down from the keyboard, focus back on the pocket.
    await visitor.keyboard.press("Escape");
    await putDown();
    await expect(graded).toBeFocused();
    await graded.press("Enter");
    await expect(title).toBeFocused();
    await visitor.keyboard.press("Escape");
    await putDown();
    await expect(graded).toBeFocused();

    // The close button, by key and by press.
    await graded.press("Enter");
    await closeButton.press("Enter");
    await putDown();
    await expect(graded).toBeFocused();
    await graded.click();
    await closeButton.click();
    await putDown();

    // The backdrop: the empty corner of the screen, away from the close button.
    await graded.click();
    await expect(dialog).toBeVisible();
    if (isMobile) await visitor.touchscreen.tap(8, 8);
    else await visitor.mouse.click(8, 8);
    await putDown();

    // Browser Back puts it down; Forward picks it back up; focus follows.
    await graded.click();
    await expect(dialog).toBeVisible();
    await visitor.goBack();
    await putDown();
    await expect(graded).toBeFocused();
    await visitor.goForward();
    await expect(dialog).toBeVisible();
    await closeButton.click();
    await putDown();

    // --- Turning the pages -----------------------------------------------------
    await expect(previous).toBeDisabled();
    await next.click();
    await onSecondPage(visitor);
    await expect(next).toBeDisabled();
    await expect(rawCopy).toBeVisible();
    await expect(pageTwo.getByRole("button")).toHaveCount(1);
    await expect(pageTwo.getByText("Empty pocket", { exact: true })).toHaveCount(8);
    // A phone shows one page; a wide screen shows the last page beside the back cover.
    await expect(visitor.getByText("The back cover. That's the whole binder.")).toHaveCount(isMobile ? 0 : 1);
    await expectNoOwnerAction(visitor);
    await previous.click();
    await onFirstPage(visitor);
    await expect(graded).toBeVisible();
    await visitor.keyboard.press("PageDown");
    await onSecondPage(visitor);
    await visitor.keyboard.press("PageDown"); // the last page: nowhere further to go
    await onSecondPage(visitor);
    await visitor.keyboard.press("PageUp");
    await onFirstPage(visitor);
    await visitor.keyboard.press("PageDown");
    await onSecondPage(visitor);

    // --- The URL holds the place: reload ---------------------------------------
    await visitor.reload();
    await onSecondPage(visitor);
    await expect(rawCopy).toBeVisible();

    // The raw copy's details, opened on page 2: the page stays in the URL beside the card.
    const rawName = /button "(.+), pocket 1 on page 2"/.exec(await rawCopy.ariaSnapshot())?.[1];
    expect(rawName, "the pocket's name starts with the card's title").toBeTruthy();
    const rawDialog = (p: Page) => p.getByRole("dialog", { name: rawName, exact: true });
    const rawAbout = rawDialog(visitor).getByRole("group", { name: "About this card", exact: true });
    await rawCopy.click();
    await expect(rawDialog(visitor).getByRole("heading", { level: 2, name: rawName, exact: true })).toBeVisible();
    await expect(visitor).toHaveURL(/[?&]page=2(&|$)/);
    await expect(rawAbout.getByText("Excellent", { exact: true })).toBeVisible();
    await expect(rawAbout.getByText("PSA 10", { exact: true })).toHaveCount(0);
    await expect(rawAbout.getByText("Trade", { exact: true })).toHaveCount(0);
    const rawKey = new URL(visitor.url()).searchParams.get("card");
    expect(rawKey, "the open card is in the URL").toBeTruthy();
    await expectNoSecrets(visitor, rawDialog(visitor));

    // A reload keeps the card open, and it still puts down onto its page.
    await visitor.reload();
    await expect(rawDialog(visitor)).toBeVisible();
    await visitor.keyboard.press("Escape");
    await expect(rawDialog(visitor)).toBeHidden();
    await expectNoCardInUrl(visitor);
    await onSecondPage(visitor);
    await expect(rawCopy).toBeFocused();

    // --- The URL holds the place: pasted links, in a tab with no history -------
    const pasted = await visitorContext.newPage();
    // A card alone opens over its own page; closing stays there, in the URL too.
    await pasted.goto(`${link.pathname}?card=${rawKey}`);
    await expect(rawDialog(pasted)).toBeVisible();
    await expect(binder(pasted).pageTwo).toHaveCount(1);
    await rawDialog(pasted).getByRole("button", { name: "Close the top loader", exact: true }).click();
    await expect(rawDialog(pasted)).toBeHidden();
    await expectNoCardInUrl(pasted);
    await onSecondPage(pasted);
    await expect(binder(pasted).rawCopy).toBeFocused();
    // The same put down from the keyboard.
    await pasted.goto(`${link.pathname}?card=${rawKey}`);
    await expect(rawDialog(pasted)).toBeVisible();
    await pasted.keyboard.press("Escape");
    await expect(rawDialog(pasted)).toBeHidden();
    await expectNoCardInUrl(pasted);
    await onSecondPage(pasted);
    await expect(binder(pasted).rawCopy).toBeFocused();
    // A page alone: that page, nothing open.
    await pasted.goto(`${link.pathname}?page=2`);
    await onSecondPage(pasted);
    await expect(pasted.getByRole("dialog")).toHaveCount(0);
    // More than the binder has: the last page. Nonsense, or a card that isn't here: the first, nothing open.
    await pasted.goto(`${link.pathname}?page=99`);
    await onSecondPage(pasted, { url: false });
    await pasted.goto(`${link.pathname}?page=nope`);
    await expect(binder(pasted).pageOne).toBeVisible();
    await expect(pasted.getByText(whereFirst, { exact: true })).toBeVisible();
    await pasted.goto(`${link.pathname}?card=nope`);
    await expect(binder(pasted).graded).toBeVisible();
    await expect(pasted.getByRole("dialog")).toHaveCount(0);
    await pasted.close();

    // A wrong link name: not found, the same screen as private.
    await visitor.goto(`${link.pathname}-nope`);
    await expectNotFound(visitor);
    await expectAccessible(visitor, { label: "Public page not found" });

    // The profile's shelf lists the public binder and Up for Trade.
    await visitor.goto(`/u/${username}`);
    const profileShelf = visitor.getByRole("region", { name: "Collection" });
    const binderLink = profileShelf.getByRole("link", { name: new RegExp(`^${escapeRegExp(binderName)}`) });
    await expect(binderLink).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(profileShelf.getByRole("link", { name: "Up for Trade" })).toBeVisible();
    await expectAccessible(visitor, { label: "Public profile with its shelf" });

    // Into the binder from the shelf: turning pages and opening a card leave no
    // step behind, so one Back from the binder is back on the shelf.
    await binderLink.click();
    await onFirstPage(visitor);
    await graded.click();
    await expect(dialog).toBeVisible();
    await visitor.keyboard.press("Escape");
    await putDown();
    await next.click();
    await onSecondPage(visitor);
    await previous.click();
    await onFirstPage(visitor);
    await next.click();
    await onSecondPage(visitor);
    await visitor.goBack();
    await expect(binderLink).toBeVisible();
    await expect(visitor.getByRole("heading", { level: 1, name: binderName })).toHaveCount(0);

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
    // The card link goes with it: no dialog over the not-found screen.
    await visitor.goto(`${link.pathname}?card=${rawKey}`);
    await expectNotFound(visitor);
    await expect(visitor.getByRole("dialog")).toHaveCount(0);
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
    // NEO-362: label and rename controls live in the binder's settings.
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
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

    // --- Cleanup through the UI: remove the copies, delete the empty binder ---
    // A fresh load of Checklists: the trips above leave the tab's remembered
    // drill and scope behind, so start it from a known place.
    await page.goto("/collection?tab=checklists");
    await drillToCollectorBase(page);
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    for (const c of [card, raw]) {
      const copyDrawer = page.getByRole("dialog", {
        name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(c.number)} ${escapeRegExp(c.player)}`),
      });
      await checklist.getByRole("button", { name: `Details for ${c.short}`, exact: true }).click();
      const yourCopies = copyDrawer.getByRole("region", { name: `Your copies of ${c.short}`, exact: true });
      await yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRegExp(c.short)}, `) }).click();
      await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
      await copyDrawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(copyDrawer).toBeHidden();
    }
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) }).click();
    // NEO-362: label and rename controls live in the binder's settings.
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
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
