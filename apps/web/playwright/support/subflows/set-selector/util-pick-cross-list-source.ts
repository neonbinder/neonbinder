/**
 * Port of .maestro/flows/set-selector/util-pick-cross-list-source.yaml — with
 * the "Add Cross-Release Cards" modal already open, walk its wizard down to
 * the source set and leave it confirmed ("Source set: <SOURCE_VARIANT>").
 */
import type { Maestro } from "../../maestro";
import { idWithText } from "../id-with-text";

export interface PickCrossListSourceOptions {
  SOURCE_SPORT: string;
  SOURCE_YEAR: string;
  SOURCE_MANUFACTURER: string;
  SOURCE_SET: string;
  SOURCE_VARIANT_TYPE: string;
  SOURCE_VARIANT: string;
}

export async function utilPickCrossListSource(m: Maestro, o: PickCrossListSourceOptions): Promise<void> {
  await m.waitVisible(m.id("Add cross-release cards"), 7000);

  // Q1 sport (long list -> filter first)
  if (await m.isVisible(m.id("Filter Sport options"))) {
    await m.tapOn(m.id("Filter Sport options"));
    await m.inputText(o.SOURCE_SPORT);
  }
  await m.tapOn(m.id(`Pick Sport ${o.SOURCE_SPORT}`));
  await m.assertVisible(idWithText(m, "Change Sport", o.SOURCE_SPORT));

  // Q2 year
  await m.tapOn(m.id(`Pick Year ${o.SOURCE_YEAR}`));
  await m.assertVisible(idWithText(m, "Change Year", o.SOURCE_YEAR));

  // Q3 manufacturer
  await m.tapOn(m.id(`Pick Manufacturer ${o.SOURCE_MANUFACTURER}`));
  await m.assertVisible(idWithText(m, "Change Manufacturer", o.SOURCE_MANUFACTURER));

  // Q4 set (grows run after run -> filter first)
  if (await m.isVisible(m.id("Filter Set options"))) {
    await m.tapOn(m.id("Filter Set options"));
    await m.inputText(o.SOURCE_SET);
  }
  await m.tapOn(m.id(`Pick Set ${o.SOURCE_SET}`));
  await m.assertVisible(idWithText(m, "Change Set", o.SOURCE_SET));

  // Q5 variant
  await m.tapOn(m.id(`Pick Variant ${o.SOURCE_VARIANT_TYPE}`));
  await m.assertVisible(idWithText(m, "Change Variant", o.SOURCE_VARIANT_TYPE));

  // Q6 insert (the checklist the cards live in)
  await m.tapOn(m.id(`Pick Insert ${o.SOURCE_VARIANT}`));
  await m.assertVisible(idWithText(m, "Change Insert", o.SOURCE_VARIANT));

  await m.waitVisible(`Source set: ${o.SOURCE_VARIANT}`, 7000);
}
