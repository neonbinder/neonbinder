/**
 * NEO-536 — /admin/card-requests keeps its view in the URL so Back works:
 * a filter (`?status=`, `?kind=sync`) replaces the entry, opening one item
 * (`?open=<id>`) pushes one, Back returns to the list, and a pasted link
 * reopens the same item. The Sync reports list draws `syncReports.queue`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => [] as { name: string; args: unknown }[]);
const answers = vi.hoisted(() => new Map<string, unknown>());

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      const name = getFunctionName(ref);
      if (args === "skip") return undefined;
      queries.push({ name, args });
      return answers.get(name);
    },
    useMutation: (ref: never) => async () => answers.get(getFunctionName(ref)),
  };
});
// The picker reads players and the theme; neither matters here.
vi.mock("@/components/SetSelector/PlayerPicker", () => ({ default: () => null }));

import AdminCardRequestsPage from "./page";

function Probe() {
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

function show(entries: string[]) {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/before" element={<Probe />} />
        <Route
          path="/admin/card-requests"
          element={
            <>
              <AdminCardRequestsPage />
              <Probe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const url = () => screen.getByRole("status", { name: "Page URL" }).textContent;
const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
const filter = (name: string) =>
  fireEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name }));

const REQUEST = { _id: "cr1", kind: "card", label: "1996 Contenders #41 Reggie White", requestedAt: 1, hasPhotos: false };
const REPORT = {
  _id: "sr1",
  label: "2024 Topps Chrome Base",
  platform: "bsc",
  variantId: "v1",
  heldBack: 3,
  note: "Ohtani never lists",
  reportedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  alsoReportedBy: 2,
};
const REVIEW = {
  _id: "sr1",
  status: "open",
  label: "2024 Topps Chrome Base",
  platform: "bsc",
  variantId: "v1",
  heldBack: 1,
  reportedAt: 1,
  lastUpdated: 1,
  ownerId: "user_9",
  cards: [{ cardId: "k1", reason: "noLink", cardNumber: "1", cardLabel: "Shohei Ohtani" }],
  cardsGone: 0,
  alsoReportedBy: 0,
};

beforeEach(() => {
  queries.length = 0;
  answers.clear();
  answers.set("collectionRequests:queue", [REQUEST]);
  answers.set("syncReports:queue", { reports: [REPORT], more: false });
  answers.set("syncReports:review", REVIEW);
  answers.set("selectorOptions:getAncestorChain", []);
  answers.set("collectionRequests:review", null);
});
afterEach(cleanup);

describe("Card Requests in the URL", () => {
  it("a filter replaces the entry: Back leaves the page rather than undoing the filter", () => {
    show(["/before", "/admin/card-requests"]);
    filter("Not added");
    expect(url()).toBe("/admin/card-requests?status=declined");
    expect(queries.at(-1)).toEqual({ name: "collectionRequests:queue", args: { status: "declined" } });
    filter("Sync reports");
    expect(url()).toBe("/admin/card-requests?kind=sync");
    back();
    expect(url()).toBe("/before");
  });

  it("opening a report pushes an entry, and Back returns to the list", () => {
    show(["/admin/card-requests?kind=sync"]);
    const list = screen.getByRole("region", { name: "Reports" });
    fireEvent.click(within(list).getByRole("button", { name: /^BuySportsCards: 2024 Topps Chrome Base/ }));
    expect(url()).toBe("/admin/card-requests?kind=sync&open=sr1");
    expect(within(screen.getByRole("region", { name: "Review" })).getByRole("heading", { level: 3 }).textContent).toBe(
      "Sync report: 2024 Topps Chrome Base",
    );
    back();
    expect(url()).toBe("/admin/card-requests?kind=sync");
    expect(screen.getByText("Pick a report to review it.")).toBeTruthy();
  });

  it("opening a card request pushes too, with the request filter kept", () => {
    show(["/admin/card-requests?status=declined"]);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Requests" })).getByRole("button", { name: /^Card: 1996 Contenders/ }),
    );
    expect(url()).toBe("/admin/card-requests?status=declined&open=cr1");
    expect(queries).toContainEqual({ name: "collectionRequests:review", args: { requestId: "cr1" } });
    back();
    expect(url()).toBe("/admin/card-requests?status=declined");
  });

  it("a pasted link reopens the same report", () => {
    show(["/admin/card-requests?kind=sync&open=sr1"]);
    expect(screen.getByRole("button", { name: "Sync reports", pressed: true })).toBeTruthy();
    expect(queries).toContainEqual({ name: "syncReports:review", args: { id: "sr1" } });
    expect(screen.getByRole("heading", { level: 3, name: "Sync report: 2024 Topps Chrome Base" })).toBeTruthy();
  });

  it("an unknown status reads as Waiting", () => {
    show(["/admin/card-requests?status=nope"]);
    expect(screen.getByRole("button", { name: "Waiting", pressed: true })).toBeTruthy();
    expect(queries).toContainEqual({ name: "collectionRequests:queue", args: { status: "waiting" } });
  });

  it("Back to the list after a close steps back to the list it was opened from, and the keyboard lands there", async () => {
    answers.set("syncReports:close", { closed: 1 });
    show(["/before", "/admin/card-requests?kind=sync"]);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Reports" })).getByRole("button", { name: /^BuySportsCards:/ }),
    );
    expect(url()).toBe("/admin/card-requests?kind=sync&open=sr1");
    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to the list" }));
    await waitFor(() => expect(url()).toBe("/admin/card-requests?kind=sync"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Reports" })));
    // One step, not two: the entry before the list is still the one before it.
    back();
    expect(url()).toBe("/before");
  });

  it("Back to the list from a pasted link drops the item in place", async () => {
    answers.set("syncReports:close", { closed: 1 });
    show(["/before", "/admin/card-requests?kind=sync&open=sr1"]);
    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to the list" }));
    await waitFor(() => expect(url()).toBe("/admin/card-requests?kind=sync"));
    back();
    expect(url()).toBe("/before");
  });
});

describe("the Sync reports list", () => {
  it("shows the set, platform, held-back count, age, note and who else reported it", () => {
    show(["/admin/card-requests?kind=sync"]);
    const item = within(screen.getByRole("region", { name: "Reports" })).getByRole("button", {
      name: /^BuySportsCards: 2024 Topps Chrome Base/,
    });
    expect(item.textContent).toContain("3 cards held back, waiting 3 days");
    expect(item.textContent).toContain("+2 reported");
    expect(item.textContent).toContain("“Ohtani never lists”");
  });

  it("says 20+ at the server's count cap, and that more are waiting past the list", () => {
    answers.set("syncReports:queue", { reports: [{ ...REPORT, alsoReportedBy: 20 }], more: true });
    show(["/admin/card-requests?kind=sync"]);
    expect(screen.getByText("20+ more reported")).toBeTruthy();
    expect(screen.getByText("More waiting past these. Close a few and they move up.")).toBeTruthy();
  });

  it("says so when none are open", () => {
    answers.set("syncReports:queue", { reports: [], more: false });
    show(["/admin/card-requests?kind=sync"]);
    expect(screen.getByText("No sync reports open. Smooth sailing.")).toBeTruthy();
  });
});
