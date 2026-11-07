// NEO-360, NEO-444 (R1): public share links. A signed-in collector picks a
// public name, builds a binder holding one graded copy with a cost, a location,
// notes and a cert, flagged Up for trade, plus a raw copy with a front and back
// photo aimed at the first pocket of page 2. PageDown and PageUp turn their own
// binder. They open Share: Private is picked. They rename the link, pick Public
// and read the plain link (`/u/<username>/binders/<link name>`) off the panel.
//
// A visitor (a fresh, signed-out context on the same device) opens it and sees
// the real binder, read-only: its name, the card in its pocket on page 1 with
// the grade on the sleeve, and none of the private strings anywhere on the
// page. Nothing an owner can do is on offer, and an empty pocket is not a
// button. A pocket pops its card into a top loader: a dialog named by the card's
// title, with the title showing and the details below it. Escape, the close
// button, the backdrop and browser Back all put it down, and focus goes back to
// the pocket. The raw copy's photos really load for a visitor, See the back and
// See the front flip them, and Tab walks every stop and wraps. Pages turn with
// the buttons and PageUp / PageDown, on a phone one page at a time (a phone on
// its side gets the spread, a tablet held upright the single page). The URL
// holds the place: a reload or a pasted link opens the same `?page=` and the
// same `?card=`, and a link that asks for more than there is never breaks the
// page.
//
// Then the rest of the sharing: a wrong link name reads as not found; the
// profile's shelf lists the binder and Up for Trade, and from there Back leaves
// the binder in one step however many pages were turned and cards were opened;
// the Want List (never switched public) reads as not found; Up for Trade, public
// by default, lists the card. The collector keeps the binder sorted by checklist
// with its empty slots shared: the visitor sees Need sleeves that are no buttons,
// and the graded pocket still opens; the settings go back. Up for Trade switched
// private, with the binder still public, reads as not found and leaves the
// profile's shelf, and the Trade flag drops off the binder's pocket and top
// loader while the card stays; switched back, the flag returns. The collector
// picks Private and the visitor's link, card link included, reads as not found.
// The Want List switched public opens. A second binder can't take the first
// one's link name. Both shelves are put back as they were.
//
// Not covered here: the for-sale page. Boxes are made only in the demo until
// Inventory reaches the real collection (NEO-364); unit tests in
// convex/publicCollection.test.ts cover it. A swipe's page turn: Playwright's
// touchscreen only taps, so it stays with BinderDesk.test.tsx.
//
// R7/R7a: writes only the signed-in user's own rows (`publicProfiles`,
// `collectionContainers`, `collectionCopies`, `collectionCopyPhotos`; the
// bootstrap reset clears the account) on the first two ordinary rows of the
// seed's 2024 Topps Chrome Base, registered in SET-REGISTRY.md. Never writes the
// set, its cards, players or teams. Self-cleaning: the copies are removed through
// the UI, which detaches the photos for the hourly sweep (their R2 objects land
// in the dev bucket, which expires them), and the binder is deleted. The username
// is `env.TEST_USERNAME`, fresh per test.
//
// The sorted step's empty slots fit: one checklist (at most MAX_NEED_CHECKLISTS)
// of 335 cards, well under MAX_NEEDS, so `binderNeeds` never truncates here.
//
// R3: the collector's cascade is drilled through `support/collection.ts`.
import type { Locator, Page } from "@playwright/test";
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A 50x70 JPEG, inline: no fixture file to keep.
const CARD_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABGADIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCcDccCl8s+1Ef3vwptYxjQp0IznBttvrba3k+5+YjvLPtR5Z9qbRU+1wv/AD6f/gX/AAA1HeWfakKlRk0lOP8Aqx9a0gsPVhPlg00r736ry8w1G0UUV5ox0f3vwptOj+9+FNruq/7rS9ZfoLqFFFFcIwpx/wBWPrTacf8AVj613YT4av8Ahf5oTG0UUVwjHR/e/Cm06P734U2u6r/utL1l+guoUUUVwjCnH/Vj602nH/Vj613YT4av+F/mhMbRRRXCMdH978KbTo/vfhSbG9K9KVGpUwtPki3rLZX7C6iUUuxvSjY3pXN9UxH/AD7l9zHdCU4/6sfWk2N6UrDEYB9a68PQq04VXOLS5XumuqExtFFFeWMM46Ubj6miirjUnFWTYBuPqaNx9TRRVe2qfzP7wDcfU0ZJ6miik6s2rOTAKKKKzA//2Q==",
  "base64",
);
const photoFile = (name: string) => ({ name, mimeType: "image/jpeg", buffer: CARD_JPEG });

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
    // The owner's call to the page-turn keys: PageDown and back, then the button.
    // (The owner's back page is named "Page 2, A fresh page" until a card lands on it.)
    const ownerPage = (n: number) => page.getByRole("group", { name: new RegExp(`^Page ${n}(,|$)`) });
    await expect(ownerPage(1)).toBeVisible();
    // Page 1 draws before the binder's cards are in; until they are, there is no next page to turn to.
    await expect(page.getByRole("button", { name: nextName, exact: true })).toBeEnabled();
    await page.keyboard.press("PageDown");
    await expect(ownerPage(2)).toBeVisible();
    await expect(ownerPage(1)).toHaveCount(0);
    await page.keyboard.press("PageUp");
    await expect(ownerPage(1)).toBeVisible();
    await expect(ownerPage(2)).toHaveCount(0);
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

    // --- Its front and back photos, from its pocket ---------------------------
    await ownerPage(2).getByRole("button", { name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(raw.number)} ${escapeRegExp(raw.player)}`) }).click();
    const rawDrawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(raw.number)} ${escapeRegExp(raw.player)}`),
    });
    const rawCopies = rawDrawer.getByRole("region", { name: `Your copies of ${raw.short}`, exact: true });
    await rawCopies.getByRole("button", { name: `Edit ${raw.short}, Raw, Excellent`, exact: true }).click();
    const photoPanel = rawCopies
      .getByRole("form", { name: "Edit Raw, Excellent", exact: true })
      .getByRole("region", { name: "Photos", exact: true });
    await photoPanel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
    await expect(photoPanel.getByRole("status")).toHaveText("Front photo saved.");
    await photoPanel.getByLabel("Back photo file", { exact: true }).setInputFiles(photoFile("back.jpg"));
    await expect(photoPanel.getByRole("status")).toHaveText("Back photo saved.");
    await rawDrawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(rawDrawer).toBeHidden();

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
          name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}, .*, PSA 10, up for trade, pocket \\d+ on page 1$`),
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
    await expect(visitor.getByText(isMobile ? "Tap a card to pop it out. Swipe to turn." : "PageUp and PageDown turn the pages. Pick a card to pop it out.")).toBeVisible();
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
    const gradedName = /button "(.+), PSA 10, up for trade, pocket \d+ on page 1"/.exec(await graded.ariaSnapshot())?.[1];
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
    await expectAccessible(visitor, { label: "Public binder page, the last page" });
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

    // --- The collector's photos: they load for a visitor, and flip -------------
    const rawFront = rawDialog(visitor).getByRole("img", { name: rawName, exact: true });
    const rawBack = rawDialog(visitor).getByRole("img", { name: `${rawName}, the back`, exact: true });
    const seeBack = rawAbout.getByRole("button", { name: "See the back", exact: true });
    const seeFront = rawAbout.getByRole("button", { name: "See the front", exact: true });
    const fullSize = rawAbout.getByRole("link", { name: "See it full size (opens a new tab)", exact: true });
    await expect(rawFront).toBeVisible();
    // A broken image reads 0. Retries until it has loaded, on the 7 s budget.
    await expect(rawFront).not.toHaveJSProperty("naturalWidth", 0);
    await expect(rawBack).toHaveCount(0);
    await expectAccessible(visitor, { label: "Public binder page, a card's photos in the top loader" });

    // Every tab stop, in order, and round again. Where the stage overflows (a short
    // screen) it is a stop of its own, after the close button.
    const rawTitle = rawDialog(visitor).getByRole("heading", { level: 2, name: rawName, exact: true });
    const rawClose = rawDialog(visitor).getByRole("button", { name: "Close the top loader", exact: true });
    const scrollingStage = rawDialog(visitor).getByRole("group", { name: "This card and its details", exact: true });
    await expect(rawTitle).toBeFocused();
    await visitor.keyboard.press("Tab");
    await expect(seeBack).toBeFocused();
    await visitor.keyboard.press("Tab");
    await expect(fullSize).toBeFocused();
    await visitor.keyboard.press("Tab"); // wraps
    await expect(rawClose).toBeFocused();
    if (await scrollingStage.count()) {
      await visitor.keyboard.press("Tab");
      await expect(scrollingStage).toBeFocused();
    }
    await visitor.keyboard.press("Tab");
    await expect(seeBack).toBeFocused();
    if (await scrollingStage.count()) {
      await visitor.keyboard.press("Shift+Tab");
      await expect(scrollingStage).toBeFocused();
    }
    await visitor.keyboard.press("Shift+Tab");
    await expect(rawClose).toBeFocused();
    await visitor.keyboard.press("Shift+Tab"); // wraps the other way
    await expect(fullSize).toBeFocused();

    // See the back: the image's name changes, and the full-size link follows it.
    const frontHref = await fullSize.getAttribute("href");
    await seeBack.press("Enter");
    await expect(rawBack).toBeVisible();
    await expect(rawBack).not.toHaveJSProperty("naturalWidth", 0);
    await expect(rawFront).toHaveCount(0);
    await expect(seeFront).toBeFocused();
    await expect(rawAbout.getByRole("status")).toHaveText("Showing the back");
    await expect(fullSize).not.toHaveAttribute("href", frontHref ?? "");
    await seeFront.press("Enter");
    await expect(rawFront).toBeVisible();
    await expect(rawFront).not.toHaveJSProperty("naturalWidth", 0);
    await expect(rawBack).toHaveCount(0);
    await expect(seeBack).toBeFocused();
    await expect(rawAbout.getByRole("status")).toHaveText("Showing the front");
    await expect(fullSize).toHaveAttribute("href", frontHref ?? "");

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
    await expectNoCardInUrl(pasted); // the URL stops asking for it
    // The open card's own page wins over the page in the link: its pocket has to be there to take focus back.
    await pasted.goto(`${link.pathname}?page=1&card=${rawKey}`);
    await expect(rawDialog(pasted)).toBeVisible();
    await pasted.keyboard.press("Escape");
    await expect(rawDialog(pasted)).toBeHidden();
    await onSecondPage(pasted);
    await expect(binder(pasted).rawCopy).toBeFocused();
    if (isMobile) {
      // A phone on its side has room for the spread, and still no keys to name. A
      // tablet held upright has the width for one but reads better as a single page.
      await pasted.goto(link.pathname);
      await pasted.setViewportSize({ width: 839, height: 412 });
      await expect(pasted.getByText("Inside cover and page 1 of 2", { exact: true })).toBeVisible();
      await expect(pasted.getByText("Swipe to turn the pages. Tap a card to pop it out.", { exact: true })).toBeVisible();
      await pasted.setViewportSize({ width: 768, height: 1024 });
      await expect(pasted.getByText("Page 1 of 2", { exact: true })).toBeVisible();
      await expect(pasted.getByText("Tap a card to pop it out. Swipe to turn.", { exact: true })).toBeVisible();
      await expect(pasted.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
    }
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

    // --- Sorted by checklist, its empty slots shared: Need sleeves ------------
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: `${binderName} settings`, exact: true });
    const wherePut = settings.getByRole("radio", { name: /^Where I put them/ });
    const keepSorted = settings.getByRole("radio", { name: /^Keep sorted by checklist/ });
    const includeEmpty = settings.getByRole("checkbox", { name: /^Include empty slots/ });
    const showEmpty = settings.getByRole("checkbox", { name: /^Show empty slots on my public page/ });
    await expect(wherePut).toBeChecked();
    await expect(includeEmpty).not.toBeChecked();
    await expect(showEmpty).not.toBeChecked();
    await keepSorted.check();
    await expect(keepSorted).toBeChecked();
    await includeEmpty.check();
    await expect(includeEmpty).toBeChecked();
    await showEmpty.check();
    await expect(showEmpty).toBeChecked();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toBeHidden();

    await visitor.goto(link.pathname);
    // A sorted page says what it holds: "Page 1, 2024 Topps Chrome Base".
    const sortedPageOne = visitor.getByRole("group", { name: /^Page 1(,|$)/ });
    await expect(sortedPageOne.getByText("Need", { exact: true }).first()).toBeVisible();
    await expect(sortedPageOne.getByText(/, this binder still needs it$/).first()).toBeVisible();
    // A sleeve it still needs is no button: only the cards it holds are.
    await expect(sortedPageOne.getByRole("button", { name: /needs|need\. Add it|Move it here/ })).toHaveCount(0);
    await expect(sortedPageOne.getByRole("button", { name: / on page 1$/ })).toHaveCount(await sortedPageOne.getByRole("button").count());
    await expectNoOwnerAction(visitor);
    await expectNoSecrets(visitor, visitor.getByRole("main"));
    await expectAccessible(visitor, { label: "Public binder page, sorted with its empty slots" });
    const sortedGraded = sortedPageOne.getByRole("button", {
      name: new RegExp(`^${escapeRegExp(gradedName!)}, PSA 10, up for trade, pocket \\d+ on page 1$`),
    });
    await sortedGraded.click();
    await expect(title).toBeVisible();
    await expect(about.getByText("PSA 10", { exact: true })).toBeVisible();
    await visitor.keyboard.press("Escape");
    await putDown();
    await expect(sortedGraded).toBeFocused();

    // The settings go back; the visitor's sleeves go with them. Sorting off leaves each card where it is.
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
    await showEmpty.uncheck();
    await expect(showEmpty).not.toBeChecked();
    await includeEmpty.uncheck();
    await expect(includeEmpty).not.toBeChecked();
    // Not check(): this radio only moves once the sorted order has been written down, a save or two later.
    await wherePut.click();
    await expect(wherePut).toBeChecked();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toBeHidden();
    await visitor.goto(link.pathname);
    await expect(graded).toBeVisible();
    await expect(visitor.getByText("Need", { exact: true })).toHaveCount(0);
    await expect(visitor.getByText(/, this binder still needs it$/)).toHaveCount(0);

    // --- Up for Trade switched private, with the binder still public ---------
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
    await expect(binderLink).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Up for Trade" })).toHaveCount(0);

    // The binder says nothing of a private shelf: no flag in the pocket's name, on
    // its sleeve or in the top loader, and the card and its grade still show.
    await visitor.goto(link.pathname);
    const gradedNoFlag = pageOne.getByRole("button", {
      name: new RegExp(`^${escapeRegExp(gradedName!)}, PSA 10, pocket \\d+ on page 1$`),
    });
    await expect(gradedNoFlag).toBeVisible();
    await expect(graded).toHaveCount(0);
    await expect(gradedNoFlag.getByText("PSA 10", { exact: true })).toBeVisible();
    await expect(gradedNoFlag.getByText(card.player).first()).toBeVisible();
    await expect(gradedNoFlag.getByText("Trade", { exact: true })).toHaveCount(0);
    await gradedNoFlag.click();
    await expect(title).toBeVisible();
    await expect(about.getByText("PSA 10", { exact: true })).toBeVisible();
    await expect(about.getByText("Trade", { exact: true })).toHaveCount(0);
    await visitor.keyboard.press("Escape");
    await putDown();

    // Switched back, the flag returns on the page the visitor already has open.
    await tradeVisibility.getByRole("radio", { name: /^Public/ }).check();
    await expect(tradeVisibility.getByRole("radio", { name: /^Public/ })).toBeChecked();
    await expect(graded).toBeVisible();
    await expect(gradedNoFlag).toHaveCount(0);
    await expect(graded.getByText("Trade", { exact: true })).toBeVisible();
    await graded.click();
    await expect(about.getByText("Trade", { exact: true })).toBeVisible();
    await visitor.keyboard.press("Escape");
    await putDown();
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // --- Back to private: the link reads as not found ----------------------
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    await shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binderName)}, `) }).click();
    await expect(heading).toBeVisible();
    await page.getByRole("button", { name: `Share ${binderName}`, exact: true }).click();
    await expect(publicChoice).toBeChecked();
    await privateChoice.check();
    await expect(privateChoice).toBeChecked();
    await visitor.goto(link.pathname);
    await expectNotFound(visitor);
    // The card link goes with it: no dialog over the not-found screen.
    await visitor.goto(`${link.pathname}?card=${rawKey}`);
    await expectNotFound(visitor);
    await expect(visitor.getByRole("dialog")).toHaveCount(0);
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
