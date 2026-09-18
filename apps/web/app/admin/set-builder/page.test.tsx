/**
 * NEO-287 — /admin/set-builder's credential GATE, and where the pause switch
 * sits relative to it.
 *
 * `MissingCredentialsBanner` used to block the whole builder behind BOTH
 * marketplaces' credentials, unconditionally. A paused marketplace is not
 * something an admin can fix by signing in — the server refuses the login —
 * so requiring it here would strand the builder on a state nobody can clear.
 * The fix: a paused site is filtered out of `REQUIRED_SITES` before the gate
 * runs, and `PausedNotice` renders the strip in its place once the builder is
 * open.
 *
 * `SetSelector` (the actual cascade) is heavy and unrelated to this gate, so
 * it is stubbed to a marker div — this file is about the gate and the strip,
 * not the columns beneath them.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: undefined as { siteCredentials?: unknown[] } | undefined,
  paused: [] as string[],
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    userProfile: { getUserProfile: "userProfile:getUserProfile" },
    marketplacePause: {
      getPausedPlatforms: "marketplacePause:getPausedPlatforms",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string) =>
    ref === "marketplacePause:getPausedPlatforms" ? mocks.paused : mocks.profile,
}));

vi.mock("@/components/modules/SetSelector", () => ({
  default: () => <div data-testid="set-selector-stub" />,
}));

import AdminSetBuilderPage from "./page";

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminSetBuilderPage />
    </MemoryRouter>,
  );
}

function setProfile(siteCredentials: Array<{ site: string; hasCredentials: boolean }>) {
  mocks.profile = { siteCredentials };
}

function setPaused(sites: string[]) {
  mocks.paused = sites;
}

const BSC = "buysportscards";
const SL = "sportlots";

beforeEach(() => {
  setProfile([]);
  setPaused([]);
});

describe("AdminSetBuilderPage — credential gate", () => {
  it("gates on BOTH marketplaces when nothing is paused and neither is connected", () => {
    renderPage();
    expect(screen.queryByTestId("set-selector-stub")).toBeNull();
  });

  it("a PAUSED marketplace is not required — the builder opens with only the other connected", () => {
    setPaused([SL]);
    setProfile([{ site: BSC, hasCredentials: true }]);

    renderPage();

    expect(screen.getByTestId("set-selector-stub")).not.toBeNull();
  });

  it("still gates on the UNPAUSED marketplace even if the other is paused", () => {
    setPaused([SL]);
    setProfile([]); // BSC not connected either

    renderPage();

    expect(screen.queryByTestId("set-selector-stub")).toBeNull();
  });

  it("both marketplaces paused: the builder opens with neither connected", () => {
    setPaused([BSC, SL]);
    setProfile([]);

    renderPage();

    expect(screen.getByTestId("set-selector-stub")).not.toBeNull();
  });

  it("renders the paused strip above the heading once the builder is open", () => {
    setPaused([SL]);
    setProfile([{ site: BSC, hasCredentials: true }]);

    renderPage();

    expect(screen.getByRole("status").textContent).toContain(
      "SportLots is on pause.",
    );
  });

  it("renders nothing from PausedNotice when nothing is paused", () => {
    setProfile([
      { site: BSC, hasCredentials: true },
      { site: SL, hasCredentials: true },
    ]);

    renderPage();

    expect(screen.queryByRole("status")).toBeNull();
  });
});
