// NEO-446 (R1): Add cards takes photos up to 64 MP (the limit was 50 MP). One
// real card, front and back, upscaled to 6000x8400 = 50.4 MP and stamped 2400 dpi
// (so it measures 2.5 x 3.5 in), goes up as a zip, is unpacked, read and paired,
// and the pair reaches the lanes as the card it is, in a set that has that card.
// Before NEO-446 the same two photos were turned away as "too big".
//
// Fixture: `fixtures/intake/high-res/bowe-50mp.zip` (README beside it has the
// generation commands): the repo's 2014 Score Dwayne Bowe #315 scans
// (`fixtures/intake/03-bowe-front.jpg`, `04-bowe-back.jpg`), 2.4 MB and 1.9 MB,
// stored with `zip -0`. Each entry is far under the 32 MiB entry cap, and a
// stored entry has a 1:1 expansion, so the 100:1 guard never applies.
//
// Why this stays on the fast path (no heavy escalation, so the minutes-long cold
// start of the heavy model never applies): `scan_meta.is_card_sized_scan`
// (services/preprocess/app/cropper/scan_meta.py) reads the JFIF density, 2400 dpi
// is over its 200 dpi floor and square, and 6000 x 8400 px at 2400 dpi is 2.5 x 3.5 in,
// inside its 3% tolerance of a card. The frame IS the card, so the crop cascade
// returns it without a pixel pass or the heavy tier, the same route
// pipeline-pairs-uploaded-scans proves for scanner frames.
//
// This can only pass where the preprocess service's pixel limit is the new one
// (65 MP). A deployment still on the old 50 MP service turns both photos away.
//
// R7/R7a: writes only a hand-made, per-attempt set (`hres-<worker key>-<attempt>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace id
// beneath it: one hand-added card, with the real player's name on purpose (it is
// what the photo reads, like add-cards-from-photos-real-scans). The run and its
// pair are the account's own and nothing is saved; the set and its card stand.
//
// R3: the Set Builder through `support/set-builder.ts`; the collector's cascade
// through `support/collection.ts`. add-cards-from-photos-real-scans owns matching
// and the save; this spec owns "a photo over 50 MP is processed".
//
// R5: the one wait past 7 s is the pipeline's own exception, the ceiling
// pipeline-pairs-uploaded-scans uses for fast-path work (180 s: upload, extract of
// two 50 MP photos, two fast-path reads and the pairing run, cold fast instance
// included). Everything a collector does runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectorCascade } from "../../support/collection";
import { addCardViaForm } from "../../support/cards";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { VARIANT_TYPES_SYNC, columnHeading, drillToCustom, selectOrCreate, setBuilderReady } from "../../support/set-builder";

const ZIP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "intake",
  "high-res",
  "bowe-50mp.zip",
);
/** The preprocess pipeline's fast-path ceiling (see the header). */
const PIPELINE = 180_000;

/**
 * The measured length of a PIPELINE wait, kept as a report annotation (and in the
 * run's output) so the ceiling can be argued from real numbers, not guessed.
 */
function waitMeasured(wait: string, ms: number): void {
  test.info().annotations.push({ type: "pipeline wait", description: `${wait}: ${ms} ms` });
  console.log(`pipeline wait [${test.info().project.name}] ${wait}: ${ms} ms`);
}

test(
  "Add cards: a zip of 50 MP photos is unpacked, read and paired into the lanes",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const setName = `hres-${env.WORKER_KEY}-${env.ATTEMPT_ID}`;

    // --- A set of our own, holding the card the photos show ------------------------
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName });
    await selectOrCreate(page, "Variant Types", "Insert", { via: "list" });
    await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 15_000 });
    // A new type's column pays its first-visit sync before "+ Custom" shows.
    await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible({ timeout: VARIANT_TYPES_SYNC });
    await selectOrCreate(page, "Inserts", "Base", { via: "list" });
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
    await addCardViaForm(page, { cardNumber: "315", playerName: "Dwayne Bowe" });

    // --- Set up the run: Main, this set's Base ---------------------------------------
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
    await cascade
      .getByRole("listbox", { name: "Insert" })
      .getByRole("option")
      .filter({ has: page.getByText("Base", { exact: true }) })
      .click();
    await expect(page.getByRole("button", { name: `Set: 2024 ${setName} Base` })).toBeVisible();

    // --- Drop the zip: the run starts and lands on the URL -----------------------------
    const dropped = Date.now();
    await page.getByLabel("Drag your card photos here, or browse your files").setInputFiles(ZIP);
    // Sending the archive is the pipeline's upload leg: its exception.
    await expect(page).toHaveURL(/[?&]run=/, { timeout: PIPELINE });
    const uploaded = Date.now();
    waitMeasured("upload: zip dropped to ?run= in the URL", uploaded - dropped);

    // --- Unpacked, read, paired: the card is in the lanes ---------------------------------
    // "Unpacking your zip…" shows only while the service extracts, which a warm
    // service finishes in a moment, and the lanes are on screen (empty) from the
    // moment the run exists, so neither can synchronise with the pipeline. The
    // proof is the end state: the 50 MP pair READ and in the lanes.
    const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
    // The pair reaches Needs you as the card in the photos (pipeline exception: two
    // 50 MP reads, then pairing and matching).
    await expect(waiting).toHaveAccessibleName("Needs you, 1", { timeout: PIPELINE });
    waitMeasured("read: ?run= to the pair in Needs you (extract, 2 reads, pairing)", Date.now() - uploaded);
    const tile = waiting.getByRole("article", { name: "#315 Dwayne Bowe", exact: true });
    await expect(tile).toBeVisible();
    // What the 50 MP photo said, as read, so any case: its number and name.
    await expect(tile.getByText(/^Read: #315 · .*bowe/i)).toBeVisible();

    // The zip took no failure line and no reject copy: nothing was turned away.
    await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toHaveCount(0);
    // The positive proof that the photos got through is the tile above (read from
    // the photos, in the lanes); this only rules out the rejection copy beside it.
    await expect(page.getByText(/too big \(over 64 megapixels/)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Saved, 0" })).toBeVisible();
    // Settled (nothing arriving): the whole screen with a 50 MP pair waiting.
    await expectAccessible(page, { label: "Add cards, a zip of 50 MP photos read into the lanes" });
  },
);
