/**
 * NEO-325 — `useBaseMatchProbe`: the client queue behind the Reconcile
 * dialog's Base check. A fake client answers by hand, one call at a time, so
 * what was SENT (batch sizes, order, how many in flight) is as observable as
 * what came back. The verdict rules themselves are `lib/cards/base-match.test.ts`;
 * the dialog's use of the hook is `ReconciliationModal.baseMatch.test.tsx`.
 *
 * The real `api` is a proxy of function names, so a call is identified with
 * `getFunctionName`, never by mocking the generated module.
 */

import { act, renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { BaseSignature } from "@/lib/cards/base-match";
import {
  BSC_BATCH,
  MAX_IN_FLIGHT_PER_SIDE,
  SL_COUNT_BATCH,
  SL_FIRST_PAGE_BATCH,
  checkKey,
  useBaseMatchProbe,
  type BaseMatchClient,
  type SideIds,
} from "./base-match-probe";

const VT = "vt1" as Id<"selectorOptions">;
const FN = {
  signature: "baseMatchProbe:getBaseSignatureForVariantType",
  bsc: "baseMatchProbe:probeBscSets",
  slFirst: "baseMatchProbe:probeSlFirstPage",
  slCount: "baseMatchProbe:probeSlCount",
} as const;

const TROUT = { cardNumber: "1", cardName: "Mike Trout" };
const NOBODY = { cardNumber: "99", cardName: "Nobody" };

function signature(perSide = { bsc: 3, sportlots: 3 }): BaseSignature {
  const first = {
    cardNumber: "1",
    cardName: "Mike Trout",
    namesOnCard: ["Mike Trout"],
    isTeamCard: false,
  };
  return {
    status: "ok",
    baseId: "base1",
    baseName: "Base",
    first,
    perSide,
    cards: [first],
  };
}

type Call = {
  name: string;
  args: { setIds?: string[]; variantNameIds?: string[] };
  /** Ids the call asked about, whichever arg carried them. */
  ids: string[];
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function harness(sig: unknown = signature()) {
  const calls: Call[] = [];
  const signatureResolvers: Array<{
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  let signatureCalls = 0;
  const client = {
    query: vi.fn((ref: never) => {
      expect(getFunctionName(ref)).toBe(FN.signature);
      signatureCalls++;
      if (sig === "hold") {
        return new Promise((resolve, reject) =>
          signatureResolvers.push({ resolve, reject }),
        );
      }
      if (sig instanceof Error) return Promise.reject(sig);
      return Promise.resolve(sig);
    }),
    action: vi.fn((ref: never, args: Call["args"]) => {
      return new Promise((resolve, reject) => {
        const call: Call = {
          name: getFunctionName(ref),
          args,
          ids: [...(args.setIds ?? args.variantNameIds ?? [])],
          settled: false,
          resolve: (v) => {
            call.settled = true;
            resolve(v);
          },
          reject: (e) => {
            call.settled = true;
            reject(e);
          },
        };
        calls.push(call);
      });
    }),
  };
  return {
    client: client as unknown as BaseMatchClient,
    raw: client,
    calls,
    signatureResolvers,
    signatureCalls: () => signatureCalls,
    of: (name: string) => calls.filter((c) => c.name === name),
    outstanding: (name: string) =>
      calls.filter((c) => c.name === name && !c.settled),
  };
}

type Props = {
  client: BaseMatchClient | null;
  variantTypeId: Id<"selectorOptions"> | undefined;
  scope: SideIds;
  view: SideIds;
};

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const sides = (bsc: string[] = [], sportlots: string[] = []): SideIds => ({
  bsc,
  sportlots,
});

function mount(h: ReturnType<typeof harness>, scope: SideIds, view = scope) {
  const initialProps: Props = { client: h.client, variantTypeId: VT, scope, view };
  return renderHook((p: Props) => useBaseMatchProbe(p), { initialProps });
}

/** Let promise continuations and effects run. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function answer(call: Call, value: unknown) {
  await act(async () => {
    call.resolve(value);
  });
  await settle();
}

const bscOk = (id: string, first: unknown = TROUT, count = 3) => ({
  id,
  status: "ok" as const,
  count,
  first,
});
const slFirstOk = (id: string, first: unknown = TROUT, pageHadRows = true) => ({
  id,
  status: "ok" as const,
  first,
  nonVariationRowsOnPage: first ? 1 : 0,
  pageHadRows,
});
const slCountOk = (id: string, count = 3) => ({
  id,
  status: "ok" as const,
  count,
  pages: 1,
});

const stateOf = (
  r: { current: ReturnType<typeof useBaseMatchProbe> },
  side: "bsc" | "sportlots",
  id: string,
) => r.current.checks.get(checkKey(side, id));

describe("useBaseMatchProbe — the signature", () => {
  test("is queried once, with the variant type, and the hook goes loading then on", async () => {
    const h = harness();
    const { result, rerender } = mount(h, sides(ids("b", 2)));
    expect(result.current.phase).toBe("loading");
    expect(result.current.checks.size).toBe(0);
    await settle();

    expect(result.current.phase).toBe("on");
    expect(result.current.signature?.baseId).toBe("base1");
    // New scope and view content do not ask again.
    rerender({
      client: h.client,
      variantTypeId: VT,
      scope: sides(ids("b", 3)),
      view: sides(ids("b", 3)),
    });
    await settle();
    expect(h.raw.query).toHaveBeenCalledTimes(1);
    expect((h.raw.query.mock.calls[0] as unknown[])[1]).toEqual({ variantTypeId: VT });
  });

  test.each(["noBase", "manyBases", "notParallelType", "noCards", "tooManyCards"])(
    "a %s answer turns the check off, with no actions and no chrome",
    async (status) => {
      const h = harness({ status });
      const { result } = mount(h, sides(ids("b", 3), ids("s", 3)));
      await settle();
      expect(result.current.phase).toBe("off");
      expect(result.current.checks.size).toBe(0);
      expect(h.raw.action).not.toHaveBeenCalled();
    },
  );

  test("a signature call that throws turns the check off", async () => {
    const h = harness(new Error("boom"));
    const { result } = mount(h, sides(ids("b", 3)));
    await settle();
    expect(result.current.phase).toBe("off");
    expect(h.raw.action).not.toHaveBeenCalled();
  });

  test("no client, or no variant type, is off and asks nothing", async () => {
    const h = harness();
    const noClient = renderHook(() =>
      useBaseMatchProbe({
        client: null,
        variantTypeId: VT,
        scope: sides(["b0"]),
        view: sides(["b0"]),
      }),
    );
    const noType = renderHook(() =>
      useBaseMatchProbe({
        client: h.client,
        variantTypeId: undefined,
        scope: sides(["b0"]),
        view: sides(["b0"]),
      }),
    );
    await settle();
    expect(noClient.result.current.phase).toBe("off");
    expect(noType.result.current.phase).toBe("off");
    expect(h.raw.query).not.toHaveBeenCalled();
    expect(h.raw.action).not.toHaveBeenCalled();
  });
});

describe("useBaseMatchProbe — batching", () => {
  test("SportLots first pages go out in batches of at most 32", async () => {
    const h = harness();
    mount(h, sides([], ids("s", 70)));
    await settle();

    const first = h.of(FN.slFirst);
    expect(SL_FIRST_PAGE_BATCH).toBe(32);
    expect(first.map((c) => c.ids.length)).toEqual([32, 32]);
    await answer(first[0], first[0].ids.map((id) => slFirstOk(id, NOBODY)));
    expect(h.of(FN.slFirst).map((c) => c.ids.length)).toEqual([32, 32, 6]);
  });

  test("SportLots counts go out in batches of at most 8, and only for first-card matches", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ids("s", 20)));
    await settle();
    const [call] = h.of(FN.slFirst);
    // s0-s9 match the Base's first card; s10-s19 do not.
    await answer(
      call,
      call.ids.map((id, i) => slFirstOk(id, i < 10 ? TROUT : NOBODY)),
    );

    expect(SL_COUNT_BATCH).toBe(8);
    const counted = h.of(FN.slCount).flatMap((c) => c.ids);
    expect(h.of(FN.slCount).map((c) => c.ids.length)).toEqual([8, 2]);
    expect(counted.sort()).toEqual(ids("s", 10).sort());
    // A first-card mismatch is decided with no count.
    expect(stateOf(result, "sportlots", "s15")).toMatchObject({
      state: "done",
      verdict: "mismatch",
    });
  });

  test("a side with no linked Base cards is never counted", async () => {
    const h = harness(signature({ bsc: 3, sportlots: 0 }));
    const { result } = mount(h, sides([], ids("s", 5)));
    await settle();
    await answer(h.of(FN.slFirst)[0], ids("s", 5).map((id) => slFirstOk(id)));

    expect(h.of(FN.slCount)).toHaveLength(0);
    expect(stateOf(result, "sportlots", "s0")).toMatchObject({
      state: "done",
      verdict: "match",
    });
  });

  test("BSC goes out in batches of at most 4, with the variant type", async () => {
    const h = harness();
    mount(h, sides(ids("b", 10)));
    await settle();

    expect(BSC_BATCH).toBe(4);
    const bsc = h.of(FN.bsc);
    expect(bsc.map((c) => c.ids.length)).toEqual([4, 4]);
    expect(bsc[0].args).toMatchObject({ variantTypeId: VT });
    await answer(bsc[0], bsc[0].ids.map((id) => bscOk(id)));
    expect(h.of(FN.bsc).map((c) => c.ids.length)).toEqual([4, 4, 2]);
  });

  test("at most two calls are in flight per side, and the sides do not share the limit", async () => {
    const h = harness();
    mount(h, sides(ids("b", 20), ids("s", 100)));
    await settle();

    expect(MAX_IN_FLIGHT_PER_SIDE).toBe(2);
    expect(h.outstanding(FN.bsc)).toHaveLength(2);
    expect(h.outstanding(FN.slFirst)).toHaveLength(2);

    await answer(h.outstanding(FN.bsc)[0], []);
    expect(h.outstanding(FN.bsc)).toHaveLength(2);
    await answer(h.outstanding(FN.bsc)[0], []);
    await answer(h.outstanding(FN.bsc)[0], []);
    for (let i = 0; i < 6; i++) {
      expect(h.outstanding(FN.bsc).length).toBeLessThanOrEqual(2);
      expect(h.outstanding(FN.slFirst).length).toBeLessThanOrEqual(2);
      const next = h.outstanding(FN.bsc)[0];
      if (next) await answer(next, []);
    }
  });
});

describe("useBaseMatchProbe — priority", () => {
  test("ids in the view are dispatched first, in view order, then the rest as they joined", async () => {
    const h = harness();
    mount(h, sides(ids("b", 10)), sides(["b7", "b5", "b9"]));
    await settle();

    const [first, second] = h.of(FN.bsc);
    expect(first.ids).toEqual(["b7", "b5", "b9", "b0"]);
    expect(second.ids).toEqual(["b1", "b2", "b3", "b4"]);
  });

  test("a view change mid-run re-sorts what is dispatched next", async () => {
    const h = harness();
    const scope = sides(ids("b", 12));
    const { rerender } = mount(h, scope, sides([]));
    await settle();
    expect(h.of(FN.bsc).map((c) => c.ids)).toEqual([
      ["b0", "b1", "b2", "b3"],
      ["b4", "b5", "b6", "b7"],
    ]);

    rerender({
      client: h.client,
      variantTypeId: VT,
      scope,
      view: sides(["b11", "b10"]),
    });
    await settle();
    await answer(h.of(FN.bsc)[0], []);

    expect(h.of(FN.bsc)[2].ids).toEqual(["b11", "b10", "b8", "b9"]);
  });

  test("widening the scope enqueues the new ids", async () => {
    const h = harness();
    const { rerender } = mount(h, sides(ids("b", 4)));
    await settle();
    await answer(h.of(FN.bsc)[0], ids("b", 4).map((id) => bscOk(id)));
    expect(h.of(FN.bsc)).toHaveLength(1);

    rerender({
      client: h.client,
      variantTypeId: VT,
      scope: sides(ids("b", 6)),
      view: sides(ids("b", 6)),
    });
    await settle();
    expect(h.of(FN.bsc)).toHaveLength(2);
    expect(h.of(FN.bsc)[1].ids).toEqual(["b4", "b5"]);
  });

  test("narrowing the scope stops dispatching the dropped ids", async () => {
    const h = harness();
    const { rerender } = mount(h, sides(ids("b", 12)));
    await settle();
    expect(h.outstanding(FN.bsc)).toHaveLength(2); // b0-b7

    const narrow = sides([...ids("b", 8), "b9"]);
    rerender({ client: h.client, variantTypeId: VT, scope: narrow, view: narrow });
    await settle();
    await answer(h.of(FN.bsc)[0], []);

    // b8, b10, b11 left the scope: only b9 is dispatched.
    expect(h.of(FN.bsc)[2].ids).toEqual(["b9"]);
    await answer(h.of(FN.bsc)[1], []);
    expect(h.of(FN.bsc)).toHaveLength(3);
  });
});

describe("useBaseMatchProbe — the cache", () => {
  test("an id that leaves the scope and re-enters is not probed again", async () => {
    const h = harness();
    const full = sides(ids("b", 4));
    const { result, rerender } = mount(h, full);
    await settle();
    await answer(h.of(FN.bsc)[0], ids("b", 4).map((id) => bscOk(id)));
    expect(stateOf(result, "bsc", "b3")).toMatchObject({ verdict: "match" });

    const narrow = sides(["b0", "b1"]);
    rerender({ client: h.client, variantTypeId: VT, scope: narrow, view: narrow });
    await settle();
    rerender({ client: h.client, variantTypeId: VT, scope: full, view: full });
    await settle();

    expect(h.of(FN.bsc)).toHaveLength(1);
    expect(stateOf(result, "bsc", "b3")).toMatchObject({
      state: "done",
      verdict: "match",
    });
  });
});

describe("useBaseMatchProbe — cancel on close", () => {
  const closed = (h: ReturnType<typeof harness>, scope: SideIds): Props => ({
    client: h.client,
    variantTypeId: undefined,
    scope,
    view: scope,
  });
  const open = (h: ReturnType<typeof harness>, scope: SideIds): Props => ({
    client: h.client,
    variantTypeId: VT,
    scope,
    view: scope,
  });

  test("late results are ignored, nothing more is sent, and the cache is gone on reopen", async () => {
    const h = harness();
    const scope = sides(ids("b", 12));
    const { result, rerender } = mount(h, scope);
    await settle();
    const [a, b] = h.of(FN.bsc);

    rerender(closed(h, scope));
    await settle();
    expect(result.current.phase).toBe("off");
    expect(result.current.checks.size).toBe(0);

    await answer(a, a.ids.map((id) => bscOk(id)));
    await answer(b, b.ids.map((id) => bscOk(id)));
    expect(h.of(FN.bsc)).toHaveLength(2); // nothing more was sent
    expect(result.current.checks.size).toBe(0);

    // Reopen: the signature is asked again, and the ids start from nothing.
    rerender(open(h, scope));
    await settle();
    expect(h.signatureCalls()).toBe(2);
    expect(h.of(FN.bsc)).toHaveLength(4);
    expect(h.of(FN.bsc)[2].ids).toEqual(["b0", "b1", "b2", "b3"]);
    expect(stateOf(result, "bsc", "b0")).toEqual({ state: "checking" });
  });

  test("an answer from before the close does not free a slot in the reopened sitting", async () => {
    const h = harness();
    const scope = sides(ids("b", 12));
    const { rerender } = mount(h, scope);
    await settle();
    const [oldA] = h.of(FN.bsc);

    rerender(closed(h, scope));
    await settle();
    rerender(open(h, scope));
    await settle();
    expect(h.outstanding(FN.bsc)).toHaveLength(4); // 2 old + 2 new

    await answer(oldA, oldA.ids.map((id) => bscOk(id)));
    // The old answer is stale: the new sitting still has exactly its two.
    expect(h.of(FN.bsc)).toHaveLength(4);
  });

  test("a signature that arrives after the close is ignored", async () => {
    const h = harness("hold");
    const scope = sides(ids("b", 3));
    const { result, rerender } = mount(h, scope);
    await settle();

    rerender(closed(h, scope));
    await settle();
    await act(async () => {
      h.signatureResolvers[0].resolve(signature());
    });
    await settle();

    expect(result.current.phase).toBe("off");
    expect(h.raw.action).not.toHaveBeenCalled();
  });

  test("unmounting cancels too: nothing more is sent after a late answer", async () => {
    const h = harness();
    const { unmount } = mount(h, sides(ids("b", 12)));
    await settle();
    const [a] = h.of(FN.bsc);
    unmount();
    await answer(a, a.ids.map((id) => bscOk(id)));
    expect(h.of(FN.bsc)).toHaveLength(2);
  });
});

describe("useBaseMatchProbe — what a probe can say", () => {
  test("refused, failed, a missing id and a thrown call are all unverifiable; results are mapped by id", async () => {
    const h = harness();
    const { result } = mount(h, sides(["b0", "b1", "b2", "b3"]));
    await settle();
    // Out of request order, one id absent, one refused, one failed: only the
    // last id asked about is ok, and it comes back first.
    await answer(h.of(FN.bsc)[0], [
      bscOk("b3"),
      { id: "b1", status: "refused" },
      { id: "b0", status: "failed", kind: "network" },
    ]);

    expect(stateOf(result, "bsc", "b3")).toMatchObject({
      state: "done",
      verdict: "match",
    });
    for (const id of ["b0", "b1", "b2"]) {
      expect(stateOf(result, "bsc", id)).toMatchObject({
        state: "done",
        verdict: "unverifiable",
      });
    }
  });

  test("a thrown BSC call makes every id in it unverifiable and releases the slot", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 12)));
    await settle();
    const [a] = h.of(FN.bsc);
    await act(async () => {
      a.reject(new Error("network"));
    });
    await settle();

    for (const id of a.ids) {
      expect(stateOf(result, "bsc", id)).toMatchObject({
        state: "done",
        verdict: "unverifiable",
      });
    }
    // The freed slot dispatches the next batch.
    expect(h.of(FN.bsc)).toHaveLength(3);
  });

  test("SportLots: a failed first page, and a failed or missing count, are unverifiable", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ["s0", "s1", "s2", "s3"]));
    await settle();
    await answer(h.of(FN.slFirst)[0], [
      slFirstOk("s2"),
      { id: "s0", status: "failed", kind: "network" },
      slFirstOk("s1"),
      // s3 absent
    ]);
    expect(stateOf(result, "sportlots", "s0")).toMatchObject({ verdict: "unverifiable" });
    expect(stateOf(result, "sportlots", "s3")).toMatchObject({ verdict: "unverifiable" });

    const [count] = h.of(FN.slCount);
    expect(count.ids.sort()).toEqual(["s1", "s2"]);
    await answer(count, [slCountOk("s2", 3)]); // s1 missing
    expect(stateOf(result, "sportlots", "s2")).toMatchObject({ verdict: "match" });
    expect(stateOf(result, "sportlots", "s1")).toMatchObject({ verdict: "unverifiable" });
  });

  test("a thrown SportLots count is unverifiable for every id in it", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ["s0", "s1"]));
    await settle();
    await answer(h.of(FN.slFirst)[0], ["s0", "s1"].map((id) => slFirstOk(id)));
    await act(async () => {
      h.of(FN.slCount)[0].reject(new Error("boom"));
    });
    await settle();
    expect(stateOf(result, "sportlots", "s0")).toMatchObject({ verdict: "unverifiable" });
    expect(stateOf(result, "sportlots", "s1")).toMatchObject({ verdict: "unverifiable" });
  });

  test("an exactly equal count is a match and an off-by-one a mismatch, end to end", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ["s0", "s1"]));
    await settle();
    await answer(h.of(FN.slFirst)[0], ["s0", "s1"].map((id) => slFirstOk(id)));
    await answer(h.of(FN.slCount)[0], [slCountOk("s0", 3), slCountOk("s1", 4)]);
    expect(stateOf(result, "sportlots", "s0")).toMatchObject({ verdict: "match" });
    expect(stateOf(result, "sportlots", "s1")).toMatchObject({ verdict: "mismatch" });
  });

  test("an empty page counts as 0 with no count call", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ["s0"]));
    await settle();
    await answer(h.of(FN.slFirst)[0], [{ ...slFirstOk("s0", TROUT, false), first: undefined }]);

    expect(h.of(FN.slCount)).toHaveLength(0);
    const check = stateOf(result, "sportlots", "s0");
    expect(check).toMatchObject({ state: "done", verdict: "mismatch" });
    expect(check).toMatchObject({ reason: expect.stringContaining("0 cards") });
  });

  test("rows but no first card (all variations) is a mismatch with no count call", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ["s0"]));
    await settle();
    await answer(h.of(FN.slFirst)[0], [{ ...slFirstOk("s0"), first: undefined }]);

    expect(h.of(FN.slCount)).toHaveLength(0);
    const check = stateOf(result, "sportlots", "s0");
    expect(check).toMatchObject({ state: "done", verdict: "mismatch" });
    expect(check).toMatchObject({ reason: expect.stringContaining("only variations") });
  });
});

describe("useBaseMatchProbe — a scope rebuilt every render", () => {
  test("a content-identical scope passed as a new array each render does not loop", async () => {
    const h = harness();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useBaseMatchProbe({
        client: h.client,
        variantTypeId: VT,
        // Fresh arrays every render, as the dialog's lists are.
        scope: { bsc: ids("b", 6), sportlots: ids("s", 3) },
        view: { bsc: ids("b", 6), sportlots: ids("s", 3) },
      });
    });
    await settle();
    await answer(h.of(FN.bsc)[0], h.of(FN.bsc)[0].ids.map((id) => bscOk(id)));
    await settle();

    expect(result.current.phase).toBe("on");
    expect(renders).toBeLessThan(30);
    expect(h.raw.query).toHaveBeenCalledTimes(1);
    expect(h.of(FN.bsc).map((c) => c.ids.length)).toEqual([4, 2]);
  });
});
