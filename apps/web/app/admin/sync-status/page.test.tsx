import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

/**
 * NEO-370 Rev 4 — /admin/sync-status: the collector's Sync status screen for
 * every collector who lists, or one picked under "Collector" (kept in the
 * URL, replacing the entry). Read-only: no Sync, no Profile links.
 */

type Args = Record<string, unknown>;

const PLATFORM = {
  platform: "bsc",
  connected: true,
  listing: true,
  needsReauth: false,
  paused: false,
  sellerConflict: false,
  running: null,
  queued: { cards: [], more: false },
  sets: [
    {
      variantId: "v1",
      setLabel: "1990 Score Base",
      status: "idle",
      lastSuccessAt: new Date(2026, 10, 1, 14, 0).getTime(),
      counts: { listed: 4, pushed: 1, zeroed: 0, skipped: 0 },
      problemsTotal: 6,
      problems: [
        { reason: "noPrice", cardNo: "1", cardLabel: "Nolan Ryan" },
        { reason: "noPrice", cardNo: "2", cardLabel: "Bo Jackson" },
      ],
    },
  ],
};

const mocks = vi.hoisted(() => ({
  owners: undefined as { ownerId: string; label: string }[] | undefined,
  status: vi.fn(),
  problems: vi.fn(),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    listingSync: {
      adminSyncOwners: "listingSync:adminSyncOwners",
      adminSyncStatus: "listingSync:adminSyncStatus",
      adminSyncSetProblems: "listingSync:adminSyncSetProblems",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: Args) => (ref === "listingSync:adminSyncOwners" ? mocks.owners : mocks.status(args)),
  useConvex: () => ({ query: (_ref: string, args: Args) => mocks.problems(args) }),
}));

import AdminSyncStatusPage from "./page";

function Probe() {
  const { search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Page URL">{search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function draw(start = "/admin/sync-status") {
  const tree = () => (
    <Theme>
      <MemoryRouter initialEntries={["/admin", start]}>
        <Routes>
          <Route
            path="/admin/sync-status"
            element={
              <>
                <AdminSyncStatusPage />
                <Probe />
              </>
            }
          />
          <Route path="/admin" element={<p>Admin hub</p>} />
        </Routes>
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return { view, rerender: () => view.rerender(tree()) };
}

const collector = () => screen.getByRole("combobox", { name: "Collector" }) as HTMLSelectElement;
const url = () => screen.getByRole("status", { name: "Page URL" }).textContent;

beforeEach(() => {
  mocks.owners = [
    { ownerId: "u1", label: "Doc's Cards" },
    { ownerId: "u2", label: "@straw" },
  ];
  mocks.status.mockImplementation((args: Args) =>
    args.ownerId === "u2"
      ? { owners: [{ ownerId: "u2", label: "@straw", status: { platforms: [PLATFORM] } }], more: false }
      : {
          owners: [
            { ownerId: "u1", label: "Doc's Cards", status: { platforms: [{ ...PLATFORM, listing: false }] } },
            { ownerId: "u2", label: "@straw", status: { platforms: [PLATFORM] } },
          ],
          more: true,
        },
  );
  mocks.problems.mockResolvedValue({ problems: [], problemsTotal: 0 });
});
afterEach(cleanup);

describe("admin Sync Status", () => {
  it("everyone: one section per collector, read-only, with a note when there are more", async () => {
    const { view, rerender } = draw();
    expect(screen.getByRole("heading", { level: 2, name: "Sync Status" })).toBeTruthy();
    expect(collector().value).toBe("");
    expect(screen.getByRole("heading", { level: 3, name: "Doc's Cards" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 4, name: "BuySportsCards" })).toHaveLength(2);
    // Read-only: no Sync, no link to anyone's Profile.
    expect(screen.queryByRole("button", { name: /^Sync/ })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Sync status for Doc's Cards" })).getByText("Not started")).toBeTruthy();
    expect(screen.getByText(/^Showing the first 2 collectors\./)).toBeTruthy();
    expect(screen.getByText(/^Each collector's lists are cut short here\./)).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "admin Sync Status, everyone", rerender });
  });

  it("picking a collector filters to them, in the URL, replacing the entry", async () => {
    const { view, rerender } = draw();
    fireEvent.change(collector(), { target: { value: "u2" } });
    expect(url()).toBe("?owner=u2");
    expect(mocks.status).toHaveBeenLastCalledWith({ ownerId: "u2" });
    expect(screen.queryByRole("heading", { level: 3, name: "Doc's Cards" })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "@straw" })).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "admin Sync Status, one collector", rerender });
    // A filter is not a Back step: Back leaves the screen.
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(screen.getByText("Admin hub")).toBeTruthy();
  });

  it("See everything drills into one collector as a Back step", async () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: "See everything for @straw" }));
    expect(url()).toBe("?owner=u2");
    expect(collector().value).toBe("u2");
    // One collector's view: full lists, no drill button, no cut-short note.
    expect(screen.queryByRole("button", { name: /^See everything for/ })).toBeNull();
    expect(screen.queryByText(/^Each collector's lists are cut short here\./)).toBeNull();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(collector());
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(url()).toBe("");
    expect(screen.getByRole("heading", { level: 3, name: "Doc's Cards" })).toBeTruthy();
  });

  it("a pasted link opens the same collector", () => {
    draw("/admin/sync-status?owner=u2");
    expect(collector().value).toBe("u2");
    expect(screen.getByRole("heading", { level: 3, name: "@straw" })).toBeTruthy();
  });

  it("Show all reads that collector's held-back list on demand", async () => {
    draw("/admin/sync-status?owner=u2");
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 held back in 1990 Score Base" }));
    await act(async () => {});
    expect(mocks.problems).toHaveBeenCalledWith({ ownerId: "u2", variantId: "v1", platform: "bsc" });
  });

  it("loading and empty, in plain words", () => {
    mocks.status.mockReturnValue(undefined);
    const loading = draw();
    expect(loading.view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    cleanup();
    mocks.status.mockReturnValue({ owners: [], more: false });
    draw();
    expect(screen.getByText("Nobody lists anywhere yet. Quiet on the wire.")).toBeTruthy();
  });
});
