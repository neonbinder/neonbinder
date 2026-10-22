/**
 * NEO-339 — the Set Builder deep link: the page's own drill query string
 * (sport/year/brand/set/type/insert/parallel, NB ids, root first), absolute on
 * the app origin when the tool was given one and root-relative otherwise.
 */
import { describe, expect, test } from "vitest";
import { fakeClient, FAKE_TARGET } from "../runner/fake-client";
import { drillPathOf, SET_BUILDER_ROUTE, setBuilderLink, setBuilderUrl } from "./set-builder-link";

const step = (_id: string, level: string) => ({ _id: _id as never, level: level as never });

/** 2024 › Topps › Topps Chrome › Insert › Future Stars › Future Stars Gold. */
const TO_PARALLEL = [
  step("sp", "sport"),
  step("yr", "year"),
  step("mf", "manufacturer"),
  step("st", "setName"),
  step("vtI", "variantType"),
  step("iFS", "insert"),
  step("fsG", "parallel"),
];
const TO_INSERT = TO_PARALLEL.slice(0, 6);

describe("setBuilderUrl", () => {
  test("a parallel row: every level, in the page's own param names and order", () => {
    expect(setBuilderUrl(TO_PARALLEL)).toBe(
      "/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtI&insert=iFS&parallel=fsG",
    );
  });

  test("an insert row (a Parallel type's row, a checklist under an Insert type): stops at insert", () => {
    expect(setBuilderUrl(TO_INSERT)).toBe("/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtI&insert=iFS");
  });

  test("absolute on the app origin when there is one; any path on it is dropped", () => {
    expect(setBuilderUrl(TO_INSERT, "https://app.example.test")).toBe(
      "https://app.example.test/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtI&insert=iFS",
    );
    expect(setBuilderUrl(TO_INSERT.slice(0, 4), "http://localhost:3001")).toBe(
      "http://localhost:3001/admin/set-builder?sport=sp&year=yr&brand=mf&set=st",
    );
  });

  test("no origin: root-relative, so it opens on whatever host the operator pastes it after", () => {
    expect(setBuilderUrl(TO_PARALLEL, undefined).startsWith(`${SET_BUILDER_ROUTE}?`)).toBe(true);
    expect(setBuilderUrl([])).toBe(SET_BUILDER_ROUTE);
  });

  test("a chain that breaks off links to the deepest point that holds", () => {
    // A set straight under a year: nothing past the year is where the cascade would show it.
    expect(drillPathOf([step("sp", "sport"), step("yr", "year"), step("st", "setName")])).toEqual(["sp", "yr"]);
    expect(drillPathOf([step("yr", "year")])).toEqual([]);
  });
});

describe("setBuilderLink", () => {
  test("reads the row's ancestor chain and links to the row itself, on the target's app origin", async () => {
    const client = fakeClient().on("selectorOptions:getAncestorChain", TO_PARALLEL);
    Object.assign(client, { target: { ...FAKE_TARGET, appOrigin: "https://app.example.test" } });
    await expect(setBuilderLink(client, "fsG" as never)).resolves.toBe(
      "https://app.example.test/admin/set-builder?sport=sp&year=yr&brand=mf&set=st&type=vtI&insert=iFS&parallel=fsG",
    );
    expect(client.callsTo("selectorOptions:getAncestorChain").map((c) => c.args)).toEqual([{ id: "fsG" }]);
  });

  test("a chain that cannot be read never costs the message: the link opens the Set Builder", async () => {
    const client = fakeClient().on("selectorOptions:getAncestorChain", () => {
      throw new Error("Not authorized");
    });
    await expect(setBuilderLink(client, "fsG" as never)).resolves.toBe(SET_BUILDER_ROUTE);
  });
});
