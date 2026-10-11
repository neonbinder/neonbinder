/**
 * Port of .maestro/flows/set-selector/util-add-custom-card.yaml — drill to the
 * per-worker custom set, ensure INSERT_NAME exists in the Variants column
 * (idempotent), open the CardChecklist and add one card.
 */
import type { Maestro } from "../../maestro";
import { utilDrillToCustomSet } from "./util-drill-to-custom-set";

export interface AddCustomCardOptions {
  SET_NAME: string;
  /** Default "Insert". */
  VARIANT_TYPE?: string;
  /** Default "Base". */
  INSERT_NAME?: string;
  CARD_NUMBER: string;
  PLAYER_NAME: string;
  /** Typed into "Card name" when truthy. */
  CARD_NAME?: string;
}

export async function utilAddCustomCard(m: Maestro, o: AddCustomCardOptions): Promise<void> {
  const VARIANT_TYPE = o.VARIANT_TYPE || "Insert";
  const INSERT_NAME = o.INSERT_NAME || "Base";

  await utilDrillToCustomSet(m, { SET_NAME: o.SET_NAME, VARIANT_TYPE });

  await m.scrollUntilVisible(m.id(`Add custom ${VARIANT_TYPE}s`), { centerElement: true, timeout: 7000 });

  if (await m.isNotVisible(INSERT_NAME)) {
    await m.tapOn(m.id(`Add custom ${VARIANT_TYPE}s`));
    await m.assertVisible("Add Custom Entry");
    await m.inputText(INSERT_NAME);
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create insert"))) {
      await m.tapOn(m.id("Create insert"));
    }
    await m.assertNotVisible("Add Custom Entry");
  }

  await m.scrollUntilVisible(INSERT_NAME, { centerElement: true, timeout: 7000 });
  await m.tapOn(INSERT_NAME);

  // visibilityPercentage: 50 has no equivalent (dropped per PORTING.md).
  await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7000 });

  await m.tapOn(m.id("Open add card form"));
  await m.waitVisible(m.id("Card name"), 15000);

  // The card number input is autofocused: type directly.
  await m.inputText(o.CARD_NUMBER);

  await m.tapOn("Player name");
  await m.inputText(o.PLAYER_NAME);

  if (o.CARD_NAME) {
    await m.tapOn(m.id("Card name"));
    await m.eraseText(80);
    await m.inputText(o.CARD_NAME);
  }

  await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7000 });
  await m.tapOn(m.id("Submit new card"));

  await m.waitNotVisible(m.id("Card name"), 7000);

  await m.scrollUntilVisible(m.id(`Edit card ${o.CARD_NUMBER}(, .*)?`), { centerElement: true, timeout: 7000 });
}
