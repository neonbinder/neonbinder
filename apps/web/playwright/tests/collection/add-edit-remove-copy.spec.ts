// NEO-358 (R1): a signed-in collector's real /collection: they find a card in
// the catalog (drill, search, a player suggestion), mark it Have, add a second
// copy in the drawer with a condition and notes, see identical copies fold into
// one line and different ones sit apart, edit and remove the copies, and the
// card reads "need" again. My Cards lists the card while it is owned. Along the
// way: the checklist's count line reads base cards first (the same total as
// "Have X of T"), then the rows with variations (the stored count is what the
// page reads), the card drawer rides on the URL (Back closes it), and the
// drawer fits the phone as a sheet and the desktop as a side panel.
//
// The signed-in page is the REAL collection (Convex, per user), not the demo:
// it shows "My Cards", "Checklists" and (NEO-359) "My Binders", no demo bar and
// no "Demo theme" switch. The public demo (/binder-tracking?demo=on) is proved by the
// home/binder-tracking-demo* specs; this spec replaces the retired
// home/collection-demo-signed-in and home/collection-demo-theme.
//
// R7/R7a: writes only `collectionCopies` (per user; the account's copies are
// cleared by the bootstrap reset) on ONE card of the seed's 2024 Topps Chrome
// Base, registered in SET-REGISTRY.md. It never writes the set, its cards,
// players or teams. Self-cleaning: every copy it adds is removed through the
// UI, and the closing My Cards check proves the account is empty again.
//
// R3: `drillToSet` drives the admin Set Builder; this is the collector's
// cascade (group "Sport, year, brand and set"), a different screen with its
// own listboxes, so it drills through `support/collection.ts`.
import { collectorCascade } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Collection: find a card, mark Have, add an identical and a different copy, edit and remove them",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, isMobile }) => {
    // --- Signed-in /collection is the real thing, not the demo --------------
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await expect(tabs.getByRole("link", { name: "My Cards", exact: true })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Checklists", exact: true })).toBeVisible();
    // My Binders is part of the real collection (NEO-359; binders-move-fold-trade-want
    // proves it), and the demo's own chrome is gone.
    await expect(tabs.getByRole("link", { name: "My Binders", exact: true })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Demo theme" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "About this demo" })).toHaveCount(0);

    // R2: the account starts with nothing, so every count below is this spec's.
    // With binders on (NEO-359) My Cards is "Everything else I own": the shelf
    // of cards that sit on no set build, counting from 0.
    const everythingElse = page.getByRole("region", { name: "Everything else I own" });
    await expect(everythingElse.getByRole("heading", { level: 2, name: "Everything else I own" })).toBeVisible();
    await expect(everythingElse.getByRole("status").filter({ hasText: /^0 cards$/ })).toBeVisible();
    await expect(everythingElse.getByRole("list", { name: /^Off the board, / })).toHaveCount(0);
    // The scoreboard has landed too ("0 on the board"), so axe reads the settled page.
    await expect(page.getByRole("heading", { level: 2, name: "Sets I'm building" })).toBeVisible();
    await expect(page.getByText(/^\d+ on the board$/)).toBeVisible();
    await expectAccessible(page, { label: "My Cards, empty" });

    // --- Drill to the seed's 2024 Topps Chrome Base --------------------------
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const searchBox = page.getByRole("searchbox", { name: "Search every card" });
    await expect(searchBox).toBeVisible();

    const { drill } = collectorCascade(page);
    await drill("Sports", "Baseball", "Years");
    await drill("Years", "2024", "Brands");
    await drill("Brands", "Topps", "Sets");
    await drill("Sets", "Topps Chrome", "Variant Types");

    // NEO-364: the drill's rows carry no counts (the count lives on the
    // checklist; checklists-drill-offers-only-levels-with-cards owns that
    // absence), so the drill goes straight to the Base row.
    await drill("Variant Types", "Base");

    const checklist = page.getByRole("region", { name: "2024 Topps Chrome Base" });
    await expect(checklist.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeVisible();
    const progress = checklist.getByText(/^Have \d+ of \d+/);
    await expect(progress).toBeVisible();
    const total = Number(/^Have 0 of (\d+)/.exec((await progress.textContent()) ?? "")?.[1]);
    expect(total, "the Base checklist starts at Have 0 of N").toBeGreaterThan(1);
    await expect(progress).toHaveText(`Have 0 of ${total} · Need ${total}`);

    // --- The total is the stored count, and it is the right one --------------
    // "Have 0 of T" reads the row's stored count of regular cards (the server
    // counts by hand only when the stored one is missing). The checklist's count
    // line reads base cards first, the same T ("300 cards"), and, when the
    // checklist also lists photo variations, a second figure ("335 with
    // variations") that is every row it lists. So T must equal the first
    // number, and the second must equal the rows on screen: a stale count, or
    // the count with photo variations swapped in, makes them differ. A missing
    // count that the server can still tally by hand reads the same number, so
    // the page shows the right total either way; one it cannot tally reads "N
    // owned", which fails the "Have 0 of" read above.
    const countLine = checklist
      .getByRole("status")
      .filter({ hasText: /^\d+ cards?(, \d+ with variations)?$/ });
    await expect(countLine).toBeVisible();
    const counts = /^(\d+) cards?(?:, (\d+) with variations)?$/.exec((await countLine.textContent()) ?? "");
    expect(counts, "the count line reads 'N cards' or 'N cards, M with variations'").not.toBeNull();
    const baseListed = Number(counts![1]);
    const withVariations = counts![2] === undefined ? null : Number(counts![2]);
    // The list is fully on screen: one Details button per listed card (nothing is owned yet).
    const listed = withVariations ?? baseListed;
    await expect(checklist.getByRole("button", { name: /^Details for / })).toHaveCount(listed);
    expect(baseListed, "the count line's first figure is T").toBe(total);
    if (withVariations !== null) {
      expect(withVariations, "'with variations' includes the base cards").toBeGreaterThan(baseListed);
    }

    // The card this spec uses: the first Base row that reads "#N First Last"
    // (two or more words, one player, no variation), never #300 (the
    // signed-by spec's card). It is read off the row's own accessible name,
    // so the choice follows the seed.
    const ordinaryRow = checklist
      .getByRole("button", { name: /^Details for #(?!300 )\S+ [^,/\s]+ [^,/]+$/ })
      // "Any one" ordinary row: the first is the one SET-REGISTRY.md names.
      .first();
    await expect(ordinaryRow).toBeVisible();
    const snapshot = await ordinaryRow.ariaSnapshot();
    const short = /button "Details for ([^"]+)"/.exec(snapshot)?.[1] ?? "";
    const parsed = /^#(\S+) (.+)$/.exec(short);
    expect(parsed, `a Base row named "#N First Last" (read: ${short})`).not.toBeNull();
    const number = parsed![1];
    const player = parsed![2];
    const words = player.split(" ");

    const detailsButton = checklist.getByRole("button", { name: `Details for ${short}`, exact: true });
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    const haveOn = checklist.getByRole("button", { name: `Have ${short}, Raw`, exact: true, pressed: true });
    await expect(haveOff).toBeVisible();
    await expectAccessible(page, { label: "Checklists, Base checklist loaded" });

    // --- Have, then Undo, then Have again ------------------------------------
    await haveOff.click();
    await expect(haveOn).toBeVisible();
    await expect(progress).toHaveText(`Have 1 of ${total} · Need ${total - 1}`);
    const notice = page.getByRole("status").filter({ hasText: `Added ${short} to Main` });
    await expect(notice).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(haveOff).toBeVisible();
    await expect(progress).toHaveText(`Have 0 of ${total} · Need ${total}`);
    await haveOff.click();
    await expect(haveOn).toBeVisible();
    await expect(progress).toHaveText(`Have 1 of ${total} · Need ${total - 1}`);

    // --- My Cards lists it while it is owned; Back returns to the checklist --
    await tabs.getByRole("link", { name: "My Cards", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=cards/);
    // Nothing is marked as a set build, so the card sits on the shelf "Off the board".
    await expect(everythingElse.getByRole("status").filter({ hasText: /^1 card$/ })).toBeVisible();
    const owned = everythingElse.getByRole("list", { name: "Off the board, 1 card", exact: true });
    await expect(owned).toBeVisible();
    await expect(
      owned.getByRole("button", { name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(number)} ${escapeRegExp(player)}.*, have$`) }),
    ).toBeVisible();
    await expectAccessible(page, { label: "My Cards, one card owned" });
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(haveOn).toBeVisible();
    await expect(progress).toHaveText(`Have 1 of ${total} · Need ${total - 1}`);

    // --- Search: terms, a quoted phrase, and a phrase that is not there ------
    const quick = page.getByRole("region", { name: "Quick search" });
    // The card's row among the hits: its number, its player and its checklist
    // ("2024 Topps Chrome", not one of its parallels). A parallel of the same
    // card reads the same number and player, so the sub-line tells them apart.
    const hitRow = (scope: typeof quick) =>
      scope
        .getByRole("listitem")
        .filter({ has: page.getByText(`#${number}`, { exact: true }) })
        .filter({ has: page.getByText(player, { exact: true }) })
        .filter({ has: page.getByText(/(^|· )2024 Topps Chrome$/) });
    /** Shows the card's row, opening "Show all" first when it sits past the first page. */
    const showCardRow = async (scope: typeof quick) => {
      const row = hitRow(scope);
      const more = scope.getByRole("button", { name: /^Show all \d+( matches)?$/ });
      await expect(row.or(more).first()).toBeVisible();
      if (!(await row.isVisible())) await more.click();
      await expect(row).toBeVisible();
      return row;
    };

    // Unquoted words are separate terms, in any order.
    await searchBox.fill([...words].reverse().join(" "));
    const termsRow = await showCardRow(quick);
    // The hit shows the copy the collector holds.
    await expect(termsRow.getByRole("button", { name: /^Have .*, Raw$/, pressed: true })).toBeVisible();

    // A quoted phrase is that exact string.
    await searchBox.fill(`"${player}"`);
    await showCardRow(quick);

    // A phrase whose words are all in the title but not side by side finds nothing
    // (a one-word name reads the same reversed, so the miss adds a word).
    await searchBox.fill(`"${words.length > 1 ? [...words].reverse().join(" ") : `${player} xylophone`}"`);
    await expect(quick.getByText("Not in the catalog yet.")).toBeVisible();
    await expect(hitRow(quick)).toHaveCount(0);
    await expectAccessible(page, { label: "Checklists, search finds nothing" });

    // --- A player suggestion lists every card of that player -----------------
    await searchBox.fill(player);
    const suggestions = quick.getByRole("region", { name: "Suggestions" });
    const everyButton = suggestions.getByRole("button", { name: `Every ${player} card`, exact: true });
    await expect(everyButton).toBeVisible();
    await showCardRow(quick);
    // The search has settled on its hits (not "Flipping through the catalog…").
    await expect(quick.getByRole("status").filter({ hasText: /\d+ cards? match|The first \d+ matches/ })).toBeVisible();
    await expectAccessible(page, { label: "Checklists, search hits with suggestions" });
    await everyButton.click();
    const every = page.getByRole("region", { name: `Every ${player} card` });
    await expect(every).toBeVisible();
    await showCardRow(every);
    await expect(every.getByRole("status").filter({ hasText: /\d+ cards?/ })).toBeVisible();
    await expectAccessible(page, { label: "Checklists, every card of one player" });
    // The step is a history entry: Back returns to the search and its suggestions.
    await page.goBack();
    await expect(every).toBeHidden();
    await expect(suggestions.getByRole("button", { name: `Every ${player} card`, exact: true })).toBeVisible();
    await expect(searchBox).toHaveValue(player);
    await expect(checklist.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeVisible();
    await searchBox.fill("");
    await expect(suggestions).toBeHidden();

    // --- The drawer rides on the URL: Back closes it --------------------------
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(number)} ${escapeRegExp(player)}`),
    });
    await detailsButton.click();
    await expect(drawer.getByText(/^1 in binders\.?$/)).toBeVisible();
    await expect(page).toHaveURL(/[?&]detail=[^&]+/);
    // Opened from the checklist's rows, it says where the card sits among them.
    await expect(drawer.getByRole("status").filter({ hasText: /^Card \d+ of \d+, / })).toHaveText(
      new RegExp(`^Card \\d+ of ${listed}, 2024 Topps Chrome #${escapeRegExp(number)} ${escapeRegExp(player)}`),
    );
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]detail=/);
    // The checklist is still there, on the same card, with its copy.
    await expect(checklist.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeVisible();
    await expect(haveOn).toBeVisible();
    await expect(progress).toHaveText(`Have 1 of ${total} · Need ${total - 1}`);

    // --- The drawer: add, fold, edit, remove ---------------------------------
    // "Add another" opens it on its Add a copy form, and the URL says so.
    await checklist.getByRole("button", { name: `Add another ${short}`, exact: true }).click();
    await expect(page).toHaveURL(/[?&]detail=[^&]+/);
    await expect(page).toHaveURL(/[?&]mode=add(&|$)/);
    await expect(drawer.getByText(/^1 in binders\.?$/)).toBeVisible();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    // Fully on screen before axe reads it (the drawer slides in).
    await expect(drawer).toBeInViewport({ ratio: 0.99 });
    // A phone gets a sheet nearly the width of the screen; a desktop a side
    // panel that leaves the page showing beside it (the drawer is `w-full`
    // capped at 95vw below the `sm` breakpoint and 40rem above it).
    const box = await drawer.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) throw new Error("the drawer or the viewport could not be measured");
    if (isMobile) expect(box.width, "the drawer fills the phone").toBeGreaterThanOrEqual(view.width * 0.9);
    else expect(box.width, "the drawer is a side panel").toBeLessThanOrEqual(view.width * 0.75);
    await expectAccessible(page, { within: drawer, label: "Card drawer, one copy" });

    const addForm = drawer.getByRole("form", { name: "Add another copy" });
    const addNearMint = async () => {
      await addForm.getByRole("combobox", { name: "Condition" }).selectOption("Near Mint");
      await addForm.getByRole("textbox", { name: "Notes" }).fill("Pulled at the show");
      await addForm.getByRole("button", { name: "Add to collection" }).click();
    };

    // A copy with different details is a second line.
    await addNearMint();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${short}, Raw, Near Mint` })).toBeVisible();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (2 lines)" })).toBeVisible();
    await expect(yourCopies.getByText("Raw, Near Mint")).toBeVisible();
    await expect(yourCopies.getByText(/Pulled at the show/)).toBeVisible();

    // The same details again fold into that line instead of making a third.
    await addNearMint();
    await expect(drawer.getByRole("status").filter({ hasText: `Stacked it: another ${short} on the pile` })).toBeVisible();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (2 lines)" })).toBeVisible();
    await expect(yourCopies.getByText("Raw, Near Mint ×2")).toBeVisible();

    // Edit the stacked line.
    await yourCopies.getByRole("button", { name: `Edit ${short}, Raw, Near Mint ×2`, exact: true }).click();
    const editForm = drawer.getByRole("form", { name: "Edit Raw, Near Mint ×2" });
    await expect(editForm).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card drawer, edit form open" });
    await editForm.getByRole("combobox", { name: "Condition" }).selectOption("Excellent");
    await editForm.getByRole("button", { name: "Save copy" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Saved ${short}, Raw, Excellent ×2` })).toBeVisible();
    await expect(editForm).toBeHidden();
    await expect(yourCopies.getByText("Raw, Excellent ×2")).toBeVisible();

    // Remove every copy: the card needs again.
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent ×2`, exact: true }).click();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await expect(drawer.getByText("Need it")).toBeVisible();

    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]detail=/);
    await expect(haveOff).toBeVisible();
    await expect(progress).toHaveText(`Have 0 of ${total} · Need ${total}`);

    // The account is empty again (self-cleaning, R7).
    await tabs.getByRole("link", { name: "My Cards", exact: true }).click();
    await expect(everythingElse.getByRole("status").filter({ hasText: /^0 cards$/ })).toBeVisible();
    await expect(everythingElse.getByRole("list", { name: /^Off the board, / })).toHaveCount(0);
  },
);
