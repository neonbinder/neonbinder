/**
 * NEO-536 — the admin's review of one sync report: the held cards with NB's
 * reason and the sync's own detail set apart, the links out, Mark fixed and
 * Not a bug (which needs a note, here as on the server), the server's refusal
 * shown as it says it, and a closed report with nothing to press. The server
 * half is syncReports.test.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { name: string; args: unknown }[]);
const answers = vi.hoisted(() => new Map<string, unknown>());

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : answers.get(getFunctionName(ref))),
    useMutation: (ref: never) => async (args: unknown) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const answer = answers.get(name);
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
});

import SyncReportReview, { NOT_A_BUG_NEEDS_A_NOTE } from "./SyncReportReview";

function review(over: Record<string, unknown> = {}) {
  return {
    _id: "sr1",
    status: "open",
    label: "2024 Topps Chrome Base",
    platform: "ebay",
    variantId: "v1",
    heldBack: 4,
    note: "Ohtani and Judge never go up.",
    reportedAt: 1,
    lastUpdated: 1,
    ownerId: "user_9",
    cards: [
      { cardId: "k1", reason: "noLink", cardNumber: "1", cardLabel: "Shohei Ohtani" },
      { cardId: "k2", reason: "missingAspect", detail: "Team", cardNumber: "2", cardLabel: "Aaron Judge" },
    ],
    cardsGone: 1,
    alsoReportedBy: 3,
    ...over,
  };
}

const CHAIN = ["sp", "yr", "br", "st", "base"].map((id) => ({ _id: id }));

/** With others on the set (the fixture's 3), the close note goes to all of them, and the field says so. */
const TO_EVERYONE = "Note to every collector who reported this set";
const ids = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
const describedBy = (el: Element) => ids(el).map((id) => document.getElementById(id)?.textContent);

function show(onDone = () => {}) {
  return render(
    <MemoryRouter>
      <SyncReportReview reportId="sr1" onDone={onDone} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  answers.set("syncReports:review", review());
  answers.set("selectorOptions:getAncestorChain", CHAIN);
  answers.set("syncReports:close", { closed: 4 });
});
afterEach(cleanup);

