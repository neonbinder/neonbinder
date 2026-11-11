/**
 * PR 451 (NEO-487) — a value that moves at most once per interval.
 *
 * Built for the checklist's "Still looking up teams for N cards" line, whose
 * count ticks down as the background lookup answers cards. The properties
 * worth pinning: the first change is not held back, changes inside the
 * interval collapse to the latest, and the last value always arrives.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrottledValue } from "./useThrottledValue";

describe("useThrottledValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const mount = (initial: number) =>
    renderHook(({ value }: { value: number }) => useThrottledValue(value, 5000), {
      initialProps: { value: initial },
    });

  it("starts at the value it mounts with", () => {
    const { result } = mount(7);
    expect(result.current).toBe(7);
  });

  it("lets the first change through on the next tick, not after a whole interval", () => {
    const { result, rerender } = mount(0);
    rerender({ value: 3 });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toBe(3);
  });

  it("collapses changes inside the interval into the latest, delivered when it ends", () => {
    const { result, rerender } = mount(5);
    rerender({ value: 4 });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toBe(4);

    // Three more answers a second apart: none shows until 5 s after the 4.
    rerender({ value: 3 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ value: 2 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ value: 1 });
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(result.current).toBe(4);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(1);
  });

  it("goes quiet when the value returns to what is shown", () => {
    const { result, rerender } = mount(2);
    rerender({ value: 1 });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    rerender({ value: 0 });
    rerender({ value: 1 });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(1);
  });

  it("lands a change straight away again after a quiet spell longer than the interval", () => {
    const { result, rerender } = mount(3);
    rerender({ value: 2 });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    rerender({ value: 1 });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toBe(1);
  });
});
