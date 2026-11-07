// NEO-441 (R1): Add cards from photos, signed in. The button at the foot of the
// Pairing column tells the collector what it still needs and is only pressable
// once it has it: nothing picked reads "Select 2 to Pair" (disabled), one photo
// picked reads "Select Partner" (disabled), two picked reads "Pair Images"
// (enabled), and the label follows the picks up AND back down. Pressing "Pair
// Images" pairs the two: they leave the Pairing column for Matching (or, once
// matched, Needs you), the picks clear, and the button goes with the last
// photos.
//
// The loose photos are seeded (/testing/seed-placeholder-run?loosePhotos=1,
// `seedMyTestLoosePhotosRun`): real photos pair themselves, so a spec cannot keep
// two of them loose, and making a read photo stay unpaired on cue would cost
// minutes of real model time. The seed is an open run holding four photos,
// loose-1.jpg to loose-4.jpg, all read (`done`) with nothing read off them and no
// pair; it schedules no pairing, so nothing pairs them before the collector.
// The run has no set picked, so a pair, once matched, lands in Needs you as "No
// match": this spec proves the button and the move, not the match. The seed
// uploads no scan, so each tile shows the image's fallback text ahead of the file
// name, which is why a tile's name match is not anchored to its start.
//
// What is not asserted: that the FIRST photo picked is the front. A pair's
// sides are only named while it sits in Matching (its front scan's alt text),
// which the sync leaves within moments, and no later column names the file.
// manuallyPairPlaceholderImages' unit tests own that order.
//
// R7: writes only the account's own seeded run (the seed cancels the account's
// open runs first, for the active-run cap). The run stands open until the idle
// sweep or the next seed; the pairs it makes are on that run only.
//
// R5: every wait is the standard 7 s; the first load goes through the sign-in
// hop and the seed, so its gate is LAUNCH_GATE.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Add cards from photos: the pair button follows the picks, and Pair Images moves the two photos on",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    const pairing = page.getByRole("region", { name: /^Pairing, \d+$/ });
    // The pile's button, whichever of its three labels it wears.
    const pairButton = pairing.getByRole("button", { name: /^(Select 2 to Pair|Select Partner|Pair Images)$/ });
    const photo = (n: number, pressed?: boolean) =>
      pairing.getByRole("button", { name: new RegExp(`loose-${n}\\.jpg`), pressed });
    const matching = (n: number) => page.getByRole("region", { name: `Matching, ${n}`, exact: true });
    const needsYou = (n: number) => page.getByRole("region", { name: `Needs you, ${n}`, exact: true });

    await signIn("/testing/seed-placeholder-run%3FloosePhotos%3D1");
    // The launch gate: sign-in, the seed hop and the run screen's first load.
    await expect(pairing).toHaveAccessibleName("Pairing, 4", { timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(/\/collection\?tab=add&run=/);

    // --- Nothing picked ----------------------------------------------------------
    for (const n of [1, 2, 3, 4]) await expect(photo(n, false)).toBeVisible();
    await expect(pairButton).toHaveAccessibleName("Select 2 to Pair");
    await expect(pairButton).toBeDisabled();
    await expectAccessible(page, { label: "Add cards, four loose photos, none picked" });

    // --- One picked: it still needs a partner ---------------------------------------
    await photo(2).click();
    await expect(photo(2, true)).toBeVisible();
    await expect(pairButton).toHaveAccessibleName("Select Partner");
    await expect(pairButton).toBeDisabled();
    await expectAccessible(page, { label: "Add cards, one loose photo picked" });

    // --- Two picked: ready ----------------------------------------------------------
    await photo(3).click();
    await expect(photo(3, true)).toBeVisible();
    await expect(photo(2, true)).toBeVisible();
    await expect(pairButton).toHaveAccessibleName("Pair Images");
    await expect(pairButton).toBeEnabled();
    await expectAccessible(page, { label: "Add cards, two loose photos picked" });

    // --- And back down: un-picking walks the label back -------------------------------
    await photo(3).click();
    await expect(photo(3, false)).toBeVisible();
    await expect(pairButton).toHaveAccessibleName("Select Partner");
    await expect(pairButton).toBeDisabled();
    await photo(2).click();
    await expect(photo(2, false)).toBeVisible();
    await expect(pairButton).toHaveAccessibleName("Select 2 to Pair");
    await expect(pairButton).toBeDisabled();

    // --- Pair two: they leave Pairing for Matching or Needs you ------------------------
    await photo(1).click();
    await photo(2).click();
    await expect(pairButton).toHaveAccessibleName("Pair Images");
    await expect(pairButton).toBeEnabled();
    await pairButton.click();
    await expect(pairing).toHaveAccessibleName("Pairing, 2");
    await expect(photo(1)).toHaveCount(0);
    await expect(photo(2)).toHaveCount(0);
    // They arrive further along, as one card: Matching while it is read, Needs you once matched.
    await expect(matching(1).or(needsYou(1))).toBeVisible();
    // The picks cleared with the press; the two left are untouched and need a pair.
    await expect(photo(3, false)).toBeVisible();
    await expect(photo(4, false)).toBeVisible();
    await expect(pairButton).toHaveAccessibleName("Select 2 to Pair");
    await expect(pairButton).toBeDisabled();

    // --- Pair the last two: the pile is empty and its button is gone ----------------------
    await photo(4).click();
    await photo(3).click();
    await expect(pairButton).toHaveAccessibleName("Pair Images");
    await expect(pairButton).toBeEnabled();
    await pairButton.click();
    await expect(pairing).toHaveAccessibleName("Pairing, 0");
    await expect(pairButton).toHaveCount(0);
    // Both cards have moved on: two in Matching while they are read, two in Needs you once matched.
    await expect(matching(2).or(needsYou(2))).toBeVisible();
    await expectAccessible(page, { label: "Add cards, every loose photo paired" });
  },
);
