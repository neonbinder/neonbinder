/**
 * NEO-224 — `useComboboxHighlight`: the keyed, derived cursor behind every
 * Set Builder column. Pinned here in isolation so a regression in the hook is
 * named as the hook's, not read off the EntitySelector suites.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useComboboxHighlight } from "./useComboboxHighlight";

type Args = { keys: string[]; seed: string | null; seedOn: string };

function setup(initial: Args) {
  return renderHook((args: Args) => useComboboxHighlight(args), {
    initialProps: initial,
  });
}

describe("useComboboxHighlight", () => {
  it("rests on the seed before any arrow press", () => {
    const { result } = setup({ keys: ["a", "b", "c"], seed: "b", seedOn: "1" });

    expect(result.current.highlighted).toBe("b");
  });

  it("has no highlight when the seed is null", () => {
    const { result } = setup({ keys: ["a", "b"], seed: null, seedOn: "1" });

    expect(result.current.highlighted).toBeNull();
  });

  it("ignores a seed that is not among the keys", () => {
    const { result } = setup({ keys: ["a", "b"], seed: "zzz", seedOn: "1" });

    expect(result.current.highlighted).toBeNull();
  });

  it("moves down and up one key at a time and reports where it landed", () => {
    const { result } = setup({ keys: ["a", "b", "c"], seed: "a", seedOn: "1" });

    let landed: string | null = null;
    act(() => {
      landed = result.current.move(1);
    });
    expect(landed).toBe("b");
    expect(result.current.highlighted).toBe("b");

    act(() => {
      landed = result.current.move(-1);
    });
    expect(landed).toBe("a");
    expect(result.current.highlighted).toBe("a");
  });

  it("does not wrap at either end", () => {
    const { result } = setup({ keys: ["a", "b"], seed: "a", seedOn: "1" });

    act(() => {
      result.current.move(-1);
    });
    expect(result.current.highlighted).toBe("a");

    act(() => {
      result.current.move(1);
    });
    act(() => {
      result.current.move(1);
    });
    expect(result.current.highlighted).toBe("b");
  });

  it("from no highlight, Down lands on the first key and Up on the last", () => {
    const down = setup({ keys: ["a", "b", "c"], seed: null, seedOn: "1" });
    act(() => {
      down.result.current.move(1);
    });
    expect(down.result.current.highlighted).toBe("a");

    const up = setup({ keys: ["a", "b", "c"], seed: null, seedOn: "1" });
    act(() => {
      up.result.current.move(-1);
    });
    expect(up.result.current.highlighted).toBe("c");
  });

  it("returns null and highlights nothing when there are no keys", () => {
    const { result } = setup({ keys: [], seed: null, seedOn: "1" });

    let landed: string | null = "unset";
    act(() => {
      landed = result.current.move(1);
    });

    expect(landed).toBeNull();
    expect(result.current.highlighted).toBeNull();
  });

  it("forgets an arrow move when seedOn changes, falling back to the new seed", () => {
    const { result, rerender } = setup({
      keys: ["a", "b", "c"],
      seed: "a",
      seedOn: "1",
    });
    act(() => {
      result.current.move(1);
    });
    expect(result.current.highlighted).toBe("b");

    rerender({ keys: ["a", "b", "c"], seed: "c", seedOn: "2" });

    expect(result.current.highlighted).toBe("c");
  });

  it("keeps an arrow move while seedOn is unchanged, even if the seed moves", () => {
    const { result, rerender } = setup({
      keys: ["a", "b", "c"],
      seed: "a",
      seedOn: "1",
    });
    act(() => {
      result.current.move(1);
    });

    rerender({ keys: ["a", "b", "c"], seed: "c", seedOn: "1" });

    expect(result.current.highlighted).toBe("b");
  });

  it("is keyed, not indexed: a re-ordered list keeps the same row highlighted", () => {
    const { result, rerender } = setup({
      keys: ["a", "b", "c"],
      seed: "a",
      seedOn: "1",
    });
    act(() => {
      result.current.move(1);
    });

    rerender({ keys: ["c", "b", "a"], seed: "a", seedOn: "1" });

    expect(result.current.highlighted).toBe("b");
  });

  it("falls back to the seed when the moved-to key leaves the list", () => {
    const { result, rerender } = setup({
      keys: ["a", "b", "c"],
      seed: "a",
      seedOn: "1",
    });
    act(() => {
      result.current.move(1);
    });

    rerender({ keys: ["a", "c"], seed: "a", seedOn: "1" });

    expect(result.current.highlighted).toBe("a");
  });

  it("moves from the live position after the list changes under it", () => {
    const { result, rerender } = setup({
      keys: ["a", "b", "c"],
      seed: "b",
      seedOn: "1",
    });
    rerender({ keys: ["a", "x", "b", "c"], seed: "b", seedOn: "1" });

    act(() => {
      result.current.move(-1);
    });

    expect(result.current.highlighted).toBe("x");
  });
});
