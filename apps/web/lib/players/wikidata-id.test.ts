/**
 * NEO-212 security review — the Wikidata id chokepoint.
 *
 * The finding these cases pin: two render sites interpolated a STORED
 * `externalIds.wikidataId` directly into an anchor `href` with no validation,
 * and that value is not necessarily operator-typed — it can arrive from the
 * SPARQL adapter or from a row written before `savePlayerFields` validated
 * anything. React warns on a `javascript:` href and renders it anyway, so the
 * check has to happen before the URL is built.
 *
 * So the cases below are mostly about what `wikidataUrl` REFUSES. A test that
 * only proved `Q303` round-trips would have passed before the fix too.
 */

import { describe, expect, it } from "vitest";
import {
  WIKIDATA_QID,
  isWikidataQid,
  wikidataUrl,
  wikipediaUrl,
} from "./wikidata-id";

describe("isWikidataQid", () => {
  it("accepts a bare Q-id", () => {
    expect(isWikidataQid("Q303")).toBe(true);
    expect(isWikidataQid("Q1")).toBe(true);
    expect(isWikidataQid("Q313256")).toBe(true);
  });

  it("rejects anything that is not exactly Q followed by digits", () => {
    for (const bad of [
      "",
      "Q",
      "303",
      "q303",
      "Q303x",
      "Q 303",
      "Q-303",
      "P31",
      "Q303\n",
    ]) {
      expect(isWikidataQid(bad)).toBe(false);
    }
  });

  it("rejects a value with surrounding whitespace rather than trimming it", () => {
    // Deliberate: trimming here would put the untrimmed value into a URL at
    // every call site that passes the original string on. The editor trims
    // BEFORE asking; nothing else should.
    expect(isWikidataQid(" Q303")).toBe(false);
    expect(isWikidataQid("Q303 ")).toBe(false);
  });

  it("rejects non-strings, so it can guard a value read off a document", () => {
    for (const bad of [undefined, null, 303, {}, ["Q303"]]) {
      expect(isWikidataQid(bad)).toBe(false);
    }
  });

  it("answers the same on repeat calls (the regex carries no lastIndex)", () => {
    // A `g`-flagged regex would alternate true/false here. That is the exact
    // bug an un-anchored, globally-flagged copy of this pattern would ship.
    expect(WIKIDATA_QID.global).toBe(false);
    expect(isWikidataQid("Q303")).toBe(true);
    expect(isWikidataQid("Q303")).toBe(true);
  });
});

describe("wikidataUrl", () => {
  it("builds the canonical record URL for a valid id", () => {
    expect(wikidataUrl("Q303")).toBe("https://www.wikidata.org/wiki/Q303");
  });

  it("returns null for a script-scheme payload rather than a URL", () => {
    // The whole reason this module exists. Before it, this string reached an
    // anchor's href verbatim.
    expect(wikidataUrl("javascript:alert(1)")).toBeNull();
    expect(wikidataUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("returns null for a path-traversal or absolute-URL attempt", () => {
    expect(wikidataUrl("../../evil")).toBeNull();
    expect(wikidataUrl("https://evil.example/Q303")).toBeNull();
    expect(wikidataUrl("Q303/../../evil")).toBeNull();
  });

  it("returns null for an absent id", () => {
    expect(wikidataUrl(undefined)).toBeNull();
    expect(wikidataUrl(null)).toBeNull();
    expect(wikidataUrl("")).toBeNull();
  });
});

describe("wikipediaUrl", () => {
  it("underscores spaces", () => {
    expect(wikipediaUrl("Mike Trout")).toBe(
      "https://en.wikipedia.org/wiki/Mike_Trout",
    );
  });

  it("percent-encodes accents and leaves parentheses alone", () => {
    expect(wikipediaUrl("José Ramírez (baseball)")).toBe(
      "https://en.wikipedia.org/wiki/Jos%C3%A9_Ram%C3%ADrez_(baseball)",
    );
  });

  it("trims before encoding, so a padded title is not encoded as %20", () => {
    expect(wikipediaUrl("  Mike Trout  ")).toBe(
      "https://en.wikipedia.org/wiki/Mike_Trout",
    );
  });

  it("cannot produce a script scheme, because the colon is encoded", () => {
    // A title has no validatable shape, so this one escapes rather than
    // validates. Encoding the colon is what makes the result a path segment
    // under the https origin instead of a new scheme.
    const url = wikipediaUrl("javascript:alert(1)");
    expect(url.startsWith("https://en.wikipedia.org/wiki/")).toBe(true);
    expect(url).not.toContain("javascript:");
    expect(url).toContain("javascript%3A");
  });
});
