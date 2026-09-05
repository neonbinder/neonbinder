import { describe, expect, test } from "vitest";
import {
  parseSlVariationMarker,
  stripBrandPrefixForLabel,
} from "./sportlots";

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

/**
 * NEO-239 — the brand-prefix strip, which is DERIVATION and not a query input.
 *
 * SportLots names its sets with the brand in front ("Topps Series 1") where NB
 * files "Series 1" under a manufacturer row called "Topps". A fresh NB row
 * seeds its display value from what the fetch returns, so leaving the prefix
 * on gives every synced set a name that repeats its own parent — and on a
 * re-sync of rows created before that, the stored SL label disagrees with
 * every NB value and NEO-211's suggestion query nags a rename on the whole
 * year.
 *
 * The invariant permits this ("a row may be derived from marketplace data when
 * it is created") and forbids the reverse. Which direction this is, is
 * enforced by where it sits: applied to the parsed RESPONSE, from a parameter
 * `resolveSlScope` never receives. See `retireCustom.security.test.ts` for the
 * test that it never reaches the wire.
 */
describe("stripBrandPrefixForLabel", () => {
  test("strips the brand the NB parent is called", () => {
    expect(stripBrandPrefixForLabel("Topps Series 1", "Topps")).toBe("Series 1");
  });

  test("leaves an unrelated prefix alone", () => {
    // SportLots lists more than one brand's sets when the year is browsed, and
    // the strip must not chew a name it does not own.
    expect(stripBrandPrefixForLabel("Bowman Chrome", "Topps")).toBe(
      "Bowman Chrome",
    );
  });

  test("requires a WORD boundary — a longer word that merely starts the same is untouched", () => {
    // The bug the first revision shipped: a bare `startsWith` turned
    // "Toppstown Retro" into "town Retro". Not a cosmetic slip — NB seeds a
    // fresh row's display value from this string, so a real SportLots set was
    // silently renamed to nonsense that no operator typed and none would
    // recognise.
    expect(stripBrandPrefixForLabel("Toppstown Retro", "Topps")).toBe(
      "Toppstown Retro",
    );
    expect(stripBrandPrefixForLabel("Toppsy Turvy", "Topps")).toBe(
      "Toppsy Turvy",
    );
    expect(stripBrandPrefixForLabel("Topps1 Special", "Topps")).toBe(
      "Topps1 Special",
    );
  });

  test("a non-space separator ends the word too, and is itself left in place", () => {
    // The boundary rule is "absent or non-alphanumeric", so a hyphen ends the
    // brand as a space does and the strip applies. What comes back still has
    // the separator on the front: the remainder is whitespace-trimmed and
    // nothing more, exactly as the original did. Inventing a second cleanup
    // rule for punctuation is a different decision from restoring this one,
    // and it would have to guess whether a leading "#" is a separator or part
    // of the set's name.
    expect(stripBrandPrefixForLabel("Topps-Series 1", "Topps")).toBe(
      "-Series 1",
    );
    expect(stripBrandPrefixForLabel("Topps Series 1", "Topps")).toBe(
      "Series 1",
    );
  });

  test("no manufacturer in context means no strip at all", () => {
    // The attach pane and the top-level syncs pass no manufacturer; the label
    // is then the marketplace's own name, unaltered.
    expect(stripBrandPrefixForLabel("Topps Series 1", undefined)).toBe(
      "Topps Series 1",
    );
    expect(stripBrandPrefixForLabel("Topps Series 1", "   ")).toBe(
      "Topps Series 1",
    );
  });

  test("case-sensitive, matching what shipped before", () => {
    // Kept deliberately: widening the match is a behaviour change beyond
    // restoring the strip, and a case-folded match would start eating prefixes
    // the original left alone.
    expect(stripBrandPrefixForLabel("TOPPS Series 1", "Topps")).toBe(
      "TOPPS Series 1",
    );
  });

  test("a label that IS the brand keeps its name instead of vanishing", () => {
    // The second correction to the original. Stripping this to "" made the caller's
    // `if (radioId && setName)` guard drop the row entirely — losing a set
    // because SportLots named it after its brand is not a cleanup.
    expect(stripBrandPrefixForLabel("Topps", "Topps")).toBe("Topps");
    expect(stripBrandPrefixForLabel("Topps   ", "Topps")).toBe("Topps   ");
  });

  // NEO-239 ADVERSARIAL PASS — found a real bug, now FIXED. The first
  // revision checked `label.startsWith(brand)` with no word-boundary check, so
  // a brand that is a plain string-prefix of a longer, unrelated word got
  // sliced mid-word: "Toppstown Retro" became "town Retro". Not cosmetic — NB
  // seeds a fresh row's display value from this string, so a real SportLots
  // set was renamed to nonsense no operator typed and none would recognise.
  //
  // The original test above ("leaves an unrelated prefix alone") demonstrated
  // the same bug with "Toppsy Turvy" while being captioned as though the label
  // were untouched; both are now asserted correctly.
  test("a brand with no trailing word-boundary leaves the label alone", () => {
    // "Toppstown" is not "Topps" — it merely starts with the same letters, and
    // the right answer is the label unchanged, exactly like "Bowman Chrome".
    expect(stripBrandPrefixForLabel("Toppstown Retro", "Topps")).toBe(
      "Toppstown Retro",
    );
  });
});
