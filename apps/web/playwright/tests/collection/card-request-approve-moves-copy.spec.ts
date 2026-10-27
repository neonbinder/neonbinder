// NEO-361 (R1): a collector asks for a card the catalog doesn't have, owns it
// straight away, and when our crew adds it (the admin's Card Requests review,
// "Add and approve") their copy lands on the new catalog card by itself: the
// checklist shows it held, and My requests says Added.
//
// One account plays both parts: the worker's account is the collector who asks
// (through /collection > Checklists > "Request a card") and the admin who
// approves (/admin/card-requests). The admin queue is shared by every shard,
// so the request is found by its minted card number and player, never by
// position.
//
// R7/R7a: writes only a hand-made, per-attempt set (`crqa-<worker>-<attempt>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace
// id beneath it: one hand-added card (so the collector's catalog offers the set
// at all; a known-empty set is hidden) and the card the approval adds. The
// request, the private card and the copy are the account's own (the bootstrap
// reset clears them). Self-cleaning: the copy is removed through the UI at the
// end; the set and its two cards stand, per attempt.
//
// R3: the collector's cascade drills through `support/collection.ts`; the set
// builder through `support/set-builder.ts`. The decline path (the card stays
// private, with the crew's note) is card-request-decline-stays-private.
//
// MINTED NAMES are single tokens: the set `crqa-<worker>-<attempt>`, the card
// numbers `1<token>` (the seed card) and `9<token>` (the requested one), the
// player `Asked<token>`.
import { collectorCascade } from "../../support/collection";
import { addCardViaForm, escapeRe } from "../../support/cards";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";

test(
  "Card request: a collector asks for a missing card, owns it at once, and an admin's approval moves their copy onto the new catalog card",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    const setName = `crqa-${env.WORKER_INDEX}-${A}`;
    const seedNumber = `1${T}`;
    const number = `9${T}`;
    const player = `Asked${T}`;

    // --- A set of our own, holding one card ------------------------------------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    const build = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName, variantType: "Insert", variant: "Base" };
    await drillToCustom(page, build);
    await addCardViaForm(page, { cardNumber: seedNumber, playerName: `Seed${T}` });

    // --- The collector asks for #9<token> ----------------------------------------
    await page.goto("/collection?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    const { drill } = collectorCascade(page);
    await drill("Sports", "Baseball", "Years");
    await drill("Years", "2024", "Brands");
    await drill("Brands", "Topps", "Sets");
    await drill("Sets", setName, "Variant Types");
    await drill("Variant Types", "Insert");
    await drill("Insert", "Base");
    const checklist = page.getByRole("region", { name: `2024 ${setName} Base`, exact: true });
    await expect(checklist.getByRole("button", { name: `Details for #${seedNumber}`, exact: true })).toBeVisible();
    // Not in the catalog yet: R2's precondition for the approval below.
    await expect(checklist.getByRole("button", { name: `Details for #${number}`, exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Request a card", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Can't find it?" });
    await expect(dialog.getByRole("tab", { name: "Request a card", selected: true })).toBeVisible();
    const form = dialog.getByRole("form", { name: "Request a card" });
    // The form starts where the collector is: the set and its checklist picked.
    await form.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: "Baseball" });
    await form.getByRole("combobox", { name: "Year", exact: true }).selectOption({ label: "2024" });
    await form.getByRole("combobox", { name: "Brand", exact: true }).selectOption({ label: "Topps" });
    await form.getByRole("combobox", { name: "Set", exact: true }).selectOption({ label: setName });
    await form.getByRole("combobox", { name: "Checklist", exact: true }).selectOption({ label: "Insert" });
    await form.getByRole("combobox", { name: "Insert", exact: true }).selectOption({ label: "Base" });
    await form.getByLabel("Card number", { exact: true }).fill(number);
    await form.getByLabel("Player", { exact: true }).fill(player);
    await expectAccessible(page, { label: "Request a card, filled" });
    await form.getByRole("button", { name: "Send request" }).click();

    const sent = form.getByRole("status").filter({ hasText: `Sent #${number} ${player}.` });
    await expect(sent).toBeVisible();
    // Theirs to own at once: "I have it" files a copy and closes the dialog.
    await sent.getByRole("button", { name: "I have it" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`#${escapeRe(number)}.*to Main`) })).toBeVisible();

    // --- The admin adds it and approves ------------------------------------------
    await page.goto("/admin/card-requests");
    await expect(page.getByRole("heading", { level: 2, name: "Card Requests" })).toBeVisible();
    const label = `2024 ${setName} Base #${number} ${player}`;
    await page
      .getByRole("region", { name: "Requests" })
      .getByRole("button", { name: new RegExp(`^Card: ${escapeRe(label)}`) })
      .click();
    const review = page.getByRole("region", { name: "Review" });
    await expect(review.getByRole("heading", { level: 3, name: `Card: ${label}` })).toBeFocused();
    await expect(review.getByText("they hold 1 copy", { exact: false })).toBeVisible();
    const add = review.getByRole("group", { name: "Add it to Base" });
    await expect(add.getByLabel("Card number", { exact: true })).toHaveValue(number);
    await expect(add.getByLabel("Card title", { exact: true })).toHaveValue(player);
    await expectAccessible(page, { label: "Card request review" });
    await add.getByRole("button", { name: "Add and approve" }).click();
    await expect(
      review.getByRole("status").filter({ hasText: `Added #${number} to Base. One line of their copies moved onto it.` }),
    ).toBeVisible();

    // --- The collector's copy is on the catalog card now ----------------------
    await page.goto("/collection?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await drill("Sports", "Baseball", "Years");
    await drill("Years", "2024", "Brands");
    await drill("Brands", "Topps", "Sets");
    await drill("Sets", setName, "Variant Types");
    await drill("Variant Types", "Insert");
    await drill("Insert", "Base");
    // A hand-added card has no linked player, so the checklist reads its number.
    const short = `#${number}`;
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw`, exact: true, pressed: true })).toBeVisible();

    await page.getByRole("button", { name: "My requests", exact: true }).click();
    await expect(dialog.getByRole("tab", { name: "My requests", selected: true })).toBeVisible();
    const mine = dialog.getByRole("list", { name: "My requests" }).getByRole("listitem").filter({ hasText: label });
    await expect(mine.getByText("Added", { exact: true })).toBeVisible();
    // An added request can't be withdrawn: it's a catalog card now.
    await expect(mine.getByRole("button", { name: /^Withdraw / })).toHaveCount(0);
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();

    // --- Clean up: the copy goes ---------------------------------------------
    await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 ${escapeRe(setName)}.*#${escapeRe(number)}`) });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw`, exact: true }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Removed ${short}, Raw` })).toBeVisible();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
  },
);
