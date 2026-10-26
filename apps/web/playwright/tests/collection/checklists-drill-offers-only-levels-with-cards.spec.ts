// NEO-364 (R1): the collector's Checklists drill (/collection > Checklists)
// offers a sport only once a card exists somewhere beneath it, and its rows
// carry no counts and no has-cards marker (Jason, 2026-10-25: "Simply showing
// or not showing the record in the selector is enough"). The drill used to list
// a sport with nothing under it (Basketball, in the Sports column) and printed
// "N cards" under every checklist row.
//
// Proved live, in this order, on one hand-made subtree of our own:
//   1. A sport we just created in the Set Builder, with a year, brand, set and
//      an empty Base checklist beneath it and NOT ONE card, is absent from the
//      collector's Sports column, while the real Baseball is there (so the
//      column has answered and the absence is the filter, never a column that
//      has not loaded: R2).
//   2. The seed's 2024 Topps Chrome Base row, drilled to the Variant Types
//      column, reads as its name alone: no "N cards" anywhere in the drill.
//   3. We add one card through the Set Builder. The sport is now offered, and
//      the drill walks Sport > Year > Brand > Set > Insert > Base to a
//      checklist that holds the card. Back steps up one level at a time.
//   4. We delete the card again (self-cleaning). The sport stays offered: its
//      flag is set the first time a card lands and is never taken back.
//
// R7/R7a: writes only to a hand-made subtree under a sport of our own
// (`hcs<token>`, registered in SET-REGISTRY.md), no marketplace id anywhere
// beneath it. The seed's 2024 Topps Chrome is only READ (step 2). The sport and
// its year, brand, set and Base row stand: nothing deletes a minted row
// mid-run, and a sport that has held a card cannot be deleted.
//
// R3: card-collectors-own-cannot-be-deleted proves a SET is hidden while empty
// (and its Baseball > 2024 > Topps ancestors are bundle rows); this spec owns
// the SPORT level and the count-free rows. `drillToCustom` is the Set Builder
// drill (R9); the collector's cascade is `collectorCascade`.
//
// Minted names are single tokens built from `env.ATTEMPT_TOKEN`: the sport
// `hcs<token>`, the set `hcset<token>`, the card number `372<token>` and the
// card name `Hc<token>`. Per-attempt, so the "no card yet" precondition always
// holds on a fresh sport.
import { collectorCascade } from "../../support/collection";
import { deleteCardButton, confirmDeleteCardButton, editCardButton, addCardViaForm } from "../../support/cards";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";

test(
  "Checklists: a sport with no card beneath it is not offered until one exists, and drill rows carry no counts",
  { tag: ["@smoke", "@collection"] },
  async ({ page, signIn, env }) => {
    const sport = `hcs${env.ATTEMPT_TOKEN}`;
    const setName = `hcset${env.ATTEMPT_TOKEN}`;
    const number = `372${env.ATTEMPT_TOKEN}`;
    const cardName = `Hc${env.ATTEMPT_TOKEN}`;

    // --- A sport of our own, with a Base checklist and no card ----------------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    const build = {
      sport,
      year: "2026",
      manufacturer: "Topps",
      set: setName,
      variantType: "Insert",
      variant: "Base",
    };
    // Ends on the Base checklist's "Open add card form": every row exists, no card does.
    await drillToCustom(page, build);

    // --- The collector's cascade -----------------------------------------------
    const { cascade, drill } = collectorCascade(page);
    const sportsList = cascade.getByRole("listbox", { name: "Sports" });
    const sportOption = sportsList
      .getByRole("option")
      .filter({ has: page.getByText(sport, { exact: true }) });
    const baseball = sportsList.getByRole("option").filter({ has: page.getByText("Baseball", { exact: true }) });
    const openSports = async () => {
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      await expect(baseball).toBeVisible();
    };

    // --- 1. No card beneath: the sport is not offered ---------------------------
    await openSports();
    await expect(sportOption).toHaveCount(0);
    await expectAccessible(page, { label: "Checklists, Sports without the empty sport" });

    // --- 2. The seed's Base row reads as its name alone -------------------------
    await drill("Sports", "Baseball", "Years");
    await drill("Years", "2024", "Brands");
    await drill("Brands", "Topps", "Sets");
    await drill("Sets", "Topps Chrome", "Variant Types");
    const baseOption = cascade
      .getByRole("listbox", { name: "Variant Types" })
      .getByRole("option")
      .filter({ has: page.getByText("Base", { exact: true }) });
    await expect(baseOption).toBeVisible();
    // The row is its name: no "N cards" (no "1 card" either) in any column of the drill.
    await expect(baseOption.getByText(/\d+ cards?/)).toHaveCount(0);
    await expect(cascade.getByText(/\b\d[\d,]* cards?\b/)).toHaveCount(0);

    // --- 3. One card beneath: the sport is offered and leads to it --------------
    await drillToCustom(page, build);
    await addCardViaForm(page, { cardNumber: number, playerName: cardName });

    await openSports();
    await expect(sportOption).toBeVisible();
    await drill("Sports", sport, "Years");
    await drill("Years", "2026", "Brands");
    await drill("Brands", "Topps", "Sets");
    await drill("Sets", setName, "Variant Types");
    await drill("Variant Types", "Insert");
    await drill("Insert", "Base");
    const checklist = page.getByRole("region", { name: `2026 ${setName} Base`, exact: true });
    // A hand-made card has no linked player, so the collector sees only its number.
    await expect(checklist.getByRole("button", { name: `Details for #${number}`, exact: true })).toBeVisible();

    // The last pick is one history step: Back reopens the Insert column, checklist gone.
    await page.goBack();
    await expect(checklist).toBeHidden();
    await expect(
      cascade
        .getByRole("listbox", { name: "Insert" })
        .getByRole("option")
        .filter({ has: page.getByText("Base", { exact: true }) }),
    ).toBeVisible();

    // --- 4. Clean up: delete the card; the sport stays offered ------------------
    await drillToCustom(page, build);
    await deleteCardButton(page, number).click();
    await confirmDeleteCardButton(page, number).click();
    await expect(editCardButton(page, number)).toBeHidden();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();

    await openSports();
    await expect(sportOption).toBeVisible();
  },
);
