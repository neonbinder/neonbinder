/**
 * NEO-487 — "Waiting on BuySportsCards… 12s": shown only while a call is
 * outstanding and past 1.5 s, counted on the client's clock, announced once,
 * from a status region that is always mounted and never hidden.
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
  waitingText,
} from "./WaitingOnMarketplace";

beforeEach(() => {
  vi.useFakeTimers();
  mockUseQuery.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const region = () => document.querySelector("[data-marketplace-wait]") as HTMLElement;

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
    const { rerender } = render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
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
    render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" className="mb-3" />);
    pastThreshold();
    expect(screen.getByText(waitingText("BuySportsCards"))).toBeTruthy();
    expect(waitingText("BuySportsCards")).toBe("Waiting on BuySportsCards…");
    expect(region().textContent).toContain("1s");
    // The region keeps no layout of its own; the host's class is on the wrapper.
    expect(region().className).toBe("");
    const wrapper = region().firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("mb-3");
  });

  it("counts seconds on the client's clock, never from the server timestamp", () => {
    // A server timestamp from 1970 would read as billions of seconds if it were used.
    render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(region().textContent).toContain("3s");
  });

  it("keeps the seconds out of the announcement and a new waitingSince starts a new wait", () => {
    const { rerender } = render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const secs = region().querySelector("[aria-hidden='true'].tabular-nums");
    expect(secs?.textContent).toBe("5s");
    // A new call is a new wait: it has to clear the threshold again.
    rerender(<WaitingOnMarketplace waitingSince={2} marketplace="BuySportsCards" />);
    expect(region().textContent).toBe("");
    pastThreshold();
    expect(region().textContent).toContain("1s");
  });

  it("clears when the wait ends, and the region stays mounted", () => {
    const { rerender } = render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    pastThreshold();
    const before = region();
    rerender(<WaitingOnMarketplace marketplace="BuySportsCards" />);
    expect(region().textContent).toBe("");
    expect(region()).toBe(before);
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
    mockUseQuery.mockReturnValue({ waitingSince: 123, accumulatedMs: 0 });
    render(<WaitingOnMarketplaceRun runKey="k1" active marketplace="BuySportsCards" />);
    pastThreshold();
    expect(screen.getByText("Waiting on BuySportsCards…")).toBeTruthy();
  });

  it("shows nothing once the action is no longer pending, even if the row still says waiting", () => {
    mockUseQuery.mockReturnValue({ waitingSince: 123, accumulatedMs: 0 });
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
