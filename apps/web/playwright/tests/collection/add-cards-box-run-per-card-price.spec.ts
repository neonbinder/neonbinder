// NEO-481 (R1): on Add cards into a BOX, every waiting card has a price of its
// own. The field ("Price, <card>") starts at the run's Min price; `p` on the
// selected card jumps there, a typed price and Enter save THAT card at it (a
// text that isn't a price stays, with an alert under the field, and saves
// nothing), and
// a card saved with the field untouched goes in at the run's default. The card
// drawer then shows each line's own price. A binder never shows a price: that
// half is asserted on the binder run of add-cards-from-photos-real-scans (its
// tiles have a Count and no Price), so this spec pays for one pipeline run, not
// two.
//
// The pairs are real: two 2014 Score scans pairs (McFadden #160, Bowe #315,
// `playwright/fixtures/intake/`) go through the real pipeline and are matched
// in a set this spec builds. The plan offered a seeded `matchedPairs` run
// (the /testing/seed-placeholder-run precedent), but no such seed exists and
// the UI path needs no new testing surface, so the spec drives the UI.
//
// R7/R7a: writes only a hand-made, per-attempt set (`intkp-<ATTEMPT_TOKEN>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace
// id beneath it: two hand-added cards with the real players' names (what the
// scans read; scoped by the set). A minted box that lists nowhere (deleted at
// the end), one intake run (closed with "Done adding photos") and the two
// copies it saves (removed through the drawer). It never writes a common price:
// the per-card price is the card's own (`intakeMatches.minPriceCents`, then the
// copy's `minPriceCents`). Self-cleaning on any path (the finally).
//
// R3: the set builder through `support/set-builder.ts`, the run's set through
// `pickIntakeSet`, the box through `createBox` / `deleteOpenBox`.
//
// R5: the upload and the reads are the placeholder pipeline's exception (real
// crops and model reads, the ceiling add-cards-from-photos-real-scans uses);
// every collector action, the price included, runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addCardViaForm, escapeRe } from "../../support/cards";
import { collectorCascade, createBox, deleteOpenBox, intakeDropzone, inventoryTabs, pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { VARIANT_TYPES_SYNC, columnHeading, drillToCustom, selectOrCreate, setBuilderReady } from "../../support/set-builder";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const scans = (...names: string[]) => names.map((n) => path.join(FIXTURES, n));
/** The placeholder pipeline's exception: the same ceiling as add-cards-from-photos-real-scans (NEO-407). */
const PIPELINE = 480_000;

test(
  "Add cards into a box: each card has its own price, prefilled from the run's Min price; p, a price and Enter save that card at it",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const setName = `intkp-${env.ATTEMPT_TOKEN}`;
    const boxName = `Price${env.ATTEMPT_TOKEN}`;
    const mcfadden = { cardNumber: "160", playerName: "Darren McFadden" };
    const bowe = { cardNumber: "315", playerName: "Dwayne Bowe" };
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const doneButton = page.getByRole("button", { name: "Done adding photos" });
    const runClosedNote = page.getByText("This run's photos are all in. To add more, start a new run.");
    let tidyBox = false;
    let doneClicked = false;
    const copiesLeft = new Set<string>();
    let bodyPassed = false;

    // The set's checklist drawer for one card, from the collection's Checklists.
    const openDrawer = async (number: string) => {
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      const { drill } = collectorCascade(page);
      await drill("Sports", "Baseball", "Years");
      await drill("Years", "2024", "Brands");
      await drill("Brands", "Topps", "Sets");
      await drill("Sets", setName, "Variant Types");
      await drill("Variant Types", "Insert");
      await drill("Insert", "Base");
      const checklist = page.getByRole("region", { name: `2024 ${setName} Base`, exact: true });
      await checklist.getByRole("button", { name: `Details for #${number}`, exact: true }).click();
      const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 ${escapeRe(setName)}.*#${number}`) });
      await expect(drawer).toBeVisible();
      return { drawer, yourCopies: drawer.getByRole("region", { name: `Your copies of #${number}`, exact: false }) };
    };
    const removeCopy = async (number: string) => {
      const { drawer, yourCopies } = await openDrawer(number);
      await yourCopies.getByRole("button", { name: new RegExp(`^Remove #${number}\\b`) }).click();
      await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
      copiesLeft.delete(number);
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
    };

    try {
      // --- A set of our own, holding the two cards ------------------------------------------
      await signIn("/set-selector");
      await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
      await drillToCustom(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName });
      await selectOrCreate(page, "Variant Types", "Insert", { via: "list" });
      // 15 s is INHERITED, as is, from add-cards-from-photos-real-scans (NEO-382): the
      // Inserts column of a type this spec just made mounts behind the create. No
      // sign-off is recorded at either site (GUIDE hard rule 3); flagged in the
      // NEO-481 report for Jason to sign off or bring to 7 s, not granted here.
      await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 15_000 });
      // A new type's column pays its first-visit sync before "+ Custom" shows (as in add-cards-from-photos-real-scans).
      await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible({ timeout: VARIANT_TYPES_SYNC });
      await selectOrCreate(page, "Inserts", "Base", { via: "list" });
      await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
      for (const card of [mcfadden, bowe]) await addCardViaForm(page, card);

      // --- A box that lists nowhere (no listing gate), and a run into it at $1.25 -----------
      await page.goto("/inventory?tab=boxes");
      await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
      await createBox(page, boxName);
      tidyBox = true;
      const listed = page.getByRole("checkbox", { name: "Listed on marketplaces", exact: true });
      await listed.uncheck();
      await expect(said(`${boxName} is in-person only now.`)).toBeVisible();

      await inventoryTabs(page).getByRole("link", { name: "Add cards", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=add/);
      await page.getByRole("combobox", { name: "Put them in this box" }).selectOption({ label: boxName });
      await pickIntakeSet(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName }, { under: "Insert" });
      const defaults = page.getByRole("button", { name: /^Defaults: / });
      await defaults.click();
      const minPrice = page.getByRole("textbox", { name: "Min price", exact: true });
      await minPrice.fill("1.25");
      await minPrice.press("Enter");
      await expect(defaults).toHaveAccessibleName(/^Defaults: .*, \$1\.25$/);
      await defaults.click();
      await expect(defaults).toHaveAttribute("aria-expanded", "false");

      // --- Four photos: two cards, read, paired and matched -----------------------------------
      await intakeDropzone(page).setInputFiles(
        scans("01-mcfadden-front.jpg", "02-mcfadden-back.jpg", "03-bowe-front.jpg", "04-bowe-back.jpg"),
      );
      // Sending is the pipeline's upload leg: its exception.
      await expect(said("Sent 4 photos.")).toBeVisible({ timeout: PIPELINE });
      await expect(page).toHaveURL(/[?&]run=/);
      const runStatus = page.getByRole("status").filter({ hasText: /^(Working on your photos\.|Everything is read\..*|Done reading\..*|\d+ saved\..*)$/ });
      await expect(runStatus).toHaveText("Everything is read. 2 waiting for you, 0 saved.", { timeout: PIPELINE });

      const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
      const saved = page.getByRole("region", { name: /^Saved, \d+$/ });
      const tile = (label: string) => waiting.getByRole("article", { name: label, exact: true });
      const mcfaddenTile = tile("#160 Darren McFadden");
      const boweTile = tile("#315 Dwayne Bowe");
      await expect(mcfaddenTile.getByText(/^Matched \d+%$/)).toBeVisible();
      await expect(boweTile.getByText(/^Matched \d+%$/)).toBeVisible();

      // --- Each card's own price, starting at the run's Min price ------------------------------
      const mcfaddenPrice = mcfaddenTile.getByRole("textbox", { name: "Price, #160 Darren McFadden", exact: true });
      const bowePrice = boweTile.getByRole("textbox", { name: "Price, #315 Dwayne Bowe", exact: true });
      await expect(mcfaddenPrice).toHaveValue("1.25");
      await expect(bowePrice).toHaveValue("1.25");
      await expectAccessible(page, { label: "Add cards into a box, each card with its own price" });

      // --- p on the card, a price, Enter: that card saves at it --------------------------------
      // Keys act on the card that has focus (WCAG 2.1.4): focus McFadden's own Yes first.
      await mcfaddenTile.getByRole("button", { name: "Yes, save #160 Darren McFadden", exact: true }).focus();
      await page.keyboard.press("p");
      await expect(mcfaddenPrice).toBeFocused();
      // A price that isn't one stays in the field with why under it, and Enter saves nothing.
      // The field selects its number on focus, so typing replaces it.
      const priceProblem = mcfaddenTile.getByRole("alert").filter({ hasText: "That price doesn't look right. Try something like 1.50." });
      await page.keyboard.type("4.2.5");
      await page.keyboard.press("Enter");
      await expect(priceProblem).toBeVisible();
      await expect(mcfaddenPrice).toHaveAttribute("aria-invalid", "true");
      await expect(mcfaddenPrice).toHaveAccessibleDescription(/^That price doesn't look right\. Try something like 1\.50\. /);
      await expect(mcfaddenPrice).toHaveValue("4.2.5");
      await expect(waiting).toHaveAccessibleName("Needs you, 2");
      await expect(saved).toHaveAccessibleName("Saved, 0");
      await expectAccessible(page, { label: "Add cards into a box, a card price that doesn't look right" });
      // A real price clears it.
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("4.25");
      await expect(priceProblem).toBeHidden();
      await expect(mcfaddenPrice).not.toHaveAttribute("aria-invalid", "true");
      await expect(mcfaddenPrice).toHaveValue("4.25");
      await page.keyboard.press("Enter");
      copiesLeft.add("160");
      await expect(saved).toHaveAccessibleName("Saved, 1");
      await expect(waiting).toHaveAccessibleName("Needs you, 1");

      // --- The other card, untouched: Yes saves it at the run's default -------------------------
      await expect(bowePrice).toHaveValue("1.25");
      await boweTile.getByRole("button", { name: "Yes, save #315 Dwayne Bowe", exact: true }).click();
      copiesLeft.add("315");
      await expect(saved).toHaveAccessibleName("Saved, 2");
      await expect(waiting).toHaveAccessibleName("Needs you, 0");

      await doneButton.click();
      doneClicked = true;
      await expect(runClosedNote).toBeVisible();

      // --- The drawer shows each line's own price ----------------------------------------------
      {
        const { drawer, yourCopies } = await openDrawer("160");
        // One line, in the box: its words carry its own price.
        await expect(yourCopies.getByRole("button", { name: /^Remove #160\b/ })).toHaveCount(1);
        await expect(yourCopies.getByText(/(^|· )\$4\.25( ·|$)/)).toBeVisible();
        await expectAccessible(page, { within: drawer, label: "Card drawer, a box copy saved at its own price from Add cards" });
        await drawer.getByRole("button", { name: "Close card detail" }).click();
        await expect(drawer).toBeHidden();
      }
      {
        const { drawer, yourCopies } = await openDrawer("315");
        await expect(yourCopies.getByRole("button", { name: /^Remove #315\b/ })).toHaveCount(1);
        // The run's Min price, as this copy's floor (never a common price: none was set).
        await expect(yourCopies.getByText(/(^|· )\$1\.25( ·|$)/)).toBeVisible();
        await expect(yourCopies.getByText(/, common/)).toHaveCount(0);
        await drawer.getByRole("button", { name: "Close card detail" }).click();
        await expect(drawer).toBeHidden();
      }

      // --- Clean up the copies, then the box (R7) ----------------------------------------------
      await removeCopy("160");
      await removeCopy("315");
      await page.goto("/inventory?tab=boxes");
      await page
        .getByRole("list", { name: "Your boxes" })
        .getByRole("button", { name: new RegExp(`^${boxName}, box,`) })
        .click();
      await deleteOpenBox(page, boxName);
      tidyBox = false;
      bodyPassed = true;
    } finally {
      // Self-cleaning on any path (R7): close the run, remove the copies, delete the
      // box. One step failing never skips the rest; a failure is thrown only when the
      // body passed, else noted (the body's own failure is the one to read).
      const left: unknown[] = [];
      const tidy = async (step: () => Promise<void>) => {
        try {
          await step();
        } catch (e) {
          left.push(e);
        }
      };
      const openRun = /[?&]run=/.test(page.url()) ? page.url() : "";
      if (!doneClicked && openRun) {
        await tidy(async () => {
          // A fresh load: anything left open (a viewer, a focused price) stays out of the way.
          await page.goto(openRun);
          await doneButton.click();
          await expect(runClosedNote).toBeVisible();
        });
      }
      for (const number of [...copiesLeft]) await tidy(() => removeCopy(number));
      if (tidyBox) {
        await tidy(async () => {
          await page.goto("/inventory?tab=boxes");
          await page
            .getByRole("list", { name: "Your boxes" })
            .getByRole("button", { name: new RegExp(`^${boxName}, box,`) })
            .click();
          await deleteOpenBox(page, boxName);
        });
      }
      if (left.length > 0) {
        if (bodyPassed) throw left[0];
        test.info().annotations.push({ type: "cleanup-failed", description: String(left[0]) });
      }
    }
  },
);
