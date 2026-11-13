/**
 * NEO-536 — the crew on the dashboard: "Report to our crew" on a Sync status
 * set that holds back cards only the crew can fix, and the crew section under
 * Sync status (the collector's open asks; an admin's from every collector).
 * Only the signed-in page has a crew; the demo (no provider) draws neither.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYNC_REPORT_GROUP_COUNT_CAP } from "@/lib/collection/sync-report";
import { getDashboard, type DashboardData, type SyncProblemSet } from "../fake-data";
import DashboardScreen from "./DashboardScreen";
import { alsoReportedLine } from "@/app/admin/card-requests/syncReportCopy";
import { WITHDREW_SHOWN_MS } from "./CrewDesk";
import { CREW_DESK_WAITING } from "@/convex/crewDesk";
import { CrewProvider, MY_REQUESTS_HREF, WAITING_SHOWN, type Crew, type CrewAsk, type CrewDeskData } from "./crew";
import { heldLead, heldOrder, HELD_PREVIEW } from "./SyncStatus";

afterEach(cleanup);

const EMPTY_DESK: CrewDeskData = { mine: [], mineMore: 0, waiting: null, waitingMore: false };

function crewOf(over: Partial<Crew> = {}): Crew {
  return {
    desk: EMPTY_DESK,
    isReported: () => false,
    report: vi.fn(async () => null),
    withdraw: vi.fn(async () => null),
    ...over,
  };
}

/** The demo's collector, its first held-back set made one only the crew can fix. */
function crewSet(over: Partial<SyncProblemSet> = {}): { data: DashboardData; set: SyncProblemSet } {
  const data = getDashboard();
  const status = data.syncStatus!;
  const set: SyncProblemSet = { ...status.problems[0], variantId: "variant-1", crewFix: "all", ...over };
  return { data: { ...data, syncStatus: { ...status, problems: [set, ...status.problems.slice(1)] } }, set };
}

function draw(data: DashboardData, crew: Crew | null) {
  const screenEl = <DashboardScreen data={data} />;
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      {crew ? <CrewProvider value={crew}>{screenEl}</CrewProvider> : screenEl}
    </MemoryRouter>,
  );
}

const reportButton = (set: SyncProblemSet) =>
  screen.queryByRole("button", { name: `Report to our crew about ${set.setLabel} on eBay` });

const ask = (over: Partial<CrewAsk> & Pick<CrewAsk, "id" | "kind">): CrewAsk => ({ label: `Ask ${over.id}`, at: 1, ...over });

describe("the lead over a set's held-back cards says who fixes them", () => {
  const base = { marketplace: "ebay" as const };
  it("the collector: each card's own fix (unchanged)", () => {
    expect(heldLead({ ...base, heldBack: 1 })).toBe("1 card held back from eBay. Fix it on the card and it goes up next sync:");
    expect(heldLead({ ...base, heldBack: 3 })).toBe(
      "3 cards held back from eBay. Fix each one on its card and it goes up next sync:",
    );
  });

  it("the crew, every card: short, and no colon (the action is the Report button)", () => {
    expect(heldLead({ ...base, heldBack: 1, crewFix: "all" })).toBe("1 card held back from eBay. On our crew, not you.");
    expect(heldLead({ ...base, heldBack: 4, crewFix: "all" })).toBe("4 cards held back from eBay. On our crew, not you.");
  });

  it("both: fix yours, the rest are on us", () => {
    expect(heldLead({ ...base, heldBack: 4, crewFix: "some" })).toBe(
      "4 cards held back from eBay. Fix yours on the card. The rest are on us.",
    );
  });

  it("the screen draws the crew's lead on the set", () => {
    const { data, set } = crewSet();
    draw(data, crewOf());
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(within(sync).getByText(heldLead(set))).toBeTruthy();
  });
});

