import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { getDashboard, type DashboardData } from "./fake-data";

/**
 * NEO-464 — the signed-in dashboard shows Loading once, on the way in. A read
 * that starts over afterwards (a want starred in the card panel re-reads the
 * chase's cards) keeps the last screen up, so the screen and the card panel
 * open over it never drop out from under the collector.
 */
let current: DashboardData | undefined;
vi.mock("./real/useRealDashboard", () => ({ useRealDashboard: () => current }));
vi.mock("./real/useCrewDesk", () => ({
  useRealCrew: () => ({
    desk: undefined,
    isReported: () => false,
    report: async () => null,
    withdraw: async () => null,
  }),
}));
vi.mock("@/app/collection/final/data/convexStore", () => ({
  ConvexCollectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { default: DashboardPage } = await import("./page");

function draw() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <DashboardPage />
    </MemoryRouter>,
  );
}

const greeting = () => screen.queryByRole("heading", { level: 1, name: "Welcome back, slugger." });

afterEach(() => {
  cleanup();
  current = undefined;
});

describe("the signed-in dashboard while its reads settle", () => {
  it("shows Loading until the first answer", () => {
    current = undefined;
    draw();
    expect(screen.getByText("Loading your dashboard.")).toBeTruthy();
    expect(greeting()).toBeNull();
  });

  it("keeps the last screen up while a read starts over, then shows the new answer", () => {
    current = getDashboard();
    const { rerender } = draw();
    expect(greeting()).not.toBeNull();

    current = undefined;
    rerender(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(greeting()).not.toBeNull();
    expect(screen.queryByText("Loading your dashboard.")).toBeNull();

    current = { ...getDashboard(), newListings: [] };
    rerender(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("heading", { level: 2, name: "New Listings" })).toBeNull();
  });
});
