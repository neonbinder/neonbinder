// NEO-427 (R1): a saved card whose scans could not be put on its copy says so on
// its Saved tile and offers the way on, and the save above it stands. Three ends:
//   - "The scans aged out." (the scans were cleared before the attach): no retry
//     can help, so the tile offers "Add a photo to <card>", which opens the card's
//     own form (its Photos box) on the copy the save made;
//   - "These scans won't cut it." (the pair cannot be turned into listing
//     photos): the same way on, "Add a photo to <card>";
//   - "Photos didn't stick." (a failed attempt that may still work): "Try again:
//     photos for <card>", pressed once.
//
// The failures are seeded rather than produced (/testing/seed-placeholder-run
// with `savedPhotoFailure=scanGone|unusable|error`): making a scan age out takes
// two days, and an unusable or failing attach cannot be made certain with real
// photos. Each seed is an intake run holding one SAVED pair, "#1 Testcard", with
// a real quantity-1 copy behind it in a fresh box that does not list anywhere,
// in a per-seed set under the real Baseball > 2024 > Topps. Nothing was uploaded
// under the seeded pair, so Try again runs the real retry path against scans that
// do not exist: it ends on "The scans aged out." rather than landing photos, and
// the spec asserts that readable end, never that a retry succeeds. The attach finds
// neither stored sizes nor an output in the bucket, so it never calls preprocess.
//
// R7/R7a: writes only the account's own seeded runs, sets and boxes (SET-REGISTRY.md,
// `PhotoFixture-`); each seed cancels the account's open runs first, for the
// active-run cap, and they stand until the global reset.
//
// R5: every wait is the standard 7 s; the first seed is a full page load, so its
// gate is LAUNCH_GATE.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const CARD = "#1 Testcard";

test(
  "Add cards from photos: a saved card whose scans failed says why on its tile and offers the way on",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    const saved = page.getByRole("region", { name: "Saved, 1" });
    const tile = saved.getByRole("listitem");
    const addPhoto = tile.getByRole("button", { name: `Add a photo to ${CARD}`, exact: true });
    const tryAgain = tile.getByRole("button", { name: `Try again: photos for ${CARD}`, exact: true });

    // --- Scans aged out: add a photo from the card ---------------------------------
    // The first seed goes through the sign-in hop: the launch gate.
    await signIn("/testing/seed-placeholder-run%3FsavedPhotoFailure%3DscanGone");
    await expect(page).toHaveURL(/\/collection\?tab=add&run=/, { timeout: LAUNCH_GATE });
    await expect(saved).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(tile.getByText(CARD, { exact: true })).toBeVisible();
    await expect(tile.getByText("Saved +1", { exact: true })).toBeVisible();
    await expect(tile.getByText("The scans aged out.", { exact: true })).toBeVisible();
    // No retry on offer: nothing could be retried.
    await expect(addPhoto).toBeVisible();
    await expect(tryAgain).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, a saved card whose scans aged out" });
    await addPhoto.click();
    // The card's own form, on the copy the save made, with its Photos box.
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("form", { name: /^Edit / }).getByRole("region", { name: /^Photos of / })).toBeVisible();
    // Back closes the card and returns to the run, tile and all.
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/[?&]run=/);
    await expect(tile.getByText("The scans aged out.", { exact: true })).toBeVisible();

    // --- Scans that won't cut it: the same way on ------------------------------------
    await page.goto("/testing/seed-placeholder-run?savedPhotoFailure=unusable");
    await expect(page).toHaveURL(/\/collection\?tab=add&run=/, { timeout: LAUNCH_GATE });
    await expect(tile.getByText("These scans won't cut it.", { exact: true })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(addPhoto).toBeVisible();
    await expect(tryAgain).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, a saved card whose scans won't cut it" });
    await addPhoto.click();
    await expect(drawer.getByRole("form", { name: /^Edit / }).getByRole("region", { name: /^Photos of / })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- Photos that didn't stick: Try again --------------------------------------------
    await page.goto("/testing/seed-placeholder-run?savedPhotoFailure=error");
    await expect(page).toHaveURL(/\/collection\?tab=add&run=/, { timeout: LAUNCH_GATE });
    await expect(tile.getByText("Photos didn't stick.", { exact: true })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(tryAgain).toBeVisible();
    await expect(addPhoto).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, a saved card whose photos didn't stick" });
    await tryAgain.click();
    // No scans stand behind the seeded pair, so the retry cannot land photos: it
    // ends on the aged-out line, which offers the card's form instead of another try.
    // The press answers within the standard budget: the spinner, or on a warm
    // service the result itself (the spinner can come and go between looks).
    const agedOut = tile.getByText("The scans aged out.", { exact: true });
    const slipping = tile.getByText("Slipping in the photos…", { exact: true });
    await expect(slipping.or(agedOut).first()).toBeVisible();
    await expect(agedOut).toBeVisible();
    await expect(slipping).toHaveCount(0);
    await expect(addPhoto).toBeVisible();
    await expect(tryAgain).toHaveCount(0);
    await expect(saved).toHaveAccessibleName("Saved, 1");
  },
);
