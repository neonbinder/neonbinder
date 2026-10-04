/**
 * NEO-224 — the set builder's drill in the URL.
 *
 * Two halves. The pure helpers (`parseDrillParams`, `canonicalPrefix`,
 * `serializeDrillPath`) are pinned directly. The hook is driven under a real
 * `MemoryRouter` with `resolveDrillPath` mocked at the `convex/react` boundary
 * (`mockResolver`), so navigation type (push vs replace), navigation COUNT and
 * Back/Forward are the router's own, not a stub of it.
 *
 * The trusted-id gate is the thing the page's safety rests on: an id the
 * operator picked never goes to the resolver, and an id pasted into the
 * address bar always does, and the cascade shows nothing (`resolving`) until
 * it answers.
 */

import { act, render } from "@testing-library/react";
import React from "react";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { drillPath: { resolveDrillPath: "resolveDrillPath" } },
}));

/** Every resolver call that was NOT skipped, in order, and its answer. */
const resolverCalls: Array<{ ids: string[] }> = [];
/**
 * What the mocked resolver answers: `undefined` = still loading, otherwise a
 * function from the asked ids to the answer.
 */
let mockResolver:
  | ((ids: string[]) => Array<{ _id: string }>)
  | undefined;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref !== "resolveDrillPath" || args === "skip") return undefined;
    const { ids } = args as { ids: string[] };
    resolverCalls.push({ ids });
    return mockResolver ? mockResolver(ids) : undefined;
  },
}));

import { ALL_BRANDS_VIEW } from "./all-brands-view";
import {
  canonicalPrefix,
  parseDrillParams,
  serializeDrillPath,
  useDrillUrlState,
  type DrillUrlState,
} from "./useDrillUrlState";

