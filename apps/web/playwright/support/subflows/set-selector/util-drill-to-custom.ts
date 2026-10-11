/**
 * Port of .maestro/flows/set-selector/util-drill-to-custom.yaml — drill the
 * EntitySelector hierarchy to the deepest provided level (real or custom),
 * creating each missing level as a custom entry. Each `when: true: "${X}"`
 * level runs only when X and every level above it are truthy.
 */
import type { Maestro } from "../../maestro";

export interface DrillToCustomOptions {
  SPORT?: string;
  YEAR?: string;
  MANUFACTURER?: string;
  SET_NAME?: string;
  VARIANT_TYPE?: string;
  VARIANT?: string;
}

export async function utilDrillToCustom(m: Maestro, o: DrillToCustomOptions = {}): Promise<void> {
  const { SPORT, YEAR, MANUFACTURER, SET_NAME, VARIANT_TYPE, VARIANT } = o;

  await m.openLink("/set-selector");
  await m.waitVisible(".*Build set parameters using marketplace APIs.*", 20000);

  await m.waitVisible("Sports", 30000);
  await m.waitVisible("Baseball", 60000);

  // ── Sport ──
  if (SPORT) {
    await m.scrollUntilVisible(m.id("Search sports"), { centerElement: true, timeout: 7000 });
    await m.tapOn(m.id("Search sports"));
    await m.inputText(SPORT);
    const sportRow = m.below(`.*${SPORT}.*`, m.id("Search sports"));
    if (await m.isVisible(sportRow)) {
      await m.waitVisible(sportRow, 7000);
      if (await m.isNotVisible("Years")) {
        await m.tapOn(sportRow);
      }
    }
    if (await m.isNotVisible("Years")) {
      if (await m.isNotVisible(sportRow)) {
        await m.scrollUntilVisible(m.id("Add custom Sports"), { centerElement: true, timeout: 7000 });
        await m.tapOn(m.id("Add custom Sports"));
        await m.waitVisible("Add Custom Entry", 5000);
        await m.inputText(SPORT);
        await m.pressKey("Enter");
        if (await m.isVisible(m.id("Create sport"))) {
          await m.tapOn(m.id("Create sport"));
        }
        await m.waitNotVisible("Add Custom Entry", 10000);
        await m.waitVisible(sportRow, 10000);
        await m.tapOn(sportRow);
      }
    }
    await m.waitVisible("Years", 60000);
  }

  // ── Year ──
  if (SPORT && YEAR) {
    await m.waitVisible(".*Search years.*", 7000);
    await m.tapOn(".*Search years.*");
    await m.inputText(YEAR);
    const yearRow = m.below(YEAR, m.id("Search years"));
    if (await m.isVisible(yearRow)) {
      await m.waitVisible(yearRow, 7000);
      if (await m.isNotVisible("Manufacturers")) {
        await m.tapOn(yearRow);
      }
    }
    if (await m.isNotVisible("Manufacturers")) {
      if (await m.isNotVisible(yearRow)) {
        await m.eraseText(50);
        await m.scrollUntilVisible(m.id("Add custom Years"), { centerElement: true, timeout: 7000 });
        await m.tapOn(m.id("Add custom Years"));
        await m.waitVisible("Add Custom Entry", 5000);
        await m.inputText(YEAR);
        await m.pressKey("Enter");
        if (await m.isVisible(m.id("Create year"))) {
          await m.tapOn(m.id("Create year"));
        }
        await m.waitNotVisible("Add Custom Entry", 10000);
        await m.tapOn(".*Search years.*");
        await m.inputText(YEAR);
        await m.waitVisible(yearRow, 10000);
        await m.tapOn(yearRow);
      }
    }
    await m.waitVisible("Manufacturers", 20000);
  }

  // ── Manufacturer ──
  if (SPORT && YEAR && MANUFACTURER) {
    await m.waitVisible(".*Search manufacturers.*", 7000);
    await m.tapOn(".*Search manufacturers.*");
    await m.inputText(MANUFACTURER);
    const mfrRow = m.below(MANUFACTURER, m.id("Search manufacturers"));
    if (await m.isVisible(mfrRow)) {
      await m.waitVisible(mfrRow, 7000);
      if (await m.isNotVisible("Sets")) {
        await m.tapOn(mfrRow);
      }
    }
    if (await m.isNotVisible("Sets")) {
      if (await m.isNotVisible(mfrRow)) {
        await m.eraseText(50);
        await m.scrollUntilVisible(m.id("Add custom Manufacturers"), { centerElement: true, timeout: 7000 });
        await m.tapOn(m.id("Add custom Manufacturers"));
        await m.waitVisible("Add Custom Entry", 5000);
        await m.inputText(MANUFACTURER);
        await m.pressKey("Enter");
        if (await m.isVisible(m.id("Create manufacturer"))) {
          await m.tapOn(m.id("Create manufacturer"));
        }
        await m.waitNotVisible("Add Custom Entry", 10000);
        await m.tapOn(".*Search manufacturers.*");
        await m.inputText(MANUFACTURER);
        await m.waitVisible(mfrRow, 10000);
        await m.tapOn(mfrRow);
      }
    }
    await m.waitVisible("Sets", 20000);
  }

  // ── Set ──
  if (SPORT && YEAR && MANUFACTURER && SET_NAME) {
    await m.scrollUntilVisible(m.id("Add custom Sets"), { centerElement: true, timeout: 7000 });

    if (await m.isNotVisible(SET_NAME)) {
      await m.tapOn(m.id("Add custom Sets"));
      await m.waitVisible("Add Custom Entry", 5000);
      await m.inputText(SET_NAME);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create set"))) {
        await m.tapOn(m.id("Create set"));
      }
      await m.waitNotVisible("Add Custom Entry", 10000);
    }

    if (await m.isNotVisible("Variant Types")) {
      await m.scrollUntilVisible(m.id("Search sets"), { direction: "UP", centerElement: true, timeout: 7000 });
      await m.tapOn(".*Search sets.*");
      await m.inputText(SET_NAME);
      const setRow = m.below(`.*${SET_NAME}.*`, m.id("Search sets"));
      await m.waitVisible(setRow, 10000);
      await m.tapOn(setRow); // waitToSettleTimeoutMs: 2000 has no equivalent
    }
    await m.waitVisible("Variant Types", 30000);
  }

  // ── Variant type ──
  if (SPORT && YEAR && MANUFACTURER && SET_NAME && VARIANT_TYPE) {
    await m.scrollUntilVisible(m.id(`Sets: ${SET_NAME} — change`), { direction: "UP", timeout: 7000 });
    await m.scrollUntilVisible(m.id("Add custom Variant Types"), { centerElement: true, timeout: 7000 });

    if (await m.isNotVisible(VARIANT_TYPE)) {
      await m.scrollUntilVisible(m.id("Add custom Variant Types"), { centerElement: true, timeout: 7000 });
      await m.tapOn(m.id("Add custom Variant Types"));
      await m.waitVisible("Add Custom Entry", 10000);
      await m.inputText(VARIANT_TYPE);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create variant type"))) {
        await m.tapOn(m.id("Create variant type"));
      }
      await m.waitNotVisible("Add Custom Entry", 10000);
      await m.waitVisible(`.*${VARIANT_TYPE}.*`, 5000);
    }

    await m.scrollUntilVisible(VARIANT_TYPE, { centerElement: true, timeout: 7000 });
    await m.tapOn(VARIANT_TYPE);

    await m.assertNotVisible("An error occurred. Please refresh the page.");
    await m.waitVisible(`.*${VARIANT_TYPE}s.*`, 15000);
    await m.scrollUntilVisible(m.id(`Add custom ${VARIANT_TYPE}s`), { centerElement: true, timeout: 7000 });
  }

  // ── Variant (insert / parallel) ──
  if (SPORT && YEAR && MANUFACTURER && SET_NAME && VARIANT_TYPE && VARIANT) {
    if (await m.isNotVisible(VARIANT)) {
      await m.tapOn(m.id(`Add custom ${VARIANT_TYPE}s`));
      await m.waitVisible("Add Custom Entry", 5000);
      await m.inputText(VARIANT);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create insert"))) {
        await m.tapOn(m.id("Create insert"));
      }
      await m.waitNotVisible("Add Custom Entry", 10000);
    }

    await m.scrollUntilVisible(VARIANT, { centerElement: true, timeout: 7000 });
    await m.tapOn(VARIANT);

    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7000 });
  }
}
