// Port of .maestro/flows/labels/label-history-empty-state.yaml
import { test } from "../../support/fixtures";

test("Print Shop — Label History empty state", { tag: ["@labels"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/print", { account: "new-profile" }));
  await m.waitVisible("Print Shop", 45_000);

  await m.scrollUntilVisible(".*Reprint a label you already paid for.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Reprint a label you already paid for.*");

  await m.waitVisible(".*newest first. Reprint one without paying for it twice.*", 10_000);

  await m.assertVisible(".*No labels yet.*nothing to reprint.*");
  await m.assertVisible(".*Buy postage over on.*");
  await m.assertNotVisible("Reprint");
});
