/**
 * NEO-487 — "Waiting on BuySportsCards… 12s": shown only while a call is
 * outstanding and past 1.5 s (on the client's clock), announced once, from a
 * status region that is always mounted and never hidden. NEO-483: the time is
 * counted from the server's `waitingSince` (floored at what the client has
 * watched), and reads "4m 7s" from a minute.
 */
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseQuery = vi.fn();
vi.mock("convex/react", () => ({ useQuery: (...a: unknown[]) => mockUseQuery(...a) }));
vi.mock("../../convex/_generated/api", () => ({
  api: { marketplaceWaits: { forRun: "marketplaceWaits.forRun" } },
}));

import {
  ANNOUNCE_AFTER_MS,
  WaitingOnMarketplace,
  WaitingOnMarketplaceRun,
  waitedText,
  waitingText,
} from "./WaitingOnMarketplace";

/** The fake clock's "now" when each test starts; a wait that starts now has `waitingSince` T0. */
const T0 = 1_760_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockUseQuery.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const region = () => document.querySelector("[data-marketplace-wait]") as HTMLElement;
/** The running time: aria-hidden, so it is never part of the announcement. */
const secs = () => region().querySelector("[aria-hidden='true'].tabular-nums");

/** Past the 1.5 s threshold a wait has to clear before it shows. */
const pastThreshold = () =>
  act(() => {
    vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
  });

describe("WaitingOnMarketplace", () => {
  it("is an always-mounted status region, empty and never hidden while nothing waits", () => {
    render(<WaitingOnMarketplace marketplace="BuySportsCards" className="mb-3" />);
    expect(region().getAttribute("role")).toBe("status");
    expect(region().textContent).toBe("");
    // A live region that is display:none drops the first announcement: the
    // idle region is a bare, classless paragraph (zero height), never hidden.
    expect(region().hidden).toBe(false);
    expect(region().className).toBe("");
    expect(region().getAttribute("style")).toBeNull();
    expect(region().childElementCount).toBe(0);
    expect(screen.queryByText("Waiting on BuySportsCards…")).toBeNull();
  });

  it("never announces a wait shorter than 1.5 s", () => {
    expect(ANNOUNCE_AFTER_MS).toBe(1500);
    const { rerender } = render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    expect(region().textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS - 1);
    });
    expect(region().textContent).toBe("");
    // The call answered in time: nothing was ever said.
    rerender(<WaitingOnMarketplace marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(region().textContent).toBe("");
  });

  it("names the marketplace once a wait passes 1.5 s, with the layout on an inner wrapper", () => {
    render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" className="mb-3" />);
    pastThreshold();
    expect(screen.getByText(waitingText("BuySportsCards"))).toBeTruthy();
    expect(waitingText("BuySportsCards")).toBe("Waiting on BuySportsCards…");
    expect(region().textContent).toContain("1s");
    // The region keeps no layout of its own; the host's class is on the wrapper.
    expect(region().className).toBe("");
    const wrapper = region().firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("mb-3");
    // The dot's glow is scaled by --glow: lit in dark, none on light's paper.
    const dot = wrapper.firstElementChild as HTMLElement;
    expect(dot.className).toContain("var(--glow)");
  });

  it("counts seconds from the wait's start while it is under a minute", () => {
    render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(secs()?.textContent).toBe("3s");
  });

  it("reads minutes and seconds from one minute on", () => {
    render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(secs()?.textContent).toBe("59s");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(secs()?.textContent).toBe("1m 0s");
    act(() => {
      vi.advanceTimersByTime(187_000);
    });
    expect(secs()?.textContent).toBe("4m 7s");
  });

  it("a refresh mid-wait reads the wait's true length, not 0s (counted from waitingSince)", () => {
    // The page mounts 90 s into a wait the server started at T0.
    vi.setSystemTime(T0 + 90_000);
    render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    // The 1.5 s gate is still this client's own: nothing until it has watched that long.
    expect(region().textContent).toBe("");
    pastThreshold();
    expect(secs()?.textContent).toBe("1m 31s");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(secs()?.textContent).toBe("1m 32s");
  });

  it("an old wait still clears the client's 1.5 s gate before it shows (no flash on skew)", () => {
    vi.setSystemTime(T0 + 600_000);
    render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS - 1);
    });
    expect(region().textContent).toBe("");
  });

  it("a client clock behind the server's never reads negative or frozen: it counts what it watched", () => {
    // waitingSince is 10 s in this client's future.
    render(<WaitingOnMarketplace waitingSince={T0 + 10_000} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(secs()?.textContent).toBe("3s");
  });

  it("keeps the seconds out of the announcement and a new waitingSince starts a new wait", () => {
    const { rerender } = render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(secs()?.textContent).toBe("5s");
    // The sentence the region announces carries no number.
    expect(region().querySelector("span > span:not([aria-hidden])")?.textContent).toBe(waitingText("BuySportsCards"));
    // A new call (started now, 5 s on) is a new wait: it has to clear the threshold again.
    rerender(<WaitingOnMarketplace waitingSince={T0 + 5000} marketplace="BuySportsCards" />);
    expect(region().textContent).toBe("");
    pastThreshold();
    expect(region().textContent).toContain("1s");
  });

  it("clears when the wait ends, and the region stays mounted", () => {
    const { rerender } = render(<WaitingOnMarketplace waitingSince={T0} marketplace="BuySportsCards" />);
    pastThreshold();
    const before = region();
    rerender(<WaitingOnMarketplace marketplace="BuySportsCards" />);
    expect(region().textContent).toBe("");
    expect(region()).toBe(before);
  });
});