/** The resolver that says every asked id is real. */
const allValid = (ids: string[]) => ids.map((_id) => ({ _id }));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseDrillParams", () => {
  it("reads one value per level, root first, null where absent", () => {
    const params = new URLSearchParams("sport=a&year=b&set=d");
    expect(parseDrillParams(params)).toEqual(["a", "b", null, "d", null, null, null]);
  });

  it("reads the short key for each level", () => {
    const params = new URLSearchParams(
      "sport=1&year=2&brand=3&set=4&type=5&insert=6&parallel=7",
    );
    expect(parseDrillParams(params)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("treats an empty or whitespace-only value as absent and trims the rest", () => {
    const params = new URLSearchParams("sport=%20a%20&year=&brand=%20%20");
    expect(parseDrillParams(params)).toEqual(["a", null, null, null, null, null, null]);
  });
});

describe("canonicalPrefix", () => {
  it("keeps a contiguous run from the root", () => {
    expect(canonicalPrefix(["a", "b", "c", null, null, null, null])).toEqual({
      path: ["a", "b", "c"],
      dropped: false,
    });
  });

  it("stops at the first hole and says it dropped what came after", () => {
    // A set with no brand hangs off nothing.
    expect(canonicalPrefix(["a", "b", null, "d", null, null, null])).toEqual({
      path: ["a", "b"],
      dropped: true,
    });
  });

  it("an empty drill is an empty path, not a drop", () => {
    expect(canonicalPrefix([null, null, null, null, null, null, null])).toEqual({
      path: [],
      dropped: false,
    });
  });

  it("drops a value past 128 characters and everything after it", () => {
    expect(canonicalPrefix(["a", "x".repeat(129), "c"])).toEqual({
      path: ["a"],
      dropped: true,
    });
    expect(canonicalPrefix(["a", "x".repeat(128), "c"]).path).toHaveLength(3);
  });

  it("allows brand=all at the brand position when nothing sits below it", () => {
    expect(canonicalPrefix(["a", "b", "all", null, null, null, null])).toEqual({
      path: ["a", "b", "all"],
      dropped: false,
    });
  });

  it("cuts a set (or anything) written below brand=all", () => {
    expect(canonicalPrefix(["a", "b", "all", "d", null, null, null])).toEqual({
      path: ["a", "b", "all"],
      dropped: true,
    });
  });

  it("refuses 'all' in any slot but the brand's", () => {
    expect(canonicalPrefix(["all", "b"])).toEqual({ path: [], dropped: true });
    expect(canonicalPrefix(["a", "all"])).toEqual({ path: ["a"], dropped: true });
    expect(canonicalPrefix(["a", "b", "c", "all"])).toEqual({
      path: ["a", "b", "c"],
      dropped: true,
    });
  });
});

describe("serializeDrillPath", () => {
  it("writes the keys in canonical order whatever order the base had", () => {
    const base = new URLSearchParams("parallel=zz&year=old&sport=old");
    const out = serializeDrillPath(["s", "y"], base);
    expect(out.toString()).toBe("sport=s&year=y");
  });

  it("clears a stale deeper level the new path does not reach", () => {
    const base = new URLSearchParams("sport=s&year=y&brand=b&set=d");
    expect(serializeDrillPath(["s"], base).toString()).toBe("sport=s");
  });

  it("keeps parameters that are not the drill's", () => {
    const base = new URLSearchParams("utm=1&sport=s&ref=x");
    const out = serializeDrillPath(["s", "y"], base);
    expect(out.get("utm")).toBe("1");
    expect(out.get("ref")).toBe("x");
    expect(out.get("year")).toBe("y");
  });

  it("does not mutate the params it was handed", () => {
    const base = new URLSearchParams("sport=s&year=y");
    serializeDrillPath([], base);
    expect(base.toString()).toBe("sport=s&year=y");
  });

  it("an empty path with no base is an empty query", () => {
    expect(serializeDrillPath([]).toString()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The hook, under a real router
// ---------------------------------------------------------------------------

type Visit = { search: string; type: string; key: string };

type Harness = {
  state: () => DrillUrlState;
  /** One entry per committed location, in order, with how it was reached. */
  visits: Visit[];
  search: () => string;
  navigate: (to: number | string) => void;
};

function mount(initial: string): Harness {
  const visits: Visit[] = [];
  const box: { state?: DrillUrlState; navigate?: (n: number | string) => void } = {};
  function Probe() {
    const location = useLocation();
    const type = useNavigationType();
    const navigate = useNavigate();
    box.navigate = (n) => navigate(n as never);
    React.useEffect(() => {
      visits.push({ search: location.search, type, key: location.key });
    }, [location, type]);
    return null;
  }
  function Hook() {
    box.state = useDrillUrlState();
    return null;
  }
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Probe />
      <Hook />
    </MemoryRouter>,
  );
  return {
    state: () => box.state!,
    visits,
    search: () => visits[visits.length - 1].search,
    navigate: (n) => box.navigate!(n),
  };
}

/** Run `fn` and report how many NEW locations the router committed. */
async function navigationsDuring(h: Harness, fn: () => void): Promise<number> {
  const before = h.visits.length;
  await act(async () => {
    fn();
  });
  return h.visits.length - before;
}

const paramsOf = (search: string) => new URLSearchParams(search);

beforeEach(() => {
  resolverCalls.length = 0;
  mockResolver = allValid;
});

describe("useDrillUrlState — the trusted-id gate", () => {
  it("an empty URL is not resolved: nothing is asked and the selection is empty", () => {
    const h = mount("/");
    expect(h.state().resolving).toBe(false);
    expect(resolverCalls).toHaveLength(0);
    expect(h.state().selection).toEqual({
      sportId: null,
      yearId: null,
      manufacturer: null,
      setId: null,
      variantTypeId: null,
      insertId: null,
      parallelId: null,
    });
  });

  it("a self-written path skips the resolver entirely", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", "br"));

    expect(resolverCalls).toHaveLength(0);
    expect(h.state().resolving).toBe(false);
    expect(h.state().selection.manufacturer).toBe("br");
  });

  it("a pasted path asks the resolver first, and the cascade is resolving with no selection", () => {
    mockResolver = undefined; // still loading
    const h = mount("/?sport=sp&year=yr&brand=br");

    expect(resolverCalls.at(-1)).toEqual({ ids: ["sp", "yr", "br"] });
    expect(h.state().resolving).toBe(true);
    // Nothing from the URL leaks to a column query before the answer.
    expect(h.state().selection.sportId).toBeNull();
    expect(h.state().selection.yearId).toBeNull();
  });

  it("opens the restored selection once the resolver answers", async () => {
    mockResolver = allValid;
    const h = mount("/?sport=sp&year=yr&brand=br");
    await act(async () => {});

    expect(h.state().resolving).toBe(false);
    expect(h.state().selection).toMatchObject({
      sportId: "sp",
      yearId: "yr",
      manufacturer: "br",
    });
    expect(h.state().truncatedOnLoad).toBe(false);
  });

  it("once the resolver vouched for a path, later renders do not ask again", async () => {
    const h = mount("/?sport=sp&year=yr");
    await act(async () => {});
    const askedBefore = resolverCalls.length;
    // Same chain, new pick below it: trusted parents, so no new question.
    await act(async () => h.state().select("manufacturer", "br"));
    expect(resolverCalls.length).toBe(askedBefore);
  });

  it("an id typed into the address bar after a pick is checked, not trusted", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    expect(resolverCalls).toHaveLength(0);

    // Same sport, a year nobody picked: that is a typed URL, whatever the
    // router calls the navigation.
    mockResolver = (ids) => allValid(ids.slice(0, 1));
    await act(async () => h.navigate("/?sport=sp&year=typed"));

    expect(resolverCalls.at(-1)).toEqual({ ids: ["sp", "typed"] });
    expect(h.state().selection.yearId).toBeNull();
    expect(h.state().truncatedOnLoad).toBe(true);
  });

  it("trust is per chain: a trusted id under a different parent is asked about again", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    expect(resolverCalls).toHaveLength(0);

    await act(async () => h.navigate("/?sport=other&year=yr"));
    expect(resolverCalls.at(-1)).toEqual({ ids: ["other", "yr"] });
  });
});

describe("useDrillUrlState — a pasted path the server cuts short", () => {
  it("rewrites the URL to the valid prefix with replace and says so", async () => {
    mockResolver = (ids) => allValid(ids.slice(0, 2));
    const h = mount("/?sport=sp&year=yr&brand=gone&set=orphan");
    await act(async () => {});

    expect(h.state().truncatedOnLoad).toBe(true);
    expect(paramsOf(h.search()).toString()).toBe("sport=sp&year=yr");
    expect(h.visits.at(-1)!.type).toBe("REPLACE");
    // The first location, then ONE rewrite: not a pile of them.
    expect(h.visits).toHaveLength(2);
    expect(h.state().selection).toMatchObject({ sportId: "sp", yearId: "yr", manufacturer: null });
  });

  it("an answer of nothing leaves an empty cascade and an empty query", async () => {
    mockResolver = () => [];
    const h = mount("/?sport=nope&year=nada");
    await act(async () => {});

    expect(h.state().truncatedOnLoad).toBe(true);
    expect(h.search()).toBe("");
    expect(h.state().selection.sportId).toBeNull();
  });

  it("the notice clears on the next pick", async () => {
    mockResolver = () => [];
    const h = mount("/?sport=nope");
    await act(async () => {});
    expect(h.state().truncatedOnLoad).toBe(true);

    await act(async () => h.state().select("sport", "sp"));
    expect(h.state().truncatedOnLoad).toBe(false);
  });

  it("a valid link does not raise the notice", async () => {
    const h = mount("/?sport=sp&year=yr");
    await act(async () => {});
    expect(h.state().truncatedOnLoad).toBe(false);
  });

  it("a URL out of canonical order is put right with replace and is not a truncation", async () => {
    const h = mount("/?year=yr&sport=sp");
    await act(async () => {});

    expect(paramsOf(h.search()).toString()).toBe("sport=sp&year=yr");
    expect(h.visits.at(-1)!.type).toBe("REPLACE");
    expect(h.state().truncatedOnLoad).toBe(false);
  });

  it("a value with a hole above it is dropped and reported (set with no brand)", async () => {
    const h = mount("/?sport=sp&year=yr&set=orphan");
    await act(async () => {});

    expect(h.search()).toBe("?sport=sp&year=yr");
    expect(h.state().truncatedOnLoad).toBe(true);
  });
});

describe("useDrillUrlState — brand=all", () => {
  it("is never sent to the server", async () => {
    mockResolver = allValid;
    mount("/?sport=sp&year=yr&brand=all");
    await act(async () => {});

    expect(resolverCalls.length).toBeGreaterThan(0);
    for (const call of resolverCalls) expect(call.ids).not.toContain("all");
    expect(resolverCalls.at(-1)).toEqual({ ids: ["sp", "yr"] });
  });

  it("restores the All Brands view when everything above it checked out", async () => {
    const h = mount("/?sport=sp&year=yr&brand=all");
    await act(async () => {});

    expect(h.state().selection.manufacturer).toBe(ALL_BRANDS_VIEW);
    expect(h.search()).toBe("?sport=sp&year=yr&brand=all");
    expect(h.state().truncatedOnLoad).toBe(false);
  });

  it("loses the view when the year above it did not check out", async () => {
    mockResolver = (ids) => allValid(ids.slice(0, 1));
    const h = mount("/?sport=sp&year=bad&brand=all");
    await act(async () => {});

    expect(h.state().selection.manufacturer).toBeNull();
    expect(h.search()).toBe("?sport=sp");
    expect(h.state().truncatedOnLoad).toBe(true);
  });

  it("is only valid with nothing below it: a set under it is cut, the view kept", async () => {
    const h = mount("/?sport=sp&year=yr&brand=all&set=s1");
    await act(async () => {});

    expect(h.state().selection.manufacturer).toBe(ALL_BRANDS_VIEW);
    expect(h.state().selection.setId).toBeNull();
    expect(h.search()).toBe("?sport=sp&year=yr&brand=all");
    expect(h.state().truncatedOnLoad).toBe(true);
    expect(resolverCalls.at(-1)!.ids).toEqual(["sp", "yr"]);
  });

  it("picking the view writes brand=all, and no resolver call follows", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", ALL_BRANDS_VIEW));

    expect(h.search()).toBe("?sport=sp&year=yr&brand=all");
    expect(h.state().selection.manufacturer).toBe(ALL_BRANDS_VIEW);
    expect(resolverCalls).toHaveLength(0);
  });

  it("a set picked in the view back-fills the brand from its parent in ONE push", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", ALL_BRANDS_VIEW));

    const count = await navigationsDuring(h, () => h.state().selectSetUnder("br", "s1"));

    expect(count).toBe(1);
    expect(h.visits.at(-1)!.type).toBe("PUSH");
    expect(h.search()).toBe("?sport=sp&year=yr&brand=br&set=s1");
    expect(h.state().selection.manufacturer).toBe("br");
    expect(resolverCalls).toHaveLength(0);
  });
});

