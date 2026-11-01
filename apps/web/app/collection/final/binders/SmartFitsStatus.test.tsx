/**
 * NEO-410 — a smart binder's empty-slot status line: quiet while a recompute
 * is quick, "finding" once it lasts, the failure with Try again, and focus
 * kept on the line when Try again turns the binder pending.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SmartFitsStatus, { FAILED, FINDING, PENDING_SHOWN_AFTER_MS } from "./SmartFitsStatus";

describe("SmartFitsStatus", () => {
  it("says nothing for a quick recompute, then 'finding' once it has run a second", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<SmartFitsStatus pending failed={false} onRetry={vi.fn()} />);
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("");
      act(() => vi.advanceTimersByTime(PENDING_SHOWN_AFTER_MS));
      expect(status.textContent).toBe(FINDING);
      // Landed: quiet again, the same live region still mounted.
      rerender(<SmartFitsStatus pending={false} failed={false} onRetry={vi.fn()} />);
      expect(screen.getByRole("status")).toBe(status);
      expect(status.textContent).toBe("");
      // A new spell starts quiet again.
      rerender(<SmartFitsStatus pending failed={false} onRetry={vi.fn()} />);
      expect(status.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure says so, outside the button, and Try again keeps focus on the line", async () => {
    let finish: () => void = () => {};
    const onRetry = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { rerender } = render(<SmartFitsStatus pending={false} failed onRetry={onRetry} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(FAILED);
    const button = screen.getByRole("button", { name: "Try again" });
    expect(status.contains(button)).toBe(false);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(status);
    // A second press while the first is in flight does nothing.
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The binder turns pending: the button goes, focus stays on the line.
    rerender(<SmartFitsStatus pending failed={false} onRetry={onRetry} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.activeElement).toBe(status);
    await act(async () => finish());
  });
});
