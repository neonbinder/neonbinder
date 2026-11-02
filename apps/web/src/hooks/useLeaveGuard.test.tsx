/**
 * NEO-370 — asks before leaving while a guarded run is unfinished: tab
 * close, in-app links, and Back/Forward (restored on "Stay").
 */

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLeaveGuard } from "./useLeaveGuard";

const MESSAGE = "Leave anyway?";

function Page({ active }: { active: boolean }) {
  useLeaveGuard(active, MESSAGE);
  return (
    <>
      <a href="/inventory">Inventory</a>
      <a href={window.location.pathname}>This page</a>
      <a href="/inventory" target="_blank">
        New tab
      </a>
    </>
  );
}

let confirm: ReturnType<typeof vi.fn>;
let go: ReturnType<typeof vi.fn>;
let landed: ReturnType<typeof vi.fn>;
const onLand = (event: MouseEvent) => {
  landed(event.defaultPrevented);
  event.preventDefault();
};

beforeEach(() => {
  confirm = vi.fn(() => false);
  // happy-dom has no window.confirm: put one in place for each test.
  Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
  go = vi.fn();
  vi.spyOn(window.history, "go").mockImplementation(go as never);
  landed = vi.fn();
  document.addEventListener("click", onLand);
});
afterEach(() => {
  document.removeEventListener("click", onLand);
  cleanup();
  vi.restoreAllMocks();
});

const back = (idx: number) => act(() => void window.dispatchEvent(new PopStateEvent("popstate", { state: { idx } })));

describe("useLeaveGuard", () => {
  it("does nothing while inactive", () => {
    render(<Page active={false} />);
    fireEvent.click(screen.getByText("Inventory"));
    expect(confirm).not.toHaveBeenCalled();
    expect(landed).toHaveBeenCalledWith(false);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("asks on tab close or reload", () => {
    renderHook(() => useLeaveGuard(true, MESSAGE));
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("an in-app link asks; Stay stops it, Leave lets it go", () => {
    render(<Page active />);
    fireEvent.click(screen.getByText("Inventory"));
    expect(confirm).toHaveBeenCalledWith(MESSAGE);
    expect(landed).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText("Inventory"));
    expect(landed).toHaveBeenCalledWith(false);
  });

  it("a link to the same page, a new tab, or a modifier click is not asked about", () => {
    render(<Page active />);
    fireEvent.click(screen.getByText("This page"));
    fireEvent.click(screen.getByText("New tab"));
    fireEvent.click(screen.getByText("Inventory"), { metaKey: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(landed).toHaveBeenCalledTimes(3);
  });

  it("Back asks; Stay steps history back to where the user was", () => {
    window.history.replaceState({ idx: 3 }, "");
    renderHook(() => useLeaveGuard(true, MESSAGE));
    back(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(1);
    // The restoring pop is not asked about.
    back(3);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("Back with Leave goes, and nothing is restored", () => {
    window.history.replaceState({ idx: 5 }, "");
    confirm.mockReturnValue(true);
    renderHook(() => useLeaveGuard(true, MESSAGE));
    back(4);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
  });

  it("Stay parks focus through onStay once history is back, and only once", () => {
    window.history.replaceState({ idx: 7 }, "");
    const onStay = vi.fn(() => true);
    const { rerender } = renderHook(() => useLeaveGuard(true, MESSAGE, { onStay }));
    back(6);
    expect(go).toHaveBeenCalledWith(1);
    // Still on the entry the user tried to go to: not yet.
    window.history.replaceState({ idx: 6 }, "");
    rerender();
    expect(onStay).not.toHaveBeenCalled();
    window.history.replaceState({ idx: 7 }, "");
    back(7);
    rerender();
    expect(onStay).toHaveBeenCalledTimes(1);
    rerender();
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it("Stay after the page remounted: the new mount parks focus, retrying until its target is drawn", () => {
    window.history.replaceState({ idx: 9 }, "");
    const first = renderHook(() => useLeaveGuard(true, MESSAGE));
    back(8);
    expect(go).toHaveBeenCalledWith(1);
    // The router drew the other page: the guarding component is gone.
    first.unmount();
    window.history.replaceState({ idx: 9 }, "");
    let drawn = false;
    const onStay = vi.fn(() => drawn);
    const again = renderHook(() => useLeaveGuard(false, MESSAGE, { onStay }));
    expect(onStay).toHaveBeenCalledTimes(1);
    drawn = true;
    again.rerender();
    expect(onStay).toHaveBeenCalledTimes(2);
    again.rerender();
    expect(onStay).toHaveBeenCalledTimes(2);
  });

  it("Back with Leave never moves focus", () => {
    window.history.replaceState({ idx: 4 }, "");
    confirm.mockReturnValue(true);
    const onStay = vi.fn(() => true);
    const { rerender } = renderHook(() => useLeaveGuard(true, MESSAGE, { onStay }));
    back(3);
    window.history.replaceState({ idx: 4 }, "");
    rerender();
    expect(onStay).not.toHaveBeenCalled();
  });

  it("stops asking once inactive", () => {
    const { rerender } = render(<Page active />);
    rerender(<Page active={false} />);
    fireEvent.click(screen.getByText("Inventory"));
    expect(confirm).not.toHaveBeenCalled();
  });
});
