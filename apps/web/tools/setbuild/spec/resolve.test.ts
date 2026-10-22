import { describe, expect, test } from "vitest";
import { fakeNbClient, row } from "../lib/fake-nb-client";
import { pickExactlyOne, resolveSetPath, resolveVariantRow, ResolveError, tryResolveSetPath } from "./resolve";

describe("pickExactlyOne", () => {
  const rows = [row("a", "setName", "Topps Chrome"), row("b", "setName", "Topps Chrome Update"), row("c", "setName", "Big League")];

  test("one row under the store's fold (case, surrounding space) resolves", () => {
    expect(pickExactlyOne(rows, "  topps chrome ", "set")._id).toBe("a");
  });

  test("no match is a ResolveError listing only near names", () => {
    try {
      pickExactlyOne(rows, "Chrome", "set", "steps[1].path.set");
      throw new Error("expected ResolveError");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolveError);
      const e = err as ResolveError;
      expect(e.at).toBe("steps[1].path.set");
      expect(e.candidates.map((c) => c.id).sort()).toEqual(["a", "b"]);
    }
  });

  test("two rows sharing a folded name: an exact spelling decides only when it is unique", () => {
    const twins = [row("x", "insert", "Anime"), row("y", "insert", "anime")];
    expect(pickExactlyOne(twins, "Anime", "row")._id).toBe("x");
    const sameSpelling = [row("x", "insert", "Anime"), row("y", "insert", "Anime")];
    expect(() => pickExactlyOne(sameSpelling, "Anime", "row")).toThrow(/matches 2/);
  });

  test("never picks by position", () => {
    const dupes = [row("1", "sport", "Baseball"), row("2", "sport", "BASEBALL")];
    expect(() => pickExactlyOne(dupes, "baseball", "sport")).toThrow(ResolveError);
  });
});

describe("resolveSetPath", () => {
  const client = () =>
    fakeNbClient({
      "selectorOptions:getSelectorOptions": (a) => {
        const byParent: Record<string, ReturnType<typeof row>[]> = {
          "sport:root": [row("s1", "sport", "Baseball"), row("s2", "sport", "Football")],
          "year:s1": [row("y1", "year", "2024")],
          "manufacturer:y1": [row("m1", "manufacturer", "Topps")],
          "setName:m1": [row("t1", "setName", "Topps Chrome"), row("t2", "setName", "Topps Chrome")],
        };
        return byParent[`${a.level}:${(a.parentId as string) ?? "root"}`] ?? [];
      },
    });

  test("walks each level under the row above it", async () => {
    const c = client();
    const r = await tryResolveSetPath(c, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Big League" }, "steps[0].path");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.at).toBe("steps[0].path.set");
      expect(r.error.candidates).toEqual([]);
    }
    expect(c.callsTo("selectorOptions:getSelectorOptions").map((x) => x.args.parentId)).toEqual([undefined, "s1", "y1", "m1"]);
  });

  test("an ambiguous set is a ResolveError with both candidates", async () => {
    await expect(
      resolveSetPath(client(), { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" }),
    ).rejects.toMatchObject({ name: "ResolveError", candidates: [{ id: "t1" }, { id: "t2" }] });
  });
});

/** The ResolveError a lookup threw; a lookup that resolved fails the test. */
async function refusal(p: Promise<unknown>): Promise<ResolveError> {
  try {
    await p;
  } catch (err) {
    return err as ResolveError;
  }
  throw new Error("expected a ResolveError");
}

describe("resolveVariantRow: a row Group Parallels grouped keeps its own name (NEO-339, 2023 Topps Chrome)", () => {
  // "Future Stars Autographs" was nested under "Future Stars" as a parallel.
  const client = (extraInserts: ReturnType<typeof row>[] = [], extraParallels: ReturnType<typeof row>[] = []) =>
    fakeNbClient({
      "selectorOptions:getSelectorOptions": (a) =>
        a.level === "insert" && a.parentId === "vt" ? [row("fs", "insert", "Future Stars"), row("rr", "insert", "Radiating Rookies"), ...extraInserts] : [],
      "selectorOptions:getInsertTreeByVariantType": () => [
        { insert: row("fs", "insert", "Future Stars"), parallels: [row("fsa", "parallel", "Future Stars Autographs"), ...extraParallels] },
        { insert: row("rr", "insert", "Radiating Rookies"), parallels: [] },
      ],
    });

  test("the grouped row resolves by its own name, not to the parent its name begins with", async () => {
    expect((await resolveVariantRow(client(), "vt" as never, "future stars autographs", "steps[0].variants[0].rows[1].name"))._id).toBe("fsa");
  });

  test("a top-level row answers first, without reading the tree", async () => {
    const c = client();
    expect((await resolveVariantRow(c, "vt" as never, "Future Stars"))._id).toBe("fs");
    expect(c.callsTo("selectorOptions:getInsertTreeByVariantType")).toEqual([]);
  });

  test("two grouped rows with the name are asked, each named with its parent", async () => {
    const c = fakeNbClient({
      "selectorOptions:getSelectorOptions": () => [row("a", "insert", "Stars"), row("b", "insert", "Rookies")],
      "selectorOptions:getInsertTreeByVariantType": () => [
        { insert: row("a", "insert", "Stars"), parallels: [row("g1", "parallel", "Gold")] },
        { insert: row("b", "insert", "Rookies"), parallels: [row("g2", "parallel", "Gold")] },
      ],
    });
    const err = await refusal(resolveVariantRow(c, "vt" as never, "Gold"));
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.message).toBe('"Gold" matches 2 rows; name exactly one.');
    expect(err.candidates).toEqual([
      { id: "g1", name: "Gold", detail: "parallel of Stars" },
      { id: "g2", name: "Gold", detail: "parallel of Rookies" },
    ]);
  });

  test("no match says so: near names are listed as candidates, never reported as matches", async () => {
    const err = await refusal(resolveVariantRow(client(), "vt" as never, "Future Stars Autos"));
    expect(err).toBeInstanceOf(ResolveError);
    expect(err.message).toBe('No row named "Future Stars Autos"; 1 similar name is listed as a candidate.');
    expect(err.candidates).toEqual([{ id: "fs", name: "Future Stars", detail: "insert" }]);
  });
});
