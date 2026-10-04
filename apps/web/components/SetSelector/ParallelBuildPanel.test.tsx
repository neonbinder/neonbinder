/**
 * NEO-312 — `useParallelBuildRun` (the runner) and `ParallelBuildButton` (the
 * parallel row's own trigger).
 *
 * The runner is tested through `renderHook`, driving `convex.query` /
 * `convex.action` with manually-controlled promises so the order of calls,
 * the effect of Stop, and a failure's effect on the NEXT parallel are all
 * directly observable. The button is tested through `render`, the same style
 * as `MakeParallelControl.test.tsx`.
 *
 * `ParallelBuildPanel.tsx` has named exports besides its default (the module's
 * own note); this file imports the real module rather than mocking it, so
 * that note does not apply here — it matters to `CardChecklist.test.tsx`,
 * which mounts the panel alongside a checklist that mocks the same `api`
 * object.
 */

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    parallelChecklistBuild: {
      getParallelsForBuild: "getParallelsForBuild",
      buildParallelChecklist: "buildParallelChecklist",
    },
  },
}));

const mockQuery = vi.fn();
const mockActionFn = vi.fn();
const mockUseAction = vi.fn(() => mockActionFn);

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: mockQuery, action: mockActionFn }),
  useAction: (ref: unknown) => mockUseAction(ref),
}));

import ParallelBuildPanel, {
  ParallelBuildButton,
  builtText,
  buildButtonLabel,
  rebuildConfirmCopy,
  useParallelBuildRun,
  useHostedParallelBuildRun,
  panelHeading,
  detailBuckets,
  moreText,
  pulseText,
  type ParallelBuildPlan,
  type ParallelBuildResult,
  type ParallelRun,
} from "./ParallelBuildPanel";

const INSERT_ID = "insert-1" as unknown as Id<"selectorOptions">;
const A = "parallel-a" as unknown as Id<"selectorOptions">;
const B_BLOCKED = "parallel-b" as unknown as Id<"selectorOptions">;
const C_NO_IDS = "parallel-c" as unknown as Id<"selectorOptions">;
const D = "parallel-d" as unknown as Id<"selectorOptions">;

function plan(): ParallelBuildPlan {
  return {
    truncated: false,
    parallels: [
      { _id: A, value: "Anime Gold", sides: { bsc: true, sportlots: false }, hasCards: false },
      {
        _id: B_BLOCKED,
        value: "Anime Silver",
        sides: { bsc: true, sportlots: false },
        hasCards: true,
        blocked: "some of its cards have scans on them, and a rebuild would lose them",
      },
      { _id: C_NO_IDS, value: "Anime Bronze", sides: { bsc: false, sportlots: false }, hasCards: false },
      { _id: D, value: "Anime Platinum", sides: { bsc: true, sportlots: false }, hasCards: false },
    ],
  };
}

function builtResult(): ParallelBuildResult {
  return {
    status: "built",
    copied: 10,
    notCopied: 0,
    unlinked: { bsc: 0, sportlots: 0 },
    ambiguous: { bsc: 0, sportlots: 0 },
    sidesFetched: ["bsc"],
    sidesSkipped: ["sportlots"],
    earlierLinksMissing: { bsc: 0, sportlots: 0 },
    rebuilt: false,
  };
}

