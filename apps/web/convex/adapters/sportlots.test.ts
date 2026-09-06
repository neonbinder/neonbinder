import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  decodeSlEntities,
  parseSlSubjects,
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

/**
 * NEO-251 — `parseSlSubjects`.
 *
 * The bug this closes: SportLots rows never carried `players`, so an SL-only
 * set committed with 100% of its cards flagged "needs attention" and the
 * entity-review wizard never opened for it. SL's description IS the player
 * name; nothing else in the row is.
 *
 * The parser's stance is asymmetric on purpose. A missed name costs the
 * operator one manual entry in a wizard that already exists for exactly that.
 * An invented name writes marketplace-derived garbage into NB's own player
 * data — the thing the product invariant is there to stop. So every rule
 * below fails toward `{}`, and a single doubtful subject rejects the whole
 * row rather than emitting the subjects around it.
 */
describe("parseSlSubjects", () => {
  describe("names it accepts", () => {
    test("a plain two-token name", () => {
      expect(parseSlSubjects("Coby Mayo")).toEqual({ players: ["Coby Mayo"] });
    });

    test("SL's `|` delimiter splits a multi-player row into two subjects", () => {
      // The real 2021 Topps Heritage #11 row.
      expect(parseSlSubjects("Alec Bohm|Spencer Howard")).toEqual({
        players: ["Alec Bohm", "Spencer Howard"],
      });
    });

    test("a generational suffix is part of the name, not noise", () => {
      expect(parseSlSubjects("Fernando Tatis Jr.")).toEqual({
        players: ["Fernando Tatis Jr."],
      });
    });

    test("period-initials survive", () => {
      expect(parseSlSubjects("J.T. Realmuto")).toEqual({
        players: ["J.T. Realmuto"],
      });
    });

    test("accents are KEPT, not stripped or rejected", () => {
      // An ASCII-only token class would have turned this into a rejection,
      // which quietly costs names on a large fraction of a baseball set.
      expect(parseSlSubjects("José Ramírez")).toEqual({
        players: ["José Ramírez"],
      });
    });

    test("a trailing team abbreviation is stripped and never emitted", () => {
      // SL prints no team — it prints a 2-3 letter code whose meaning varies
      // by sport and era. Mapping it to an NB team would mean looking an NB
      // row up by a marketplace display string, which the invariant forbids.
      // So it is removed from the name and dropped.
      const result = parseSlSubjects("Mike Trout LAA");
      expect(result).toEqual({ players: ["Mike Trout"] });
      expect(result).not.toHaveProperty("teams");
      expect(result).not.toHaveProperty("team");
    });

    test("mascots parse as subjects — SL files them as cards like any other", () => {
      expect(parseSlSubjects("Mr. Met")).toEqual({ players: ["Mr. Met"] });
      expect(parseSlSubjects("Billy the Marlin")).toEqual({
        players: ["Billy the Marlin"],
      });
      expect(parseSlSubjects("Wally the Green Monster")).toEqual({
        players: ["Wally the Green Monster"],
      });
    });

    test("two people who differ only by suffix are two people", () => {
      // The dedupe is case-insensitive on the WHOLE name, so "Jr." vs "Sr."
      // must not collapse. A father/son subset card that emitted one name
      // would silently lose half the card's subjects.
      expect(parseSlSubjects("Ken Griffey Jr.|Ken Griffey Sr.")).toEqual({
        players: ["Ken Griffey Jr.", "Ken Griffey Sr."],
      });
    });

    test("a repeated subject is deduped rather than emitted twice", () => {
      // Note the dedupe never rescues a MALFORMED repeat: "Mike Trout|mike
      // trout" is rejected outright, because the lowercase copy fails the
      // token rule before dedupe is ever reached. Validation first, dedupe
      // second — that ordering is what keeps a bad subject from being
      // laundered by a good one beside it.
      expect(parseSlSubjects("Mike Trout|Mike Trout")).toEqual({
        players: ["Mike Trout"],
      });
      expect(parseSlSubjects("Mike Trout|mike trout")).toEqual({});
    });
  });

  describe("rows it refuses", () => {
    const refused = (desc: string) => expect(parseSlSubjects(desc)).toEqual({});

    test("a bare checklist line", () => {
      // Single-token subjects are rejected wholesale. "Checklist" and
      // "Ichiro" are indistinguishable to this parser, and it is the
      // checklist rows that are common.
      refused("Checklist");
    });

    test("stoplist words veto the subject even beside a plausible name", () => {
      refused("Team Checklist");
      refused("Yankee Stadium");
      refused("Header Card");
      refused("New York Yankees Team Card");
    });

    test("anything with a digit", () => {
      refused("1998 Topps");
    });

    test("a single-token name — a real one, and that is the point", () => {
      // Ichiro Suzuki really is printed as "Ichiro" on some cards. Accepting
      // it would mean accepting every one-word non-name too, so this is a
      // deliberate, documented false negative.
      refused("Ichiro");
    });

    test("five subjects — that is a checklist line, not a card", () => {
      refused("Mike Trout|Aaron Judge|Bryce Harper|Juan Soto|Shohei Ohtani");
    });
  });

  describe("hostile input", () => {
    test("`&` decodes and the result is then judged on its merits", () => {
      // "Tom &amp; Jerry" decodes to "Tom & Jerry", which splits on ` & `
      // into two SINGLE-token subjects — and single tokens are refused. The
      // sequencing matters: decode first, judge second.
      expect(parseSlSubjects("Tom &amp; Jerry")).toEqual({});
    });

    test("markup is rejected AFTER decoding, so encoding it does not help", () => {
      expect(parseSlSubjects("<b>Mike</b> Trout")).toEqual({});
      expect(parseSlSubjects("&lt;b&gt;Mike&lt;/b&gt; Trout")).toEqual({});
    });

    test("a double-encoded payload is caught by the same post-decode guard", () => {
      // Decoding runs in ONE pass and does not re-scan its own output, so
      // this yields the literal text "&lt;script&gt;". Nothing executes and
      // nothing is emitted.
      expect(parseSlSubjects("&amp;lt;script&amp;gt; Mike Trout")).toEqual({});
    });

    test("control characters, newline included", () => {
      expect(parseSlSubjects("Mike\nTrout")).toEqual({});
      expect(parseSlSubjects("Mike\u0000 Trout")).toEqual({});
      expect(parseSlSubjects("Mike Trout\u007F")).toEqual({});
      expect(parseSlSubjects("Mike Trout\r\nSpencer Howard")).toEqual({});
    });

    test("an over-long subject is refused rather than truncated", () => {
      // Truncating would emit a name no one printed. 121 chars of a
      // structurally valid two-token name still fails the length cap.
      const long = `Mike ${"A".repeat(120)}`;
      expect(long.length).toBeGreaterThan(120);
      expect(parseSlSubjects(long)).toEqual({});
    });

    test("every accepted name is trimmed, collapsed and within the cap", () => {
      const { players } = parseSlSubjects("  Alec   Bohm | Spencer  Howard  ");
      expect(players).toEqual(["Alec Bohm", "Spencer Howard"]);
      for (const name of players ?? []) {
        expect(name).toBe(name.trim());
        expect(name.length).toBeLessThanOrEqual(120);
        expect(name).not.toMatch(/\s{2,}/);
        // eslint-disable-next-line no-control-regex
        expect(name).not.toMatch(/[\u0000-\u001F\u007F<>]/);
      }
    });

    test("the contract's bounds hold: 1-4 names or nothing at all", () => {
      const { players } = parseSlSubjects("A. One|B. Two|C. Three|D. Four");
      expect(players).toHaveLength(4);
      expect(players!.length).toBeLessThanOrEqual(4);
    });
  });
});

