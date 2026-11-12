/**
 * NEO-500 — the Pick List in the public demo: reachable logged out, rows that
 * mark pulled with Undo, sort on the URL by replace, By the Box as Back steps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "../PublicCollectionDemo";

vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const PICK_URL = "/binder-tracking?demo=on&side=inventory&tab=pick";

function LocationProbe() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Page URL">{pathname + search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function renderPick(url = PICK_URL) {
  render(
    <Theme>
      <MemoryRouter initialEntries={["/binder-tracking?demo=on", url]} initialIndex={1}>
        <Routes>
          <Route
            path="/binder-tracking"
            element={
              <>
                <PublicCollectionDemo onExit={vi.fn()} keepParams={{ demo: "on" }} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const pageUrl = () => new URLSearchParams(screen.getByRole("status", { name: "Page URL" }).textContent!.split("?")[1]);
const toggle = (name: RegExp) => screen.getByRole("button", { name });

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("the Pick List demo", () => {
  it("opens logged out on the inventory side, Can't find it first, then the sets behind their sport", async () => {
    renderPick();
    expect(await screen.findByRole("heading", { level: 2, name: "Pick List" })).toBeTruthy();
    const table = screen.getByRole("table", { name: "Cards to pull" });
    const groups = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(groups[0]).toContain("Can't find it");
    expect(groups[1]).toContain("Baseball");
    expect(groups[1]).toContain("2026 Topps Series 1");
    expect(groups.at(-1)).toContain("Sold since you started");
    // Heading navigation reaches every group.
    expect(within(table).getByRole("heading", { level: 3, name: "Can't find it" })).toBeTruthy();
    expect(within(table).getByRole("heading", { level: 3, name: "2026 Topps Series 1" })).toBeTruthy();
  });

  it("never gives two rows' controls the same name", async () => {
    renderPick();
    const names = (await screen.findAllByRole("button", { name: /^Pulled / })).map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
    fireEvent.click(screen.getByRole("button", { name: "Group by order" }));
    const grouped = screen.getAllByRole("button", { name: /^Pulled / }).map((b) => b.getAttribute("aria-label"));
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("marks a row pulled with a tap and takes it back with Undo", async () => {
    renderPick();
    const trout = await screen.findByRole("button", { name: /^Pulled #27 Mike Trout/ });
    expect(trout.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(trout.closest("tr")!.querySelectorAll("td")[4]);
    expect(trout.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Pulled #27 Mike Trout.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(toggle(/^Pulled #27 Mike Trout/).getAttribute("aria-pressed")).toBe("false");
  });

  it("moves between rows with the arrow keys", async () => {
    renderPick();
    const toggles = (await screen.findAllByRole("button", { name: /^Pulled / })).filter((b) => b.closest("tbody"));
    act(() => toggles[0].focus());
    fireEvent.keyDown(toggles[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(toggles[1]);
    fireEvent.keyDown(toggles[1], { key: "End" });
    expect(document.activeElement).toBe(toggles.at(-1));
  });

  it("sorts on the URL in place and Back to default clears it", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("button", { name: /^Player/ }));
    expect(pageUrl().get("psort")).toBe("player");
    fireEvent.click(screen.getByRole("button", { name: "Only slabs" }));
    expect(pageUrl().get("pslabs")).toBe("1");
    expect(screen.getAllByRole("button", { name: /^Pulled / })).toHaveLength(2);
    expect(screen.getByText("2 cards match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to default" }));
    // The button switches itself off, so the keyboard lands on Find, not the page.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Find a card" }));
    expect(pageUrl().get("psort")).toBeNull();
    expect(pageUrl().get("pslabs")).toBeNull();
    // Sorting and filtering replaced the entry: Back leaves the Pick List.
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(pageUrl().get("tab")).toBeNull();
  });

  it("walks By the Box one box at a time, each Next a Back step", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("link", { name: "By the Box" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Box 1 of 5 · 2026 Baseball · 6 to pull");
    const slots = within(screen.getByRole("table")).getAllByRole("button", { name: /^Pulled / });
    expect(slots[0].getAttribute("aria-label")).toMatch(/^Pulled #27 Mike Trout/);
    fireEvent.click(screen.getByRole("button", { name: "Next box" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("Box 2 of 5 · Box 2");
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("Box 1 of 5");
  });

  it("names the box in the title, says Can't find it is coming, and ends the walk there", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("link", { name: "By the Box" }));
    expect(document.title).toContain("2026 Baseball");
    expect(screen.getByText("Plus 2 sales NB couldn't tie to a card. They're the last stop, after the boxes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print this box" })).toBeTruthy();
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "Next box" }));
    fireEvent.click(screen.getByRole("button", { name: "Can't find it (2)" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Last stop · Can't find it · 2 to pull");
    expect(within(screen.getByRole("table")).getAllByRole("button", { name: /^Pulled / })).toHaveLength(2);
  });

  it("Box done marks the box after a confirm and steps to the next one", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("link", { name: "By the Box" }));
    const done = screen.getByRole("button", { name: "Box done" });
    fireEvent.click(done);
    expect(done.textContent).toBe("Pull all 6 here?");
    fireEvent.click(done);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("Box 2 of 5");
    fireEvent.click(screen.getByRole("button", { name: "Previous box" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Box 1 of 5 · 2026 Baseball · all pulled");
  });

  it("Pull Complete asks first, then marks everything left and keeps the keyboard", async () => {
    renderPick();
    const pull = await screen.findByRole("button", { name: "Pull Complete" });
    fireEvent.click(pull);
    expect(pull.textContent).toMatch(/^Pull all \d+\?$/);
    // Not yet backs out.
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(pull.textContent).toBe("Pull Complete");
    expect(screen.getAllByRole("button", { name: /^Pulled / }).some((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
    fireEvent.click(pull);
    act(() => pull.focus());
    fireEvent.click(pull);
    expect(screen.getByText("All pulled! Totally tubular.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Pulled / }).every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
    expect(pull.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(pull);
  });

  it("with a filter on, pulls only the rows that match", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("button", { name: "Only slabs" }));
    const pull = screen.getByRole("button", { name: "Pull these 2" });
    fireEvent.click(pull);
    expect(pull.textContent).toBe("Pull these 2?");
    fireEvent.click(pull);
    expect(screen.getAllByRole("button", { name: /^Pulled / }).every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to default" }));
    const all = screen.getAllByRole("button", { name: /^Pulled / });
    expect(all.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(2);
  });

  it("prints a dense sheet, one line per card, only while printing", async () => {
    renderPick();
    await screen.findByRole("table", { name: "Cards to pull" });
    expect(screen.queryByRole("table", { name: "Pick sheet" })).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    const sheet = screen.getByRole("table", { name: "Pick sheet" });
    const lines = within(sheet).getAllByRole("row").filter((r) => r.closest("tbody") && !within(r).queryByRole("rowheader"));
    // One line per row on screen: 29 sales, the two-order Skenes merged into one.
    expect(lines).toHaveLength(screen.getAllByRole("button", { name: /^Pulled / }).length);
    const groups = within(sheet).getAllByRole("rowheader").map((h) => h.textContent);
    // The sport is written once, where it starts.
    expect(groups.filter((g) => g?.startsWith("Baseball"))).toHaveLength(1);
    expect(groups.some((g) => g?.startsWith("2022 Topps Heritage"))).toBe(true);
    expect(within(sheet).getAllByText(/Last ones/).length).toBeGreaterThan(0);
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(screen.queryByRole("table", { name: "Pick sheet" })).toBeNull();
  });

  it("tucks the extra filters under More filters with a count of what is on", async () => {
    renderPick();
    const more = await screen.findByRole("button", { name: "More filters" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: "Sport" }), { target: { value: screen.getByRole("option", { name: "Hockey" }).getAttribute("value") } });
    expect(screen.getByRole("button", { name: "More filters (1 on)" })).toBeTruthy();
  });
});

describe("a Pick List cut short", () => {
  it("says so above the list when the store holds more than it handed over, and not otherwise", async () => {
    const { DemoPickListProvider, DEMO_PICK_DATA } = await import("./demoPickStore");
    const { default: PickListTab } = await import("./PickListTab");
    const { CollectionModeProvider } = await import("../mode");
    const NOTE = "Your Pick List is too long to show at once, so it starts with your oldest orders. Pull these and the rest will show up.";
    const show = (truncated: boolean) =>
      render(
        <Theme>
          <MemoryRouter initialEntries={["/inventory?tab=pick"]}>
            <CollectionModeProvider mode="app" surface="inventory">
              <DemoPickListProvider data={{ ...DEMO_PICK_DATA, truncated }}>
                <PickListTab />
              </DemoPickListProvider>
            </CollectionModeProvider>
          </MemoryRouter>
        </Theme>,
      );
    show(true);
    const region = screen.getByRole("region", { name: "Pick List" });
    expect(within(region).getByText(NOTE)).toBeTruthy();
    cleanup();
    show(false);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByRole("region", { name: "Pick List" })).toBeTruthy();
  });
});

describe("a store that saves to a server", () => {
  it("says Saving… until the mark lands, then Pulled; a failed save says so", async () => {
    const { DEMO_PICK_DATA } = await import("./demoPickStore");
    const { default: PickListTab } = await import("./PickListTab");
    const { CollectionModeProvider } = await import("../mode");
    const { PickListStoreContext } = await import("./store");
    const { PageApiContext } = await import("../pageApi");
    const notify = vi.fn();
    let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
    const store = {
      kind: "convex" as const,
      data: DEMO_PICK_DATA,
      pulled: new Set<string>(),
      setPulled: () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    };
    render(
      <Theme>
        <MemoryRouter initialEntries={["/inventory?tab=pick"]}>
          <CollectionModeProvider mode="app" surface="inventory">
            <PageApiContext.Provider value={{ notify, inform: vi.fn() } as never}>
              <PickListStoreContext.Provider value={store}>
                <PickListTab />
              </PickListStoreContext.Provider>
            </PageApiContext.Provider>
          </CollectionModeProvider>
        </MemoryRouter>
      </Theme>,
    );
    const toggles = screen.getAllByRole("button", { name: /^Pulled #/ });
    fireEvent.click(toggles[0]);
    expect(notify).toHaveBeenLastCalledWith("Saving…", expect.any(Function));
    await act(async () => settle!.resolve());
    expect(notify.mock.lastCall?.[0]).toMatch(/^Pulled #/);

    fireEvent.click(toggles[1]);
    expect(notify).toHaveBeenLastCalledWith("Saving…", expect.any(Function));
    await act(async () => settle!.reject(new Error("offline")));
    expect(notify).toHaveBeenLastCalledWith("That pull didn't save. Try it again.");
  });
});

describe("the signed-in Pick List's ways out", () => {
  async function show(data: Partial<import("./types").PickListData>, withSales: boolean) {
    const { DemoPickListProvider, DEMO_PICK_DATA } = await import("./demoPickStore");
    const { default: PickListTab } = await import("./PickListTab");
    const { CollectionModeProvider } = await import("../mode");
    const { CollectionStoreContext } = await import("../data/store");
    const { REAL_CAPABILITIES } = await import("../data/types");
    const { stubListing } = await import("../inventory/listing/stubListing");
    const store = { kind: "convex", capabilities: REAL_CAPABILITIES, listing: stubListing() } as never;
    const tab = (
      <DemoPickListProvider data={{ ...DEMO_PICK_DATA, ...data }}>
        <PickListTab />
      </DemoPickListProvider>
    );
    render(
      <Theme>
        <MemoryRouter initialEntries={["/inventory?tab=pick"]}>
          <CollectionModeProvider mode="app" surface="inventory">
            {withSales ? <CollectionStoreContext.Provider value={store}>{tab}</CollectionStoreContext.Provider> : tab}
          </CollectionModeProvider>
        </MemoryRouter>
      </Theme>,
    );
    return screen.getByRole("region", { name: "Pick List" });
  }

  it("nothing to pull: no progress bar or Print, and links to Sales and the Inventory list", async () => {
    const region = await show({ lines: [] }, true);
    expect(within(region).getByText("Nothing to pull. Go sell something rad.")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: /^Print/ })).toBeNull();
    expect(region.querySelector(".bg-neon-green")).toBeNull();
    expect(within(region).getByRole("link", { name: "See what sold" }).getAttribute("href")).toBe("/inventory?tab=sales");
    expect(within(region).getByRole("link", { name: "open your inventory" }).getAttribute("href")).toBe("/inventory?tab=cards");
    cleanup();
    // No Sales tab (the demo): only the Inventory list.
    const demo = await show({ lines: [] }, false);
    expect(within(demo).queryByRole("link", { name: "See what sold" })).toBeNull();
    expect(within(demo).getByRole("link", { name: "Open your inventory" })).toBeTruthy();
  });

  it("a line NB couldn't match names its order, and its order opens that sale on the Sales tab", async () => {
    const region = await show({}, true);
    // The toggle carries the order: two orders' strays never read alike.
    expect(
      within(region).getByRole("button", { name: /^Pulled 2025 Bowman Chrome Prospects #BCP-77 Auto, BSC 88257$/ }),
    ).toBeTruthy();
    // The wide cell and the phone's one cell each carry it; CSS shows one.
    for (const link of within(region).getAllByRole("link", { name: "BSC 88257 on your Sales tab" })) {
      expect(link.getAttribute("href")).toBe("/inventory?tab=sales&sorder=o7");
    }
    // A matched card's order stays plain text.
    expect(within(region).queryByRole("link", { name: /^eBay 12-3456/ })).toBeNull();
  });
});