describe("SyncReportReview", () => {
  it("shows the held cards with NB's reason, the sync's detail marked as eBay's, and the rest", () => {
    show();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Sync report: 2024 Topps Chrome Base" }));
    const cards = screen.getByRole("list", { name: "Held back on eBay" });
    const [ohtani, judge] = within(cards).getAllByRole("listitem");
    expect(ohtani.textContent).toContain("#1");
    expect(ohtani.textContent).toContain("Shohei Ohtani");
    expect(ohtani.textContent).toContain("eBay has no match for this card yet");
    expect(judge.textContent).toContain("eBay asked for: “Team”");
    screen.getByText("1 card in the report isn't in NeonBinder anymore.");
    screen.getByText(/1 more card was held back too; the report keeps the first 3\./);
    screen.getByText("Ohtani and Judge never go up.");
    screen.getByText("Only our crew sees this.");
    screen.getByText("Also reported by 3 other collectors. Closing this closes theirs too.");
    expect(screen.getByRole("link", { name: "Open their Sync status" }).getAttribute("href")).toBe(
      "/admin/sync-status?owner=user_9",
    );
    expect(screen.getByRole("link", { name: "Open the set builder" }).getAttribute("href")).toBe(
      "/admin/set-builder?sport=sp&year=yr&brand=br&set=st&type=base",
    );
  });

  it("says when the collector's set last listed cleanly", () => {
    answers.set("syncReports:review", review({ listedCleanlySince: Date.UTC(2026, 10, 12, 18) }));
    show();
    screen.getByText(/^Listed cleanly since .+\. Their last sync held none of these back\.$/);
  });

  it("marks it fixed, with the note when there is one, and lands on the outcome", async () => {
    const onDone = vi.fn();
    show(onDone);
    fireEvent.change(screen.getByLabelText(TO_EVERYONE), { target: { value: "  Relinked both.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    await waitFor(() =>
      expect(calls).toEqual([{ name: "syncReports:close", args: { id: "sr1", outcome: "fixed", note: "Relinked both." } }]),
    );
    const outcome = await screen.findByText("Marked fixed. 4 reports on this set closed with it.");
    await waitFor(() => expect(document.activeElement?.contains(outcome)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("marks it fixed with no note at all", async () => {
    answers.set("syncReports:close", { closed: 1 });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    await waitFor(() => expect(calls).toEqual([{ name: "syncReports:close", args: { id: "sr1", outcome: "fixed" } }]));
    await screen.findByText("Marked fixed.");
  });

  it("won't send Not a bug without a note: it says why and puts the keyboard in the note", () => {
    show();
    const note = screen.getByLabelText(TO_EVERYONE);
    const helper = "Optional for Mark fixed. Not a bug needs one. Every collector who reported this set reads it.";
    expect(describedBy(note)).toEqual([helper]);
    fireEvent.change(note, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Not a bug" }));
    expect(calls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe(NOT_A_BUG_NEEDS_A_NOTE);
    expect(document.activeElement).toBe(note);
    expect(note.getAttribute("aria-invalid")).toBe("true");
    // The helper still describes it, and the complaint with it.
    expect(describedBy(note)).toEqual([helper, NOT_A_BUG_NEEDS_A_NOTE]);
    // Typing one clears the complaint.
    fireEvent.change(note, { target: { value: "B" } });
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(note.getAttribute("aria-invalid")).toBeNull();
    expect(describedBy(note)).toEqual([helper]);
  });

  it("with nobody else on the set, the note is to the one collector, and the helper says so", () => {
    answers.set("syncReports:review", review({ alsoReportedBy: 0 }));
    show();
    const note = screen.getByLabelText("Note to the collector");
    expect(describedBy(note)).toEqual(["Optional for Mark fixed. Not a bug needs one: they read it."]);
    expect(screen.queryByLabelText(TO_EVERYONE)).toBeNull();
  });

  it("says 20 or more at the server's count cap", () => {
    answers.set("syncReports:review", review({ alsoReportedBy: 20 }));
    show();
    screen.getByText("Also reported by 20 or more other collectors. Closing this closes theirs too.");
  });

  it("closes as Not a bug with the note", async () => {
    answers.set("syncReports:close", { closed: 1 });
    show();
    fireEvent.change(screen.getByLabelText(TO_EVERYONE), {
      target: { value: "eBay needs the team; add it on the card." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Not a bug" }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          name: "syncReports:close",
          args: { id: "sr1", outcome: "notABug", note: "eBay needs the team; add it on the card." },
        },
      ]),
    );
    await screen.findByText("Closed as not a bug.");
  });

  it("shows the server's refusal as it says it", async () => {
    answers.set("syncReports:close", () => {
      throw Object.assign(new Error("[Request ID: x] Server Error"), {
        data: { code: "SYNC_REPORT_INVALID", message: "That report is closed already." },
      });
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That report is closed already."));
    // Still open: the buttons stay to try again.
    expect(screen.getByRole("button", { name: "Mark fixed" })).toBeTruthy();
  });

  it("a closed report shows how it closed and the crew's note, with nothing to press", () => {
    answers.set("syncReports:review", review({ status: "notABug", closedAt: 5, closeNote: "Add the team on the card.", alsoReportedBy: 0 }));
    show();
    screen.getByText("Not a bug");
    screen.getByText("Add the team on the card.");
    expect(screen.queryByRole("button", { name: "Mark fixed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not a bug" })).toBeNull();
    expect(screen.queryByLabelText("Note to the collector")).toBeNull();
    expect(screen.queryByLabelText(TO_EVERYONE)).toBeNull();
  });

  it("says so when the report is gone", () => {
    answers.set("syncReports:review", null);
    show();
    screen.getByText("That report isn't there anymore. The collector may have withdrawn it.");
  });
});