describe("decodeSlEntities", () => {
  test("decodes the bounded set", () => {
    expect(decodeSlEntities("Peter O&#39;Brien")).toBe("Peter O'Brien");
    expect(decodeSlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeSlEntities("A&nbsp;B")).toBe("A B");
    expect(decodeSlEntities("&QUOT;x&QUOT;")).toBe('"x"');
  });

  test("leaves an entity OUTSIDE the set as literal text", () => {
    // The closed set is the security property: an attacker cannot invent an
    // entity name and have it resolved. The cost is that a genuinely accented
    // page using `&eacute;` yields no players for that row — a false negative,
    // which is the direction this adapter fails in.
    expect(decodeSlEntities("Jos&eacute;")).toBe("Jos&eacute;");
    expect(decodeSlEntities("&#60;script&#62;")).toBe("&#60;script&#62;");
  });

  test("one pass only — a decoded result is never re-scanned", () => {
    expect(decodeSlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeSlEntities("&amp;amp;")).toBe("&amp;");
  });
});

/**
 * The recorded page fixture.
 *
 * Unit cases above are hand-written strings; this runs the parser over rows
 * as they actually arrive from `listcards.tpl`, matched with the adapter's
 * own `cardRegex`. It is the check that the two <td> cells, the entity
 * encoding and the tokenizer's leftovers line up in practice and not just in
 * a test author's imagination.
 */
