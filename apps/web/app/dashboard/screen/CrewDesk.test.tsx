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
import { alsoReportedLabel } from "./CrewDesk";
import { CrewProvider, MY_REQUESTS_HREF, WAITING_SHOWN, type Crew, type CrewAsk, type CrewDeskData } from "./crew";
import { heldLead } from "./SyncStatus";

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

  it("the crew, every card: report it", () => {
    expect(heldLead({ ...base, heldBack: 1, crewFix: "all" })).toBe(
      "1 card held back from eBay. That one's on our crew, not you. Report it and we'll fix it:",
    );
    expect(heldLead({ ...base, heldBack: 4, crewFix: "all" })).toBe(
      "4 cards held back from eBay. These are on our crew, not you. Report them and we'll fix them:",
    );
  });

  it("both: fix yours, report the rest", () => {
    expect(heldLead({ ...base, heldBack: 4, crewFix: "some" })).toBe(
      "4 cards held back from eBay. Fix what you can on each card and it goes up next sync. The rest are on our crew, so report them:",
    );
  });

  it("the screen draws the crew's lead on the set", () => {
    const { data, set } = crewSet();
    draw(data, crewOf());
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(within(sync).getByText(heldLead(set))).toBeTruthy();
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
    const report = vi.fn(async () => null);
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
    // Only a report is withdrawn here.
    expect(within(mine).getAllByRole("button", { name: /^Withdraw/ })).toHaveLength(1);
    expect(within(mine).getByRole("link", { name: "4 more in My requests" }).getAttribute("href")).toBe(MY_REQUESTS_HREF);
    expect(screen.queryByRole("region", { name: "From collectors" })).toBeNull();
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
    expect(screen.getByRole("alert").textContent).toBe("The crew closed that report already.");
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
    expect(screen.queryByRole("region", { name: "With our crew" })).toBeNull();
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

  it(`"+N reported" reads "${SYNC_REPORT_GROUP_COUNT_CAP}+" at the count's cap`, () => {
    expect(alsoReportedLabel(1)).toBe("+1 reported");
    expect(alsoReportedLabel(SYNC_REPORT_GROUP_COUNT_CAP)).toBe(`${SYNC_REPORT_GROUP_COUNT_CAP}+ reported`);
  });
});
