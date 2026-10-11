// Port of .maestro/flows/set-selector/custom-entry-survives-resync.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test("Custom Entry Survives Re-Sync", { tag: ["@set-selector"] }, async ({ m, env }) => {
  const NAME = `TestCustomSport-${env.ATTEMPT_ID}`;
  const READY = ".*Build set parameters using marketplace APIs.*";

  await m.launch(m.signInUrl("/set-selector"));
  await m.waitVisible(READY, 45_000);

  await m.openLink("/set-selector");
  await m.assertVisible(READY);

  // Step 1: add a custom Sport
  await m.waitVisible("Baseball", 60_000);
  await m.scrollUntilVisible(m.id("Add custom Sports"), { timeout: 7_000, centerElement: true });
  await m.tapOn(m.id("Add custom Sports"));
  await m.assertVisible("Add Custom Entry");

  await m.tapOn("Enter custom value...");
  await m.inputText(NAME);
  await m.pressKey("Enter");
  if (await m.isVisible(m.id("Create sport"))) {
    await m.tapOn(m.id("Create sport"));
  }
  await m.assertNotVisible("Add Custom Entry");

  // Step 2: it survives a reload
  await m.openLink("/set-selector");
  await m.assertVisible(READY);

  await m.tapOn(m.id("Search sports"));
  await m.inputText(NAME);
  await m.waitVisible(m.below(NAME, m.id("Search sports")), 7_000);

  // Step 3: re-sync the Sports column
  await m.openLink("/set-selector");
  await m.assertVisible(READY);

  await m.waitVisible("Baseball", 30_000);
  await m.scrollUntilVisible("Sync Sports", { timeout: 7_000, centerElement: true });
  await m.tapOn("Sync Sports");

  const SL_PAUSED = utilPausedPlatforms(m);

  await m.waitVisible("Syncing Sport Options", 7_000);
  await m.waitNotVisible("Syncing Sport Options", 55_000);
  if (!SL_PAUSED) {
    await m.assertNotVisible("SportLots is on pause: nothing from SportLots was asked for or changed.");
  }
  if (SL_PAUSED) {
    await m.scrollUntilVisible("SportLots is on pause: nothing from SportLots was asked for or changed.", {
      direction: "UP",
      timeout: 7_000,
    });
  }

  // Safety net: recover if the sync panel is still showing
  if (await m.isVisible("Syncing Sport Options")) {
    if (await m.isVisible("Cancel")) {
      await m.scrollUntilVisible("Cancel", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Cancel");
    }
    if (await m.isVisible("Syncing Sport Options")) {
      if (await m.isVisible("Close")) {
        await m.scrollUntilVisible("Close", { centerElement: true, timeout: 7_000 });
        await m.tapOn("Close");
      }
    }
    await m.waitNotVisible("Syncing Sport Options", 10_000);
  }

  // Step 4: still there after the re-sync
  await m.openLink("/set-selector");
  await m.assertVisible(READY);

  await m.tapOn(m.id("Search sports"));
  await m.inputText(NAME);
  await m.waitVisible(m.below(NAME, m.id("Search sports")), 7_000);

  // Step 5: clean up
  await m.openLink("/set-selector");
  await m.assertVisible(READY);

  await m.assertVisible("Baseball");

  await m.tapOn(m.id("Search sports"));
  await m.inputText(NAME);
  await m.tapOn(m.below(NAME, m.id("Search sports")));

  await m.scrollUntilVisible(`.*Attributes for ${NAME}.*`, { centerElement: true, timeout: 7_000 });

  await m.retry(1, async () => {
    await m.tapOn(m.id(`Delete ${NAME}`));
    await m.waitVisible(`.*Delete Sport .${NAME}..*`, 7_000);
  });

  await m.assertVisible("Nothing is below it. This cannot be undone.");
  await m.tapOn("Yes, delete");

  await m.openLink("/set-selector");
  await m.assertVisible(READY);
  await m.waitVisible("Baseball", 30_000);
  await m.tapOn(m.id("Search sports"));
  await m.inputText(NAME);
  await m.waitVisible("No matches found", 7_000);
});