describe("useDrillUrlState — push for picks, replace for corrections", () => {
  async function drilled(): Promise<Harness> {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", "br"));
    await act(async () => h.state().select("setName", "s1"));
    await act(async () => h.state().select("variantType", "vt"));
    return h;
  }

  it("an operator's pick is a push, one navigation", async () => {
    const h = mount("/");
    const n = await navigationsDuring(h, () => h.state().select("sport", "sp"));
    expect(n).toBe(1);
    expect(h.visits.at(-1)!.type).toBe("PUSH");
    expect(h.search()).toBe("?sport=sp");
  });

  it("a pick sets its level and clears everything deeper in the same single write", async () => {
    const h = await drilled();
    const n = await navigationsDuring(h, () => h.state().select("year", "yr2"));

    expect(n).toBe(1);
    expect(h.search()).toBe("?sport=sp&year=yr2");
    expect(h.state().selection).toMatchObject({
      yearId: "yr2",
      manufacturer: null,
      setId: null,
      variantTypeId: null,
    });
  });

  it("clearFrom truncates with replace, one navigation", async () => {
    const h = await drilled();
    const n = await navigationsDuring(h, () => h.state().clearFrom("setName"));

    expect(n).toBe(1);
    expect(h.visits.at(-1)!.type).toBe("REPLACE");
    expect(h.search()).toBe("?sport=sp&year=yr&brand=br");
  });

  it("clearFrom at the sport level empties the drill", async () => {
    const h = await drilled();
    await act(async () => h.state().clearFrom("sport"));
    expect(h.search()).toBe("");
    expect(h.state().selection.sportId).toBeNull();
  });

  it("moveSet re-parents the brand with replace and keeps the set and below", async () => {
    const h = await drilled();
    const n = await navigationsDuring(h, () => h.state().moveSet("br2"));

    expect(n).toBe(1);
    expect(h.visits.at(-1)!.type).toBe("REPLACE");
    expect(h.search()).toBe("?sport=sp&year=yr&brand=br2&set=s1&type=vt");
  });

  it("moveSet with no brand selected does nothing", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    const n = await navigationsDuring(h, () => h.state().moveSet("br2"));
    expect(n).toBe(0);
  });

  it("drillTo with push replays a server path as ONE push", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    const n = await navigationsDuring(h, () =>
      h.state().drillTo(
        [
          { _id: "br", level: "manufacturer" },
          { _id: "s1", level: "setName" },
          { _id: "vt", level: "variantType" },
        ],
        "push",
      ),
    );

    expect(n).toBe(1);
    expect(h.visits.at(-1)!.type).toBe("PUSH");
    expect(h.search()).toBe("?sport=sp&year=yr&brand=br&set=s1&type=vt");
    expect(resolverCalls).toHaveLength(0); // server-supplied ids are trusted
  });

  it("drillTo with replace is one replace, and each step clears below its level", async () => {
    const h = await drilled();
    const n = await navigationsDuring(h, () =>
      h.state().drillTo(
        [
          { _id: "s2", level: "setName" },
          { _id: "vt2", level: "variantType" },
          { _id: "ins", level: "insert" },
        ],
        "replace",
      ),
    );

    expect(n).toBe(1);
    expect(h.visits.at(-1)!.type).toBe("REPLACE");
    expect(h.search()).toBe("?sport=sp&year=yr&brand=br&set=s2&type=vt2&insert=ins");
  });

  it("drillTo stops at a step whose parent level is not set", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () =>
      h.state().drillTo(
        [
          { _id: "s1", level: "setName" }, // brand level is empty: nothing to hang on
          { _id: "vt", level: "variantType" },
        ],
        "push",
      ),
    );
    expect(h.search()).toBe("?sport=sp");
  });

  it("a pick above the current depth (a hole) is ignored", async () => {
    const h = mount("/");
    const n = await navigationsDuring(h, () => h.state().select("setName", "s1"));
    expect(n).toBe(0);
    expect(h.search()).toBe("");
  });
});

