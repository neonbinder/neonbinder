// NEO-361 (R1): a card our crew declines stays the collector's, privately. They
// ask for a card in a checklist the set doesn't list (typed by name), file a
// copy, and an admin declines it with a note. The card is still in My Cards,
// tagged unlisted; its drawer says it wasn't added; My requests shows "Not
// added" with the crew's note; and removing the request (behind a confirm that
// says the copy goes too) takes the card and its copy away.
//
// One account plays both parts, as in card-request-approve-moves-copy (which
// proves the approve path); the shared admin queue is searched by the minted
// card number and player, never by position.
//
// R7/R7a: writes only a hand-made, per-attempt set (`crqd-<worker>-<attempt>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace
// id beneath it: one hand-added card, so the collector's catalog offers the set
// (a known-empty set is hidden). The request is declined, so nothing is ever
// added to the catalog. The request, private card and copy are the account's
// own; removing the request at the end deletes all three (self-cleaning).
//
// MINTED NAMES are single tokens: the set `crqd-<worker>-<attempt>`, the card
// numbers `1<token>` (the seed card) and `8<token>` (the requested one), the
// player `Declined<token>`, the typed checklist `Foil<token>`.
import { collectorCascade } from "../../support/collection";
import { addCardViaForm, escapeRe } from "../../support/cards";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";

test(
  "Card request: a declined card stays the collector's own, marked unlisted with the crew's note, until they remove it",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    const setName = `crqd-${env.WORKER_INDEX}-${A}`;
    const number = `8${T}`;
    const player = `Declined${T}`;
    const checklistName = `Foil${T}`;
    const crewNote = `We could not confirm this parallel ${T}.`;

    // --- A set of our own, holding one card ------------------------------------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: setName,
      variantType: "Insert",
      variant: "Base",
    });
    await addCardViaForm(page, { cardNumber: `1${T}`, playerName: `Seed${T}` });

    // --- The collector asks, naming a checklist the set doesn't list ----------
    await page.goto("/collection?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await page.getByRole("button", { name: "Request a card", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Can't find it?" });
    const form = dialog.getByRole("form", { name: "Request a card" });
    await form.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: "Baseball" });
    await form.getByRole("combobox", { name: "Year", exact: true }).selectOption({ label: "2024" });
    await form.getByRole("combobox", { name: "Brand", exact: true }).selectOption({ label: "Topps" });
    await form.getByRole("combobox", { name: "Set", exact: true }).selectOption({ label: setName });
    await form.getByRole("combobox", { name: "Checklist", exact: true }).selectOption({ label: "It isn't listed" });
    await form.getByLabel("Which checklist?", { exact: true }).fill(checklistName);
    await form.getByLabel("Card number", { exact: true }).fill(number);
    // Required fields are said, not silently refused: no player yet.
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(form.getByRole("alert")).toHaveText("Add the player.");
    await form.getByLabel("Player", { exact: true }).fill(player);
    await form.getByRole("button", { name: "Send request" }).click();
    const sent = form.getByRole("status").filter({ hasText: `Sent #${number} ${player}.` });
    await expect(sent).toBeVisible();
    await sent.getByRole("button", { name: "I have it" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`#${escapeRe(number)}.*to Main`) })).toBeVisible();

    // --- The admin declines it, with a note --------------------------------------
    await page.goto("/admin/card-requests");
    await expect(page.getByRole("heading", { level: 2, name: "Card Requests" })).toBeVisible();
    const label = `2024 ${setName} ${checklistName} #${number} ${player}`;
    await page
      .getByRole("region", { name: "Requests" })
      .getByRole("button", { name: new RegExp(`^Card: ${escapeRe(label)}`) })
      .click();
    const review = page.getByRole("region", { name: "Review" });
    await expect(review.getByRole("heading", { level: 3, name: `Card: ${label}` })).toBeFocused();
    // A typed checklist can't be added from here: the set builder comes first.
    await expect(review.getByRole("link", { name: "Open the set builder" })).toBeVisible();
    await expectAccessible(page, { label: "Card request review, typed checklist" });
    await review.getByLabel("Note to the collector (optional)").fill(crewNote);
    await review.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(review.getByRole("status").filter({ hasText: "Declined. It stays theirs, just for them." })).toBeVisible();

    // --- Still theirs: in My Cards, tagged unlisted -------------------------------
    await page.goto("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    const shelf = page.getByRole("region", { name: "Everything else I own" });
    // Narrowed to this card, so a long shelf can't page it out of sight. The
    // filter finds an unlisted card by its name (the catalog search can't).
    const filter = shelf.getByRole("textbox", { name: "Filter these cards" });
    await filter.fill(player);
    const tile = shelf.getByRole("button", {
      name: new RegExp(`#${escapeRe(number)} ${escapeRe(player)}, unlisted, have$`),
    });
    await expect(tile).toBeVisible();
    await tile.click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`#${escapeRe(number)}`) });
    await expect(drawer.getByText("Unlisted: not in the NeonBinder catalog")).toBeVisible();
    await expect(drawer.getByText("We didn't add it to the catalog. It stays yours, just for you.")).toBeVisible();
    // A card of their own can't go on the Want List: there's no catalog card to want.
    await expect(drawer.getByRole("button", { name: /^Want/ })).toHaveCount(0);
    await expectAccessible(page, { label: "Unlisted card drawer" });
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- My requests: not added, with the crew's note; remove it -----------------
    await page.goto("/collection?tab=checklists");
    await expect(page.getByRole("searchbox", { name: "Search every card" })).toBeVisible();
    await page.getByRole("button", { name: "My requests", exact: true }).click();
    await expect(dialog.getByRole("tab", { name: "My requests", selected: true })).toBeVisible();
    const mine = dialog.getByRole("list", { name: "My requests" }).getByRole("listitem").filter({ hasText: label });
    await expect(mine.getByText("Not added", { exact: true })).toBeVisible();
    await expect(mine.getByText(crewNote)).toBeVisible();
    await expectAccessible(page, { label: "My requests, declined" });
    await mine.getByRole("button", { name: `Remove ${label}` }).click();
    const confirm = mine.getByRole("group", { name: `Remove ${label}?` });
    await expect(confirm.getByText("Remove this request? Your copy of it goes too. This can't be undone.")).toBeVisible();
    // The keyboard starts on the safe answer: Enter never destroys by default.
    await expect(confirm.getByRole("button", { name: "Keep it" })).toBeFocused();
    await expectAccessible(page, { label: "Remove request, confirm" });
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(mine).toHaveCount(0);
    // The keyboard isn't dropped with the row: it lands on the list (or, when
    // this was the account's only request, on the line that says so).
    await expect(
      dialog
        .getByRole("list", { name: "My requests" })
        .or(dialog.getByText("Nothing asked for yet. Your requests show up here.")),
    ).toBeFocused();
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();

    // --- Gone from My Cards too ----------------------------------------------------
    await page.goto("/collection");
    await expect(shelf.getByRole("heading", { level: 2, name: "Everything else I own" })).toBeVisible();
    await filter.fill(player);
    await expect(filter).toHaveValue(player);
    await expect(tile).toHaveCount(0);
  },
);
