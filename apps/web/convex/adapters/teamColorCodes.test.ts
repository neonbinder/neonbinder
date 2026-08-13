/**
 * NEO-147: unit tests for `convex/adapters/teamColorCodes.ts`.
 *
 * Pure functions plus a mocked global `fetch`, so like `espn.test.ts` this
 * needs no `convex-test` harness and lives beside its adapter.
 *
 * The HTML fixtures are trimmed from real pages fetched on 2026-08-13, with
 * their markup quirks preserved deliberately — the entity apostrophe in the
 * Seibu heading, the raw curly apostrophe and singular "Color" in Chiba
 * Lotte's, the "Primary Logo Colors" wording on UConn's, and the Brewers'
 * five historical sections. Those quirks are the reason the parser keys off
 * heading POSITION rather than heading text, so a fixture that tidied them up
 * would stop testing the thing most likely to break.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  colorSourceMatchKey,
  fetchTeamColorSourceIndex,
  fetchTeamColors,
  parseCurrentTeamColors,
  parseSitemapLocs,
  teamNameFromSourceUrl,
} from "./teamColorCodes";

afterEach(() => {
  vi.unstubAllGlobals();
});

function colorblock(hex: string, label = "Color"): string {
  return `<div class="colorblock" style="background-color: ${hex}; color: #000;">${label}<br>Hex COLOR: ${hex};</div>`;
}

function page(inner: string): string {
  return `<html><body><article><div class="entry-content" data-x="1">${inner}</div></article></body></html>`;
}

// ---------------------------------------------------------------------------
// colorSourceMatchKey
// ---------------------------------------------------------------------------

describe("colorSourceMatchKey", () => {
  test("strips the Set Builder sport suffix that college rows carry", () => {
    expect(colorSourceMatchKey("UConn Huskies baseball")).toBe("uconn huskies");
    expect(colorSourceMatchKey("Vassar College Brewers Softball")).toBe(
      "vassar college brewers",
    );
  });

  test("only strips a sport word at the END, never mid-name", () => {
    expect(colorSourceMatchKey("Baseball Ground Rovers")).toBe(
      "baseball ground rovers",
    );
  });

  test("normalizes apostrophes and punctuation", () => {
    expect(colorSourceMatchKey("Chiba Lotte Marines’")).toBe(
      "chiba lotte marines",
    );
    expect(colorSourceMatchKey("St. Cloud State  Huskies")).toBe(
      "st cloud state huskies",
    );
  });

  test("preserves word order — unlike teams.normalizeTeamName, which sorts", () => {
    expect(colorSourceMatchKey("Chiba Lotte Marines")).not.toBe(
      colorSourceMatchKey("Marines Lotte Chiba"),
    );
  });
});

// ---------------------------------------------------------------------------
// teamNameFromSourceUrl
// ---------------------------------------------------------------------------

describe("teamNameFromSourceUrl", () => {
  test("handles both live slug suffixes", () => {
    expect(
      teamNameFromSourceUrl("https://teamcolorcodes.com/milwaukee-brewers-color-codes/"),
    ).toBe("milwaukee brewers");
    // The suffix that makes slug construction impossible — see the adapter header.
    expect(
      teamNameFromSourceUrl("https://teamcolorcodes.com/connecticut-huskies-colors/"),
    ).toBe("connecticut huskies");
  });

  test("rejects non-team URLs found in the same sitemap", () => {
    expect(teamNameFromSourceUrl("https://teamcolorcodes.com/")).toBeNull();
    expect(
      teamNameFromSourceUrl("https://teamcolorcodes.com/some-page/deeper/"),
    ).toBeNull();
    expect(teamNameFromSourceUrl("https://example.com/fake-color-codes/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSitemapLocs
// ---------------------------------------------------------------------------

describe("parseSitemapLocs", () => {
  test("extracts locs regardless of surrounding whitespace", () => {
    const xml = `<urlset><url><loc>https://a.test/one/</loc></url><url>
      <loc>
        https://a.test/two/
      </loc></url></urlset>`;
    expect(parseSitemapLocs(xml)).toEqual([
      "https://a.test/one/",
      "https://a.test/two/",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseCurrentTeamColors — the historical-colors trap
// ---------------------------------------------------------------------------

describe("parseCurrentTeamColors", () => {
  test("takes only the current section when historical eras follow", () => {
    // Trimmed from the real Milwaukee Brewers page: 11 colorblocks across five
    // sections. Everything after the first heading boundary is a different era.
    const html = page(
      `<h2>Milwaukee Brewers Primary Colors</h2>
       ${colorblock("#ffc52f", "Yellow")}
       ${colorblock("#12284b", "Navy Blue")}
       <h3>Milwaukee Brewers Primary Logo Colors (2018 &#8211; 2019)</h3>
       ${colorblock("#0a2351")}${colorblock("#b6922e")}
       <h3>Milwaukee Brewers Alternate Colors</h3>
       ${colorblock("#0a2351")}${colorblock("#fed141")}
       <h3>Milwaukee Brewers Primary Logo Colors (2000 &#8211; 2017)</h3>
       ${colorblock("#13294b")}${colorblock("#85714d")}${colorblock("#7c2529")}
       <h3>Milwaukee Brewers Retro Logo Colors</h3>
       ${colorblock("#0046ae")}${colorblock("#ffd451")}`,
    );

    const result = parseCurrentTeamColors(html);

    expect(result).not.toBeNull();
    expect(result!.primary).toBe("#ffc52f");
    expect(result!.secondary).toBe("#12284b");
    // The retro palette must not leak in — labelling a binder in 1990s colors
    // is the specific failure this boundary rule exists to prevent.
    expect(result!.all).toEqual(["#ffc52f", "#12284b"]);
    expect(result!.all).not.toContain("#0046ae");
  });

  test("reads a heading carrying an HTML-entity apostrophe", () => {
    const html = page(
      `<h2>Saitama Seibu Lions&#8217; Primary Colors</h2>
       ${colorblock("#AB0008")}${colorblock("#01214B")}${colorblock("#FFFFFF")}
       <h2>Saitama Seibu Lions Pantone Color Codes</h2>`,
    );

    const result = parseCurrentTeamColors(html);

    expect(result!.heading).toBe("Saitama Seibu Lions' Primary Colors");
    // Hex is normalized to lowercase so stored values compare cleanly.
    expect(result!.all).toEqual(["#ab0008", "#01214b", "#ffffff"]);
  });

  test("keeps near-white out of the two stored slots but not out of `all`", () => {
    // Chiba Lotte Marines leads with silver then pure white. Storing
    // white-on-silver would print as a blank label.
    const html = page(
      `<h2>Chiba Lotte Marines’ Primary Color</h2>
       ${colorblock("#E5E1E6")}${colorblock("#FFFFFF")}${colorblock("#101820")}
       <h2>Chiba Lotte Marines Pantone Color Codes</h2>`,
    );

    const result = parseCurrentTeamColors(html);

    expect(result!.primary).toBe("#e5e1e6");
    expect(result!.secondary).toBe("#101820");
    expect(result!.all).toContain("#ffffff");
  });

  test("falls back to raw order when every color is near-white", () => {
    const html = page(
      `<h2>Blank Team Primary Colors</h2>${colorblock("#ffffff")}${colorblock("#fefefe")}`,
    );

    const result = parseCurrentTeamColors(html);

    expect(result!.primary).toBe("#ffffff");
    expect(result!.secondary).toBe("#fefefe");
  });

  test("expands three-digit hex", () => {
    const html = page(`<h2>Short Hex Colors</h2>${colorblock("#0a3")}`);
    expect(parseCurrentTeamColors(html)!.primary).toBe("#00aa33");
  });

  test("dedupes a color repeated within the current section", () => {
    const html = page(
      `<h2>Dupe Team Primary Colors</h2>${colorblock("#123456")}${colorblock("#123456")}`,
    );
    expect(parseCurrentTeamColors(html)!.all).toEqual(["#123456"]);
  });

  test("returns null when the first heading does not name colors", () => {
    // Page shape changed — a silent wrong answer is worse than none.
    const html = page(`<h2>Team Roster</h2>${colorblock("#123456")}`);
    expect(parseCurrentTeamColors(html)).toBeNull();
  });

  test("returns null when the section has no colorblocks", () => {
    const html = page(`<h2>Team Primary Colors</h2><p>Coming soon.</p><h2>Next</h2>`);
    expect(parseCurrentTeamColors(html)).toBeNull();
  });

  test("ignores colorblocks appearing before any heading", () => {
    const html = page(
      `${colorblock("#aaaaaa")}<h2>Team Primary Colors</h2>${colorblock("#bbbbbb")}<h2>Next</h2>`,
    );
    expect(parseCurrentTeamColors(html)!.all).toEqual(["#bbbbbb"]);
  });
});

// ---------------------------------------------------------------------------
// fetchTeamColorSourceIndex
// ---------------------------------------------------------------------------

describe("fetchTeamColorSourceIndex", () => {
  function stubSite(pages: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = pages[String(url)];
        if (body === undefined) {
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }
        return { ok: true, status: 200, text: async () => body } as unknown as Response;
      }),
    );
  }

  test("walks the index into every child sitemap and keeps only team pages", async () => {
    stubSite({
      "https://teamcolorcodes.com/wp-sitemap.xml": `<sitemapindex>
        <sitemap><loc>https://teamcolorcodes.com/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>https://teamcolorcodes.com/page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      "https://teamcolorcodes.com/post-sitemap.xml": `<urlset>
        <url><loc>https://teamcolorcodes.com/</loc></url>
        <url><loc>https://teamcolorcodes.com/milwaukee-brewers-color-codes/</loc></url>
        <url><loc>https://teamcolorcodes.com/connecticut-huskies-colors/</loc></url>
      </urlset>`,
      "https://teamcolorcodes.com/page-sitemap.xml": `<urlset>
        <url><loc>https://teamcolorcodes.com/saitama-seibu-lions-color-codes/</loc></url>
      </urlset>`,
    });

    const index = await fetchTeamColorSourceIndex();

    expect(index).toHaveLength(3);
    expect(index.map((e) => e.name)).toEqual([
      "milwaukee brewers",
      "connecticut huskies",
      "saitama seibu lions",
    ]);
  });

  test("never fetches the robots-disallowed search path", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "<sitemapindex></sitemapindex>",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTeamColorSourceIndex();

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/search/");
      expect(String(call[0])).not.toContain("?s=");
    }
  });

  test("returns empty rather than throwing when the index is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchTeamColorSourceIndex()).resolves.toEqual([]);
  });

  test("skips a child sitemap that fails without losing the others", async () => {
    stubSite({
      "https://teamcolorcodes.com/wp-sitemap.xml": `<sitemapindex>
        <sitemap><loc>https://teamcolorcodes.com/broken.xml</loc></sitemap>
        <sitemap><loc>https://teamcolorcodes.com/post-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
      "https://teamcolorcodes.com/post-sitemap.xml": `<urlset>
        <url><loc>https://teamcolorcodes.com/milwaukee-brewers-color-codes/</loc></url>
      </urlset>`,
    });

    const index = await fetchTeamColorSourceIndex();

    expect(index.map((e) => e.name)).toEqual(["milwaukee brewers"]);
  });
});

// ---------------------------------------------------------------------------
// fetchTeamColors
// ---------------------------------------------------------------------------

describe("fetchTeamColors", () => {
  test("returns null on a non-OK response instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "" } as unknown as Response)),
    );
    await expect(
      fetchTeamColors("https://teamcolorcodes.com/gone-color-codes/"),
    ).resolves.toBeNull();
  });

  test("parses a fetched page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          page(`<h2>Team Primary Colors</h2>${colorblock("#ab0008")}<h2>Next</h2>`),
      } as unknown as Response)),
    );

    const result = await fetchTeamColors(
      "https://teamcolorcodes.com/team-color-codes/",
    );

    expect(result!.primary).toBe("#ab0008");
  });

  test("identifies itself with a contactable User-Agent", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => page("<h2>Team Primary Colors</h2>"),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTeamColors("https://teamcolorcodes.com/team-color-codes/");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain(
      "neonbinder.io",
    );
  });
});
