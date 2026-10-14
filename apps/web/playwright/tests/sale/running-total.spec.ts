// Origin: .maestro/flows/sale/running-total.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { fillPublicProfile } from "../../support/profile";

test("Sale page — running total accumulates", { tag: ["@smoke", "@sale"] }, async ({ page, browser, baseURL, signIn, env }) => {
  await signIn("/testing/reset?redirect=/profile/public", { account: "new-profile" });
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: LAUNCH_GATE,
  });
  await fillPublicProfile(page, env.TEST_USERNAME);

  // The buyer's view: signed out, a fresh context on the same device as this
  // project (a phone project's buyer is on a phone).
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const buyer = await browser.newContext({
    baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
  });
  const sale = await buyer.newPage();

  await sale.goto(`/u/${env.TEST_USERNAME}/sale?amt=5`);
  await expect(sale.getByText("Total Sale Amount")).toBeVisible();
  await expect(sale.getByText("$5.00", { exact: true })).toBeVisible();

  // A second scan adds to the running total.
  await sale.goto(`/u/${env.TEST_USERNAME}/sale?amt=3`);
  await expect(sale.getByText("$8.00", { exact: true })).toBeVisible();

  // Every payment method is offered.
  await expect(sale.getByText("PayPal (F&F)")).toBeVisible();
  await expect(sale.getByText("PayPal (G&S)")).toBeVisible();
  await expect(sale.getByText("Venmo")).toBeVisible();
  await expect(sale.getByText("Cash App")).toBeVisible();
  await expectAccessible(sale, { label: "Sale page, running total" });

  await buyer.close();
});
