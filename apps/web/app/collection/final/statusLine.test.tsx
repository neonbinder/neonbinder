import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { NOTHING_TO_UNDO, NOTICE_MS, useFloatingClearance, useStatusLine } from "./statusLine";

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
