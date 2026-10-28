// NEO-382 (R1): Add cards from photos, signed in. Real card scans go through
// the real pipeline (crop, read, pair), are matched in the set picked, and
// wait for the collector: a sure match says "Matched", a number that names
// one card while the name names another says "Check this" and offers both,
// and a card fed through twice asks whether it is a second copy. Nothing
// saves until the collector says yes; what they save lands in the binder.
//
// The scans are six real 2014 Score football photos (McFadden #160, Bowe
// #315, Bell #174, front then back) plus a re-scan of the Bowe card dropped
// later into the same run (`playwright/fixtures/intake/`). The misread case is
// made certain rather than left to the reader (Jason, 2026-10-28): the set we
// build gives #174 to another player and Bell his own #47, so Bell's photo
// reads a number that names one card and a name that names another. That is
// the path the Rookies & Stars "Bell #47 read as 17" scan took.
//
// R7/R7a: writes only a hand-made, per-attempt set (`intk-<worker>-<attempt>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace
// id beneath it: four hand-added cards. The card names are the real players'
// names on purpose (they are what the photos read; not minted, like vtk's
// kind words), scoped by the per-attempt set. The run and its photos are the
// account's own. Self-cleaning: the three saved copies are removed through the
// checklist at the end; the set and its cards stand, per attempt.
//
// R3: the Set Builder through `support/set-builder.ts`; both collector
// cascades through `support/collection.ts`. pipeline-pairs-uploaded-scans
// proves pairing on synthetic scans; this spec owns matching and the save.
//
// R5: the reading waits are the placeholder pipeline's own exception (real
// crops and model reads on the preprocess service), the ceiling
// pipeline-pairs-uploaded-scans uses for six photos; every collector action
// runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectorCascade } from "../../support/collection";
import { addCardViaForm, escapeRe } from "../../support/cards";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const scans = (...names: string[]) => names.map((n) => path.join(FIXTURES, n));
/** The placeholder pipeline: real crops and reads (pipeline-pairs-uploaded-scans' ceiling). */
const PIPELINE = 180_000;