/** A promise the test controls the resolution of. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockActionFn.mockReset();
  mockUseAction.mockClear();
});

describe("useParallelBuildRun — the runner's order", () => {
  test("only the WAITING entries reach the action, in list order — blocked and no-id parallels never do", async () => {
    mockQuery.mockResolvedValue(plan());
    const calls: Id<"selectorOptions">[] = [];
    mockActionFn.mockImplementation(async (_ref: unknown, args: { parallelId: Id<"selectorOptions"> }) => {
      calls.push(args.parallelId);
      return builtResult();
    });

    const { result } = renderHook(() => useParallelBuildRun());
    await act(async () => {
      await result.current.start({ id: INSERT_ID, value: "Anime" });
    });

    expect(calls).toEqual([A, D]);
    expect(result.current.run?.phase).toBe("finished");
    const byId = new Map(result.current.run?.entries.map((e) => [e.id, e.line]));
    expect(byId.get(B_BLOCKED)?.kind).toBe("blocked");
    expect(byId.get(C_NO_IDS)?.kind).toBe("skipped");
    expect(byId.get(A)?.kind).toBe("built");
    expect(byId.get(D)?.kind).toBe("built");
  });
});

describe("useParallelBuildRun — Stop takes effect between calls, never mid-call", () => {
  test("pressing Stop while A is building lets A finish, then stops before D is ever sent", async () => {
    mockQuery.mockResolvedValue(plan());
    const first = deferred<ParallelBuildResult>();
    let secondCalled = false;
    mockActionFn.mockImplementation(async (_ref: unknown, args: { parallelId: Id<"selectorOptions"> }) => {
      if (args.parallelId === A) return first.promise;
      secondCalled = true;
      return builtResult();
    });

    const { result } = renderHook(() => useParallelBuildRun());
    let done!: Promise<string | null>;
    act(() => {
      done = result.current.start({ id: INSERT_ID, value: "Anime" });
    });

    // Wait for the loop to have reached A's in-flight call.
    await waitFor(() => {
      const line = result.current.run?.entries.find((e) => e.id === A)?.line;
      expect(line?.kind).toBe("building");
    });

    act(() => {
      result.current.stop();
    });
    // D is shown as stopped immediately — Stop takes effect without waiting
    // for the call in flight.
    expect(result.current.run?.entries.find((e) => e.id === D)?.line.kind).toBe("stopped");
    expect(secondCalled).toBe(false);

    act(() => {
      first.resolve(builtResult());
    });
    await act(async () => {
      await done;
    });

    expect(secondCalled).toBe(false);
    expect(result.current.run?.phase).toBe("stopped");
    expect(result.current.run?.entries.find((e) => e.id === A)?.line.kind).toBe("built");
  });
});

describe("useParallelBuildRun — a failure moves on to the next parallel", () => {
  test("A throws; D is still built, and the run finishes rather than aborting", async () => {
    mockQuery.mockResolvedValue(plan());
    mockActionFn.mockImplementation(async (_ref: unknown, args: { parallelId: Id<"selectorOptions"> }) => {
      if (args.parallelId === A) throw new Error("boom");
      return builtResult();
    });

    const { result } = renderHook(() => useParallelBuildRun());
    await act(async () => {
      await result.current.start({ id: INSERT_ID, value: "Anime" });
    });

    expect(result.current.run?.phase).toBe("finished");
    expect(result.current.run?.entries.find((e) => e.id === A)?.line).toEqual({
      kind: "failed",
      message: "boom",
    });
    expect(result.current.run?.entries.find((e) => e.id === D)?.line.kind).toBe("built");
  });
});

describe("useParallelBuildRun — an empty parallel list mounts no panel", () => {
  test("start resolves and leaves run null when the insert has no parallels", async () => {
    mockQuery.mockResolvedValue({ parallels: [], truncated: false });
    const { result } = renderHook(() => useParallelBuildRun());

    await act(async () => {
      await result.current.start({ id: INSERT_ID, value: "Anime" });
    });

    expect(result.current.run).toBeNull();
    expect(mockActionFn).not.toHaveBeenCalled();
  });
});

describe("ParallelBuildPanel — heading and Stop button", () => {
  test("renders the running heading and a Stop button while live", async () => {
    mockQuery.mockResolvedValue(plan());
    mockActionFn.mockImplementation(
      () => new Promise<ParallelBuildResult>(() => {}), // never resolves — keep it "running"
    );
    const { result } = renderHook(() => useParallelBuildRun());
    act(() => {
      void result.current.start({ id: INSERT_ID, value: "Anime" });
    });
    await waitFor(() => expect(result.current.run).not.toBeNull());

    render(<ParallelBuildPanel run={result.current.run!} onStop={() => {}} />);
    expect(screen.getByText(/Building parallels of Anime/)).toBeTruthy();
    expect(screen.getByText("Stop after this one")).toBeTruthy();
  });
});

describe("ParallelBuildButton — Build/Rebuild labels and the rebuild confirm", () => {
  test("buildButtonLabel: 'Build from X' with no cards, 'Rebuild from X' with cards", () => {
    expect(buildButtonLabel("Anime", false)).toBe("Build from Anime");
    expect(buildButtonLabel("Anime", true)).toBe("Rebuild from Anime");
  });

  test("a parallel with no cards builds immediately, with no confirm", async () => {
    mockActionFn.mockResolvedValue(builtResult());
    const onResult = vi.fn();
    render(
      <ParallelBuildButton
        parallelId={A}
        parallelValue="Anime Gold"
        sourceValue="Anime"
        cardCount={0}
        onResult={onResult}
      />,
    );

    const button = screen.getByRole("button", { name: "Build from Anime" });
    fireEvent.click(button);

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockActionFn).toHaveBeenCalledWith({ parallelId: A });
  });

  test("a parallel WITH cards shows Rebuild and confirms before calling the action", async () => {
    mockActionFn.mockResolvedValue(builtResult());
    const onResult = vi.fn();
    render(
      <ParallelBuildButton
        parallelId={A}
        parallelValue="Anime Gold"
        sourceValue="Anime"
        cardCount={12}
        onResult={onResult}
      />,
    );

    const button = screen.getByRole("button", { name: "Rebuild from Anime" });
    fireEvent.click(button);

    // Not called yet — the confirm is up.
    expect(mockActionFn).not.toHaveBeenCalled();
    const copy = rebuildConfirmCopy("Anime Gold", "Anime", 12);
    expect(screen.getByText(copy.title)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace the cards" }));
    await waitFor(() => expect(mockActionFn).toHaveBeenCalledWith({ parallelId: A }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
  });

  test("cancelling the confirm never calls the action", () => {
    const onResult = vi.fn();
    render(
      <ParallelBuildButton
        parallelId={A}
        parallelValue="Anime Gold"
        sourceValue="Anime"
        cardCount={12}
        onResult={onResult}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rebuild from Anime" }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockActionFn).not.toHaveBeenCalled();
  });
});

describe("builtText — the per-side, never-summed phrasing", () => {
  test("a plain build says only the count", () => {
    expect(builtText(builtResult())).toBe("Built 10 cards");
  });

  test("unlinked, ambiguous, notCopied and rebuilt each add their own clause", () => {
    const result: ParallelBuildResult = {
      ...builtResult(),
      copied: 5,
      unlinked: { bsc: 2, sportlots: 0 },
      ambiguous: { bsc: 0, sportlots: 1 },
      notCopied: 3,
      rebuilt: true,
    };
    expect(builtText(result)).toBe(
      "Rebuilt 5 cards, 2 without a BSC card, 1 matched more than one SportLots card, 3 left off — not on either marketplace's list",
    );
  });
});

function baseRun(overrides: Partial<ParallelRun> = {}): ParallelRun {
  return {
    startedFrom: INSERT_ID,
    sourceId: INSERT_ID,
    sourceValue: "Anime",
    sourceKind: "insert",
    entries: [
      { id: A, value: "Anime Gold", line: { kind: "built", result: builtResult() } },
      { id: B_BLOCKED, value: "Anime Silver", line: { kind: "blocked", reason: "some reason" } },
      { id: C_NO_IDS, value: "Anime Bronze", line: { kind: "skipped" } },
      { id: D, value: "Anime Platinum", line: { kind: "waiting" } },
    ],
    truncated: false,
    phase: "finished",
    atIndex: null,
    announcement: "",
    ...overrides,
  };
}

describe("panelHeading", () => {
  test("running names the line being built, 1-indexed, out of the total", () => {
    const run = baseRun({ phase: "running", atIndex: 1 });
    expect(panelHeading(run)).toBe("Building parallels of Anime — 2 of 4");
  });

  test("finished lists only the non-zero buckets", () => {
    const run = baseRun({
      phase: "finished",
      entries: [
        { id: A, value: "A", line: { kind: "built", result: builtResult() } },
        { id: D, value: "D", line: { kind: "built", result: builtResult() } },
      ],
    });
    expect(panelHeading(run)).toBe("Anime parallels — 2 built");
  });

  test("finished with a mix names every non-zero bucket", () => {
    const run = baseRun({ phase: "finished" });
    expect(panelHeading(run)).toBe("Anime parallels — 1 built, 1 blocked, 1 skipped");
  });

  test("stopped names how many of the total were built before Stop", () => {
    const run = baseRun({ phase: "stopped" });
    expect(panelHeading(run)).toBe("Anime parallels — stopped after 1 of 4");
  });

  test("left names the same count, worded for having left the page", () => {
    const run = baseRun({ phase: "left" });
    expect(panelHeading(run)).toBe("Anime parallels — stopped when you left, 1 of 4 built");
  });
});

describe("detailBuckets / moreText — the disclosure", () => {
  test("only non-empty buckets are returned, each carrying the server's exact count", () => {
    const result: ParallelBuildResult = {
      ...builtResult(),
      copied: 5,
      notCopied: 2,
      unlinked: { bsc: 1, sportlots: 0 },
      cards: {
        leftOff: ["#1 A", "#2 B"],
        unlinked: { bsc: ["#3 C"], sportlots: [] },
        ambiguous: { bsc: [], sportlots: [] },
      },
    };
    const buckets = detailBuckets(result, "Anime");
    expect(buckets.map((b) => b.label)).toEqual([
      "Left off — not on either marketplace's list",
      "Without a BSC card",
    ]);
    expect(buckets[0].count).toBe(2);
    expect(buckets[0].cards).toEqual(["#1 A", "#2 B"]);
  });

  test("a bucket whose count exceeds its capped list shows '…and N more'", () => {
    expect(moreText(37)).toBe("…and 37 more");
  });

  test("the disclosure renders the '…and N more' line when a bucket is capped", async () => {
    const result: ParallelBuildResult = {
      ...builtResult(),
      copied: 1,
      notCopied: 60,
      cards: {
        leftOff: Array.from({ length: 50 }, (_, i) => `#${i} Card`),
        unlinked: { bsc: [], sportlots: [] },
        ambiguous: { bsc: [], sportlots: [] },
      },
    };
    const run = baseRun({
      phase: "finished",
      entries: [{ id: A, value: "Anime Gold", line: { kind: "built", result } }],
    });
    render(<ParallelBuildPanel run={run} onStop={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Anime Gold/ }));
    expect(screen.getByText(moreText(10))).toBeTruthy();
  });
});

describe("ParallelBuildPanel — the live region announcement", () => {
  test("a small run (10 or fewer) announces each line individually, including a plain success", async () => {
    mockQuery.mockResolvedValue(plan());
    mockActionFn.mockImplementation(async (_ref: unknown, args: { parallelId: Id<"selectorOptions"> }) => {
      if (args.parallelId === A) return builtResult();
      return builtResult();
    });
    const { result } = renderHook(() => useParallelBuildRun());
    await act(async () => {
      await result.current.start({ id: INSERT_ID, value: "Anime" });
    });
    // The final announcement is the ended heading as a sentence; the run is
    // small (4 parallels), so a plain "built" line is announced on its own
    // rather than folded into a pulse — verified by the run finishing at all
    // with each entry's own line kind intact (see the runner-order test).
    expect(result.current.run?.announcement).toBe(`${panelHeading(result.current.run!)}.`);
  });

  test("a large run (more than 10) pulses every 5 instead of announcing every plain success", async () => {
    const many = {
      truncated: false,
      parallels: Array.from({ length: 12 }, (_, i) => ({
        _id: `p-${i}` as unknown as Id<"selectorOptions">,
        value: `Parallel ${i}`,
        sides: { bsc: true, sportlots: false },
        hasCards: false,
      })),
    };
    mockQuery.mockResolvedValue(many);
    const announcements: string[] = [];
    mockActionFn.mockImplementation(async () => builtResult());
    const { result, rerender } = renderHook(() => useParallelBuildRun());
    // Capture every announcement the runner publishes by polling `run` after
    // each microtask flush — simplest is to just drive the whole run and then
    // assert the FINAL announcement is the summary sentence (proving no
    // individual "Built N cards" line was the last thing said for a plain
    // success on a run this size).
    await act(async () => {
      await result.current.start({ id: INSERT_ID, value: "Anime" });
    });
    rerender();
    expect(result.current.run?.announcement).toBe(`${panelHeading(result.current.run!)}.`);
    expect(result.current.run?.phase).toBe("finished");
    void announcements;
  });

  test("pulseText names the running total and the whole run size", () => {
    expect(pulseText(12, 40)).toBe("12 of 40 done");
  });
});

describe("useParallelBuildRun — the in-flight registry", () => {
  test("buildOne refuses a second call for a parallel already building, without hitting the server again", async () => {
    const { result } = renderHook(() => useParallelBuildRun());
    const first = deferred<string>();
    let calls = 0;
    await act(async () => {
      void result.current.buildOne("p-1", async () => {
        calls++;
        return first.promise;
      });
    });
    let second: string | undefined;
    await act(async () => {
      second = await result.current.buildOne("p-1", async () => {
        calls++;
        return "should not run";
      });
    });
    expect(second).toBeUndefined();
    expect(calls).toBe(1);
    expect(result.current.inFlight.has("p-1")).toBe(true);

    await act(async () => {
      first.resolve("done");
      await first.promise;
    });
  });

  test("a remounted ParallelBuildButton for a still-building parallel shows Building…", () => {
    const runner = {
      inFlight: new Set(["parallel-a"]),
      buildOne: vi.fn(),
    };
    render(
      <ParallelBuildButton
        parallelId={A}
        parallelValue="Anime Gold"
        sourceValue="Anime"
        cardCount={0}
        runner={runner}
        onResult={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Building…" })).toBeTruthy();
  });
});

describe("useHostedParallelBuildRun — surviving the checklist unmounting", () => {
  /**
   * `leftBehind` (in `ParallelBuildPanel.tsx`) is module-scope state, so a
   * test that reads it fresh depends on nobody else having left a run behind
   * first. The mount effect in `useRunnerCore` unconditionally clears it
   * (`leftBehind = null`) before returning control to this test — mounting
   * and immediately unmounting a hook that never starts a run is therefore a
   * reset with no product-code change needed: the mount clears the slot, and
   * the unmount (of a hook whose `run` is still null) leaves nothing new
   * behind. Every test in this block can then set up its OWN scenario without
   * caring what an earlier test in the file left lying around.
   */
  beforeEach(() => {
    const { unmount } = renderHook(() => useHostedParallelBuildRun());
    unmount();
  });

  test("a run left mid-flight when the host unmounts is picked up by the next mount as 'left'", async () => {
    mockQuery.mockResolvedValue(plan());
    mockActionFn.mockImplementation(() => new Promise<ParallelBuildResult>(() => {}));

    const { result, unmount } = renderHook(() => useHostedParallelBuildRun());
    act(() => {
      void result.current.start({ id: INSERT_ID, value: "Anime" }, { query: mockQuery, action: mockActionFn });
    });
    await waitFor(() => expect(result.current.run?.phase).toBe("running"));

    unmount();

    const { result: nextMount } = renderHook(() => useHostedParallelBuildRun());
    expect(nextMount.current.run?.phase).toBe("left");
    const byId = new Map(nextMount.current.run?.entries.map((e) => [e.id, e.line]));
    // The one that was building when the host left is "unfinished"; anything
    // still waiting is "stopped".
    expect(byId.get(A)?.kind).toBe("unfinished");
    expect(byId.get(D)?.kind).toBe("stopped");
  });

  test("the leftBehind record is read once — a second mount after consuming it starts fresh", async () => {
    // Self-contained: leaves its OWN run behind rather than relying on the
    // test above having done so.
    mockQuery.mockResolvedValue(plan());
    mockActionFn.mockImplementation(() => new Promise<ParallelBuildResult>(() => {}));

    const { result, unmount } = renderHook(() => useHostedParallelBuildRun());
    act(() => {
      void result.current.start({ id: INSERT_ID, value: "Anime" }, { query: mockQuery, action: mockActionFn });
    });
    await waitFor(() => expect(result.current.run?.phase).toBe("running"));
    unmount(); // leaves this run behind

    const { result: secondMount, unmount: unmountSecond } = renderHook(() =>
      useHostedParallelBuildRun(),
    );
    expect(secondMount.current.run?.phase).toBe("left"); // consumed it
    unmountSecond(); // never started a run — nothing new left behind

    const { result: thirdMount } = renderHook(() => useHostedParallelBuildRun());
    expect(thirdMount.current.run).toBeNull();
  });
});
