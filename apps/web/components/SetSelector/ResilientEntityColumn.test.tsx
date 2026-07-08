/**
 * NEO-83 — ResilientEntityColumn stalled-read backstop.
 *
 * The column heading is gated on the `getSelectorOptions` read; a Convex
 * reactive subscription's initial value can rarely stall forever (NEO-84),
 * hanging the column on "Loading…" with no recovery. This wrapper watches the
 * pure-read loading state and, past a threshold, re-subscribes by remounting
 * EntityColumn (a fresh Convex query id — the whole column, both listeners on
 * the shared token, so it genuinely re-subscribes rather than re-attaching to
 * the stalled value). After a retry cap it shows a recoverable error + Retry.
 *
 * These tests pin the three behaviors:
 *   (a) undefined past the threshold → auto-remount → recovers when the value
 *       finally arrives (no error).
 *   (b) persistent undefined → error + Retry after the cap; Retry re-subscribes
 *       (a fresh remount).
 *   (c) normal fast resolve → no backstop, no remount, no flicker.
 *
 * A `MountProbe` is threaded through the `selector` prop to count how many
 * times EntityColumn actually (un)mounts — that mount count IS the observable
 * proof that the `key`-bump remounts the subtree (and thus re-subscribes),
 * rather than merely re-rendering. Convex/react is mocked so `items` is
 * controllable; posthog is mocked so diagnostics are inert.
 */

import { act, fireEvent, render } from "@testing-library/react";
import React, { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      addCustomSelectorOption: "addCustomSelectorOption",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
  },
}));

// Mutable holders read lazily by the mocked hooks at call time, so a test can
// flip `items` from undefined → resolved and re-render to simulate the fresh
// subscription finally delivering.
const state: { items: unknown; status: unknown } = {
  items: undefined,
  status: null,
};

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: (ref: string) =>
    ref === "getSelectorSyncStatus" ? state.status : state.items,
}));

import ResilientEntityColumn, {
  MAX_RESUBSCRIBE_ATTEMPTS,
  SELECTOR_OPTIONS_STALL_BACKSTOP_MS,
} from "./ResilientEntityColumn";

// Counts EntityColumn (un)mounts: it is rendered inside the keyed EntityColumn
// subtree, so a key-bump remount unmounts + remounts it.
const mountSpy = vi.fn();
function MountProbe() {
  useEffect(() => {
    mountSpy();
  }, []);
  return <div>selector-probe</div>;
}

function columnElement() {
  return (
    <ResilientEntityColumn
      selector={<MountProbe />}
      renderForm={() => <div>legacy-form</div>}
      addButtonText="Sync Variant Types"
      isVisible={true}
      level="variantType"
      useEnsureSync
      syncingLabel="Syncing Variant Types"
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.items = undefined;
  state.status = null;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("ResilientEntityColumn — stalled-read backstop (NEO-83)", () => {
  it("auto-remounts a stalled read, then recovers when the value arrives", () => {
    state.items = undefined; // subscription hasn't delivered its initial value
    const { rerender, getByText, queryByText } = render(columnElement());

    // Initial mount.
    expect(mountSpy).toHaveBeenCalledTimes(1);
    expect(queryByText(/Couldn't load/i)).toBeNull();

    // Still undefined past the threshold → one auto re-subscribe (remount).
    act(() => {
      vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
    });
    expect(mountSpy).toHaveBeenCalledTimes(2);
    expect(queryByText(/Couldn't load/i)).toBeNull(); // not given up yet

    // The fresh subscription finally delivers a value.
    state.items = [{ _id: "vt1", value: "Base" }];
    act(() => {
      rerender(columnElement());
    });

    // Recovered: no error, no further remounts even long past the threshold.
    act(() => {
      vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS * 3);
    });
    expect(mountSpy).toHaveBeenCalledTimes(2);
    expect(queryByText(/Couldn't load/i)).toBeNull();
    expect(getByText("selector-probe")).toBeTruthy();
  });

  it("shows error + Retry after the cap, and Retry re-subscribes", () => {
    state.items = undefined; // never resolves
    const { getByRole, getByText, queryByText } = render(columnElement());
    expect(mountSpy).toHaveBeenCalledTimes(1);

    // Exhaust the automatic re-subscribe attempts (each remount = one mount).
    for (let i = 0; i < MAX_RESUBSCRIBE_ATTEMPTS; i++) {
      act(() => {
        vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
      });
    }
    expect(mountSpy).toHaveBeenCalledTimes(1 + MAX_RESUBSCRIBE_ATTEMPTS);
    expect(queryByText(/Couldn't load/i)).toBeNull();

    // One more threshold with no recovery → give up, show error + Retry.
    act(() => {
      vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
    });
    expect(getByText(/Couldn't load/i)).toBeTruthy();
    const retry = getByRole("button", { name: /retry/i }); // focusable = keyboard-operable
    expect(mountSpy).toHaveBeenCalledTimes(1 + MAX_RESUBSCRIBE_ATTEMPTS); // no remount while stopped

    // Retry re-subscribes: EntityColumn remounts and the error clears.
    act(() => {
      fireEvent.click(retry);
    });
    expect(queryByText(/Couldn't load/i)).toBeNull();
    expect(mountSpy).toHaveBeenCalledTimes(2 + MAX_RESUBSCRIBE_ATTEMPTS);
  });

  it("resolves fast with no backstop, no remount, and no flicker", () => {
    state.items = [{ _id: "vt1", value: "Base" }]; // read delivers immediately
    const { getByText, queryByText } = render(columnElement());

    expect(mountSpy).toHaveBeenCalledTimes(1);
    expect(getByText("selector-probe")).toBeTruthy();
    expect(queryByText(/Couldn't load/i)).toBeNull();

    // Well past every threshold + retry: the backstop never engages.
    act(() => {
      vi.advanceTimersByTime(
        SELECTOR_OPTIONS_STALL_BACKSTOP_MS * (MAX_RESUBSCRIBE_ATTEMPTS + 3),
      );
    });
    expect(mountSpy).toHaveBeenCalledTimes(1); // never remounted
    expect(queryByText(/Couldn't load/i)).toBeNull();
    expect(getByText("selector-probe")).toBeTruthy();
  });
});