describe("useDrillUrlState — re-picking the selected row", () => {
  it("is a no-op: no navigation, and the drill below survives", async () => {
    const h = mount("/");
    for (const [level, id] of [
      ["sport", "sp"],
      ["year", "yr"],
      ["manufacturer", "br"],
      ["setName", "s1"],
    ] as const) {
      await act(async () => h.state().select(level, id));
    }
    const before = h.search();

    const n = await navigationsDuring(h, () => h.state().select("year", "yr"));

    expect(n).toBe(0);
    expect(h.search()).toBe(before);
    expect(h.state().selection).toMatchObject({ yearId: "yr", manufacturer: "br", setId: "s1" });
  });

  it("re-picking the All Brands view while it is selected is a no-op too", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", ALL_BRANDS_VIEW));

    const n = await navigationsDuring(h, () =>
      h.state().select("manufacturer", ALL_BRANDS_VIEW),
    );
    expect(n).toBe(0);
  });

  it("a different row at the same level IS a pick", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    const n = await navigationsDuring(h, () => h.state().select("sport", "sp2"));
    expect(n).toBe(1);
    expect(h.search()).toBe("?sport=sp2");
  });
});

describe("useDrillUrlState — other query parameters", () => {
  it("survive a pick, a clear and a move", async () => {
    const h = mount("/?utm=1&keep=me");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", "br"));
    expect(paramsOf(h.search()).get("utm")).toBe("1");

    await act(async () => h.state().moveSet("br2"));
    expect(paramsOf(h.search()).get("keep")).toBe("me");

    await act(async () => h.state().clearFrom("sport"));
    expect(h.search()).toBe("?utm=1&keep=me");
  });

  it("survive the resolver's truncation rewrite", async () => {
    mockResolver = () => [];
    const h = mount("/?utm=1&sport=gone");
    await act(async () => {});
    expect(h.search()).toBe("?utm=1");
  });
});

describe("useDrillUrlState — Back and Forward", () => {
  it("Back restores the previous pick and Forward the next, without asking the server", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().select("manufacturer", "br"));

    await act(async () => h.navigate(-1));
    expect(h.state().selection).toMatchObject({ sportId: "sp", yearId: "yr", manufacturer: null });
    expect(h.search()).toBe("?sport=sp&year=yr");

    await act(async () => h.navigate(-1));
    expect(h.state().selection).toMatchObject({ sportId: "sp", yearId: null });

    await act(async () => h.navigate(1));
    await act(async () => h.navigate(1));
    expect(h.state().selection).toMatchObject({ yearId: "yr", manufacturer: "br" });
    expect(h.state().resolving).toBe(false);
    expect(resolverCalls).toHaveLength(0);
  });

  it("a replace (clearFrom) does not add a history entry: Back skips over it", async () => {
    const h = mount("/");
    await act(async () => h.state().select("sport", "sp"));
    await act(async () => h.state().select("year", "yr"));
    await act(async () => h.state().clearFrom("year")); // replaces the year entry

    await act(async () => h.navigate(-1));
    // Back lands on the sport pick, not on a leftover year entry.
    expect(h.search()).toBe("?sport=sp");
  });
});
