// R1: the profile photo's file input is visually hidden but a real control:
// it carries the "Choose photo" label, keyboard Tab from the field before it
// lands on it, and choosing a file stages the photo (preview plus the "will
// upload on save" note). R7: choosing a file only stages it in the page; the
// upload happens on Save, which this spec never presses, so nothing is written.
// Same call on desktop and mobile; nothing differs by viewport.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

// A 1x1 PNG, inline: no fixture file to keep or to leak a path.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test(
  "Public profile: the photo file input is labelled, reachable by keyboard and stages a chosen photo",
  { tag: ["@profile"] },
  async ({ page, signIn }) => {
    await signIn("/profile/public");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });

    // Labelled: the input is found by its label, and the label is on screen.
    const photoInput = page.getByLabel("Choose photo");
    await expect(photoInput).toHaveCount(1);
    await expect(page.getByText("Choose photo", { exact: true })).toBeVisible();

    // Reachable: Tab from the Tagline field (the control before it) lands on it.
    await page.getByLabel("Tagline").focus();
    await page.keyboard.press("Tab");
    await expect(photoInput).toBeFocused();

    // Choosing a file stages it.
    await expect(page.getByText("Photo staged — will upload on save")).toBeHidden();
    await photoInput.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: TINY_PNG });
    await expect(page.getByText("Photo staged — will upload on save")).toBeVisible();
    await expect(page.getByRole("img", { name: "Profile preview" })).toHaveAttribute("src", /^data:image\/png/);
    await expectAccessible(page, { label: "Public profile, photo staged" });
  },
);
