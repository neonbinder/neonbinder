// Port of .maestro/flows/labels/scan-visibility.yaml
import { test } from "../../support/fixtures";

test("Label History — see what USPS has scanned", { tag: ["@labels"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/testing/seed-credentials?sites=label-scans%26redirect=/print/labels"));
  await m.waitVisible(".*newest first. Reprint one without paying for it twice.*", 45_000);

  await m.assertVisible(".*Nothing scans it when you drop it off.*");

  await m.scrollUntilVisible(".*Out for delivery.*last USPS scan.*", { centerElement: true, timeout: 7_000 });
  await m.assertVisible("Scan Fixture Buyer");
  await m.assertVisible(".*Delivery.*OLYMPIA, WA.*");
  await m.assertVisible("0004012345678901234567890123456");
  await m.assertVisible(m.id("Copy the tracking number for Scan Fixture Buyer.*"));
  await m.assertVisible(".*Public scan page.*");

  await m.assertNotVisible(".*Cancellation of Postage.*postmarked.*");

  await m.scrollUntilVisible(".*Show all scans \\(4\\).*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Show all scans \\(4\\).*");

  await m.assertVisible(".*Cancellation of Postage.*postmarked.*");

  await m.tapOn(".*Hide all scans \\(4\\).*");
  await m.assertNotVisible(".*Cancellation of Postage.*postmarked.*");

  await m.assertVisible(".*Delivery.*OLYMPIA, WA.*");
});
