import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";

/**
 * NEO-370 Rev 4 — /admin/sync-status: the collector's Sync status screen for
 * every collector who has connected a marketplace, or one picked under
 * "Collector" (kept in the URL, replacing the entry). Read-only: no Sync, no
 * Profile links, and nothing said to the collector.
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
      // NEO-415: the server always sends the last run's ledger (empty before a plan).
      steps: [
        { kind: "read", condition: "Near Mint", status: "done" },
        { kind: "send", status: "done" },
      ],
    },
  ],
};

const mocks = vi.hoisted(() => ({
  owners: undefined as { ownerId: string; label: string; named: boolean }[] | undefined,
  status: vi.fn(),
  read: vi.fn(),
  problems: vi.fn(),
  names: vi.fn(),
  client: {
    query: (ref: string, args: Args): unknown =>
      ref === "listingSync:adminSyncStatus" ? mocks.read(args) : mocks.problems(args),
    action: (_ref: string, args: Args): unknown => mocks.names(args),
  },
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    listingSync: {
      adminSyncOwners: "listingSync:adminSyncOwners",
      adminSyncStatus: "listingSync:adminSyncStatus",
      adminSyncSetProblems: "listingSync:adminSyncSetProblems",
    },
    adminUsers: { adminResolveOwnerLabels: "adminUsers:adminResolveOwnerLabels" },
  },
}));

// One collector is a live subscription; everyone is read once on demand
// (`useConvex().query`), on arriving and on Refresh.
vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: Args | "skip") =>
    ref === "listingSync:adminSyncOwners" ? mocks.owners : args === "skip" ? undefined : mocks.status(args),
  // Stable, as the real client is.
  useConvex: () => mocks.client,
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

const flush = () => act(async () => {});
const collector = () => screen.getByRole("combobox", { name: "Collector" }) as HTMLSelectElement;
const url = () => screen.getByRole("status", { name: "Page URL" }).textContent;

beforeEach(() => {
  mocks.owners = [
    { ownerId: "u1", label: "Doc's Cards", named: true },
    { ownerId: "u2", label: "@straw", named: true },
  ];
  mocks.status.mockImplementation((args: Args) =>
    args.ownerId === "u2"
      ? { owners: [{ ownerId: "u2", label: "@straw", named: true, status: { platforms: [PLATFORM] } }], more: false }
      : {
          owners: [
            { ownerId: "u1", label: "Doc's Cards", named: true, status: { platforms: [{ ...PLATFORM, listing: false }] } },
            { ownerId: "u2", label: "@straw", named: true, status: { platforms: [PLATFORM] } },
          ],
          more: true,
        },
  );
  mocks.names.mockReset();
  mocks.names.mockResolvedValue({});
  mocks.problems.mockResolvedValue({ problems: [], problemsTotal: 0 });
  mocks.read.mockReset();
  mocks.read.mockImplementation(async (args: Args) => mocks.status(args));
});
afterEach(cleanup);

describe("admin Sync Status", () => {
  it("everyone: one section per collector, read-only, with a note when there are more", async () => {
    const { view, rerender } = draw();
    await flush();
    expect(screen.getByRole("heading", { level: 2, name: "Sync Status" })).toBeTruthy();
    expect(collector().value).toBe("");
    // The default says who is in it: every collector with a listing state, syncing or not.
    expect(within(collector()).getByRole("option", { selected: true }).textContent).toBe(
      "Everyone who has connected a marketplace",
    );
    expect(screen.getByRole("heading", { level: 3, name: "Doc's Cards" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 4, name: "BuySportsCards" })).toHaveLength(2);
    // Read-only: no Sync, and the only links are the drill-downs (none to anyone's Profile).
    expect(screen.queryByRole("button", { name: /^Sync/ })).toBeNull();
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "See everything for Doc's Cards",
      "See everything for @straw",
    ]);
    // Each collector's section is named by its heading.
    expect(within(screen.getByRole("region", { name: "Doc's Cards" })).getByText("Not syncing")).toBeTruthy();
    expect(screen.getByText(/^Showing the first 2 collectors\./)).toBeTruthy();
    expect(screen.getByText(/^Each collector's lists are cut short here\./)).toBeTruthy();
    // Held-back reasons are about the card, not an instruction to its owner.
    expect(screen.getAllByText(/No price yet: no common price on the set/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Set a common price above/)).toBeNull();
    // NEO-415: each set's last-run ledger reads the same here as on the collector's tab (reads folded).
    const ledger = within(screen.getByRole("region", { name: "Doc's Cards" })).getByRole("list", {
      name: "Last sync steps for 1990 Score Base on BuySportsCards",
    });
    expect(within(ledger).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual([
      "Gathering data, done",
      "Send changes to BuySportsCards, done",
    ]);
    await expectAccessibleInBothModes(view.container, { label: "admin Sync Status, everyone", rerender });
  });

  it("everyone is read once on demand, not subscribed; Refresh reads it again", async () => {
    draw();
    await flush();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenLastCalledWith({});
    // Never a subscription to everyone.
    expect(mocks.status.mock.calls.filter(([args]) => !(args as Args).ownerId)).toHaveLength(1);
    let release: () => void = () => {};
    mocks.read.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(mocks.status({})))),
    );
    const refresh = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(refresh);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    // A second press while the read is out does nothing.
    fireEvent.click(refresh);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => release());
    expect(refresh.getAttribute("aria-busy")).toBeNull();
    expect(screen.getByText(/^As of /).getAttribute("role")).toBe("status");
  });

  it("a failed read says so in an alert, with Refresh to try again", async () => {
    mocks.read.mockRejectedValueOnce(new Error("network down"));
    draw();
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't read everyone's sync status: network down. Press Refresh to try again.",
    );
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Doc's Cards" })).toBeTruthy();
  });

  it("picking a collector filters to them, in the URL, replacing the entry", async () => {
    const { view, rerender } = draw();
    await flush();
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

  it("See everything is a link that drills into one collector as a Back step", async () => {
    draw();
    await flush();
    const drill = screen.getByRole("link", { name: "See everything for @straw" });
    expect(drill.getAttribute("href")).toBe("/admin/sync-status?owner=u2");
    fireEvent.click(drill);
    expect(url()).toBe("?owner=u2");
    expect(collector().value).toBe("u2");
    // One collector's view: full lists, no drill link, no Refresh, no cut-short note.
    expect(screen.queryByRole("link", { name: /^See everything for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByText(/^Each collector's lists are cut short here\./)).toBeNull();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(collector());
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(url()).toBe("");
    await flush();
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

  describe("a collector with no public profile name", () => {
    const RAW = "user_unnamed0ab12cd";
    const UNNAMED = "Collector without a name (…ab12cd)";
    beforeEach(() => {
      mocks.owners = [...(mocks.owners ?? []), { ownerId: RAW, label: UNNAMED, named: false }];
      const everyone = mocks.status.getMockImplementation()!;
      mocks.status.mockImplementation((args: Args) => {
        if (args.ownerId === RAW) {
          return { owners: [{ ownerId: RAW, label: UNNAMED, named: false, status: { platforms: [PLATFORM] } }], more: false };
        }
        const got = everyone(args);
        return args.ownerId
          ? got
          : { ...got, owners: [...got.owners, { ownerId: RAW, label: UNNAMED, named: false, status: { platforms: [PLATFORM] } }] };
      });
    });

    /** Every place the page names a collector: picker option, section heading and region, drill link. */
    function expectNamed(name: string) {
      expect(within(collector()).getByRole("option", { name }).getAttribute("value")).toBe(RAW);
      expect(screen.getByRole("heading", { level: 3, name })).toBeTruthy();
      expect(screen.getByRole("region", { name })).toBeTruthy();
      expect(screen.getByRole("link", { name: `See everything for ${name}` })).toBeTruthy();
      expect(document.body.textContent).not.toContain(RAW);
    }

    it("Clerk's name, asked once for the unnamed ids only, replaces the unnamed label everywhere", async () => {
      mocks.names.mockResolvedValue({ [RAW]: "keith@example.test" });
      draw();
      await flush();
      expect(mocks.names).toHaveBeenCalledTimes(1);
      expect(mocks.names).toHaveBeenCalledWith({ userIds: [RAW] });
      expectNamed("keith@example.test");
      expect(screen.queryByText(UNNAMED)).toBeNull();
      // Refresh reads everyone again; the name is not asked for again.
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await flush();
      expect(mocks.read).toHaveBeenCalledTimes(2);
      expect(mocks.names).toHaveBeenCalledTimes(1);
      expectNamed("keith@example.test");
    });

    it("an answer that is the raw id (Clerk had nothing) keeps the unnamed label", async () => {
      mocks.names.mockResolvedValue({ [RAW]: RAW });
      draw();
      await flush();
      expect(mocks.names).toHaveBeenCalledTimes(1);
      expectNamed(UNNAMED);
    });

    it("a failed call keeps the unnamed label and the page", async () => {
      mocks.names.mockRejectedValue(new Error("Clerk is down"));
      draw();
      await flush();
      expectNamed(UNNAMED);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("heading", { level: 3, name: "Doc's Cards" })).toBeTruthy();
    });
  });

  it("loading and empty, in plain words", async () => {
    mocks.read.mockReturnValue(new Promise(() => {}));
    const loading = draw();
    expect(loading.view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    cleanup();
    mocks.read.mockResolvedValue({ owners: [], more: false });
    draw();
    await flush();
    expect(screen.getByText("Nobody has connected a marketplace yet.")).toBeTruthy();
  });
});
