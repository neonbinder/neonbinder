// Port of .maestro/flows/set-selector/admin-missing-bsc-shows-warning.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Set Builder Gate — admin without BSC credentials sees the warning banner",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector", { account: "admin-sl-only" }));
    await m.waitVisible("Set Builder requires marketplace credentials", 45_000);

    await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/set-selector");
    await m.waitVisible("Set Builder requires marketplace credentials", 90_000);

    await m.assertVisible("Set Builder requires marketplace credentials");
    await m.assertVisible("BuySportsCards");
    await m.assertNotVisible("SportLots");
    await m.assertNotVisible(".*Build set parameters using marketplace APIs.*");

    utilPausedPlatforms(m);
    if (env.SL_PAUSED) {
      await m.assertNotVisible("SportLots is on pause\\.");
      await m.assertNotVisible(m.id("Dismiss pause notice"));
    }

    await m.scrollUntilVisible(m.id("Configure credentials in Profile"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Configure credentials in Profile"));
    await m.assertVisible("Profile Settings");
  },
);
