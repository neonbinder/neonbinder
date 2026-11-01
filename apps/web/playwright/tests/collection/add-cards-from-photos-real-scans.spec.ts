// NEO-382 (R1): Add cards from photos, signed in. Real card scans go through
// the real pipeline (crop, read, pair), are matched in the set picked, and
// wait for the collector: a sure match says "Matched", a number that names
// one card while the name names another says "Check this" and is put right in
// the review drawer by searching the set, a card saved by keyboard (y on the
// focused card), and a card fed through twice asks whether it is a second copy
// (set aside, brought back, then counted). Nothing saves until the collector
// says yes; what they save lands in the binder, and the Inventory side offers
// its boxes.
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
// account's own. Self-cleaning: the saved copies are removed through the
// checklist at the end and the upload session is closed ("Done adding photos");
// the set, its cards and the closed run stand, per attempt.
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
import { VARIANT_TYPES_SYNC, columnHeading, drillToCustom, selectOrCreate, setBuilderReady } from "../../support/set-builder";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const scans = (...names: string[]) => names.map((n) => path.join(FIXTURES, n));
/**
 * The placeholder pipeline: real crops and reads. Usually about a minute, but
 * photos that escalate to the heavy model can meet a cold instance: a cold
 * load is ~200-300 s, a warm heavy photo ~40 s (CI run 41212224696, where 6
 * minutes ran out about a minute before the last heavy job finished, ~7.4 min
 * in). Eight minutes covers a cold load plus the queue (NEO-407, Jason
 * 2026-10-31); shard-plan.mjs runs this spec after
 * pipeline-escalation-cold-start on one shard so the two never compete for
 * the heavy instances. pipeline-escalation-cold-start allows ten for its
 * heavier load.
 */
