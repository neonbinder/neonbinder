/**
 * NEO-325 (security F1, a11y round) — what `useBaseMatchProbe` does when a
 * marketplace answers a whole batch "sign in", and what it says aloud while a
 * check runs.
 *
 *   - `wholeBatchSignedOut` / `nextAnnouncement` are pure and tested directly.
 *   - The sign-in stop: when EVERY id of a batch comes back `signed_out`
 *     (or every one `no_sign_in`), that side is not asked again this sitting.
 *     Its queued rows, and any that join later, settle as "sign in" rows;
 *     the other side carries on. One signed-out answer is not a stop.
 *   - The live line (`announcement`): a start line, one line per quarter, one
 *     closing sentence; the total is fixed when the check starts.
 *
 * The queue's batching, priority and cancel are `base-match-probe.test.tsx`.
 */

import { act, renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { BASE_MATCH_COPY, type BaseSignature } from "@/lib/cards/base-match";
import {
  checkKey,
  freshAnnounce,
  nextAnnouncement,
  useBaseMatchProbe,
  wholeBatchSignedOut,
  type AnnounceState,
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

function signature(perSide = { bsc: 0, sportlots: 0 }): BaseSignature {
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
  ids: string[];
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function harness(sig: BaseSignature = signature()) {
  const calls: Call[] = [];
  let signatureCalls = 0;
  const client = {
    query: vi.fn((ref: never) => {
      expect(getFunctionName(ref)).toBe(FN.signature);
      signatureCalls++;
      return Promise.resolve(sig);
    }),
    action: vi.fn(
      (ref: never, args: { setIds?: string[]; variantNameIds?: string[] }) =>
        new Promise((resolve, reject) => {
          const call: Call = {
            name: getFunctionName(ref),
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
        }),
    ),
  };
  return {
    client: client as unknown as BaseMatchClient,
    raw: client,
    calls,
    signatureCalls: () => signatureCalls,
    of: (name: string) => calls.filter((c) => c.name === name),
  };
}

type Props = {
  client: BaseMatchClient | null;
  variantTypeId: Id<"selectorOptions"> | undefined;
  scope: SideIds;
  view: SideIds;
};

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const sides = (bsc: string[] = [], sportlots: string[] = []): SideIds => ({ bsc, sportlots });
const props = (h: ReturnType<typeof harness>, scope: SideIds, open = true): Props => ({
  client: h.client,
  variantTypeId: open ? VT : undefined,
  scope,
  view: scope,
});

/** Mounts the hook and records every distinct announcement it showed. */
function mount(h: ReturnType<typeof harness>, scope: SideIds) {
  const said: string[] = [];
  const view = renderHook(
    (p: Props) => {
      const out = useBaseMatchProbe(p);
      if (out.announcement !== "" && said[said.length - 1] !== out.announcement) {
        said.push(out.announcement);
      }
      return out;
    },
    { initialProps: props(h, scope) },
  );
  return { ...view, said };
}

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

const signedOut = (id: string) => ({ id, status: "failed", kind: "signed_out" });
const noSignIn = (id: string) => ({ id, status: "failed", kind: "no_sign_in" });
const slOk = (id: string, first: unknown = TROUT) => ({
  id,
  status: "ok",
  first,
  nonVariationRowsOnPage: 1,
  pageHadRows: true,
});
const bscOk = (id: string, first: unknown = TROUT) => ({ id, status: "ok", count: 0, first });

const stateOf = (
  r: { current: ReturnType<typeof useBaseMatchProbe> },
  side: "bsc" | "sportlots",
  id: string,
) => r.current.checks.get(checkKey(side, id));

const SIGN_IN_ROW = {
  state: "done",
  verdict: "unverifiable",
  reason: BASE_MATCH_COPY.unverifiableSignIn,
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("wholeBatchSignedOut", () => {
  const out = (id: string, status: string, kind?: string) => ({ id, status, kind });

  test("every id failed signed_out is a stop", () => {
    expect(
      wholeBatchSignedOut(["a", "b"], [out("a", "failed", "signed_out"), out("b", "failed", "signed_out")]),
    ).toBe(true);
  });

  test("every id failed no_sign_in is a stop", () => {
    expect(
      wholeBatchSignedOut(["a", "b"], [out("a", "failed", "no_sign_in"), out("b", "failed", "no_sign_in")]),
    ).toBe(true);
  });

  test("a mix of the two sign-in kinds is a stop", () => {
    expect(
      wholeBatchSignedOut(["a", "b"], [out("a", "failed", "signed_out"), out("b", "failed", "no_sign_in")]),
    ).toBe(true);
  });

  test("one id that was answered ok is not a stop", () => {
    expect(
      wholeBatchSignedOut(["a", "b"], [out("a", "failed", "signed_out"), out("b", "ok")]),
    ).toBe(false);
  });

  test("one id with another failure kind is not a stop", () => {
    expect(
      wholeBatchSignedOut(["a", "b"], [out("a", "failed", "signed_out"), out("b", "failed", "timeout")]),
    ).toBe(false);
  });

  test("an id the server did not answer is not a stop", () => {
    expect(wholeBatchSignedOut(["a", "b"], [out("a", "failed", "signed_out")])).toBe(false);
  });

  test("a refused answer is not a stop, whether it is a status or a kind", () => {
    expect(wholeBatchSignedOut(["a"], [out("a", "refused")])).toBe(false);
    expect(wholeBatchSignedOut(["a"], [out("a", "failed", "refused")])).toBe(false);
  });

  test("a failed answer with no kind is not a stop", () => {
    expect(wholeBatchSignedOut(["a"], [out("a", "failed")])).toBe(false);
  });

  test("a sign-in kind on an ok status is not a stop", () => {
    expect(wholeBatchSignedOut(["a"], [out("a", "ok", "signed_out")])).toBe(false);
  });

  test("no ids, or no results at all, is never a stop", () => {
    expect(wholeBatchSignedOut([], [])).toBe(false);
    expect(wholeBatchSignedOut(["a"], undefined)).toBe(false);
    expect(wholeBatchSignedOut(["a"], [])).toBe(false);
  });

  test("answers for ids that were not asked about are ignored", () => {
    expect(
      wholeBatchSignedOut(["a"], [out("a", "failed", "signed_out"), out("z", "ok")]),
    ).toBe(true);
  });
});

describe("nextAnnouncement", () => {
  type Entries = Map<string, { status: "queued" | "inflight" | "done"; judgement?: { verdict: "match" | "mismatch" | "unverifiable"; reason: string } }>;
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `bsc:b${i}`);
  const NOT_STOPPED = { bsc: false, sportlots: false };

  function run(
    startKeys: string[],
    state: AnnounceState,
    done: Record<string, "match" | "mismatch" | "unverifiable">,
    opts: { inScope?: string[]; stopped?: { bsc: boolean; sportlots: boolean } } = {},
  ) {
    const entries: Entries = new Map();
    for (const key of startKeys) {
      const verdict = done[key];
      entries.set(
        key,
        verdict
          ? { status: "done", judgement: { verdict, reason: "r" } }
          : { status: "queued" },
      );
    }
    return nextAnnouncement({
      state,
      startKeys: new Set(startKeys),
      entries,
      inScope: new Set(opts.inScope ?? startKeys),
      stopped: opts.stopped ?? NOT_STOPPED,
    });
  }

  test("the first call says the start line with the fixed total", () => {
    const state = freshAnnounce();
    expect(run(keys(8), state, {})).toBe(BASE_MATCH_COPY.liveStart(8));
    expect(state.started).toBe(true);
  });

  test("the start line is said once", () => {
    const state = freshAnnounce();
    run(keys(8), state, {});
    expect(run(keys(8), state, {})).toBeNull();
  });

  test("quarters are said at 25, 50 and 75 only, each once, and nothing in between", () => {
    const k = keys(8);
    const state = freshAnnounce();
    run(k, state, {});
    const done: Record<string, "match"> = {};
    const said: Array<string | null> = [];
    for (let i = 0; i < 7; i++) {
      done[k[i]] = "match";
      said.push(run(k, state, done));
    }
    expect(said).toEqual([
      null, // 1/8
      BASE_MATCH_COPY.liveQuarter(25), // 2/8
      null, // 3/8
      BASE_MATCH_COPY.liveQuarter(50), // 4/8
      null, // 5/8
      BASE_MATCH_COPY.liveQuarter(75), // 6/8
      null, // 7/8
    ]);
  });

  test("a jump over quarters says only the one it landed on", () => {
    const k = keys(8);
    const state = freshAnnounce();
    run(k, state, {});
    const six = Object.fromEntries(k.slice(0, 6).map((key) => [key, "match" as const]));
    expect(run(k, state, six)).toBe(BASE_MATCH_COPY.liveQuarter(75));
    expect(run(k, state, six)).toBeNull();
  });

  test("the closing sentence counts what was checked, once, and ends the line for good", () => {
    const k = keys(4);
    const state = freshAnnounce();
    run(k, state, {});
    const all = {
      [k[0]]: "match",
      [k[1]]: "match",
      [k[2]]: "mismatch",
      [k[3]]: "unverifiable",
    } as const;
    expect(run(k, state, all)).toBe(BASE_MATCH_COPY.liveDone(4, 2, 1, 1));
    expect(state.done).toBe(true);
    // Nothing more, however many times it is asked or whatever joins later.
    expect(run(k, state, all)).toBeNull();
    expect(run([...k, "bsc:late"], state, all)).toBeNull();
  });

  test("a set that left the scope before it was checked counts as accounted for", () => {
    const k = keys(4);
    const state = freshAnnounce();
    run(k, state, {});
    // b3 left; b0-b2 are done: 4 of 4 accounted, 3 checked.
    const done = { [k[0]]: "match", [k[1]]: "match", [k[2]]: "mismatch" } as const;
    expect(run(k, state, done, { inScope: k.slice(0, 3) })).toBe(
      BASE_MATCH_COPY.liveDone(3, 2, 1, 0),
    );
  });

  test("a set that left the scope moves the quarter without being counted as checked", () => {
    const k = keys(4);
    const state = freshAnnounce();
    run(k, state, {});
    expect(run(k, state, {}, { inScope: k.slice(1) })).toBe(BASE_MATCH_COPY.liveQuarter(25));
  });

  test("nothing checked at all says no closing sentence", () => {
    const k = keys(3);
    const state = freshAnnounce();
    // Every set left before the first call: not even a start line.
    expect(run(k, state, {}, { inScope: [] })).toBeNull();
    expect(state.done).toBe(true);
  });

  test("everything left after the start line: still no closing sentence", () => {
    const k = keys(3);
    const state = freshAnnounce();
    expect(run(k, state, {})).toBe(BASE_MATCH_COPY.liveStart(3));
    expect(run(k, state, {}, { inScope: [] })).toBeNull();
    expect(state.done).toBe(true);
  });

  test("a stopped side is said once, with the start line in the same breath", () => {
    const k = keys(4);
    const state = freshAnnounce();
    const first = run(k, state, {}, { stopped: { bsc: false, sportlots: true } });
    expect(first).toBe(`${BASE_MATCH_COPY.liveStopped("sportlots")} ${BASE_MATCH_COPY.liveStart(4)}`);
    expect(run(k, state, {}, { stopped: { bsc: false, sportlots: true } })).toBeNull();
  });

  test("each side's stop is said on its own, once", () => {
    const k = keys(4);
    const state = freshAnnounce();
    run(k, state, {});
    expect(run(k, state, {}, { stopped: { bsc: false, sportlots: true } })).toBe(
      BASE_MATCH_COPY.liveStopped("sportlots"),
    );
    expect(run(k, state, {}, { stopped: { bsc: true, sportlots: true } })).toBe(
      BASE_MATCH_COPY.liveStopped("bsc"),
    );
    expect(run(k, state, {}, { stopped: { bsc: true, sportlots: true } })).toBeNull();
  });

  test("a stop is still said after the closing sentence", () => {
    const k = keys(1);
    const state = freshAnnounce();
    run(k, state, {});
    run(k, state, { [k[0]]: "match" });
    expect(state.done).toBe(true);
    expect(run(k, state, { [k[0]]: "match" }, { stopped: { bsc: true, sportlots: false } })).toBe(
      BASE_MATCH_COPY.liveStopped("bsc"),
    );
  });

  test("an empty check says nothing", () => {
    expect(run([], freshAnnounce(), {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sign-in stop, through the hook
// ---------------------------------------------------------------------------

describe("useBaseMatchProbe: a whole batch signed out stops that side", () => {
  test("every id signed_out: queued rows settle as sign-in rows and nothing more is sent to that side", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ids("s", 70)));
    await settle();
    const [first, second] = h.of(FN.slFirst);
    expect(first.ids).toHaveLength(32);
    expect(second.ids).toHaveLength(32);

    await answer(first, first.ids.map(signedOut));

    expect(result.current.stopped).toEqual({ bsc: false, sportlots: true });
    // The batch itself, and the six rows that were still queued.
    expect(stateOf(result, "sportlots", "s0")).toEqual(SIGN_IN_ROW);
    expect(stateOf(result, "sportlots", "s31")).toEqual(SIGN_IN_ROW);
    expect(stateOf(result, "sportlots", "s64")).toEqual(SIGN_IN_ROW);
    expect(stateOf(result, "sportlots", "s69")).toEqual(SIGN_IN_ROW);
    // The freed slot is not used.
    expect(h.of(FN.slFirst)).toHaveLength(2);

    // The other batch was already out; it settles on what came back.
    await answer(second, second.ids.map((id) => slOk(id)));
    expect(stateOf(result, "sportlots", "s40")).toMatchObject({ verdict: "match" });
    expect(h.of(FN.slFirst)).toHaveLength(2);
  });

  test("every id no_sign_in is a stop too", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ids("s", 70)));
    await settle();
    const [first] = h.of(FN.slFirst);

    await answer(first, first.ids.map(noSignIn));

    expect(result.current.stopped.sportlots).toBe(true);
    expect(stateOf(result, "sportlots", "s69")).toEqual(SIGN_IN_ROW);
    expect(h.of(FN.slFirst)).toHaveLength(2);
  });

  test("a stop at the count step settles that batch as sign-in rows too", async () => {
    const h = harness(signature({ bsc: 0, sportlots: 3 }));
    const { result } = mount(h, sides([], ids("s", 4)));
    await settle();
    await answer(h.of(FN.slFirst)[0], ids("s", 4).map((id) => slOk(id)));
    const counts = h.of(FN.slCount);
    expect(counts).toHaveLength(1);

    await answer(counts[0], counts[0].ids.map(signedOut));

    expect(result.current.stopped.sportlots).toBe(true);
    for (const id of ids("s", 4)) expect(stateOf(result, "sportlots", id)).toEqual(SIGN_IN_ROW);
  });

  test("the other side carries on", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 12), ids("s", 70)));
    await settle();
    const [slFirst] = h.of(FN.slFirst);
    await answer(slFirst, slFirst.ids.map(signedOut));
    expect(result.current.stopped).toEqual({ bsc: false, sportlots: true });
    expect(h.of(FN.bsc)).toHaveLength(2);

    const [bscA] = h.of(FN.bsc);
    await answer(bscA, bscA.ids.map((id) => bscOk(id)));

    expect(stateOf(result, "bsc", "b0")).toMatchObject({ verdict: "match" });
    expect(h.of(FN.bsc)).toHaveLength(3);
    expect(result.current.stopped.bsc).toBe(false);
  });

  test("BSC stops the same way, and leaves SportLots running", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 12), ids("s", 70)));
    await settle();
    const [bscA] = h.of(FN.bsc);
    await answer(bscA, bscA.ids.map(signedOut));

    expect(result.current.stopped).toEqual({ bsc: true, sportlots: false });
    expect(stateOf(result, "bsc", "b11")).toEqual(SIGN_IN_ROW);
    expect(h.of(FN.bsc)).toHaveLength(2);

    const [slFirst] = h.of(FN.slFirst);
    await answer(slFirst, slFirst.ids.map((id) => slOk(id)));
    expect(h.of(FN.slFirst)).toHaveLength(3);
  });

  test("a mixed batch does not stop: one ok id keeps the side running", async () => {
    const h = harness();
    const { result } = mount(h, sides([], ids("s", 70)));
    await settle();
    const [first] = h.of(FN.slFirst);

    await answer(
      first,
      first.ids.map((id) => (id === "s7" ? slOk(id) : signedOut(id))),
    );

    expect(result.current.stopped.sportlots).toBe(false);
    expect(stateOf(result, "sportlots", "s7")).toMatchObject({ verdict: "match" });
    // Signed-out rows inside a mixed batch are ordinary "couldn't check" rows.
    expect(stateOf(result, "sportlots", "s0")).toMatchObject({
      state: "done",
      verdict: "unverifiable",
      reason: BASE_MATCH_COPY.unverifiable,
    });
    // The queue goes on: the freed slot takes the next batch.
    expect(h.of(FN.slFirst)).toHaveLength(3);
  });

  test("a mixed signed_out and timeout batch does not stop", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 12)));
    await settle();
    const [a] = h.of(FN.bsc);

    await answer(a, [
      signedOut("b0"),
      signedOut("b1"),
      signedOut("b2"),
      { id: "b3", status: "failed", kind: "timeout" },
    ]);

    expect(result.current.stopped.bsc).toBe(false);
    expect(h.of(FN.bsc)).toHaveLength(3);
  });

  test("a BSC batch the chain refused does not stop", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 12)));
    await settle();
    const [a] = h.of(FN.bsc);

    await answer(a, a.ids.map((id) => ({ id, status: "refused" })));

    expect(result.current.stopped.bsc).toBe(false);
    expect(stateOf(result, "bsc", "b0")).toMatchObject({
      verdict: "unverifiable",
      reason: BASE_MATCH_COPY.unverifiable,
    });
    expect(h.of(FN.bsc)).toHaveLength(3);
  });

  test.each(["refused", "network", "timeout", "http_error", "bad_response", "unknown"])(
    "a whole batch failed %s does not stop",
    async (kind) => {
      const h = harness();
      const { result } = mount(h, sides(ids("b", 12)));
      await settle();
      const [a] = h.of(FN.bsc);

      await answer(a, a.ids.map((id) => ({ id, status: "failed", kind })));

      expect(result.current.stopped.bsc).toBe(false);
      expect(h.of(FN.bsc)).toHaveLength(3);
    },
  );

  test("a thrown call is not a sign-in stop: its ids are ordinary unverifiable rows", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 12)));
    await settle();
    await act(async () => {
      h.of(FN.bsc)[0].reject(new Error("offline"));
    });
    await settle();

    expect(result.current.stopped.bsc).toBe(false);
    expect(stateOf(result, "bsc", "b0")).toMatchObject({
      state: "done",
      verdict: "unverifiable",
      reason: BASE_MATCH_COPY.unverifiable,
    });
    expect(h.of(FN.bsc)).toHaveLength(3);
  });

  test("a set that joins a stopped side's scope settles at once, with no call", async () => {
    const h = harness();
    const { result, rerender } = mount(h, sides([], ids("s", 40)));
    await settle();
    const [first] = h.of(FN.slFirst);
    await answer(first, first.ids.map(signedOut));
    expect(result.current.stopped.sportlots).toBe(true);
    const callsBefore = h.raw.action.mock.calls.length;

    const wider = sides([], [...ids("s", 40), "late"]);
    rerender(props(h, wider));
    await settle();

    expect(stateOf(result, "sportlots", "late")).toEqual(SIGN_IN_ROW);
    expect(h.raw.action.mock.calls.length).toBe(callsBefore);
  });

  test("a late joiner on the side still running is checked as usual", async () => {
    const h = harness();
    const { result, rerender } = mount(h, sides(ids("b", 4), ids("s", 40)));
    await settle();
    const [first] = h.of(FN.slFirst);
    await answer(first, first.ids.map(signedOut));
    expect(result.current.stopped.bsc).toBe(false);
    const [bscA] = h.of(FN.bsc);
    await answer(bscA, bscA.ids.map((id) => bscOk(id)));

    rerender(props(h, sides([...ids("b", 4), "late"], ids("s", 40))));
    await settle();

    expect(stateOf(result, "bsc", "late")).toEqual({ state: "checking" });
  });

  test("closing resets the stop, the line and the cache; reopening asks again", async () => {
    const h = harness();
    const scope = sides([], ids("s", 40));
    const { result, rerender } = mount(h, scope);
    await settle();
    const [first] = h.of(FN.slFirst);
    await answer(first, first.ids.map(signedOut));
    expect(result.current.stopped.sportlots).toBe(true);
    expect(result.current.announcement).toContain(BASE_MATCH_COPY.liveStopped("sportlots"));

    rerender(props(h, scope, false));
    await settle();
    expect(result.current.stopped).toEqual({ bsc: false, sportlots: false });
    expect(result.current.announcement).toBe("");

    rerender(props(h, scope, true));
    await settle();
    expect(result.current.stopped).toEqual({ bsc: false, sportlots: false });
    expect(result.current.announcement).not.toContain(BASE_MATCH_COPY.liveStopped("sportlots"));
    // Asked afresh: the stop did not follow it into the new sitting.
    expect(h.of(FN.slFirst).length).toBeGreaterThan(2);
    expect(stateOf(result, "sportlots", "s0")).toEqual({ state: "checking" });
  });

  test("the stop is said once in the live line", async () => {
    const h = harness();
    const { result, said } = mount(h, sides(ids("b", 12), ids("s", 70)));
    await settle();
    const [slFirst] = h.of(FN.slFirst);
    await answer(slFirst, slFirst.ids.map(signedOut));
    // More progress after the stop: it must not come back.
    const [bscA, bscB] = h.of(FN.bsc);
    await answer(bscA, bscA.ids.map((id) => bscOk(id)));
    await answer(bscB, bscB.ids.map((id) => bscOk(id)));

    const stopLine = BASE_MATCH_COPY.liveStopped("sportlots");
    expect(said.filter((line) => line.includes(stopLine))).toHaveLength(1);
    expect(result.current.stopped.sportlots).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The live line, through the hook
// ---------------------------------------------------------------------------

describe("useBaseMatchProbe: the live line", () => {
  test("is empty until the signature arrives", async () => {
    const h = harness();
    const { result } = mount(h, sides(ids("b", 4)));

    expect(result.current.phase).toBe("loading");
    expect(result.current.announcement).toBe("");
    await settle();
    expect(result.current.announcement).not.toBe("");
  });

  test("says the start line with the scope's size, then the closing sentence", async () => {
    const h = harness();
    const { result, said } = mount(h, sides(ids("b", 4)));
    await settle();
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveStart(4));

    await answer(h.of(FN.bsc)[0], [bscOk("b0"), bscOk("b1"), bscOk("b2", NOBODY), signedOut("b3")]);

    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveDone(4, 2, 1, 1));
    expect(said).toEqual([BASE_MATCH_COPY.liveStart(4), BASE_MATCH_COPY.liveDone(4, 2, 1, 1)]);
  });

  test("a four-set check goes straight from the start to the end: no quarter between", async () => {
    // One batch answers all four at once; the 25/50/75 lines are for runs
    // that have those steps, never invented in between.
    const h = harness();
    const { said } = mount(h, sides(ids("b", 4)));
    await settle();
    await answer(h.of(FN.bsc)[0], ids("b", 4).map((id) => bscOk(id)));

    expect(said.some((line) => /% done/.test(line))).toBe(false);
  });

  test("a quarter is said when a batch lands on it", async () => {
    const h = harness();
    const { result, said } = mount(h, sides(ids("b", 8)));
    await settle();
    const [a, b] = h.of(FN.bsc);

    await answer(a, a.ids.map((id) => bscOk(id)));
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveQuarter(50));

    await answer(b, b.ids.map((id) => bscOk(id)));
    expect(said).toEqual([
      BASE_MATCH_COPY.liveStart(8),
      BASE_MATCH_COPY.liveQuarter(50),
      BASE_MATCH_COPY.liveDone(8, 8, 0, 0),
    ]);
  });

  test("the total is fixed at the start: rows leaving the scope mid-run do not move it", async () => {
    const h = harness();
    const { result, rerender, said } = mount(h, sides(ids("b", 12)));
    await settle();
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveStart(12));

    // Four queued rows go away (made sets, say).
    rerender(props(h, sides(ids("b", 8))));
    await settle();
    const [a, b] = h.of(FN.bsc);
    await answer(a, a.ids.map((id) => bscOk(id)));
    await answer(b, b.ids.map((id) => bscOk(id)));

    // The start line said 12 and never changed; the closing counts the eight checked.
    expect(said[0]).toBe(BASE_MATCH_COPY.liveStart(12));
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveDone(8, 8, 0, 0));
  });

  test("a set that left the scope before it was checked counts as accounted for", async () => {
    const h = harness();
    const { result, rerender } = mount(h, sides(ids("b", 12)));
    await settle();

    // The four queued rows (b8-b11) leave: that is a third of the run done.
    rerender(props(h, sides(ids("b", 8))));
    await settle();

    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveQuarter(25));
  });

  test("no second closing after rows join the scope later (Show all, a detach)", async () => {
    const h = harness();
    const { result, rerender, said } = mount(h, sides(ids("b", 4)));
    await settle();
    await answer(h.of(FN.bsc)[0], ids("b", 4).map((id) => bscOk(id)));
    const closing = BASE_MATCH_COPY.liveDone(4, 4, 0, 0);
    expect(result.current.announcement).toBe(closing);

    rerender(props(h, sides([...ids("b", 4), "b9"])));
    await settle();
    await answer(h.of(FN.bsc)[1], [bscOk("b9")]);

    expect(result.current.announcement).toBe(closing);
    expect(said.filter((line) => line.startsWith("Checked "))).toHaveLength(1);
    // The new row was still checked.
    expect(stateOf(result, "bsc", "b9")).toMatchObject({ verdict: "match" });
  });

  test("nothing checked, nothing closed: every set leaves before an answer lands", async () => {
    const h = harness();
    const { result, rerender, said } = mount(h, sides(ids("b", 4)));
    await settle();

    rerender(props(h, sides()));
    await settle();
    await answer(h.of(FN.bsc)[0], ids("b", 4).map((id) => bscOk(id)));

    expect(said).toEqual([BASE_MATCH_COPY.liveStart(4)]);
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveStart(4));
  });

  test("an empty scope at the start says nothing at all", async () => {
    const h = harness();
    const { result } = mount(h, sides());
    await settle();

    expect(result.current.phase).toBe("on");
    expect(result.current.announcement).toBe("");
  });

  test("reopening starts the line from nothing: a stale sentence is never carried over", async () => {
    const h = harness();
    const { result, rerender } = mount(h, sides(ids("b", 4)));
    await settle();
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveStart(4));

    // Closed, then opened on a scope with nothing in it: nothing to say.
    rerender(props(h, sides(), false));
    await settle();
    rerender(props(h, sides(), true));
    await settle();

    expect(result.current.phase).toBe("on");
    expect(result.current.announcement).toBe("");
  });

  test("reopening says the start line again, however far the last sitting got", async () => {
    const h = harness();
    const scope = sides(ids("b", 8));
    const { result, rerender } = mount(h, scope);
    await settle();
    await answer(h.of(FN.bsc)[0], h.of(FN.bsc)[0].ids.map((id) => bscOk(id)));
    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveQuarter(50));

    rerender(props(h, scope, false));
    await settle();
    rerender(props(h, scope, true));
    await settle();

    expect(result.current.announcement).toBe(BASE_MATCH_COPY.liveStart(8));
  });

  test("closing the dialog clears the line", async () => {
    const h = harness();
    const scope = sides(ids("b", 4));
    const { result, rerender } = mount(h, scope);
    await settle();
    expect(result.current.announcement).not.toBe("");

    rerender(props(h, scope, false));
    await settle();

    expect(result.current.announcement).toBe("");
  });
});
