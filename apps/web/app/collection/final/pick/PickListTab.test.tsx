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

  it("files a sale NB couldn't match with its set when the listing says what it is, marked Not in NB (NEO-509)", async () => {
    renderPick();
    // The toggle reads the title's parts as pauses: "2024 Score #302 · Malik Nabers" visibly.
    const nabers = await screen.findByRole("button", { name: "Pulled 2024 Score #302, Malik Nabers, not in NB, BSC 88240" });
    const row = nabers.closest("tr")!;
    expect(within(row).getAllByText("Not in NB", { exact: true }).length).toBeGreaterThan(0);
    // The chip says why, to a pointer and to a screen reader (the demo has no Sales tab to link to).
    const chip = within(row).getAllByText("Not in NB", { exact: true })[0].parentElement!;
    expect(chip.getAttribute("title")).toBe("NB doesn't have this copy. Go by the listing.");
    expect(chip.textContent).toBe("Not in NB. NB doesn't have this copy. Go by the listing.");
    expect(within(row).queryByText("Unmatched")).toBeNull();
    expect(within(row).getAllByText("#302").length).toBeGreaterThan(0);
    // The listing said Base, so the Base tag. NEO-522: no note under it; the chip already says where to look.
    expect(within(row).getAllByText("Base", { exact: true }).length).toBeGreaterThan(0);
    expect(within(row).queryByText("NB couldn't match this line. Check the order's photo.")).toBeNull();
    // Under the 2024 Score divider, before that set's insert, not in Can't find it.
    const group = row.closest("tbody")!;
    expect(within(group).getByRole("heading", { level: 3, name: "2024 Score" })).toBeTruthy();
    const order = within(group)
      .getAllByRole("button", { name: /^Pulled / })
      .map((b) => b.getAttribute("aria-label"));
    expect(order[0]).toBe(nabers.getAttribute("aria-label"));
    expect(order[1]).toMatch(/^Pulled #7 JC Latham/);
    fireEvent.click(nabers);
    expect(nabers.getAttribute("aria-pressed")).toBe("true");
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
    // A click on the name's cell (the wide screen's Player column) pulls the row.
    const name = within(trout.closest("tr")!)
      .getAllByText("Mike Trout")
      .find((el) => !el.closest("button"))!;
    fireEvent.click(name);
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

  it("names the box in the title, says the sales NB couldn't tie are coming, walks Not in a box by set, and ends on Can't find it", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("link", { name: "By the Box" }));
    expect(document.title).toContain("2026 Baseball");
    // Three: the demo's listing NB filed by its words (Not in a box) and its two strays (Can't find it).
    expect(screen.getByText("Plus 3 sales NB couldn't tie to a card. They wait after the boxes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print this box" })).toBeTruthy();
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "Next box" }));
    fireEvent.click(screen.getByRole("button", { name: "Not in a box (1)" }));
    expect(screen.getByRole("heading", { level: 3, name: "Not in a box · 1 to pull" })).toBeTruthy();
    expect(screen.getByText("NB has no copy of these, so no box to check. Go by each listing, set by set.")).toBeTruthy();
    const described = screen.getByRole("table", { name: "Sales not in NB, by set" });
    // The list's own set divider, its sport's tab beside it.
    expect(within(described).getByRole("heading", { level: 3, name: "2024 Score" })).toBeTruthy();
    expect(within(described).getByRole("button", { name: "Pulled 2024 Score #302, Malik Nabers, not in NB, BSC 88240" })).toBeTruthy();
    expect(within(described).getAllByText("Not in NB", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "All found" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Can't find it (2)" }));
    expect(screen.getByRole("heading", { level: 3, name: "Last stop · Can't find it · 2 to pull" })).toBeTruthy();
    expect(screen.getByText("These sales don't say enough to file. The order's photo is your best clue.")).toBeTruthy();
    const lost = screen.getByRole("table", { name: "Sales NB couldn't tie to a card" });
    expect(within(lost).getAllByRole("button", { name: /^Pulled / })).toHaveLength(2);
    // The heading already says it: no Not in NB chip here.
    expect(within(lost).queryByText("Not in NB", { exact: true })).toBeNull();
    // Back steps to Not in a box.
    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(screen.getByRole("heading", { level: 3, name: "Not in a box · 1 to pull" })).toBeTruthy();
  });

  it("Only not in NB keeps just the sales NB has no card for, and Back to default clears it", async () => {
    renderPick();
    fireEvent.click(await screen.findByRole("button", { name: "Only not in NB" }));
    expect(pageUrl().get("pnotnb")).toBe("1");
    expect(screen.getByRole("button", { name: "Only not in NB" }).getAttribute("aria-pressed")).toBe("true");
    const names = screen.getAllByRole("button", { name: /^Pulled / }).map((b) => b.getAttribute("aria-label"));
    expect(names).toHaveLength(3);
    expect(names.every((n) => !n!.startsWith("Pulled #"))).toBe(true);
    expect(screen.getByText("3 cards match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to default" }));
    expect(pageUrl().get("pnotnb")).toBeNull();
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
    // The described sale prints like a card, marked Not in NB, its next step kept and free to wrap.
    const nabers = lines.find((r) => r.textContent?.includes("Malik Nabers"))!;
    expect(nabers.textContent).toContain("#302");
    expect(nabers.textContent).toContain("Not in NB");
    expect(nabers.textContent).toContain("Base NB couldn't match this line. Check the order's photo.");
    expect(nabers.className).toContain("nb-pick-sheet-lost");
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

describe("NEO-522: a row read from across the room", () => {
  /** The row's own words, outside the card picture (whose face prints the team). */
  const rowWords = (row: HTMLElement) =>
    [...row.querySelectorAll("td")]
      .filter((td) => !td.querySelector(".nb-pick-thumb"))
      .map((td) => td.textContent)
      .join(" ");
  const rowOf = async (name: RegExp) => (await screen.findByRole("button", { name })).closest("tr")!;

  it("drops the team line: the card's picture carries it", async () => {
    renderPick();
    const trout = await rowOf(/^Pulled #27 Mike Trout/);
    expect(within(trout).getAllByText("Mike Trout").length).toBeGreaterThan(0);
    expect(rowWords(trout)).not.toContain("Angels");
  });

  it("tags each row with its variant's own name in its divider's colour, the kind read out first", async () => {
    renderPick();
    const tagOf = (row: HTMLElement, text: string) => within(row).getAllByText(text, { exact: true })[0].parentElement!;

    const trout = await rowOf(/^Pulled #27 Mike Trout/);
    const base = tagOf(trout, "Base");
    expect(base.textContent).toBe("Base");
    expect(base.getAttribute("title")).toBe("Base");
    expect(base.className).toContain("bg-variant-base");

    const ohtani = await rowOf(/^Pulled #8B-7 Shohei Ohtani/);
    const insert = tagOf(ohtani, "8 Bit Ballers");
    expect(insert.textContent).toBe("Insert: 8 Bit Ballers");
    expect(insert.getAttribute("title")).toBe("Insert: 8 Bit Ballers");
    expect(insert.className).toContain("bg-variant-insert");
    // The generic word is gone from the row: the name replaces it.
    expect(within(ohtani).queryByText("Insert", { exact: true })).toBeNull();

    const schlittler = await rowOf(/^Pulled #111 Cam Schlittler/);
    expect(tagOf(schlittler, "Gold Foil").textContent).toBe("Parallel: Gold Foil");
    const judge = await rowOf(/^Pulled #8B-12 Aaron Judge/);
    expect(tagOf(judge, "8 Bit Ballers Red").textContent).toBe("Insert parallel: 8 Bit Ballers Red");
    // A long name wraps to two lines and trims, never pushing the row wider.
    expect(within(judge).getAllByText("8 Bit Ballers Red", { exact: true })[0].className).toContain("line-clamp-2");
    // The serial stays with the copy's details, not the tag.
    expect(within(schlittler).getAllByText("1187/2026").length).toBeGreaterThan(0);
  });

  it("puts the tags on the name's line, never a line of their own", async () => {
    renderPick();
    const judge = await rowOf(/^Pulled #8B-12 Aaron Judge/);
    const lastOnes = within(judge).getAllByText("Last ones", { exact: true })[0];
    const name = within(judge)
      .getAllByText("Aaron Judge", { exact: true })
      .find((el) => !el.closest("button"))!;
    // One line: the name and the tags share a parent.
    expect(lastOnes.closest("span.flex-wrap")!.parentElement).toBe(name.parentElement);
  });

  it("rules a heavier line in the next variant's colour where the variant changes inside a set, a thin one elsewhere", async () => {
    renderPick();
    const firstCell = async (name: RegExp) => [...(await rowOf(name)).querySelectorAll("td")][0];
    // 2026 Topps Series 1 walks Base (#27, #150), Gold Foil, 8 Bit Ballers, 8 Bit Ballers Red.
    expect((await firstCell(/^Pulled #27 Mike Trout/)).className).toContain("border-rule");
    expect((await firstCell(/^Pulled #27 Mike Trout/)).className).not.toContain("border-b-[3px]");
    const skenes = (await firstCell(/^Pulled #150 Paul Skenes/)).className;
    expect(skenes).toContain("border-b-[3px]");
    expect(skenes).toContain("border-b-variant-parallel-rule");
    expect((await firstCell(/^Pulled #111 Cam Schlittler/)).className).toContain("border-b-variant-insert-rule");
    expect((await firstCell(/^Pulled #8B-7 Shohei Ohtani/)).className).toContain("border-b-variant-insert-parallel-rule");
    // The set's last row: the next divider's own rule takes over.
    expect((await firstCell(/^Pulled #8B-12 Aaron Judge/)).className).not.toContain("border-b-[3px]");
    // Every cell of the row carries it, so the rule runs the row's full width.
    const cells = [...(await rowOf(/^Pulled #150 Paul Skenes/)).querySelectorAll("td")];
    expect(cells.every((td) => td.className.includes("border-b-variant-parallel-rule"))).toBe(true);
  });

  it("draws no variant rule in a flat run sorted by a column", async () => {
    renderPick(`${PICK_URL}&psort=player`);
    const cells = [...(await rowOf(/^Pulled #150 Paul Skenes/)).querySelectorAll("td")];
    expect(cells.some((td) => td.className.includes("border-b-[3px]"))).toBe(false);
  });

  it("keeps the box the size of the text, the button around it the target", async () => {
    renderPick();
    const toggle = await screen.findByRole("button", { name: /^Pulled #27 Mike Trout/ });
    // A phone's 44px target, 32px with a mouse; the box inside stays 20px.
    expect(toggle.className).toContain("size-11");
    expect(toggle.className).toContain("md:size-8");
    const box = toggle.querySelector("span[aria-hidden='true']")!;
    expect(box.className).toContain("size-5");
  });

  it("names the Variant column and keeps Set and Serial sorting", async () => {
    renderPick();
    const table = await screen.findByRole("table", { name: "Cards to pull" });
    expect(within(table).getByRole("columnheader", { name: "Variant" })).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "Serial" }));
    expect(pageUrl().get("psort")).toBe("detail");
    fireEvent.click(within(table).getByRole("button", { name: "Set" }));
    expect(pageUrl().get("psort")).toBe("set");
  });

  it("drops the couldn't-match note from a sale filed with its set, and keeps Can't find it's reason", async () => {
    renderPick();
    await screen.findByRole("table", { name: "Cards to pull" });
    expect(screen.queryByText("NB couldn't match this line. Check the order's photo.")).toBeNull();
    const witt = await rowOf(/^Pulled 2026 Topps Heritage Clubhouse Collection Relic Bobby Witt Jr\./);
    expect(within(witt).getAllByText("NB has no 2026 Topps Heritage checklist yet.").length).toBeGreaterThan(0);
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

describe("a store that saves to a server: more than one save", () => {
  type Job = { ids: readonly string[]; on: boolean; resolve: () => void; reject: (e: Error) => void };
  async function mountSaving(pulledAll: boolean) {
    const { DEMO_PICK_DATA } = await import("./demoPickStore");
    const { default: PickListTab } = await import("./PickListTab");
    const { CollectionModeProvider } = await import("../mode");
    const { PickListStoreContext } = await import("./store");
    const { PageApiContext } = await import("../pageApi");
    const notify = vi.fn();
    const jobs: Job[] = [];
    const store = {
      kind: "convex" as const,
      data: DEMO_PICK_DATA,
      pulled: new Set<string>(pulledAll ? DEMO_PICK_DATA.lines.map((l) => l.id) : []),
      setPulled: (ids: readonly string[], on: boolean) =>
        new Promise<void>((resolve, reject) => jobs.push({ ids, on, resolve, reject })),
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
    return { notify, jobs, toggles: screen.getAllByRole("button", { name: /^Pulled #/ }) };
  }

  it("a failed put-back says the card didn't go back, not that the pull didn't save", async () => {
    const { notify, jobs, toggles } = await mountSaving(true);
    fireEvent.click(toggles[0]);
    expect(jobs[0].on).toBe(false);
    await act(async () => jobs[0].reject(new Error("offline")));
    expect(notify).toHaveBeenLastCalledWith("That card didn't go back on the list. Try it again.");
  });

  it("a mark that lands after a newer one began stays quiet; the newer one has the last word", async () => {
    const { notify, jobs, toggles } = await mountSaving(false);
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    expect(jobs).toHaveLength(2);
    await act(async () => jobs[0].resolve());
    expect(notify).toHaveBeenLastCalledWith("Saving…", expect.any(Function));
    await act(async () => jobs[1].resolve());
    expect(notify.mock.lastCall?.[0]).toMatch(/^Pulled #/);
  });

  it("a failed save speaks even when a newer mark has begun", async () => {
    const { notify, jobs, toggles } = await mountSaving(false);
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    await act(async () => jobs[0].reject(new Error("offline")));
    expect(notify).toHaveBeenLastCalledWith("That pull didn't save. Try it again.");
  });

  it("Undo during Saving… asks the store to flip the same lines back, and a failed Undo says so", async () => {
    const { notify, jobs, toggles } = await mountSaving(false);
    fireEvent.click(toggles[0]);
    const undo = notify.mock.lastCall![1] as () => void;
    await act(async () => undo());
    expect(jobs).toHaveLength(2);
    expect(jobs[1].ids).toEqual(jobs[0].ids);
    expect(jobs[1].on).toBe(false);
    await act(async () => jobs[1].reject(new Error("offline")));
    expect(notify).toHaveBeenLastCalledWith("That card didn't go back on the list. Try it again.");
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

  it("a listed row keeps every variant word, its sport on Can't find it, and a twin divider reads apart", async () => {
    const { DEMO_PICK_DATA } = await import("./demoPickStore");
    const order = { id: "ox", venue: "BSC", number: "99001" };
    const base = { quantity: 1, condition: "NM", order, card: null, sportCode: null, problem: "NB couldn't match this line. Check the order's photo." };
    const extra = [
      {
        ...base,
        id: "x-variation",
        listingTitle: "2024 Score Variation #302 · Malik Nabers",
        // A word NB does not file by, joined to the demo's 2024 Score by sport name.
        listed: { sportName: "Football", year: 2024, season: "2024", setName: "Score", players: "Malik Nabers", cardNumber: "302", variantWord: "Variation" },
      },
      {
        ...base,
        id: "x-twin",
        listingTitle: "2024 Score #9 · Someone",
        // Resolved to a sport row no NB set on the list carries: its own divider, titled like NB's.
        listed: { sportId: "sp-other", sportName: "Football", sportCode: "FB", year: 2024, season: "2024", setName: "Score", players: "Someone", cardNumber: "9" },
      },
      {
        ...base,
        id: "x-thin",
        listingTitle: "Hockey only · Somebody",
        listed: { sportName: "Hockey", players: "Somebody" },
      },
    ];
    const region = await show({ lines: [...DEMO_PICK_DATA.lines, ...extra] }, true);
    const variation = within(region).getByRole("button", { name: "Pulled 2024 Score Variation #302, Malik Nabers, not in NB, BSC 99001" }).closest("tr")!;
    // The listing's own word, never a Base chip it did not say.
    expect(within(variation).getAllByText("Variation", { exact: true }).length).toBeGreaterThan(0);
    expect(within(variation).queryByText("Base", { exact: true })).toBeNull();
    // With a Sales tab, the chip points at the order link.
    const chip = within(variation).getAllByText("Not in NB", { exact: true })[0].parentElement!;
    expect(chip.getAttribute("title")).toBe("NB doesn't have this copy. Go by the listing; the order link has the photo.");
    // NB's 2024 Score heading stays plain; the listing's own reads apart.
    expect(within(region).getByRole("heading", { level: 3, name: "2024 Score" })).toBeTruthy();
    expect(within(region).getByRole("heading", { level: 3, name: "2024 Score, not matched to a set" })).toBeTruthy();
    // Can't find it shows the listing's sport.
    const thin = within(region).getByRole("button", { name: "Pulled Hockey only, Somebody, not in NB, BSC 99001" }).closest("tr")!;
    expect(thin.closest("tbody")!.textContent).toContain("Can't find it");
    expect(within(thin).getAllByText("Hockey", { exact: true }).length).toBeGreaterThan(0);
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

// NEO-500: two states the live data cannot put on screen in the E2E specs (the
// list is cut at 1000 lines; a "Box not recorded" line needs a sale applied
// before boxes were tracked, and the test order hop never makes one). axe-core
// runs here on the real component. jsdom paints nothing, so contrast (and so
// light vs dark) is the one thing this cannot check: those two notices reuse
// the info and plain-ink roles that the E2E specs' axe passes already cover.
describe("the Pick List's rare states pass axe", () => {
  async function violationsFor(data: Partial<import("./types").PickListData>, url: string) {
    const axe = (await import("axe-core")).default;
    const { DemoPickListProvider, DEMO_PICK_DATA } = await import("./demoPickStore");
    const { default: PickListTab } = await import("./PickListTab");
    const { CollectionModeProvider } = await import("../mode");
    const { container } = render(
      <Theme>
        <MemoryRouter initialEntries={[url]}>
          <CollectionModeProvider mode="app" surface="inventory">
            <DemoPickListProvider data={{ ...DEMO_PICK_DATA, ...data }}>
              <PickListTab />
            </DemoPickListProvider>
          </CollectionModeProvider>
        </MemoryRouter>
      </Theme>,
    );
    const region = screen.getByRole("region", { name: "Pick List" });
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    return { region, violations: results.violations.map((v) => `${v.id}: ${v.nodes.length}`) };
  }

  it("the notice that the list is cut short", async () => {
    const { region, violations } = await violationsFor({ truncated: true }, "/inventory?tab=pick");
    expect(within(region).getByText(/^Your Pick List is too long to show at once/)).toBeTruthy();
    expect(violations).toEqual([]);
  });

  it("the Not in a box and Can't find it stops in By the Box", async () => {
    const notInBox = await violationsFor({}, "/inventory?tab=pick&pv=box&pbox=not-in-box");
    expect(within(notInBox.region).getByRole("heading", { level: 3, name: "Not in a box · 1 to pull" })).toBeTruthy();
    expect(notInBox.violations).toEqual([]);
    cleanup();
    const cantFind = await violationsFor({}, "/inventory?tab=pick&pv=box&pbox=cant-find");
    expect(within(cantFind.region).getByRole("heading", { level: 3, name: "Last stop · Can't find it · 2 to pull" })).toBeTruthy();
    expect(cantFind.violations).toEqual([]);
  });

  it("the Box not recorded stop in By the Box", async () => {
    const { DEMO_PICK_DATA } = await import("./demoPickStore");
    // Every matched card sold before NB kept track of boxes.
    const lines = DEMO_PICK_DATA.lines.map((l) => (l.card ? { ...l, boxUnrecorded: true as const, spot: undefined } : l));
    const { region, violations } = await violationsFor({ lines }, "/inventory?tab=pick&pv=box");
    expect(within(region).getByRole("heading", { level: 3, name: /^Box not recorded · \d+ to pull$/ })).toBeTruthy();
    expect(within(region).getByText("These sold before NB kept track of boxes. Look wherever you keep the set.")).toBeTruthy();
    expect(violations).toEqual([]);
  });
});
