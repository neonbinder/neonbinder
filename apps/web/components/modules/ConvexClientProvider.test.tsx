/**
 * NEO-84 — replaceable Convex client.
 *
 * A wedged websocket cannot be recovered by re-subscribing (proven in CI run
 * 31839119469: three consecutive query ids all stalled on one socket), and
 * Convex will not reconnect on its own because its reconnect path is gated on
 * `socket.state === "disconnected"` — a state a half-open socket never
 * reaches. So the provider must be able to build a new client, and with it a
 * new socket.
 *
 * That is a heavy operation: every subscription in the app briefly returns
 * `undefined`. These tests pin the guards that keep it from becoming worse
 * than the bug — a cooldown, a hard cap, and closing the socket we replaced.
 */

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed: Array<{ close: ReturnType<typeof vi.fn> }> = [];

vi.mock("convex/react", () => ({
  ConvexReactClient: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      constructed.push(this as unknown as { close: ReturnType<typeof vi.fn> });
    }
  },
}));

vi.mock("convex/react-clerk", () => ({
  ConvexProviderWithClerk: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({}) }));

import ConvexClientProvider, {
  MAX_CLIENT_RECONNECTS,
  RECONNECT_COOLDOWN_MS,
} from "./ConvexClientProvider";
import { useConvexReconnect } from "./convexReconnect";

// Exposes the hook through a real click target rather than hoisting the
// callback into a module variable — reassigning an outer binding during
// render is a side effect in render, which react-hooks/globals rejects.
function Probe() {
  const reconnect = useConvexReconnect();
  return <button onClick={reconnect}>request reconnect</button>;
}

function renderProvider() {
  const utils = render(
    <ConvexClientProvider>
      <Probe />
    </ConvexClientProvider>,
  );
  return {
    ...utils,
    requestReconnect: () => {
      act(() => {
        fireEvent.click(
          utils.getByRole("button", { name: /request reconnect/i }),
        );
      });
    },
  };
}

/** Jump past the cooldown so the next request is eligible. */
function waitOutCooldown() {
  act(() => {
    vi.advanceTimersByTime(RECONNECT_COOLDOWN_MS + 1);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  constructed.length = 0;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("ConvexClientProvider — reconnect escalation (NEO-84)", () => {
  it("builds one client normally and never churns it on re-render", () => {
    const { rerender } = renderProvider();
    expect(constructed).toHaveLength(1);

    act(() => {
      rerender(
        <ConvexClientProvider>
          <Probe />
        </ConvexClientProvider>,
      );
    });
    expect(constructed).toHaveLength(1);
    expect(constructed[0].close).not.toHaveBeenCalled();
  });

  it("swaps in a new client on request and closes the superseded one", () => {
    const { requestReconnect } = renderProvider();
    requestReconnect();

    expect(constructed).toHaveLength(2);
    // The old socket must be released, or the wedged connection lingers and
    // we leak a socket per escalation.
    expect(constructed[0].close).toHaveBeenCalledTimes(1);
    // ...but only the old one. Closing the live client would break the app.
    expect(constructed[1].close).not.toHaveBeenCalled();
  });

  it("ignores a second request inside the cooldown", () => {
    const { requestReconnect } = renderProvider();
    requestReconnect();
    expect(constructed).toHaveLength(2);

    // Several columns share one stalled socket and give up at nearly the same
    // moment. Without this guard the second request tears down the first
    // replacement before its socket ever had a chance to deliver.
    requestReconnect();
    requestReconnect();
    expect(constructed).toHaveLength(2);
  });

  it("allows a further swap once the cooldown has elapsed", () => {
    const { requestReconnect } = renderProvider();
    requestReconnect();
    expect(constructed).toHaveLength(2);

    waitOutCooldown();
    requestReconnect();
    expect(constructed).toHaveLength(3);
    expect(constructed[1].close).toHaveBeenCalledTimes(1);
  });

  it("stops swapping at the cap", () => {
    const { requestReconnect } = renderProvider();

    for (let i = 0; i < MAX_CLIENT_RECONNECTS; i++) {
      requestReconnect();
      waitOutCooldown();
    }
    expect(constructed).toHaveLength(1 + MAX_CLIENT_RECONNECTS);

    // Past the cap the socket is not the problem — backend down, auth broken,
    // no network — and swapping again only churns every subscription in the
    // app. The honest remaining move is a page reload.
    requestReconnect();
    waitOutCooldown();
    requestReconnect();
    expect(constructed).toHaveLength(1 + MAX_CLIENT_RECONNECTS);
  });
});
