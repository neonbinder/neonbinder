// Port of .maestro/flows/home/easypost-setup.yaml
import { test } from "../../support/fixtures";

test("EasyPost Setup Guide Page", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  // R5 exceptions signed off by Jason 2026-09-09 (NEO-260): 16000 and 27000 are page-length travel.
  await m.scrollUntilVisible(".*Shipping Labels.*", { centerElement: true, timeout: 16_000 });
  await m.tapOn(".*Shipping Labels.*");
  await m.assertVisible("Print the Label, Ship the Card");

  await m.scrollUntilVisible(".*Follow the EasyPost setup guide.*", { centerElement: true, timeout: 27_000 });
  await m.tapOn(".*Follow the EasyPost setup guide.*");

  await m.assertVisible("Get Your EasyPost Key");
  await m.scrollUntilVisible("Four Steps, One Time", { timeout: 7_000 });
  await m.scrollUntilVisible("Create a free EasyPost account", { timeout: 7_000 });
  await m.scrollUntilVisible("Add a payment method", { timeout: 7_000 });
  await m.scrollUntilVisible("Copy your Production API key", { timeout: 7_000 });
  await m.scrollUntilVisible("Paste it into Neon Binder", { timeout: 7_000 });
  await m.scrollUntilVisible("Good To Know", { timeout: 7_000 });

  await m.scrollUntilVisible("Get Started", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Get Started");
  await m.assertVisible("Create your account");
  await m.tapPoint("5%, 50%");
  await m.assertNotVisible("Create your account");
});
