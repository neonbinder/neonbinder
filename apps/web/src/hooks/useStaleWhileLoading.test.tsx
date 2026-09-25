/**
 * NEO-307 — the last answer, held while the next one loads.
 *
 * `useQuery` answers `undefined` between an args change and its result, so a
 * warning keyed on what the operator types blinks off on every keystroke
 * without this. The property worth guarding hardest is the reset: an answer
 * about one row must never be shown on another.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStaleWhileLoading } from "./useStaleWhileLoading";

describe("useStaleWhileLoading", () => {
  it("passes a defined value straight through", () => {
    const answer = ["Los Angeles Dodgers"];
    const { result } = renderHook(() => useStaleWhileLoading(answer, "row-1"));
    expect(result.current).toBe(answer);
  });

  it("holds the previous answer while the next one is undefined, then takes the new one", () => {
    const first = ["Los Angeles Dodgers"];
    const second: string[] = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: string[] | undefined }) => useStaleWhileLoading(value, "row-1"),
      { initialProps: { value: first as string[] | undefined } },
    );

    rerender({ value: undefined });
    expect(result.current).toBe(first);
    rerender({ value: undefined });
    expect(result.current).toBe(first);
    rerender({ value: second });
    expect(result.current).toBe(second);
    rerender({ value: undefined });
    expect(result.current).toBe(second);
  });

  it("is undefined before any answer has arrived", () => {
    const { result } = renderHook(() => useStaleWhileLoading(undefined, "row-1"));
    expect(result.current).toBeUndefined();
  });

  it("never carries an answer across a reset key", () => {
    const first = ["Los Angeles Dodgers"];
    const { result, rerender } = renderHook(
      ({ value, key }: { value: string[] | undefined; key: string }) =>
        useStaleWhileLoading(value, key),
      { initialProps: { value: first as string[] | undefined, key: "row-1" } },
    );

    rerender({ value: undefined, key: "row-2" });
    expect(result.current).toBeUndefined();
    // …and going back does not resurrect it either: the switch dropped it,
    // so row 1 shows nothing until row 1 answers again.
    rerender({ value: undefined, key: "row-1" });
    expect(result.current).toBeUndefined();
  });
});
