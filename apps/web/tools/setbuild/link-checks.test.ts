/**
 * NEO-339 — the link assertions the two smoke harnesses share, on their own:
 * form, origin, depth, and "the page's resolver opens it".
 */

import { describe, expect, test, vi } from "vitest";
import { parseDrillLink, inspectLinkProblems, linkProblems, setLinkProblems, SET_DEPTH } from "./link-checks";
import { APP, CHAIN, knownResolver, linkAt, SET_LINK, SET_LINK_ABS } from "./link-checks.fixture";
import type { InspectReport } from "./service";

const resolve = knownResolver();

describe("parseDrillLink", () => {
  test("reads the ids in the page's level order, root first", () => {
    expect(parseDrillLink(linkAt(7))).toEqual({ ids: [...CHAIN] });
  });

  test.each([
    ["no link", undefined, /no link/],
    ["an empty string", "", /no link/],
    ["another route", "/admin/players?sport=sp1", /not the Set Builder/],
    ["the Set Builder root", "/admin/set-builder", /at its root/],
    ["a stray key", "/admin/set-builder?sport=sp1&utm=x", /utm, which is not a drill key/],
    ["a repeated key", "/admin/set-builder?sport=a&sport=b", /repeats sport/],
    ["an empty value", "/admin/set-builder?sport=", /empty sport/],
    ["a skipped level", "/admin/set-builder?sport=a&brand=c", /skips a level/],
    ["an absolute link when no origin was given", SET_LINK_ABS, /absolute but no app origin/],
  ])("%s is refused", (_n, link, why) => {
    expect(parseDrillLink(link)).toEqual({ problem: expect.stringMatching(why) });
  });

  test("with an app origin: relative and foreign-origin links are refused, its own are read", () => {
    expect(parseDrillLink(SET_LINK, APP)).toEqual({ problem: expect.stringMatching(/not absolute/) });
    expect(parseDrillLink(SET_LINK_ABS.replace(APP, "https://other.example.test"), APP)).toEqual({
      problem: expect.stringMatching(/not on the app origin/),
    });
    expect(parseDrillLink(SET_LINK_ABS, APP)).toEqual({ ids: CHAIN.slice(0, 4) });
  });
});

describe("linkProblems", () => {
  test("a link whose ids the resolver answers in full has no problem", async () => {
    expect(await linkProblems("x", linkAt(5), { resolve })).toEqual([]);
  });

  test("depth pins how many ids a set link carries", async () => {
    expect(await linkProblems("set", linkAt(5), { resolve, depth: SET_DEPTH })).toEqual(["set: the link is 5 ids deep, expected 4"]);
  });

  test("a resolver that stops early means the link does not open the row", async () => {
    expect(await linkProblems("x", linkAt(5), { resolve: knownResolver(CHAIN.slice(0, 2)) })).toEqual([
      "x: resolveDrillPath answered 2 of 5 levels, so the link does not open the row",
    ]);
  });

  test("a resolver that answers another row is caught", async () => {
    const swapped = async (ids: string[]) => ids.map((_, i) => ({ _id: i === 2 ? "other" : ids[i], level: "x" }));
    expect(await linkProblems("x", linkAt(4), { resolve: swapped })).toEqual(["x: resolveDrillPath answered another row at manufacturer"]);
  });

  test("a resolver that throws is a problem, not an exception", async () => {
    const boom = async () => {
      throw new Error("Unauthenticated");
    };
    expect(await linkProblems("x", linkAt(4), { resolve: boom })).toEqual(["x: resolveDrillPath failed (Unauthenticated)"]);
  });

  test("hands the resolver exactly the ids in the link", async () => {
    const spy = vi.fn(resolve);
    await linkProblems("x", linkAt(6), { resolve: spy });
    expect(spy).toHaveBeenCalledWith([...CHAIN.slice(0, 6)]);
  });
});

describe("setLinkProblems", () => {
  test("no setLinks at all is a problem", async () => {
    expect(await setLinkProblems(undefined, { resolve })).toEqual(["the report has no setLinks, though the run touched a set"]);
    expect(await setLinkProblems([], { resolve })).toEqual(["the report has no setLinks, though the run touched a set"]);
  });

  test("each set link must be a set", async () => {
    expect(await setLinkProblems([{ path: "A/B", link: SET_LINK }], { resolve })).toEqual([]);
    expect(await setLinkProblems([{ path: "A/B", link: linkAt(2) }], { resolve })).toEqual(['setLinks "A/B": the link is 2 ids deep, expected 4']);
  });
});

describe("inspectLinkProblems", () => {
  const row = (name: string, link: string) => ({ name, cards: 1, isBase: false, links: { buysportscards: [], sportlots: [] }, link });
  const setReport = (over: Partial<InspectReport> = {}): InspectReport => ({
    target: { convexUrl: "", host: "" },
    path: { sport: "B", year: "2024", manufacturer: "T", set: "C" },
    pathText: "B/2024/T/C",
    found: true,
    link: SET_LINK,
    base: row("Base", linkAt(5)),
    variantTypes: [
      { type: "Base", link: linkAt(5), rows: [row("Base", linkAt(5))] },
      { type: "Parallel", link: linkAt(5), rows: [{ ...row("Gold", linkAt(6)), parallels: [row("Gold Refractor", linkAt(7))] }] },
    ],
    ...over,
  });

  test("a fully linked set report has no problem, and each distinct link is resolved once", async () => {
    const spy = vi.fn(resolve);
    expect(await inspectLinkProblems(setReport(), { resolve: spy })).toEqual([]);
    // SET_LINK, linkAt(5), linkAt(6), linkAt(7).
    expect(spy).toHaveBeenCalledTimes(4);
  });

  test("a not-found report has nothing to check", async () => {
    expect(await inspectLinkProblems(setReport({ found: false }), { resolve })).toEqual([]);
  });

  test("a set report without its own link is a problem", async () => {
    expect(await inspectLinkProblems(setReport({ link: undefined }), { resolve })).toContain("the set report has no link of its own");
  });

  test("a bad link on a parallel under an insert is found and named", async () => {
    const bad = setReport();
    bad.variantTypes![1].rows[0].parallels![0].link = "/admin/set-builder";
    expect(await inspectLinkProblems(bad, { resolve })).toEqual([
      'Parallel › Gold › Gold Refractor link: "/admin/set-builder" opens the Set Builder at its root, not at the row',
    ]);
  });

  test("a brand-year report's set links are checked too", async () => {
    const brand: InspectReport = {
      target: { convexUrl: "", host: "" },
      path: { sport: "B", year: "2024", manufacturer: "T" },
      pathText: "B/2024/T",
      found: true,
      link: linkAt(3),
      sets: [{ name: "C", links: { buysportscards: [], sportlots: [] }, link: "/nope" }],
    };
    expect(await inspectLinkProblems(brand, { resolve })).toEqual([expect.stringContaining('set "C" link')]);
  });

  test("a long list of problems is capped", async () => {
    const bad = setReport();
    bad.variantTypes![1].rows = Array.from({ length: 12 }, (_, i) => row(`R${i}`, `/nope?${i}`));
    const out = await inspectLinkProblems(bad, { resolve });
    expect(out).toHaveLength(9);
    expect(out.at(-1)).toMatch(/\+4 more link problems/);
  });
});