const PIPELINE = 480_000;

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
    await drillToCustom(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName });
    await selectOrCreate(page, "Variant Types", "Insert", { via: "list" });
    await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 15_000 });
    // A new type's column pays its first-visit sync before "+ Custom" shows: on
    // a slow preview that ran past drillToCustom's 7 s (twice on desktop).
    await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible({ timeout: VARIANT_TYPES_SYNC });
    await selectOrCreate(page, "Inserts", "Base", { via: "list" });
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
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
    // Sending is the pipeline's upload leg (six real scans to storage): its exception.
    await expect(page.getByRole("status").filter({ hasText: "Sent 6 photos." })).toBeVisible({ timeout: PIPELINE });
    await expect(page).toHaveURL(/[?&]run=/);
    // The run's home stays a pick (the box or binder can change mid-run), and the
    // defaults name the seller's own condition, never a "your usual" stand-in.
    const home = page.getByRole("combobox", { name: "Put them in this binder" });
    await expect(home.getByRole("option", { name: "Main", selected: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Defaults: / })).toHaveAccessibleName(
      /^Defaults: (Mint|Near Mint|Excellent|Very Good|Good|Fair|Poor)/,
    );

    const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
    const saved = page.getByRole("region", { name: /^Saved, \d+$/ });
    const tile = (label: string) => waiting.getByRole("article", { name: label, exact: true });
    const mcfadden = tile("#160 Darren McFadden");
    const bowe = tile("#315 Dwayne Bowe");
    // Bell's photo reads #174, which is Antonio Brown in this set.
    const bell = tile("#174 Antonio Brown");

    // Every pair read, paired and matched (the pipeline's exception, above). The
    // run's status line comes first so a stall says where: still reading, a
    // photo left unpaired, or matched into the wrong lane.
    const runStatus = page.getByRole("status").filter({ hasText: /^(Working on your photos\.|Everything is read\..*|\d+ saved\.)$/ });
    await expect(runStatus).toHaveText("Everything is read. 3 waiting for you, 0 saved.", { timeout: PIPELINE });
    await expect(waiting).toHaveAccessibleName("Needs you, 3");

    // --- The bands ---------------------------------------------------------------
    await expect(mcfadden.getByText(/^Matched \d+%$/)).toBeVisible();
    await expect(bowe.getByText(/^Matched \d+%$/)).toBeVisible();
    await expect(bell.getByText(/^Check this \d+%$/)).toBeVisible();
    // What was read is shown (as read, so any case), and nothing saved itself.
    await expect(bell.getByText(/^Read: #174 · .*bell/i)).toBeVisible();
    await expect(page.getByRole("region", { name: "Saved, 0" })).toBeVisible();

    // --- Bell, in the drawer: the misread explained, the right card found -----------
    await bell.getByRole("button", { name: "Review #174 Antonio Brown" }).click();
    const reviewDrawer = page.getByRole("dialog", { name: "#174 Antonio Brown" });
    await expect(reviewDrawer.getByText(/One of them is misread/)).toBeVisible();
    await expectAccessible(page, { label: "Add cards, the review drawer", within: reviewDrawer });
    await reviewDrawer.getByRole("button", { name: "Wrong card? Find it" }).click();
    await reviewDrawer.getByRole("combobox", { name: /^Find the card in / }).fill("47");
    await reviewDrawer.getByRole("option", { name: "#47 Le'Veon Bell", exact: true }).click();
    const bellDrawer = page.getByRole("dialog", { name: "#47 Le'Veon Bell" });
    await expect(bellDrawer.getByText("You picked", { exact: true })).toBeVisible();
    await bellDrawer.getByRole("button", { name: "Save this card" }).click();
    await expect(bellDrawer).toBeHidden();
    await expect(saved).toHaveAccessibleName("Saved, 1");
    await expect(waiting).toHaveAccessibleName("Needs you, 2");

    // --- McFadden by keyboard: y on the focused card saves it ------------------------
    await mcfadden.getByRole("button", { name: "Yes, save #160 Darren McFadden" }).focus();
    await page.keyboard.press("y");
    await expect(saved).toHaveAccessibleName("Saved, 2");
    await expect(waiting).toHaveAccessibleName("Needs you, 1");

    // --- The same Bowe card fed through again, into the same run ------------------
    await dropzone.setInputFiles(scans("07-bowe-again-front.jpg", "08-bowe-again-back.jpg"));
    await expect(page.getByRole("status").filter({ hasText: "Sent 2 photos." })).toBeVisible({ timeout: PIPELINE });
    await expect(waiting).toHaveAccessibleName("Needs you, 2", { timeout: PIPELINE });
    const rescan = bowe.filter({ hasText: "This card is already in this run" });
    await expect(rescan).toHaveCount(1);
    // Until it is answered it cannot be saved.
    await expect(rescan.getByRole("button", { name: "Yes, save #315 Dwayne Bowe" })).toBeDisabled();
    await rescan.getByRole("button", { name: "Same card, set it aside" }).click();
    await expect(waiting).toHaveAccessibleName("Needs you, 1");
    await expect(saved.getByText("Set aside", { exact: true })).toBeVisible();
    // Settled (nothing arriving): the whole screen, with a card set aside.
    await expectAccessible(page, { label: "Add cards, a re-scan set aside" });

    // Brought back, it asks again; this time it is a second copy.
    await saved.getByRole("button", { name: "Bring back #315 Dwayne Bowe" }).click();
    await expect(waiting).toHaveAccessibleName("Needs you, 2");
    await rescan.getByRole("button", { name: "Second copy" }).click();
    const boweYes = waiting.getByRole("button", { name: "Yes, save #315 Dwayne Bowe" });
    await expect(boweYes).toHaveCount(2);
    for (const yes of await boweYes.all()) await expect(yes).toBeEnabled();
    // Either Bowe tile: they are the same card.
    await boweYes.first().click();
    await expect(waiting).toHaveAccessibleName("Needs you, 1");
    await boweYes.click();
    await expect(page.getByRole("region", { name: "Saved, 4" })).toBeVisible();
    await expect(waiting).toHaveAccessibleName("Needs you, 0");
    const savedTiles = saved.getByRole("listitem").filter({ hasText: /Saved \+1$/ });
    for (const [label, n] of [["#160 Darren McFadden", 1], ["#315 Dwayne Bowe", 2], ["#47 Le'Veon Bell", 1]] as const) {
      await expect(savedTiles.filter({ has: page.getByText(label, { exact: true }) })).toHaveCount(n);
    }

    // --- Done adding photos: the session closes ---------------------------------------
    await page.getByRole("button", { name: "Done adding photos" }).click();
    await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();

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
      const remove = yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRe(short)}, `) });
      // One line each: the second Bowe copy folded into the first, not a line of its own.
      await expect(remove).toHaveCount(1);
      await remove.click();
      await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
    }
    // Antonio Brown (#174) was never saved.
    await expect(checklist.getByRole("button", { name: /^Have #174, /, pressed: true })).toHaveCount(0);

    // --- The Inventory side files into boxes ---------------------------------------
    await page.goto("/inventory?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Put them in this box" })).toBeVisible();
    await expectAccessible(page, { label: "Add cards, inventory" });
  },
);
