import { describe, expect, test } from "vitest";
import { fakeNbClient, row } from "../lib/fake-nb-client";
import { pickExactlyOne, resolveSetPath, ResolveError, tryResolveSetPath } from "./resolve";

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
