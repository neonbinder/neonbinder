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
const state: { items: unknown; status: unknown; connection: unknown } = {
  items: undefined,
  status: null,
  // Shape of Convex's ConnectionState. Defaults to the NEO-84 signature: the
  // client believes nothing is wrong (`isWebSocketConnected: true`) yet has
  // delivered nothing — which is precisely why the snapshot is worth capturing.
  connection: {
    isWebSocketConnected: true,
    connectionCount: 1,
    connectionRetries: 0,
    inflightMutations: 0,
    inflightActions: 0,
    timeOfOldestInflightRequest: null,
    hasInflightRequests: false,
    hasEverConnected: true,
  },
};

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ connectionState: () => state.connection }),
  useQuery: (ref: string) =>
    ref === "getSelectorSyncStatus" ? state.status : state.items,
}));

import { ConvexReconnectContext } from "../modules/convexReconnect";
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

// The socket-level escalation (NEO-84) is delivered through the real context,
// not a module mock, so these tests exercise the actual wiring the app uses.
const reconnectSpy = vi.fn();

function columnElement() {
  return (
    <ConvexReconnectContext.Provider value={reconnectSpy}>
      <ResilientEntityColumn
        selector={<MountProbe />}
        renderForm={() => <div>legacy-form</div>}
        addButtonText="Sync Variant Types"
        isVisible={true}
        level="variantType"
        useEnsureSync
        syncingLabel="Syncing Variant Types"
      />
    </ConvexReconnectContext.Provider>
  );
}