describe("waitedText", () => {
  it('reads "Ns" under a minute and "Xm Ys" from one minute', () => {
    expect(waitedText(0)).toBe("0s");
    expect(waitedText(59)).toBe("59s");
    expect(waitedText(60)).toBe("1m 0s");
    expect(waitedText(61)).toBe("1m 1s");
    expect(waitedText(247)).toBe("4m 7s");
    expect(waitedText(3725)).toBe("62m 5s");
  });

  it("never reads negative or fractional", () => {
    expect(waitedText(-4)).toBe("0s");
    expect(waitedText(12.9)).toBe("12s");
  });
});

describe("WaitingOnMarketplaceRun", () => {
  it("subscribes only while the action is active and has a key", () => {
    mockUseQuery.mockReturnValue(undefined);
    const { rerender } = render(
      <WaitingOnMarketplaceRun runKey="k1" active={false} marketplace="BuySportsCards" />,
    );
    expect(mockUseQuery).toHaveBeenLastCalledWith("marketplaceWaits.forRun", "skip");
    rerender(<WaitingOnMarketplaceRun runKey={null} active marketplace="BuySportsCards" />);
    expect(mockUseQuery).toHaveBeenLastCalledWith("marketplaceWaits.forRun", "skip");
    rerender(<WaitingOnMarketplaceRun runKey="k1" active marketplace="BuySportsCards" />);
    expect(mockUseQuery).toHaveBeenLastCalledWith("marketplaceWaits.forRun", { runKey: "k1" });
  });

  it("shows while waiting and the action is pending", () => {
    mockUseQuery.mockReturnValue({ waitingSince: T0, accumulatedMs: 0 });
    render(<WaitingOnMarketplaceRun runKey="k1" active marketplace="BuySportsCards" />);
    pastThreshold();
    expect(screen.getByText("Waiting on BuySportsCards…")).toBeTruthy();
  });

  it("shows nothing once the action is no longer pending, even if the row still says waiting", () => {
    mockUseQuery.mockReturnValue({ waitingSince: T0, accumulatedMs: 0 });
    render(<WaitingOnMarketplaceRun runKey="k1" active={false} marketplace="BuySportsCards" />);
    pastThreshold();
    expect(screen.queryByText("Waiting on BuySportsCards…")).toBeNull();
  });

  it("shows nothing between calls (no waitingSince) or before the query answers", () => {
    mockUseQuery.mockReturnValue({ accumulatedMs: 4000 });
    const { rerender } = render(
      <WaitingOnMarketplaceRun runKey="k1" active marketplace="BuySportsCards" />,
    );
    expect(screen.queryByText("Waiting on BuySportsCards…")).toBeNull();
    mockUseQuery.mockReturnValue(undefined);
    rerender(<WaitingOnMarketplaceRun runKey="k1" active marketplace="BuySportsCards" />);
    expect(screen.queryByText("Waiting on BuySportsCards…")).toBeNull();
  });
});
