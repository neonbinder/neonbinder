import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { NOTHING_TO_UNDO, NOTICE_MS, STILL_SAVING, useFloatingClearance, useStatusLine } from "./statusLine";

/**
 * NEO-464 — the status line a page holds (`useStatusLine`) and the scroll
 * clearance kept under a field while it floats (`useFloatingClearance`).
 * Hooks are driven directly; the pages that draw them are covered in
 * `RealCollection.test`, `A11yFocusAndDrawer.test` and `panelLink.test`.
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.style.scrollPaddingBottom = "";
});

describe("Ctrl/Cmd+Z with the status line", () => {
  it("says \"Nothing to undo.\" when the line holds no Undo", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.undoLast());
    expect(result.current.notice?.message).toBe(NOTHING_TO_UNDO);
    expect(NOTHING_TO_UNDO).toBe("Nothing to undo.");
    // And when the line only says something (no Undo on it).
    act(() => result.current.notify("Saved."));
    act(() => result.current.undoLast());
    expect(result.current.notice?.message).toBe("Nothing to undo.");
  });

  it("runs the line's Undo when it has one", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Moved.", undo));
    act(() => result.current.undoLast());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.notice?.message).toBe("Undone.");
  });
});

describe("the line's Undo", () => {
  it("a store whose undo lands in the same click says Undone. at once", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", undo));
    act(() => result.current.undo());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.notice?.message).toBe("Undone.");
  });

  it("a server's undo keeps the line up, inert, until it answers; a second press does nothing", async () => {
    let finish!: () => void;
    const undo = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", undo));
    act(() => result.current.undo());
    expect(result.current.notice).toMatchObject({ message: "Removed.", undoing: true });
    act(() => result.current.undo());
    act(() => result.current.undoLast());
    expect(undo).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(result.current.notice?.message).toBe("Undone.");
  });

  it("an undo the server refuses says why on the line, and Undo can be pressed again", async () => {
    const undo = vi.fn().mockRejectedValueOnce(new Error("Gone already.")).mockResolvedValue(undefined);
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", undo));
    await act(async () => result.current.undo());
    expect(result.current.notice?.message).toBe("That undo didn't go through. Gone already.");
    // The refusal line carries no Undo of its own; a fresh write's does.
    act(() => result.current.notify("Removed again.", undo));
    await act(async () => result.current.undo());
    expect(undo).toHaveBeenCalledTimes(2);
    expect(result.current.notice?.message).toBe("Undone.");
  });

  it("an undo that throws at once is refused the same way", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() =>
      result.current.notify("Removed.", () => {
        throw new Error("Nope.");
      }),
    );
    act(() => result.current.undo());
    expect(result.current.notice?.message).toBe("That undo didn't go through. Nope.");
  });
});

/** A promise the test settles by hand, so the order of two writes is the test's. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("run: the Undo belongs to the write that is on the line (NEO-460)", () => {
  it("offers no Undo while a later write is still saving, and then undoes that write, not the earlier one", async () => {
    const addUndo = vi.fn(async () => {});
    const removeUndo = vi.fn(async () => {});
    const removeWrite = deferred<{ undo: () => Promise<void> }>();
    const { result } = renderHook(() => useStatusLine());

    await act(async () => {
      await result.current.run(async () => ({ undo: addUndo }), () => "Added.");
    });
    expect(result.current.notice).toMatchObject({ message: "Added.", undo: addUndo });

    let removing!: Promise<unknown>;
    act(() => {
      removing = result.current.run(() => removeWrite.promise, () => "Removed.");
    });
    // The remove has not landed: the add's Undo must not be offered.
    expect(result.current.notice?.undo).toBeUndefined();
    act(() => result.current.undoLast());
    expect(result.current.notice).toMatchObject({ message: "Added.", announce: STILL_SAVING });
    expect(addUndo).not.toHaveBeenCalled();

    await act(async () => {
      removeWrite.resolve({ undo: removeUndo });
      await removing;
    });
    expect(result.current.notice).toMatchObject({ message: "Removed.", undo: removeUndo });
    await act(async () => result.current.undoLast());
    expect(removeUndo).toHaveBeenCalledTimes(1);
    expect(addUndo).not.toHaveBeenCalled();
    expect(result.current.notice?.message).toBe("Undone.");
  });

  it("the line's Undo button is inert too while a later write is saving", async () => {
    const addUndo = vi.fn(async () => {});
    const removeWrite = deferred<{ undo: () => Promise<void> }>();
    const { result } = renderHook(() => useStatusLine());
    await act(async () => {
      await result.current.run(async () => ({ undo: addUndo }), () => "Added.");
    });
    act(() => void result.current.run(() => removeWrite.promise, () => "Removed."));
    act(() => result.current.undo());
    expect(addUndo).not.toHaveBeenCalled();
    await act(async () => {
      removeWrite.resolve({ undo: async () => {} });
      await removeWrite.promise;
    });
  });

  it("a later write that fails says why on the line, with no Undo, and the earlier Undo stays gone", async () => {
    const addUndo = vi.fn(async () => {});
    const removeWrite = deferred<{ undo: () => Promise<void> }>();
    const { result } = renderHook(() => useStatusLine());
    await act(async () => {
      await result.current.run(async () => ({ undo: addUndo }), () => "Added.");
    });
    let removing!: Promise<unknown>;
    act(() => {
      removing = result.current.run(() => removeWrite.promise, () => "Removed.");
    });
    await act(async () => {
      removeWrite.reject(new Error("Server said no."));
      await removing;
    });
    expect(result.current.notice?.undo).toBeUndefined();
    act(() => result.current.undoLast());
    expect(addUndo).not.toHaveBeenCalled();
    expect(result.current.notice?.message).toBe(NOTHING_TO_UNDO);
  });
});

describe("an Undo's answer never overwrites a newer notice (NEO-460)", () => {
  it("a done callback that fires after a newer notice arrived leaves the newer notice in place", async () => {
    const undoWrite = deferred();
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.notify("Something newer.", newerUndo));
    await act(async () => {
      undoWrite.resolve();
      await undoWrite.promise;
    });
    expect(result.current.notice).toMatchObject({ message: "Something newer.", undo: newerUndo });
  });

  it("an error callback that fires after a newer live-Undo notice arrived merges into it and keeps its Undo", async () => {
    const undoWrite = deferred();
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.notify("Something newer.", newerUndo));
    await act(async () => {
      undoWrite.reject(new Error("Refused."));
      await undoWrite.promise.catch(() => {});
    });
    expect(result.current.notice).toMatchObject({
      message: "That undo didn't go through. Refused. Something newer.",
      undo: newerUndo,
    });
  });

  it("a done callback that fires after a newer plain notice (no Undo) arrived leaves it in place", async () => {
    const undoWrite = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.notify("Something newer."));
    await act(async () => {
      undoWrite.resolve();
      await undoWrite.promise;
    });
    expect(result.current.notice?.message).toBe("Something newer.");
  });

  it("an error callback that fires after a newer plain notice (no Undo) arrived is said in its place", async () => {
    const undoWrite = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.notify("Something newer."));
    await act(async () => {
      undoWrite.reject(new Error("Refused."));
      await undoWrite.promise.catch(() => {});
    });
    expect(result.current.notice?.message).toBe("That undo didn't go through. Refused.");
    expect(result.current.notice?.undo).toBeUndefined();
  });

  it("a line taken down while the undo ran still gets the answer: Undone.", async () => {
    const undoWrite = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.dismiss());
    expect(result.current.notice).toBeNull();
    await act(async () => {
      undoWrite.resolve();
      await undoWrite.promise;
    });
    expect(result.current.notice?.message).toBe("Undone.");
  });

  it("a line taken down while the undo ran still gets the refusal, saying why", async () => {
    const undoWrite = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.dismiss());
    await act(async () => {
      undoWrite.reject(new Error("Refused."));
      await undoWrite.promise.catch(() => {});
    });
    expect(result.current.notice?.message).toBe("That undo didn't go through. Refused.");
  });

  it("a newer write that landed while the undo ran keeps its own Undo when the undo answers", async () => {
    const undoWrite = deferred();
    const newerUndo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    await act(async () => {
      await result.current.run(async () => ({ undo: newerUndo }), () => "Added.");
    });
    await act(async () => {
      undoWrite.resolve();
      await undoWrite.promise;
    });
    expect(result.current.notice).toMatchObject({ message: "Added.", undo: newerUndo });
  });

  it("with nothing newer, the answer still says Undone. and a refusal still says why", async () => {
    const ok = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => ok.promise));
    act(() => result.current.undo());
    await act(async () => {
      ok.resolve();
      await ok.promise;
    });
    expect(result.current.notice?.message).toBe("Undone.");
  });
});

describe("a refusal is never left unsaid (NEO-460)", () => {
  const settle = async (d: ReturnType<typeof deferred>, how: "resolve" | "reject") => {
    await act(async () => {
      if (how === "resolve") d.resolve();
      else d.reject(new Error("Nope."));
      await d.promise.catch(() => {});
    });
  };

  it("a refused write goes first in the words of a newer write's live Undo, which stays", async () => {
    const firstWrite = deferred<{ undo: () => Promise<void> }>();
    const secondUndo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run(() => firstWrite.promise, () => "First.");
    });
    await act(async () => {
      await result.current.run(async () => ({ undo: secondUndo }), () => "Second.");
    });
    expect(result.current.notice).toMatchObject({ message: "Second.", undo: secondUndo });
    const before = result.current.notice!.id;
    await act(async () => {
      firstWrite.reject(new Error("Server said no."));
      await first;
    });
    expect(result.current.notice?.message).toMatch(/Server said no\. Second\.$/);
    expect(result.current.notice?.undo).toBe(secondUndo);
    expect(result.current.notice!.id).not.toBe(before);
  });

  it("a refused write replaces the line when no newer Undo is on it", async () => {
    const write = deferred<{ undo: () => Promise<void> }>();
    const { result } = renderHook(() => useStatusLine());
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.run(() => write.promise, () => "Done.");
    });
    await act(async () => {
      write.reject(new Error("Server said no."));
      await p;
    });
    expect(result.current.notice?.message).toBe("Server said no.");
    expect(result.current.notice?.undo).toBeUndefined();
  });

  it("a refused ticket (beginWrite) merges the same way", async () => {
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    let ticket!: ReturnType<typeof result.current.beginWrite>;
    act(() => {
      ticket = result.current.beginWrite();
    });
    const newer = result.current.beginWrite;
    act(() => newer().done("Newer.", newerUndo));
    act(() => ticket.refused("Old one failed."));
    expect(result.current.notice).toMatchObject({ message: "Old one failed. Newer.", undo: newerUndo });
  });

  it("a refused undo on a line where another undo is running does not merge into it", async () => {
    const firstUndo = deferred();
    const secondUndo = deferred();
    const { result } = renderHook(() => useStatusLine());
    // Undo A starts, then is overtaken by a line B whose own undo starts.
    act(() => result.current.notify("A.", () => firstUndo.promise));
    act(() => result.current.undo());
    // A's guard blocks a second undo while A runs; let A be refused first to free it.
    await settle(firstUndo, "reject");
    // The refusal replaced the line (nothing newer): a fresh write, then its undo runs.
    act(() => result.current.notify("B.", () => secondUndo.promise));
    act(() => result.current.undo());
    expect(result.current.notice).toMatchObject({ message: "B.", undoing: true });
    // Now a refusal (a stale write's) arrives while B's undo runs: it replaces the
    // line rather than merging into the running undo's notice.
    const w = deferred<{ undo: () => Promise<void> }>();
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.run(() => w.promise, () => "W.");
    });
    await act(async () => {
      w.reject(new Error("Late."));
      await p;
    });
    expect(result.current.notice?.message).toBe("Late.");
    expect(result.current.notice?.undoing).toBeUndefined();
  });
});

describe("overlapping writes (NEO-460)", () => {
  it("an overtaken write lands without its Undo; the newer write's Undo is the one on the line", async () => {
    const slow = deferred<{ undo: () => Promise<void> }>();
    const slowUndo = vi.fn(async () => {});
    const fastUndo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run(() => slow.promise, () => "Slow.");
    });
    await act(async () => {
      await result.current.run(async () => ({ undo: fastUndo }), () => "Fast.");
    });
    await act(async () => {
      slow.resolve({ undo: slowUndo });
      await first;
    });
    expect(result.current.notice).toMatchObject({ message: "Fast.", undo: fastUndo });
    await act(async () => result.current.undoLast());
    expect(fastUndo).toHaveBeenCalledTimes(1);
    expect(slowUndo).not.toHaveBeenCalled();
  });

  it("an overtaken write that lands while the newer one still saves is said, without its Undo", async () => {
    const slow = deferred<{ undo: () => Promise<void> }>();
    const slower = deferred<{ undo: () => Promise<void> }>();
    const slowUndo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run(() => slow.promise, () => "First.");
    });
    act(() => void result.current.run(() => slower.promise, () => "Second."));
    await act(async () => {
      slow.resolve({ undo: slowUndo });
      await first;
    });
    expect(result.current.notice?.message).toBe("First.");
    expect(result.current.notice?.undo).toBeUndefined();
    act(() => result.current.undoLast());
    expect(slowUndo).not.toHaveBeenCalled();
  });

  it("an already-running undo keeps its inert Undo when a new write starts", () => {
    const undoWrite = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => void result.current.beginWrite());
    expect(result.current.notice).toMatchObject({ message: "Removed.", undoing: true });
    expect(result.current.notice?.undo).toBeDefined();
  });

  it("starting a write with beginWrite drops the Undo at once and keeps the words", async () => {
    const undo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Added.", undo));
    act(() => void result.current.beginWrite());
    expect(result.current.notice?.message).toBe("Added.");
    expect(result.current.notice?.undo).toBeUndefined();
    act(() => result.current.undoLast());
    expect(undo).not.toHaveBeenCalled();
    expect(result.current.notice).toMatchObject({ message: "Added.", announce: STILL_SAVING });
  });

  it("a ticket that is the newest lands with its Undo", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    let ticket!: ReturnType<typeof result.current.beginWrite>;
    act(() => {
      ticket = result.current.beginWrite();
    });
    act(() => ticket.done("Saved.", undo));
    expect(result.current.notice).toMatchObject({ message: "Saved.", undo });
  });
});

describe("notice ids (NEO-460)", () => {
  it("never repeat after the line is dismissed", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("One."));
    const first = result.current.notice!.id;
    act(() => result.current.dismiss());
    act(() => result.current.notify("Two."));
    expect(result.current.notice!.id).toBeGreaterThan(first);
  });

  it("an undo's Undone. never lands on a later notice that reused the origin's id", async () => {
    const undoWrite = deferred();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", () => undoWrite.promise));
    act(() => result.current.undo());
    act(() => result.current.dismiss());
    act(() => result.current.notify("Fresh."));
    await act(async () => {
      undoWrite.resolve();
      await undoWrite.promise;
    });
    expect(result.current.notice?.message).toBe("Fresh.");
  });
});

describe("the line's timer", () => {
  it("takes the line down after NOTICE_MS, not before", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Saved."));
    act(() => void vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(result.current.notice?.message).toBe("Saved.");
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.notice).toBeNull();
  });

  it("a running undo keeps its line up past NOTICE_MS until it answers", async () => {
    let finish!: () => void;
    const undo = () => new Promise<void>((r) => (finish = r));
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Removed.", undo));
    act(() => result.current.undo());
    act(() => void vi.advanceTimersByTime(NOTICE_MS * 3));
    expect(result.current.notice).toMatchObject({ message: "Removed.", undoing: true });
    await act(async () => finish());
    expect(result.current.notice?.message).toBe("Undone.");
    act(() => void vi.advanceTimersByTime(NOTICE_MS));
    expect(result.current.notice).toBeNull();
  });

  it("dismiss takes the line down now", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Saved."));
    act(() => result.current.dismiss());
    expect(result.current.notice).toBeNull();
  });

  it("an aside never replaces a live Undo, and speaks when there is none", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.inform("Hello."));
    expect(result.current.notice?.message).toBe("Hello.");
    act(() => result.current.notify("Removed.", () => {}));
    act(() => result.current.inform("Aside."));
    expect(result.current.notice?.message).toBe("Removed.");
  });
});

describe("useFloatingClearance", () => {
  const padding = () => document.documentElement.style.scrollPaddingBottom;

  it("keeps 6rem under a field while the status line floats, and puts the old padding back when it stops", () => {
    document.documentElement.style.scrollPaddingBottom = "2px";
    const { rerender, unmount } = renderHook(({ floating }) => useFloatingClearance(floating), {
      initialProps: { floating: false },
    });
    expect(padding()).toBe("2px");
    rerender({ floating: true });
    expect(padding()).toBe("6rem");
    rerender({ floating: false });
    expect(padding()).toBe("2px");
    rerender({ floating: true });
    unmount();
    expect(padding()).toBe("2px");
  });

  it("leaves the page alone while the line is not floating", () => {
    renderHook(() => useFloatingClearance(false));
    expect(padding()).toBe("");
  });
});

describe("Ctrl/Cmd+Z while a write is saving (NEO-529)", () => {
  it("says \"Still saving.\" without touching the words, a fresh id each press; once it lands, Undo is back", async () => {
    const write = deferred<{ undo: () => Promise<void> }>();
    const undo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Added.", () => {}));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.run(() => write.promise, () => "Moved.");
    });
    act(() => result.current.undoLast());
    const first = result.current.notice!;
    expect(first).toMatchObject({ message: "Added.", announce: STILL_SAVING });
    act(() => result.current.undoLast());
    expect(result.current.notice).toMatchObject({ message: "Added.", announce: STILL_SAVING });
    expect(result.current.notice!.id).toBeGreaterThan(first.id);
    await act(async () => {
      write.resolve({ undo });
      await p;
    });
    expect(result.current.notice).toMatchObject({ message: "Moved.", undo });
    expect(result.current.notice?.announce).toBeUndefined();
    await act(async () => result.current.undoLast());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("says \"Still saving.\" on its own when the line was empty", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => void result.current.beginWrite());
    act(() => result.current.undoLast());
    expect(result.current.notice?.message).toBe(STILL_SAVING);
  });

  it("a Ctrl/Cmd+Z in the same tick as beginWrite never runs the earlier write's Undo", () => {
    const addUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.notify("Added.", addUndo));
    // One handle on the hook, so both calls see the notice from before beginWrite.
    const line = result.current;
    act(() => {
      line.beginWrite();
      line.undoLast();
      line.undo();
    });
    expect(addUndo).not.toHaveBeenCalled();
    expect(result.current.notice).toMatchObject({ message: "Added.", announce: STILL_SAVING });
    expect(result.current.notice?.undo).toBeUndefined();
  });

  it("goes back to \"Nothing to undo.\" once the write was refused, here or in a dialog of its own", async () => {
    const { result } = renderHook(() => useStatusLine());
    let ticket!: ReturnType<typeof result.current.beginWrite>;
    act(() => {
      ticket = result.current.beginWrite();
    });
    act(() => ticket.refusedElsewhere());
    act(() => result.current.undoLast());
    expect(result.current.notice?.message).toBe(NOTHING_TO_UNDO);
    act(() => {
      ticket = result.current.beginWrite();
    });
    act(() => ticket.refused("No room in that box."));
    act(() => result.current.undoLast());
    expect(result.current.notice?.message).toBe(NOTHING_TO_UNDO);
  });

  it("an older write still saving does not hide the Undo a newer write brought", async () => {
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    act(() => void result.current.beginWrite());
    act(() => result.current.beginWrite().done("Newer.", newerUndo));
    act(() => result.current.undoLast());
    expect(newerUndo).toHaveBeenCalledTimes(1);
  });
});

describe("a refusal on the line (NEO-529)", () => {
  it("merged in front of a newer write's words, announces only itself; the Undo is still that write's", () => {
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    let older!: ReturnType<typeof result.current.beginWrite>;
    act(() => {
      older = result.current.beginWrite();
    });
    act(() => result.current.beginWrite().done("Moved it.", newerUndo));
    act(() => older.refused("R1."));
    expect(result.current.notice).toMatchObject({
      message: "R1. Moved it.",
      announce: "R1.",
      kind: "refusal",
      undo: newerUndo,
    });
  });

  it("a second refusal replaces the first in front of the words rather than stacking", () => {
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    let one!: ReturnType<typeof result.current.beginWrite>;
    let two!: ReturnType<typeof result.current.beginWrite>;
    act(() => {
      one = result.current.beginWrite();
      two = result.current.beginWrite();
    });
    act(() => result.current.beginWrite().done("B.", newerUndo));
    act(() => one.refused("R1."));
    act(() => two.refused("R2."));
    expect(result.current.notice).toMatchObject({ message: "R2. B.", announce: "R2.", undo: newerUndo });
    act(() => result.current.undoLast());
    expect(newerUndo).toHaveBeenCalledTimes(1);
  });

  it("a stale success never erases a refusal: write 1 starts, write 2 starts, write 2 is refused, write 1 lands", () => {
    const firstUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    let first!: ReturnType<typeof result.current.beginWrite>;
    let second!: ReturnType<typeof result.current.beginWrite>;
    act(() => {
      first = result.current.beginWrite();
    });
    act(() => {
      second = result.current.beginWrite();
    });
    act(() => second.refused("That box is full."));
    act(() => first.done("Added.", firstUndo));
    expect(result.current.notice).toMatchObject({ message: "That box is full.", kind: "refusal" });
    expect(result.current.notice?.undo).toBeUndefined();
  });

  it("an aside never replaces a refusal", async () => {
    const { result } = renderHook(() => useStatusLine());
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Nope.")), () => "Done.");
    });
    expect(result.current.notice).toMatchObject({ message: "Nope.", kind: "refusal" });
    act(() => result.current.inform("Aside."));
    expect(result.current.notice?.message).toBe("Nope.");
  });
});

describe("a newer write's success never erases an unread refusal (NEO-529)", () => {
  type Ticket = ReturnType<ReturnType<typeof useStatusLine>["beginWrite"]>;

  it("lands behind the refusal: both shown, only the success said, the Undo the success's", () => {
    const newerUndo = vi.fn();
    const { result } = renderHook(() => useStatusLine());
    let older!: Ticket;
    let newer!: Ticket;
    act(() => {
      older = result.current.beginWrite();
      newer = result.current.beginWrite();
    });
    act(() => older.refused("That box is full."));
    act(() => newer.done("Moved it.", newerUndo));
    expect(result.current.notice).toMatchObject({
      message: "That box is full. Moved it.",
      announce: "Moved it.",
      kind: "refusal",
      undo: newerUndo,
    });
    act(() => result.current.undoLast());
    expect(newerUndo).toHaveBeenCalledTimes(1);
  });

  it("run's success lands the same way", async () => {
    const write = deferred<{ undo: () => Promise<void> }>();
    const undo = vi.fn(async () => {});
    const { result } = renderHook(() => useStatusLine());
    let older!: Ticket;
    act(() => {
      older = result.current.beginWrite();
    });
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.run(() => write.promise, () => "Added.");
    });
    act(() => older.refused("Nope."));
    await act(async () => {
      write.resolve({ undo });
      await p;
    });
    expect(result.current.notice).toMatchObject({ message: "Nope. Added.", announce: "Added.", undo });
  });

  it("one refusal in front, never stacked: a later success replaces the words behind it, a later refusal the one in front", () => {
    const { result } = renderHook(() => useStatusLine());
    const begin = () => {
      let t!: Ticket;
      act(() => {
        t = result.current.beginWrite();
      });
      return t;
    };
    const w1 = begin();
    const w2 = begin();
    act(() => w1.refused("R1."));
    act(() => w2.done("B.", () => {}));
    expect(result.current.notice?.message).toBe("R1. B.");
    const w3 = begin();
    act(() => w3.done("C.", () => {}));
    expect(result.current.notice).toMatchObject({ message: "R1. C.", announce: "C." });
    const w4 = begin();
    const w5 = begin();
    act(() => w4.refused("R2."));
    act(() => w5.done("D.", () => {}));
    expect(result.current.notice).toMatchObject({ message: "R2. D.", announce: "D." });
    // And a refusal merged in front of the live Undo replaces R2 rather than stacking.
    const late = begin();
    const w6 = begin();
    act(() => w6.done("E.", () => {}));
    act(() => late.refused("R3."));
    expect(result.current.notice).toMatchObject({ message: "R3. E.", announce: "R3." });
  });

  it("carries the refusal only while it is young: past NOTICE_MS a success stands alone", () => {
    const { result } = renderHook(() => useStatusLine());
    let older!: Ticket;
    let newer!: Ticket;
    act(() => {
      older = result.current.beginWrite();
      newer = result.current.beginWrite();
    });
    act(() => older.refused("R."));
    act(() => void vi.advanceTimersByTime(NOTICE_MS / 2));
    act(() => newer.done("B.", () => {}));
    expect(result.current.notice?.message).toBe("R. B.");
    // The line's timer started over with B, so it is still up; R is now past its time.
    act(() => void vi.advanceTimersByTime(NOTICE_MS / 2 + 1));
    expect(result.current.notice?.message).toBe("R. B.");
    act(() => result.current.beginWrite().done("C.", () => {}));
    expect(result.current.notice).toMatchObject({ message: "C." });
    expect(result.current.notice?.kind).toBeUndefined();
  });

  it("a plain notify (not a write's answer) still replaces a refusal", () => {
    const { result } = renderHook(() => useStatusLine());
    act(() => result.current.beginWrite().refused("R."));
    act(() => result.current.notify("Pick a binder first."));
    expect(result.current.notice).toMatchObject({ message: "Pick a binder first." });
    expect(result.current.notice?.kind).toBeUndefined();
  });
});

describe("a refusal set in front of other words ends its sentence (NEO-529)", () => {
  type Ticket = ReturnType<ReturnType<typeof useStatusLine>["beginWrite"]>;

  it("gains a period in front of a newer success, and in front of a live Undo; alone it is left as said", () => {
    const { result } = renderHook(() => useStatusLine());
    let older!: Ticket;
    let newer!: Ticket;
    act(() => {
      older = result.current.beginWrite();
      newer = result.current.beginWrite();
    });
    act(() => older.refused("No room in that box"));
    expect(result.current.notice?.message).toBe("No room in that box");
    act(() => newer.done("Moved it.", () => {}));
    expect(result.current.notice).toMatchObject({
      message: "No room in that box. Moved it.",
      refusal: { words: "No room in that box." },
      undoFor: { words: "Moved it." },
    });
    let late!: Ticket;
    act(() => {
      late = result.current.beginWrite();
    });
    act(() => result.current.beginWrite().done("Added.", () => {}));
    act(() => late.refused("Server said no!"));
    expect(result.current.notice?.message).toBe("Server said no! Added.");
  });
});

describe("the line's spoken record", () => {
  it("is one record for the life of the line", () => {
    const { result, rerender } = renderHook(() => useStatusLine());
    const first = result.current.spoken;
    act(() => result.current.notify("Saved."));
    rerender();
    expect(result.current.spoken).toBe(first);
  });
});
