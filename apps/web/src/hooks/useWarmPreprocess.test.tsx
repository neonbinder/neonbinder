/**
 * NEO-170 — the mount warm-up.
 *
 * Three properties matter and none is visible at runtime: it fires (so the model
 * starts loading while the user picks files), it fires AT MOST once even under
 * StrictMode's double-mount (so it is not a loop against a public action), and a
 * failure is swallowed (so a cold or not-yet-deployed warm-up can never fault
 * the page).
 */

import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warm: vi.fn() }));

// Only the action matters; the ref the hook builds is opaque, so the mock
// ignores it.
vi.mock("convex/react", () => ({
  useAction: () => mocks.warm,
}));

import { useWarmPreprocess } from "./useWarmPreprocess";

function Harness() {
  useWarmPreprocess();
  return null;
}

describe("useWarmPreprocess", () => {
  beforeEach(() => {
    mocks.warm = vi.fn().mockResolvedValue(undefined);
  });

  it("fires the warm-up once on mount, with no args", async () => {
    render(<Harness />);
    await waitFor(() => expect(mocks.warm).toHaveBeenCalledTimes(1));
    expect(mocks.warm).toHaveBeenCalledWith({});
  });

  it("does not re-fire on re-render", async () => {
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(mocks.warm).toHaveBeenCalledTimes(1));
    rerender(<Harness />);
    rerender(<Harness />);
    expect(mocks.warm).toHaveBeenCalledTimes(1);
  });

  it("fires once under StrictMode's mount→unmount→mount", async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    // The ref latch survives the double-invoke, so exactly one call — not two,
    // and not zero.
    await waitFor(() => expect(mocks.warm).toHaveBeenCalledTimes(1));
  });

  it("swallows a warm-up failure rather than throwing into the page", async () => {
    mocks.warm = vi.fn().mockRejectedValue(new Error("preprocess service cold"));
    // The render itself must not throw; the rejection is caught inside the hook.
    expect(() => render(<Harness />)).not.toThrow();
    await waitFor(() => expect(mocks.warm).toHaveBeenCalledTimes(1));
  });
});
