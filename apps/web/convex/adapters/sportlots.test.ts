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
      variationName: "Action",
      residual: "2021 Topps Heritage #11 Alec Bohm",
    });
  });

  test("SL's own spelling is mapped onto the NeonBinder name", () => {
    // SL "Action Image" and BSC "Action" are the same variation; likewise
    // "Throwback Alternate"/"Alternate" and "Team Name Color Swap"/"Team Color".
    expect(
      parseSlVariationMarker("... Alec Bohm [ VAR Throwback Alternate ]").variationName,
    ).toBe("Throwback Alternate");
    expect(
      parseSlVariationMarker("... Yadier Molina [ VAR Team Name Color Swap ]")
        .variationName,
    ).toBe("Team Color Swap");
    expect(
      parseSlVariationMarker("... Javier Baez [ VAR Missing Stars ]").variationName,
    ).toBe("Missing Stars");
    expect(
      parseSlVariationMarker("... Javier Baez [ VAR Error ]").variationName,
    ).toBe("Error");
  });

  test("#13 Bryce Harper — five variations all share card number 13", () => {
    const names = [
      "Action Image",
      "Missing Stars",
      "Nickname",
      "Team Name Color Swap",
      "Throwback Alternate",
    ].map(
      (n) =>
        parseSlVariationMarker(`2021 Topps Heritage #13 Bryce Harper [ VAR ${n} ]`)
          .variationName,
    );
    expect(names).toEqual([
      "Action",
      "Missing Stars",
      "Nickname",
      "Team Color Swap",
      "Throwback Alternate",
    ]);
  });

  test("tolerates tighter spacing and lowercase inside the marker", () => {
    expect(parseSlVariationMarker("Pete Alonso [VAR Nickname]")).toEqual({
      isVariation: true,
      variationName: "Nickname",
      residual: "Pete Alonso",
    });
    expect(parseSlVariationMarker("Pete Alonso [ var Nickname ]").isVariation).toBe(
      true,
    );
  });

  test("an unrecognised variation name passes through rather than being forced", () => {
    expect(
      parseSlVariationMarker("Some Player [ VAR Sombrero Photo ]").variationName,
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
