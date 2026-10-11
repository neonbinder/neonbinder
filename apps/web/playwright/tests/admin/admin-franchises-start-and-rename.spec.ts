// Port of .maestro/flows/admin/admin-franchises-start-and-rename.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";

test(
  "Franchise Management — start a franchise under a sport and rename the thread",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/franchises"));
    await m.waitVisible(".*of .* franchises.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;

    await m.tapOn("Filter franchises");
    await m.inputText("zzzznotafranchise");
    await m.assertVisible("No franchises (match that filter|yet).*");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.tapOn("Filter franchises");
    await m.eraseText(20);

    await m.tapOn("Start a franchise");
    await m.scrollUntilVisible("One name for a team.s whole run.*", { timeout: 7_000 });
    await m.scrollUntilVisible("Franchise name", { timeout: 7_000 });
    await m.tapOn("Franchise name");
    await m.inputText(`Fran${TOKEN}`);
    await m.scrollUntilVisible("Start franchise", { timeout: 7_000 });
    await m.tapOn("Start franchise");

    await m.scrollUntilVisible(`.*Started Fran${TOKEN}.*`, { direction: "UP", timeout: 7_000 });
    await m.scrollUntilVisible(".*0 teams on this thread.*", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Sport: Baseball", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("No teams yet.*", { centerElement: true, timeout: 7_000 });

    await m.scrollUntilVisible("Franchise name", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Franchise name");
    await m.eraseText(40);
    await m.inputText(`Ren${TOKEN}`);
    await m.scrollUntilVisible("Save name", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save name");
    await m.scrollUntilVisible(`.*Renamed to Ren${TOKEN}.*`, { centerElement: true, timeout: 7_000 });

    // Reload: the old name must be gone, the new one the only match.
    await m.openLink("/admin/franchises");
    await m.waitVisible(".*of .* franchises.*", 30_000);
    await m.tapOn("Filter franchises");
    await m.inputText(`Fran${TOKEN}`);
    await m.waitVisible("No franchises match that filter.", 7_000);
    await m.tapOn("Filter franchises");
    await m.eraseText(40);
    await m.inputText(`Ren${TOKEN}`);
    await m.waitVisible("1 of .* franchises.*", 7_000);
    await m.tapOn(m.below(`Ren${TOKEN}`, ".*of .* franchises.*"));
    await m.scrollUntilVisible(".*0 teams on this thread.*", { centerElement: true, timeout: 7_000 });
  },
);