test(
  "Add cards from photos: real scans are matched in the set, a misread asks, a double scan asks, and only a yes saves",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const setName = `intk-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const cards = [
      { cardNumber: "160", playerName: "Darren McFadden" },
      { cardNumber: "315", playerName: "Dwayne Bowe" },
      { cardNumber: "47", playerName: "Le'Veon Bell" },
      { cardNumber: "174", playerName: "Antonio Brown" },
    ];

    // --- A set of our own, holding the four cards -------------------------------
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
    for (const card of cards) await addCardViaForm(page, card);

    // --- Set up the run: Main, this set's Base ------------------------------------
    await page.goto("/collection?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
    await page.getByRole("button", { name: "Set: pick one" }).click();
    const { cascade, drill } = collectorCascade(page, "Sport, year, brand, set and variant");
    await drill("Sports", "Baseball", "Years");
    await drill("Years", "2024", "Brands");
    await drill("Brands", "Topps", "Sets");
    await drill("Sets", setName, "Variant Types");
    await drill("Variant Types", "Insert");
    // The variant picked, the panel folds back into its button.
    await cascade
      .getByRole("listbox", { name: "Insert" })
      .getByRole("option")
      .filter({ has: page.getByText("Base", { exact: true }) })
      .click();
    await expect(page.getByRole("button", { name: `Set: 2024 ${setName} Base` })).toBeVisible();
    await expectAccessible(page, { label: "Add cards, set up" });

    // --- Drop six photos: the run starts and lands on the URL ----------------------
    const dropzone = page.getByLabel("Drag your card photos here, or browse your files");
    await dropzone.setInputFiles(
      scans("01-mcfadden-front.jpg", "02-mcfadden-back.jpg", "03-bowe-front.jpg", "04-bowe-back.jpg", "05-bell-front.jpg", "06-bell-back.jpg"),
    );
    await expect(page.getByRole("status").filter({ hasText: "Sent 6 photos." })).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/[?&]run=/);
    await expect(page.getByText("Going into", { exact: true })).toBeVisible();

    const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
    const tile = (label: string) => waiting.getByRole("article", { name: label, exact: true });
    const mcfadden = tile("#160 Darren McFadden");
    const bowe = tile("#315 Dwayne Bowe");
    // Bell's photo reads #174, which is Antonio Brown in this set.
    const bell = tile("#174 Antonio Brown");

    // Every pair read, paired and matched (the pipeline's exception, above).
    await expect(waiting).toHaveAccessibleName("Needs you, 3", { timeout: PIPELINE });

    // --- The bands ---------------------------------------------------------------
    await expect(mcfadden.getByText(/^Matched \d+%$/)).toBeVisible();
    await expect(bowe.getByText(/^Matched \d+%$/)).toBeVisible();
    await expect(bell.getByText(/^Check this \d+%$/)).toBeVisible();
    // What was read is shown, and the other card is offered: never settled silently.
    await expect(bell.getByText(/^Read: #174 · .*Bell/)).toBeVisible();
    await expect(bell.getByText(/One of them is misread/)).toBeVisible();
    await expectAccessible(page, { label: "Add cards, three waiting" });
    // Nothing saved itself.
    await expect(page.getByRole("region", { name: "Saved, 0" })).toBeVisible();

    // --- The same Bowe card fed through again, into the same run ------------------
    await dropzone.setInputFiles(scans("07-bowe-again-front.jpg", "08-bowe-again-back.jpg"));
    await expect(page.getByRole("status").filter({ hasText: "Sent 2 photos." })).toBeVisible({ timeout: 60_000 });
    await expect(waiting).toHaveAccessibleName("Needs you, 4", { timeout: PIPELINE });
    const rescan = bowe.filter({ hasText: "This card is already in this run" });
    await expect(rescan).toHaveCount(1);
    // Until it is answered it cannot be saved.
    await expect(rescan.getByRole("button", { name: "Yes, save #315 Dwayne Bowe" })).toBeDisabled();
    await rescan.getByRole("button", { name: "Same card, set it aside" }).click();
    await expect(waiting).toHaveAccessibleName("Needs you, 3");
    const saved = page.getByRole("region", { name: /^Saved, \d+$/ });
    await expect(saved.getByText("Set aside", { exact: true })).toBeVisible();
    await expect(saved.getByRole("button", { name: "Bring back #315 Dwayne Bowe" })).toBeVisible();

    // --- Fix Bell, then yes to all three -------------------------------------------
    await bell.getByRole("button", { name: "#47 Le'Veon Bell", exact: true }).click();
    const bellFixed = tile("#47 Le'Veon Bell");
    await expect(bellFixed.getByText("You picked", { exact: true })).toBeVisible();

    await mcfadden.getByRole("button", { name: "Yes, save #160 Darren McFadden" }).click();
    await bowe.getByRole("button", { name: "Yes, save #315 Dwayne Bowe" }).click();
    await bellFixed.getByRole("button", { name: "Yes, save #47 Le'Veon Bell" }).click();
    await expect(page.getByRole("region", { name: "Saved, 3" })).toBeVisible();
    await expect(waiting).toHaveAccessibleName("Needs you, 0");
    for (const label of ["#160 Darren McFadden", "#315 Dwayne Bowe", "#47 Le'Veon Bell"]) {
      await expect(saved.getByText(label, { exact: true })).toBeVisible();
    }
    // The re-scan was not counted: one Bowe saved.
    await expect(saved.getByText("Saved +1")).toHaveCount(3);

    // --- In the binder, then clean up ----------------------------------------------
    await page.goto("/collection?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    const checklists = collectorCascade(page);
    await checklists.drill("Sports", "Baseball", "Years");
    await checklists.drill("Years", "2024", "Brands");
    await checklists.drill("Brands", "Topps", "Sets");
    await checklists.drill("Sets", setName, "Variant Types");
    await checklists.drill("Variant Types", "Insert");
    await checklists.drill("Insert", "Base");
    const checklist = page.getByRole("region", { name: `2024 ${setName} Base`, exact: true });
    for (const number of ["160", "315", "47"]) {
      const short = `#${number}`;
      await expect(
        checklist.getByRole("button", { name: new RegExp(`^Have ${escapeRe(short)}, `), pressed: true }),
      ).toBeVisible();
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 ${escapeRe(setName)}.*${escapeRe(short)}`) });
      const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
      await yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRe(short)}, `) }).click();
      await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
      await drawer.press("Escape");
      await expect(drawer).toBeHidden();
    }
    // Antonio Brown (#174) was never saved.
    await expect(checklist.getByRole("button", { name: /^Have #174, /, pressed: true })).toHaveCount(0);
  },
);
