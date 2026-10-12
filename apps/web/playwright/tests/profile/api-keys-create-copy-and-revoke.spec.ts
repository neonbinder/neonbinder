// Origin: .maestro/flows/profile/api-keys-create-copy-and-revoke.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

// The one-time secret is on screen between "Create key" and "Copy & Close".
// Failure screenshots and error-context ARIA snapshots are published, so they
// are off and the page is blanked on any failure in that window (GUIDE hard rule 7).
test.use({ screenshot: "off" });

test(
  "API Keys — create a key, copy the secret once, then revoke it",
  { tag: ["@smoke", "@api-keys"] },
  async ({ page, signIn, env }) => {
    const keyName = `e2e-${env.ATTEMPT_ID}`;
    await signIn("/profile/shipping");
    await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });

    await page.getByRole("link", { name: "API Keys" }).click();
    await expect(
      page.getByText(/An API key lets a script, spreadsheet or tool talk to Neon Binder as you/),
    ).toBeVisible();
    await expect(page.getByText(/The secret is shown once, when you create the key/)).toBeVisible();

    // Create: name it, pick an expiry.
    await page.getByRole("button", { name: "Add new key" }).click();
    await expect(page.getByRole("heading", { name: "Add new API key" })).toBeVisible();
    await expectAccessible(page, { label: "Add new API key form" });
    const create = page.getByRole("form", { name: "API key form" });
    const name = create.getByPlaceholder("Enter your secret key name");
    await name.fill(keyName);
    await expect(name).toHaveValue(keyName);
    await create.getByRole("button", { name: "Select date" }).click();
    // Clerk's select: its option label is not itself the hit target (the
    // wrapping row is), so a coordinate click is refused; the click event is
    // what the row handles.
    await page.getByText("1 Day", { exact: true }).dispatchEvent("click");
    await expect(create.getByText(/Expiring/)).toBeVisible();
    try {
      await create.getByRole("button", { name: "Create key" }).click();

      // The secret is shown once, with a warning that it cannot be viewed again.
      const secret = page.getByRole("dialog").filter({ hasText: keyName });
      await expect(secret.getByText(/Copy your.*API Key now/)).toBeVisible();
      await expect(secret.getByText(/allow you to view it again later/)).toBeVisible();
      // axe output keeps only selectors and rule ids (support/a11y.ts), never node text.
      await expectAccessible(page, { within: secret, label: "API key created dialog" });
      await secret.getByRole("button", { name: "Copy & Close" }).click();
    } catch (e) {
      await page.goto("about:blank").catch(() => {});
      throw e;
    }

    // Find it in the list.
    await page.getByPlaceholder("Search keys").fill(keyName);
    const row = page.getByRole("row").filter({ has: page.getByText(keyName, { exact: true }) });
    await expect(row).toBeVisible();
    await expect(row.getByText(/Created.*Expires/)).toBeVisible();

    // Revoke: the dialog asks you to type "Revoke".
    await row.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("menuitem", { name: "Revoke key" }).click();
    const revoke = page.getByRole("dialog").filter({ hasText: /Revoke.*secret key/ });
    await expect(revoke.getByText(new RegExp(`Revoke.*${keyName}.*secret key`))).toBeVisible();
    await expectAccessible(page, { within: revoke, label: "Revoke API key dialog" });
    await revoke.getByRole("textbox").fill("Revoke");
    await revoke.getByRole("button", { name: "Revoke key" }).click();

    await expect(page.getByText("No API keys found")).toBeVisible();
  },
);
