// Port of .maestro/flows/spine-label/design-and-queue-a-spine-label.yaml
import { test } from "../../support/fixtures";

test(
  "Spine Labels — design a label and queue it on the sheet",
  { tag: ["@smoke", "@spine-label"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/print/spine-label"));
    await m.waitVisible("Spine Labels", 45_000);

    await m.scrollUntilVisible("Name on the label", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Name on the label");
    await m.inputText("Ken Griffey Jr.");

    await m.scrollUntilVisible(".*Contrast .*:1.*", { centerElement: true, timeout: 7_000 });

    await m.scrollUntilVisible("Graduate", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Graduate");
    await m.assertVisible("Collegiate slab. Varsity.");

    await m.scrollUntilVisible('3"', { centerElement: true, timeout: 7_000 });
    await m.tapOn('3"');
    await m.assertVisible(".*2 labels per sheet at 3. wide.*");

    await m.scrollUntilVisible("Add to sheet", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Add to sheet");

    await m.swipe({ start: "50%, 25%", end: "50%, 75%" });
    await m.swipe({ start: "50%, 25%", end: "50%, 75%" });
    await m.swipe({ start: "50%, 25%", end: "50%, 75%" });
    const remove = m.id("Remove Ken Griffey Jr., 3 inch spine in Graduate, from the sheet");
    await m.scrollUntilVisible(remove, { direction: "UP", centerElement: true, timeout: 7_000 });

    await m.assertVisible(".*Sheet \\(1 label, 1 page\\).*");

    await m.tapOn(remove);
    await m.assertVisible(".*Sheet \\(0 labels, 0 pages\\).*");

    await m.scrollUntilVisible("Pick a player, or type a name, to see the label.", {
      centerElement: true,
      timeout: 7_000,
    });
  },
);
