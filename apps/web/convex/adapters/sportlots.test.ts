import { describe, expect, test } from "vitest";
import { parseSlVariationMarker } from "./sportlots";

/**
 * NEO-189 — SportLots variation markers.
 *
 * Every description below is an exact row read from `listcards.tpl` for set
 * 189991 (2021 Topps Heritage) as a logged-in seller on 2026-08-27.
 *
 * The shape that matters: SL leaves the card number IDENTICAL to the parent's
 * and distinguishes the variation only by the ` [ VAR <name> ]` marker. That is
 * the opposite of BSC, which suffixes the number (`11b`) instead.
 */
describe("parseSlVariationMarker", () => {
  test("a plain card is not a variation and is returned untouched", () => {
    expect(parseSlVariationMarker("2021 Topps Heritage #12 Alec Bohm")).toEqual({
      isVariation: false,
      residual: "2021 Topps Heritage #12 Alec Bohm",
    });
  });

  test("a multi-player parent row is still not a variation", () => {
    const desc = "2021 Topps Heritage #11 Alec Bohm|Spencer Howard";
    expect(parseSlVariationMarker(desc)).toEqual({
      isVariation: false,
      residual: desc,
    });
  });

  test("#11 — the marker is lifted and the description is left clean", () => {
    expect(
      parseSlVariationMarker("2021 Topps Heritage #11 Alec Bohm [ VAR Action Image ]"),
    ).toEqual({
      isVariation: true,
      variationLabel: "Action Image",
      residual: "2021 Topps Heritage #11 Alec Bohm",
    });
  });

  test("SL's own wording is returned UNTRANSLATED — mapping is the admin's call", () => {
    // NeonBinder holds one name per card, settled when the BSC and SL rows are
    // paired at import. An adapter never guesses a translation.
    expect(
      parseSlVariationMarker("... Alec Bohm [ VAR Throwback Alternate ]").variationLabel,
    ).toBe("Throwback Alternate");
    expect(
      parseSlVariationMarker("... Yadier Molina [ VAR Team Name Color Swap ]")
        .variationLabel,
    ).toBe("Team Name Color Swap");
    expect(
      parseSlVariationMarker("... Javier Baez [ VAR Missing Stars ]").variationLabel,
    ).toBe("Missing Stars");
  });

  test("#13 Bryce Harper — five variations all share card number 13", () => {
    const labels = [
      "Action Image",
      "Missing Stars",
      "Nickname",
      "Team Name Color Swap",
      "Throwback Alternate",
    ];
    const parsed = labels.map(
      (n) =>
        parseSlVariationMarker(`2021 Topps Heritage #13 Bryce Harper [ VAR ${n} ]`)
          .variationLabel,
    );
    expect(parsed).toEqual(labels);
  });

  test("tolerates tighter spacing and lowercase inside the marker", () => {
    expect(parseSlVariationMarker("Pete Alonso [VAR Nickname]")).toEqual({
      isVariation: true,
      variationLabel: "Nickname",
      residual: "Pete Alonso",
    });
    expect(parseSlVariationMarker("Pete Alonso [ var Nickname ]").isVariation).toBe(
      true,
    );
  });

  test("a name we have never seen is returned as data, not an error", () => {
    // It becomes an unresolved label for the admin to rule on, not a guess.
    expect(
      parseSlVariationMarker("Some Player [ VAR Sombrero Photo ]").variationLabel,
    ).toBe("Sombrero Photo");
  });

  test("a bracket that is not a VAR marker is left alone", () => {
    const desc = "2021 Topps Heritage #7 Brandon Belt [ SP ]";
    expect(parseSlVariationMarker(desc)).toEqual({
      isVariation: false,
      residual: desc,
    });
  });
});