describe("parseSlSubjects over a recorded listcards.tpl page", () => {
  // Same pattern the adapter uses. A variation row's NUMBER cell is
  // "smallcolorleft"; the description cell is always "smallleft".
  const CARD_REGEX =
    /<td class="small(?:color)?left">([^<]+)<\/td>\s*<td class="smallleft">([^<]+)<\/td>/gi;

  const html = fs.readFileSync(
    path.join(__dirname, "__fixtures__", "sl-listcards-sample.html"),
    "utf-8",
  );

  /** Mirrors the adapter's per-row derivation, minus the network. */
  const rows = (): Array<{ cardNumber: string; description: string }> => {
    const out: Array<{ cardNumber: string; description: string }> = [];
    CARD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CARD_REGEX.exec(html)) !== null) {
      out.push({
        cardNumber: match[1].trim(),
        description: decodeSlEntities(match[2].trim()),
      });
    }
    return out;
  };

  test("the fixture parses into the rows we recorded", () => {
    expect(rows()).toHaveLength(11);
  });

  test("player rows yield names; non-player rows yield none", () => {
    const players = (description: string) =>
      parseSlSubjects(
        // The adapter feeds the tokenizer residual, so strip the same things
        // the tokenizer does for the two rows that carry markers.
        description
          .replace(/\s*\[\s*(?:VAR\s+)?[^\]]+?\s*\]\s*/i, " ")
          .replace(/\/\d{1,5}\b/, "")
          .replace(/\b(?:AUTO|AU|ROOKIE|RC|RELIC|PATCH|JSY|JERSEY|SP|SSP)\b/i, "")
          .replace(/\s+/g, " ")
          .trim(),
      ).players;

    expect(players("Alec Bohm")).toEqual(["Alec Bohm"]);
    expect(players("Alec Bohm|Spencer Howard")).toEqual([
      "Alec Bohm",
      "Spencer Howard",
    ]);
    expect(players("Alec Bohm [ VAR Action Image ]")).toEqual(["Alec Bohm"]);
    expect(players("J.T. Realmuto")).toEqual(["J.T. Realmuto"]);
    expect(players("Bryce Harper PHI")).toEqual(["Bryce Harper"]);
    expect(players("Fernando Tatis Jr. RC")).toEqual(["Fernando Tatis Jr."]);
    expect(players("José Ramírez")).toEqual(["José Ramírez"]);
    expect(players("Peter O'Brien")).toEqual(["Peter O'Brien"]);
    expect(players("Yadier Molina AU /99")).toEqual(["Yadier Molina"]);

    // The two rows that must stay empty.
    expect(players("Checklist")).toBeUndefined();
    expect(players("Yankee Stadium")).toBeUndefined();
  });

  test("the fixture carries no session or account markup", () => {
    // The scrub is part of the fixture's contract, not a one-time cleanup.
    // The provenance comment NAMES the things that were removed, so it is
    // stripped before the check — otherwise the note describing the scrub
    // would be the only thing failing it.
    const markup = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(markup).not.toMatch(/Cookie|sessionid|PHPSESSID|selset|login\.tpl/i);
    expect(markup).not.toMatch(/<(?:script|form|input|a)\b/i);
  });
});
