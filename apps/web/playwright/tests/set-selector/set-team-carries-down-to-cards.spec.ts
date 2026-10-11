// Port of .maestro/flows/set-selector/set-team-carries-down-to-cards.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

/**
 * Maestro `{ id: A, text: B }`: ONE element whose accessible name matches A and
 * whose own text / input value / placeholder matches B (an input reads back its
 * value, or its placeholder when empty). The driver has no combined selector.
 */
function idText(m: Maestro, idPattern: string, textPattern: string): Relational {
  const re = mrx(textPattern);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(idPattern)} with text ${JSON.stringify(textPattern)}`,
    probe: async () => {
      const els = m.id(idPattern);
      const n = await els.count();
      for (let i = 0; i < n; i++) {
        const el = els.nth(i);
        const texts = await el
          .evaluate((e) => {
            const f = e as HTMLInputElement;
            return [f.value, f.placeholder, (e as HTMLElement).innerText, e.textContent].filter(
              (s): s is string => typeof s === "string" && s !== "",
            );
          })
          .catch(() => [] as string[]);
        if (texts.some((t) => re.test(t))) return el;
      }
      return null;
    },
  };
}

test(
  "Set-level Team carries down to cards — new cards are born with it, a change cascades to the cards that inherited it and leaves a hand-set card alone (NEO-277)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX;
    const ID = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    const drill = () =>
      utilDrillToCustom(m, {
        SPORT: `E2E Test Sport ${W}`,
        YEAR: "2026",
        MANUFACTURER: "Topps",
        SET_NAME: `stt-${W}-${ID}`,
      });

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await drill();
    await m.assertVisible("Variant Types");

    // Phase 1: set a Team on the set
    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(m.id("Add set team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add set team"));
    await m.assertVisible(m.id("Find a team for the set"));
    await m.tapOn(m.id("Find a team for the set"));
    await m.inputText(`STA${T}`);

    await m.assertVisible(m.id(`New team STA${T}`));
    await m.tapOn(m.id(`New team STA${T}`));

    await m.assertVisible(`New team: STA${T}`);
    await m.assertVisible(idText(m, "New team name", `STA${T}`));

    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${T}`);

    await m.tapOn(m.id("League"));
    await m.inputText(`STL${T}L`);
    await m.tapOn(`Create .STL${T}L.`);

    await m.waitVisible(idText(m, "New league name", `STL${T}L`), 7_000);
    await m.tapOn("Add league");

    await m.waitVisible(idText(m, "League", `STL${T}L`), 7_000);

    await m.tapOn(m.id(`Create team Loc${T} STA${T}`));

    await m.waitVisible("Team applied to cards", 7_000);
    await m.waitVisible(m.id(`Remove team Loc${T} STA${T}`), 7_000);

    // Phase 2: Insert > Base, then a first card (born with the set team)
    await m.scrollUntilVisible(m.id("Add custom Variant Types"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Add custom Variant Types"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText("Insert");
    await m.pressKey("Enter");
    await m.assertVisible(m.id("Create variant type"));
    await m.tapOn(m.id("Create variant type"));
    await m.waitNotVisible("Add Custom Entry", 7_000);
    await m.scrollUntilVisible("Insert", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    await m.waitVisible("Inserts", 7_000);

    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Inserts"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText("Base");
    await m.pressKey("Enter");
    await m.assertVisible(m.id("Create insert"));
    await m.tapOn(m.id("Create insert"));
    await m.waitNotVisible("Add Custom Entry", 7_000);
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Base");
    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });

    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`771-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Set Team Alpha ${ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);
    await m.scrollUntilVisible(m.id(`Edit card 771-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });

    await m.waitVisible(`Loc${T} STA${T}`, 7_000);

    // Phase 3: a second card, then hand-set a different team on it
    await m.scrollUntilVisible(m.id("Open add card form"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`772-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Set Team Bravo ${ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);
    await m.scrollUntilVisible(m.id(`Edit card 772-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });

    await m.tapOn(m.id(`Edit card 772-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.waitVisible(m.id(`Remove team Loc${T} STA${T}`), 7_000);

    await m.tapOn(m.id(`Remove team Loc${T} STA${T}`));
    await m.waitVisible("Saved Teams", 7_000);
    await m.assertNotVisible(m.id(`Remove team Loc${T} STA${T}`));

    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`STB${T}`);
    await m.assertVisible(m.id(`New team STB${T}`));
    await m.tapOn(m.id(`New team STB${T}`));
    await m.assertVisible(`New team: STB${T}`);
    await m.assertVisible(idText(m, "New team name", `STB${T}`));
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${T}`);
    await m.tapOn(m.id("League"));
    await m.inputText(`${T}L`);
    await m.tapOn(`STL${T}L`);
    await m.waitVisible(idText(m, "League", `STL${T}L`), 7_000);
    await m.tapOn(m.id(`Create team Loc${T} STB${T}`));
    await m.waitVisible(m.id(`Remove team Loc${T} STB${T}`), 7_000);

    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Search teams"), 7_000);
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    // Phase 4: change the set's team; the inherited card follows, the hand-set one stays
    await drill();
    await m.assertVisible("Variant Types");

    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    await m.waitVisible(`Attributes for stt-${W}-${ID} \\(Set\\)`, 7_000);
    await m.waitVisible(`STA${T}`, 7_000);
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(m.id(`Remove team Loc${T} STA${T}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Remove team Loc${T} STA${T}`));
    await m.waitVisible(`Keep Loc${T} STA${T}`, 7_000);
    await m.assertVisible("Clear team");

    await m.scrollUntilVisible(m.id("Add set team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add set team"));
    await m.assertVisible(m.id("Find a team for the set"));
    await m.tapOn(m.id("Find a team for the set"));
    await m.inputText(`STC${T}`);
    await m.assertVisible(m.id(`New team STC${T}`));
    await m.tapOn(m.id(`New team STC${T}`));
    await m.assertVisible(`New team: STC${T}`);
    await m.assertVisible(idText(m, "New team name", `STC${T}`));
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${T}`);
    await m.tapOn(m.id("League"));
    await m.inputText("No lea");
    await m.tapOn("No league");
    await m.waitVisible(idText(m, "League", "No league"), 7_000);
    await m.tapOn(m.id(`Create team Loc${T} STC${T}`));

    await m.waitVisible(`Apply Loc${T} STC${T} to this set\\?`, 7_000);
    await m.assertVisible(
      `1 card under this set will get Loc${T} STC${T}\\. 1 card carries a different team — these will not change\\.`,
    );
    await m.tapOn("Yes, apply");

    await m.waitVisible("Team applied to cards", 7_000);
    await m.assertVisible(m.id(`Remove team Loc${T} STC${T}`));
    await m.assertNotVisible(m.id(`Remove team Loc${T} STA${T}`));

    await m.scrollUntilVisible("Insert", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    await m.waitVisible("Inserts", 7_000);
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Base");
    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(m.id(`Edit card 771-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.waitVisible(`Loc${T} STC${T}`, 7_000);
    await m.assertVisible(`Loc${T} STB${T}`);

    // Cleanup
    await m.scrollUntilVisible(m.id(`Delete card 771-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 771-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 771-${ID}(, .*)?`));
    await m.assertNotVisible(`Set Team Alpha ${ID}`);

    await m.scrollUntilVisible(m.id(`Delete card 772-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 772-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 772-${ID}(, .*)?`));
    await m.assertNotVisible(`Set Team Bravo ${ID}`);
    await m.waitVisible("No cards in this checklist yet.", 7_000);
  },
);