describe("a mixed set's tiles say which cards are the crew's", () => {
  /** The demo's Finest set, its first `crew` cards made ones only the crew can fix, `size` cards in all. */
  function mixedSet(size: number, crew: number): { data: DashboardData; set: SyncProblemSet } {
    const data = getDashboard();
    const status = data.syncStatus!;
    const finest = status.problems[1];
    const cards = finest.cards.slice(0, size).map((c, i) => (i < crew ? { ...c, code: i % 2 ? ("rejected" as const) : ("noLink" as const) } : c));
    const set: SyncProblemSet = { ...finest, cards, heldBack: size, variantId: "variant-2", crewFix: crew === size ? "all" : "some" };
    return { data: { ...data, syncStatus: { ...status, problems: [status.problems[0], set] } }, set };
  }

  const tiles = (set: SyncProblemSet) =>
    within(screen.getByRole("article", { name: `${set.setLabel} on eBay` })).getAllByRole("listitem");

  it("tags each crew tile \"On our crew\" in words, and sorts them after the collector's own", () => {
    const { data, set } = mixedSet(3, 1);
    draw(data, crewOf());
    const items = tiles(set);
    expect(items).toHaveLength(3);
    // The read named the crew's card first; it shows last.
    const hrefOf = (li: HTMLElement) => decodeURIComponent(within(li).getByRole("link").getAttribute("href") ?? "");
    expect(hrefOf(items[2])).toContain(String(set.cards[0].card.id));
    expect(hrefOf(items[0])).toContain(String(set.cards[1].card.id));
    expect(within(items[2]).getByText("On our crew")).toBeTruthy();
    expect(within(items[0]).queryByText("On our crew")).toBeNull();
    expect(within(items[1]).queryByText("On our crew")).toBeNull();
    // The tag is part of the tile's link, so a reader hears it too.
    expect(within(items[2]).getByRole("link").textContent).toContain("On our crew");
  });

  it("the crew's tiles fold past the preview behind the collector's own, and Show all brings them", () => {
    const { data, set } = mixedSet(8, 2);
    draw(data, crewOf());
    expect(tiles(set)).toHaveLength(HELD_PREVIEW);
    expect(screen.queryAllByText("On our crew")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Show all 8 held back in ${set.setLabel}`) }));
    const items = tiles(set);
    expect(items).toHaveLength(8);
    expect(within(items[6]).getByText("On our crew")).toBeTruthy();
    expect(within(items[7]).getByText("On our crew")).toBeTruthy();
  });

  it("a set whose every card is the crew's carries no tags: the lead says it once", () => {
    const { data, set } = mixedSet(3, 3);
    draw(data, crewOf());
    expect(set.crewFix).toBe("all");
    expect(screen.queryAllByText("On our crew")).toHaveLength(0);
  });

  it("the demo's sets (no crew cards) keep their order and carry no tags", () => {
    draw(getDashboard(), null);
    expect(screen.queryAllByText("On our crew")).toHaveLength(0);
  });

  it("heldOrder keeps each kind in the read's order", () => {
    const cards = [
      { id: 1, code: "noLink" as const },
      { id: 2, code: "noPrice" as const },
      { id: 3, code: "rejected" as const },
      { id: 4 },
      { id: 5, code: "noPhoto" as const },
    ];
    expect(heldOrder(cards).map((c) => c.id)).toEqual([2, 4, 5, 1, 3]);
  });
});

describe("Report to our crew on Sync status", () => {
  it("the demo (no crew) draws no Report button and no crew section, even on a crew-fix set", () => {
    const { data, set } = crewSet();
    draw(data, null);
    expect(reportButton(set)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Report to our crew/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "With our crew" })).toBeNull();
    expect(screen.queryByRole("region", { name: "From collectors" })).toBeNull();
  });

  it("shows only on a set holding back a card only the crew can fix", () => {
    const { data, set } = crewSet();
    draw(data, crewOf());
    expect(reportButton(set)).not.toBeNull();
    // The demo's other set holds back only cards the collector fixes.
    expect(screen.getAllByRole("button", { name: /^Report to our crew/ })).toHaveLength(1);
  });

  it("never on a set whose last sync failed (NB runs it again), or one with no id to report by", () => {
    const failed = crewSet({ failure: "The marketplace didn't answer." });
    draw(failed.data, crewOf());
    expect(reportButton(failed.set)).toBeNull();
    cleanup();
    const noId = crewSet({ variantId: undefined });
    draw(noId.data, crewOf());
    expect(reportButton(noId.set)).toBeNull();
  });

  it("opens a note, Enter sends it, and the set reads Reported from the open reports", async () => {
    const { data, set } = crewSet();
    const report = vi.fn(async (_input: Parameters<Crew["report"]>[0]) => null);
    function Harness({ children }: { children: ReactNode }) {
      const [reported, setReported] = useState(false);
      const crew = crewOf({
        isReported: (variantId, platform) => reported && variantId === "variant-1" && platform === "ebay",
        report: async (input) => {
          const out = await report(input);
          setReported(true);
          return out;
        },
      });
      return <CrewProvider value={crew}>{children}</CrewProvider>;
    }
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Harness>
          <DashboardScreen data={data} />
        </Harness>
      </MemoryRouter>,
    );
    fireEvent.click(reportButton(set)!);
    const note = screen.getByRole("textbox", { name: `Note for our crew (optional) about ${set.setLabel} on eBay` });
    expect(document.activeElement).toBe(note);
    expect(note.getAttribute("maxlength")).toBe("500");
    fireEvent.change(note, { target: { value: "Card 12 is linked to the wrong player" } });
    await act(async () => {
      fireEvent.submit(note.closest("form")!);
    });
    expect(report).toHaveBeenCalledWith({
      variantId: "variant-1",
      platform: "ebay",
      note: "Card 12 is linked to the wrong player",
    });
    const sync = screen.getByRole("region", { name: "Sync status" });
    const status = await within(sync).findByText(/^Reported\. Our crew's on it\./);
    await waitFor(() => expect(document.activeElement).toBe(status.closest("p")));
    expect(reportButton(set)).toBeNull();
  });

  it("a set already reported reads Reported on load, with no button", () => {
    const { data, set } = crewSet();
    draw(data, crewOf({ isReported: (v, p) => v === "variant-1" && p === "ebay" }));
    expect(reportButton(set)).toBeNull();
    expect(screen.getByText(/^Reported\. Our crew's on it\./)).toBeTruthy();
  });

  it("Escape backs out without sending, and focus goes back to the button", () => {
    const { data, set } = crewSet();
    const crew = crewOf();
    draw(data, crew);
    fireEvent.click(reportButton(set)!);
    const note = screen.getByRole("textbox", { name: /^Note for our crew/ });
    fireEvent.keyDown(note, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: /^Note for our crew/ })).toBeNull();
    expect(crew.report).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(reportButton(set));
  });

  it("Cancel backs out too", () => {
    const { data, set } = crewSet();
    draw(data, crewOf());
    fireEvent.click(reportButton(set)!);
    fireEvent.click(screen.getByRole("button", { name: `Cancel report on ${set.setLabel} on eBay` }));
    expect(screen.queryByRole("textbox", { name: /^Note for our crew/ })).toBeNull();
  });

  it("a refused report shows the backend's sentence and keeps the note open", async () => {
    const { data, set } = crewSet();
    const why = "You have 50 reports open. Withdraw one, or wait for the crew to close some.";
    draw(data, crewOf({ report: vi.fn(async () => why) }));
    fireEvent.click(reportButton(set)!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Send report on ${set.setLabel} on eBay` }));
    });
    expect(screen.getByRole("alert").textContent).toBe(why);
    const note = screen.getByRole("textbox", { name: /^Note for our crew/ });
    expect(note.getAttribute("aria-invalid")).toBe("true");
  });

  it("the form's alert is there, empty, before anything goes wrong, so a refusal is announced", () => {
    const { data, set } = crewSet();
    draw(data, crewOf());
    fireEvent.click(reportButton(set)!);
    const form = screen.getByRole("textbox", { name: /^Note for our crew/ }).closest("form")!;
    expect(within(form).getByRole("alert").textContent).toBe("");
  });

  it("sent, but the read never says Reported: the keyboard goes back to the button, and nothing moves it later", async () => {
    const { data, set } = crewSet();
    const { rerender } = draw(data, crewOf());
    fireEvent.click(reportButton(set)!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Send report on ${set.setLabel} on eBay` }));
    });
    expect(document.activeElement).toBe(reportButton(set));
    // Focus moves on; a later render must not pull it back.
    const other = screen.getByRole("heading", { level: 1 });
    other.tabIndex = -1;
    other.focus();
    rerender(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <CrewProvider value={crewOf()}>
          <DashboardScreen data={data} />
        </CrewProvider>
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(other);
  });
});

describe("the crew section under Sync status", () => {
  it("draws nothing with nothing open, or while it loads", () => {
    draw(getDashboard(), crewOf());
    expect(screen.queryByRole("region", { name: "With our crew" })).toBeNull();
    cleanup();
    draw(getDashboard(), crewOf({ desk: undefined }));
    expect(screen.queryByRole("region", { name: "With our crew" })).toBeNull();
    cleanup();
    draw(getDashboard(), crewOf({ desk: { ...EMPTY_DESK, waiting: [] } }));
    expect(screen.queryByRole("region", { name: "From collectors" })).toBeNull();
  });

  it("a collector sees their open asks, one line each, right under Sync status, and More opens My requests", () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      mine: [
        ask({ id: "r1", kind: "report", label: "2024 Topps Chrome Base", platform: "ebay" }),
        ask({ id: "c1", kind: "card", label: "2024 Topps Chrome #12 Ohtani" }),
        ask({ id: "s1", kind: "set", label: "1991 Upper Deck Final Edition" }),
      ],
      mineMore: 4,
    };
    draw(getDashboard(), crewOf({ desk }));
    const mine = screen.getByRole("region", { name: "With our crew" });
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(sync.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(mine).getAllByRole("listitem")).toHaveLength(3);
    expect(within(mine).getByText("Sync report")).toBeTruthy();
    expect(within(mine).getByText("Card request")).toBeTruthy();
    expect(within(mine).getByText("Set request")).toBeTruthy();
    expect(within(mine).getByText("7 open")).toBeTruthy();
    // Only a report is withdrawn here; a card or set request opens My requests, its name telling it apart.
    expect(within(mine).getAllByRole("button", { name: /^Withdraw/ })).toHaveLength(1);
    const card = within(mine).getByRole("link", { name: /^2024 Topps Chrome #12 Ohtani/ });
    expect(card.getAttribute("href")).toBe(MY_REQUESTS_HREF);
    expect(card.textContent).toMatch(/Card request, in My requests, asked \S/);
    const set = within(mine).getByRole("link", { name: /^1991 Upper Deck Final Edition/ });
    expect(set.getAttribute("href")).toBe(MY_REQUESTS_HREF);
    expect(set.textContent).toContain("Set request, in My requests");
    expect(within(mine).queryByRole("link", { name: /^2024 Topps Chrome Base/ })).toBeNull();
    expect(within(mine).getByRole("link", { name: "4 more in My requests" }).getAttribute("href")).toBe(MY_REQUESTS_HREF);
    expect(screen.queryByRole("region", { name: "From collectors" })).toBeNull();
  });

  /** A crew whose withdraw drops the row from the desk, as the real read does, when `drop` is pressed (or at once). */
  function WithdrawHarness({
    asks,
    data,
    dropAtOnce = true,
  }: {
    asks: CrewAsk[];
    data: DashboardData;
    dropAtOnce?: boolean;
  }) {
    const [mine, setMine] = useState(asks);
    const [gone, setGone] = useState<string | null>(null);
    const crew = crewOf({
      desk: { ...EMPTY_DESK, mine },
      withdraw: async (id) => {
        if (dropAtOnce) setMine((m) => m.filter((a) => a.id !== id));
        else setGone(id);
        return null;
      },
    });
    return (
      <MemoryRouter initialEntries={["/dashboard"]}>
        <CrewProvider value={crew}>
          <DashboardScreen data={data} />
        </CrewProvider>
        <button type="button" onClick={() => setMine((m) => m.filter((a) => a.id !== gone))}>
          Read catches up
        </button>
      </MemoryRouter>
    );
  }

  const REPORT_ASK = ask({ id: "r1", kind: "report", label: "2024 Topps Chrome Base", platform: "ebay" });

  it("the withdraw line is there, empty, before any withdraw, so it is announced", () => {
    draw(getDashboard(), crewOf({ desk: { ...EMPTY_DESK, mine: [REPORT_ASK] } }));
    expect(screen.getAllByRole("status").some((el) => el.textContent === "")).toBe(true);
    // And each report's row has its alert ready too.
    const mine = screen.getByRole("region", { name: "With our crew" });
    expect(within(mine).getByRole("alert").textContent).toBe("");
  });

  it("withdrawing the last ask says so, and the keyboard lands on Sync status's heading", async () => {
    render(<WithdrawHarness asks={[REPORT_ASK]} data={getDashboard()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
    });
    expect(screen.queryByRole("region", { name: "With our crew" })).toBeNull();
    expect(screen.getByText("Withdrew the report on 2024 Topps Chrome Base (eBay).").getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Sync status" })));
  });

  it("with another ask left, the keyboard lands on With our crew's heading", async () => {
    render(<WithdrawHarness asks={[REPORT_ASK, ask({ id: "c1", kind: "card", label: "A card" })]} data={getDashboard()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "With our crew" })));
  });

  it("with no Sync status either, the keyboard lands on the page's h1, never the page", async () => {
    const data: DashboardData = { ...getDashboard(), syncStatus: null };
    render(<WithdrawHarness asks={[REPORT_ASK]} data={data} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
    });
    const h1 = screen.getByRole("heading", { level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(h1.getAttribute("tabindex")).toBe("-1");
  });

  it("the keyboard waits for the read to drop the row before it moves", async () => {
    render(<WithdrawHarness asks={[REPORT_ASK]} data={getDashboard()} dropAtOnce={false} />);
    const withdraw = screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" });
    withdraw.focus();
    await act(async () => {
      fireEvent.click(withdraw);
    });
    // Said at once; the row is still drawn, so nothing moves yet.
    expect(screen.getByText("Withdrew the report on 2024 Topps Chrome Base (eBay).")).toBeTruthy();
    expect(document.activeElement).toBe(withdraw);
    fireEvent.click(screen.getByRole("button", { name: "Read catches up" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Sync status" })));
  });

  it("two requests of one name read apart by when each was asked", () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      mine: [
        ask({ id: "a", kind: "card", label: "1991 Donruss #1 Ripken", at: Date.UTC(2026, 10, 1, 15) }),
        ask({ id: "b", kind: "card", label: "1991 Donruss #1 Ripken", at: Date.UTC(2026, 10, 9, 15) }),
      ],
    };
    draw(getDashboard(), crewOf({ desk }));
    const [one, two] = within(screen.getByRole("region", { name: "With our crew" })).getAllByRole("link", { name: /^1991 Donruss/ });
    expect(one.textContent).not.toBe(two.textContent);
  });

  it("while it withdraws, the button says so and its name still starts with Withdraw", async () => {
    const desk: CrewDeskData = { ...EMPTY_DESK, mine: [REPORT_ASK] };
    draw(getDashboard(), crewOf({ desk, withdraw: vi.fn(() => new Promise<string | null>(() => {})) }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
    const busy = await screen.findByRole("button", { name: "Withdrawing… report for 2024 Topps Chrome Base on eBay" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.hasAttribute("aria-label")).toBe(false);
  });

  it(`the withdraw line clears itself after ${WITHDREW_SHOWN_MS} ms, and the line stays mounted`, async () => {
    vi.useFakeTimers();
    try {
      render(<WithdrawHarness asks={[REPORT_ASK, ask({ id: "c1", kind: "card", label: "A card" })]} data={getDashboard()} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
      });
      const line = screen.getByText("Withdrew the report on 2024 Topps Chrome Base (eBay).");
      act(() => {
        vi.advanceTimersByTime(WITHDREW_SHOWN_MS - 1);
      });
      expect(line.textContent).not.toBe("");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(line.textContent).toBe("");
      expect(line.getAttribute("role")).toBe("status");
      expect(line.isConnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the next withdraw clears the last one's line as it starts", async () => {
    const second = ask({ id: "r2", kind: "report", label: "1993 Finest Base", platform: "bsc" });
    let release: (v: string | null) => void = () => {};
    let calls = 0;
    function Harness() {
      const [mine, setMine] = useState([REPORT_ASK, second]);
      const crew = crewOf({
        desk: { ...EMPTY_DESK, mine },
        withdraw: (id) => {
          calls += 1;
          if (calls === 1) {
            setMine((m) => m.filter((a) => a.id !== id));
            return Promise.resolve(null);
          }
          return new Promise<string | null>((resolve) => {
            release = resolve;
          });
        },
      });
      return (
        <MemoryRouter initialEntries={["/dashboard"]}>
          <CrewProvider value={crew}>
            <DashboardScreen data={getDashboard()} />
          </CrewProvider>
        </MemoryRouter>
      );
    }
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
    });
    const line = screen.getByText("Withdrew the report on 2024 Topps Chrome Base (eBay).");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 1993 Finest Base on BuySportsCards" }));
    });
    expect(line.textContent).toBe("");
    await act(async () => {
      release(null);
    });
    expect(line.textContent).toBe("Withdrew the report on 1993 Finest Base (BuySportsCards).");
  });

  it("Withdraw calls the withdraw with the report's id", async () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      mine: [ask({ id: "r1", kind: "report", label: "2024 Topps Chrome Base", platform: "ebay" })],
    };
    const crew = crewOf({ desk });
    draw(getDashboard(), crew);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on eBay" }));
    });
    expect(crew.withdraw).toHaveBeenCalledWith("r1");
  });

  it("a refused withdraw says why on its row", async () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      mine: [ask({ id: "r1", kind: "report", label: "2024 Topps Chrome Base", platform: "bsc" })],
    };
    draw(getDashboard(), crewOf({ desk, withdraw: vi.fn(async () => "The crew closed that report already.") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw report for 2024 Topps Chrome Base on BuySportsCards" }));
    });
    expect(within(screen.getByRole("region", { name: "With our crew" })).getByRole("alert").textContent).toBe(
      "The crew closed that report already.",
    );
  });

  it("an admin sees every collector's asks, each opening its review", () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      waiting: [
        ask({ id: "card-1", kind: "card", label: "Card one" }),
        ask({ id: "set-1", kind: "set", label: "Set one" }),
        ask({ id: "rep-1", kind: "report", label: "Report one", platform: "ebay", alsoReportedBy: 3 }),
        ask({ id: "rep-2", kind: "report", label: "Report two", platform: "bsc", alsoReportedBy: 0 }),
      ],
    };
    draw(getDashboard(), crewOf({ desk }));
    const waiting = screen.getByRole("region", { name: "From collectors" });
    expect(within(waiting).getByRole("link", { name: /^Card one/ }).getAttribute("href")).toBe("/admin/card-requests?open=card-1");
    expect(within(waiting).getByRole("link", { name: /^Set one/ }).getAttribute("href")).toBe("/admin/card-requests?open=set-1");
    expect(within(waiting).getByRole("link", { name: /^Report one/ }).getAttribute("href")).toBe(
      "/admin/card-requests?kind=sync&open=rep-1",
    );
    expect(within(waiting).getByText("+3 reported")).toBeTruthy();
    expect(within(waiting).queryAllByText(/reported$/)).toHaveLength(1);
    expect(within(waiting).getByText("4 waiting")).toBeTruthy();
    // The tag is seen; a reader hears who else reported it, and when each was asked.
    expect(within(waiting).getByText("+3 reported").getAttribute("aria-hidden")).toBe("true");
    // One look with Card Requests: the crew's blue pill, never the warning amber.
    expect(within(waiting).getByText("+3 reported").className).toContain("text-neon-blue-text");
    expect(within(waiting).getByText("+3 reported").className).not.toContain("notice-warn");
    const reportOne = within(waiting).getByRole("link", { name: /^Report one/ });
    expect(reportOne.textContent).toContain("also reported by 3 other collectors");
    expect(reportOne.textContent).toMatch(/asked \S/);
    expect(screen.queryByRole("region", { name: "With our crew" })).toBeNull();
  });

  it("two asks of the same name read apart by when each was asked", () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      waiting: [
        ask({ id: "a", kind: "card", label: "1991 Donruss #1 Ripken", at: Date.UTC(2026, 10, 1, 15) }),
        ask({ id: "b", kind: "card", label: "1991 Donruss #1 Ripken", at: Date.UTC(2026, 10, 9, 15) }),
      ],
    };
    draw(getDashboard(), crewOf({ desk }));
    const [one, two] = within(screen.getByRole("region", { name: "From collectors" })).getAllByRole("link", { name: /^1991 Donruss/ });
    expect(one.textContent).not.toBe(two.textContent);
  });

  it(`"+N reported" reads "${SYNC_REPORT_GROUP_COUNT_CAP}+ reported" at the cap, and a reader hears "${SYNC_REPORT_GROUP_COUNT_CAP} or more"`, () => {
    const desk: CrewDeskData = {
      ...EMPTY_DESK,
      waiting: [ask({ id: "r", kind: "report", label: "Busy set", platform: "bsc", alsoReportedBy: SYNC_REPORT_GROUP_COUNT_CAP })],
    };
    draw(getDashboard(), crewOf({ desk }));
    const link = within(screen.getByRole("region", { name: "From collectors" })).getByRole("link", { name: /^Busy set/ });
    expect(within(link).getByText(`${SYNC_REPORT_GROUP_COUNT_CAP}+ reported`)).toBeTruthy();
    expect(link.textContent).toContain(`also reported by ${SYNC_REPORT_GROUP_COUNT_CAP} or more other collectors`);
  });

  it("more waiting than the read names, but none past what is shown: the link still says there are more", () => {
    const waiting = Array.from({ length: WAITING_SHOWN }, (_, i) => ask({ id: `c${i}`, kind: "card", at: i }));
    draw(getDashboard(), crewOf({ desk: { ...EMPTY_DESK, waiting, waitingMore: true } }));
    const region = screen.getByRole("region", { name: "From collectors" });
    expect(within(region).getByRole("link", { name: "More on Card Requests" }).getAttribute("href")).toBe("/admin/card-requests");
  });

  it("the server reads exactly as many of each kind as the dashboard draws", () => {
    expect(CREW_DESK_WAITING).toBe(WAITING_SHOWN);
  });

  it(`an admin's list names the oldest ${WAITING_SHOWN}; the rest open Card Requests`, () => {
    const waiting = Array.from({ length: WAITING_SHOWN + 3 }, (_, i) => ask({ id: `c${i}`, kind: "card", at: i }));
    draw(getDashboard(), crewOf({ desk: { ...EMPTY_DESK, waiting, waitingMore: true } }));
    const region = screen.getByRole("region", { name: "From collectors" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(WAITING_SHOWN);
    expect(within(region).getByRole("link", { name: "3+ more on Card Requests" }).getAttribute("href")).toBe("/admin/card-requests");
    expect(within(region).getByText(`${WAITING_SHOWN + 3}+ waiting`)).toBeTruthy();
  });

  it("an admin with asks of their own sees both lists", () => {
    const desk: CrewDeskData = {
      mine: [ask({ id: "mine-1", kind: "set", label: "Mine" })],
      mineMore: 0,
      waiting: [ask({ id: "theirs-1", kind: "card", label: "Theirs" })],
      waitingMore: false,
    };
    draw(getDashboard(), crewOf({ desk }));
    expect(screen.getByRole("region", { name: "With our crew" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "From collectors" })).toBeTruthy();
  });

  it("the crew section never makes New on NeonBinder lead", () => {
    const data: DashboardData = {
      ...getDashboard(),
      sales: null,
      building: [],
      syncStatus: null,
      intake: { total: 0, waiting: 0, needsYou: 0, uploads: [], preview: [] },
      unlistedBoxes: [],
    };
    const desk: CrewDeskData = { ...EMPTY_DESK, mine: [ask({ id: "s1", kind: "set", label: "Mine" })] };
    const without = draw(data, crewOf());
    const ledWithout = without.container.innerHTML.indexOf("New on NeonBinder") < without.container.innerHTML.indexOf("Your binders");
    cleanup();
    const withDesk = draw(data, crewOf({ desk }));
    const ledWith = withDesk.container.innerHTML.indexOf("New on NeonBinder") < withDesk.container.innerHTML.indexOf("Your binders");
    expect(ledWith).toBe(ledWithout);
  });

  it(`"+N reported" is one wording on the dashboard and Card Requests: "${SYNC_REPORT_GROUP_COUNT_CAP}+" at the count's cap`, () => {
    expect(alsoReportedLine(0)).toBeNull();
    expect(alsoReportedLine(1)).toBe("+1 reported");
    expect(alsoReportedLine(SYNC_REPORT_GROUP_COUNT_CAP)).toBe(`${SYNC_REPORT_GROUP_COUNT_CAP}+ reported`);
  });
});