/** Advance far enough to exhaust every re-subscribe and reach give-up. */
function driveToGiveUp() {
  for (let i = 0; i <= MAX_RESUBSCRIBE_ATTEMPTS; i++) {
    act(() => {
      vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.items = undefined;
  state.status = null;
  state.connection = {
    isWebSocketConnected: true,
    connectionCount: 1,
    connectionRetries: 0,
    inflightMutations: 0,
    inflightActions: 0,
    timeOfOldestInflightRequest: null,
    hasInflightRequests: false,
    hasEverConnected: true,
  };
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

  it("keeps the column mounted after giving up, and self-heals on a late value", () => {
    state.items = undefined;
    const { rerender, getByText, queryByText } = render(columnElement());

    // Drive it all the way to the give-up state.
    for (let i = 0; i <= MAX_RESUBSCRIBE_ATTEMPTS; i++) {
      act(() => {
        vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
      });
    }
    expect(getByText(/Couldn't load/i)).toBeTruthy();

    // The banner must render ALONGSIDE the column, not instead of it. If
    // EntityColumn were unmounted here its subscription would be dropped and no
    // late value could ever arrive — the terminal dead end this guards against.
    expect(getByText("selector-probe")).toBeTruthy();
    const mountsAtGiveUp = mountSpy.mock.calls.length;

    // A value lands late on the SAME subscription — no Retry, no remount.
    state.items = [{ _id: "vt1", value: "Base" }];
    act(() => {
      rerender(columnElement());
    });

    expect(queryByText(/Couldn't load/i)).toBeNull(); // healed itself
    expect(getByText("selector-probe")).toBeTruthy();
    expect(mountSpy).toHaveBeenCalledTimes(mountsAtGiveUp); // never remounted

    // And it stays healed — the backstop doesn't re-trip on a resolved read.
    act(() => {
      vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS * 3);
    });
    expect(queryByText(/Couldn't load/i)).toBeNull();
    expect(mountSpy).toHaveBeenCalledTimes(mountsAtGiveUp);
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

/**
 * NEO-84 — socket-level escalation and on-screen diagnostics.
 *
 * Re-subscribing cannot fix a wedged websocket: in CI run 31839119469 the
 * initial subscription and both fresh query ids all stalled on one socket.
 * So once the cheap retries are spent the column asks for a whole new Convex
 * client, and records what the socket looked like at that moment — on screen,
 * because PostHog is disabled under E2E and Maestro captures no console.
 */
describe("ResilientEntityColumn — socket escalation (NEO-84)", () => {
  it("does not escalate while cheap re-subscribes are still available", () => {
    state.items = undefined;
    render(columnElement());

    // Every attempt up to (not including) the cap is a plain remount.
    for (let i = 0; i < MAX_RESUBSCRIBE_ATTEMPTS; i++) {
      act(() => {
        vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
      });
    }
    expect(mountSpy).toHaveBeenCalledTimes(1 + MAX_RESUBSCRIBE_ATTEMPTS);
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it("asks for a new websocket exactly once when every re-subscribe fails", () => {
    state.items = undefined; // never resolves on any subscription
    const { getByText } = render(columnElement());

    driveToGiveUp();

    expect(getByText(/Couldn't load/i)).toBeTruthy();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    // The column is stopped now, so no timer re-arms and no reconnect storm
    // follows — the provider's cooldown is a backstop, not the only guard.
    act(() => {
      vi.advanceTimersByTime(SELECTOR_OPTIONS_STALL_BACKSTOP_MS * 5);
    });
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });

  it("renders the socket snapshot so a CI screenshot carries it", () => {
    state.items = undefined;
    state.connection = {
      isWebSocketConnected: false,
      connectionCount: 4,
      connectionRetries: 7,
      inflightMutations: 1,
      inflightActions: 2,
      timeOfOldestInflightRequest: new Date(Date.now() - 18_000),
      hasInflightRequests: true,
      hasEverConnected: true,
    };

    const { getByTestId } = render(columnElement());
    driveToGiveUp();

    const text = getByTestId("stall-connection-state").textContent ?? "";
    expect(text).toContain("ws=down"); // the socket died and nobody noticed
    expect(text).toContain("conns=4");
    expect(text).toContain("retries=7");
    expect(text).toContain("inflight=3"); // mutations + actions

    // The age is measured when we give up, not when the request was made, so
    // it accumulates the time spent on every failed re-subscribe. That is the
    // number worth reporting — "this request has been outstanding for N
    // seconds" is what distinguishes a wedged socket from a slow one.
    const secsWaiting =
      18 +
      ((SELECTOR_OPTIONS_STALL_BACKSTOP_MS / 1000) *
        (MAX_RESUBSCRIBE_ATTEMPTS + 1));
    expect(text).toContain(`oldest=${secsWaiting}s`);
  });

  it("reports ws=up when the socket is live but delivering nothing", () => {
    // The NEO-84 signature proper: healthy-looking socket, no delivery. This
    // is the reading that would point upstream rather than at our own code.
    state.items = undefined;
    const { getByTestId } = render(columnElement());
    driveToGiveUp();

    const text = getByTestId("stall-connection-state").textContent ?? "";
    expect(text).toContain("ws=up");
    expect(text).toContain("oldest=none");
  });

  it("clears the snapshot when a late value heals the column", () => {
    state.items = undefined;
    const { rerender, queryByTestId } = render(columnElement());
    driveToGiveUp();
    expect(queryByTestId("stall-connection-state")).not.toBeNull();

    // A value lands — the snapshot described a socket that is no longer the
    // problem, so leaving it on screen would be actively misleading.
    state.items = [{ _id: "vt1", value: "Base" }];
    act(() => {
      rerender(columnElement());
    });
    expect(queryByTestId("stall-connection-state")).toBeNull();
  });

  it("asks for a new websocket again on a manual Retry", () => {
    state.items = undefined;
    const { getByRole } = render(columnElement());
    driveToGiveUp();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(getByRole("button", { name: /retry/i }));
    });

    // Retry lands only after the automatic escalation already failed, so a
    // remount alone would not be enough. Whether it actually swaps the client
    // is the provider's call (cooldown + cap), not the column's.
    expect(reconnectSpy).toHaveBeenCalledTimes(2);
  });

  it("survives a client that cannot report its connection state", () => {
    // Diagnostics must never break recovery: a throwing/absent client still
    // gives up cleanly, still escalates, and simply shows no snapshot line.
    state.items = undefined;
    state.connection = null;

    const { getByText, queryByTestId } = render(columnElement());
    driveToGiveUp();

    expect(getByText(/Couldn't load/i)).toBeTruthy();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(queryByTestId("stall-connection-state")).toBeNull();
  });
});
