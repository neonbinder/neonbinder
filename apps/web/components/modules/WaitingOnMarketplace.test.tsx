/**
 * NEO-487 — "Waiting on BuySportsCards… 12s": shown only while a call is
 * outstanding, counted on the client's clock, announced once.
 */
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseQuery = vi.fn();
vi.mock("convex/react", () => ({ useQuery: (...a: unknown[]) => mockUseQuery(...a) }));
vi.mock("../../convex/_generated/api", () => ({
  api: { marketplaceWaits: { forRun: "marketplaceWaits.forRun" } },
}));

import { WaitingOnMarketplace, WaitingOnMarketplaceRun, waitingText } from "./WaitingOnMarketplace";

beforeEach(() => {
  vi.useFakeTimers();
  mockUseQuery.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const region = () => document.querySelector("[data-marketplace-wait]") as HTMLElement;

describe("WaitingOnMarketplace", () => {
  it("is an always-mounted status region that is empty and hidden while nothing waits", () => {
    render(<WaitingOnMarketplace marketplace="BuySportsCards" />);
    expect(region().getAttribute("role")).toBe("status");
    expect(region().textContent).toBe("");
    expect(region().className).toContain("hidden");
    expect(screen.queryByText("Waiting on BuySportsCards…")).toBeNull();
  });

  it("names the marketplace once a wait starts, from 0 seconds", () => {
    render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    expect(screen.getByText(waitingText("BuySportsCards"))).toBeTruthy();
    expect(waitingText("BuySportsCards")).toBe("Waiting on BuySportsCards…");
    expect(region().textContent).toContain("0s");
  });

  it("counts seconds on the client's clock, never from the server timestamp", () => {
    // A server timestamp from 1970 would read as billions of seconds if it were used.
    render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(region().textContent).toContain("3s");
  });

  it("keeps the seconds out of the announcement and a new waitingSince restarts at 0", () => {
    const { rerender } = render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const secs = region().querySelector("[aria-hidden='true'].tabular-nums");
    expect(secs?.textContent).toBe("5s");
    rerender(<WaitingOnMarketplace waitingSince={2} marketplace="BuySportsCards" />);
    expect(region().textContent).toContain("0s");
  });

  it("clears when the wait ends", () => {
    const { rerender } = render(<WaitingOnMarketplace waitingSince={1} marketplace="BuySportsCards" />);
    rerender(<WaitingOnMarketplace marketplace="BuySportsCards" />);
    expect(region().textContent).toBe("");
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
    expect(screen.getByText("Waiting on BuySportsCards…")).toBeTruthy();
  });

  it("shows nothing once the action is no longer pending, even if the row still says waiting", () => {
    mockUseQuery.mockReturnValue({ waitingSince: 123, accumulatedMs: 0 });
    render(<WaitingOnMarketplaceRun runKey="k1" active={false} marketplace="BuySportsCards" />);
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
