/**
 * NEO-213 — Label History. NEO-121 — the USPS scan timeline on top of it.
 *
 * The two NEO-213 branches worth protecting are the ones a seller only meets
 * when something has gone wrong: a reprint that fails must show the *backend's*
 * message (an expired label and a missing EasyPost key are different problems
 * with different fixes), and a purchase past EasyPost's 180-day retention must
 * offer no button at all — a control whose only possible outcome is a failure
 * is the thing NEO-120 was corrected for on its first cut. Also pinned: the
 * reprint prints the URL the refresh action returns, never the stored one.
 *
 * NEO-121's fixture is not invented. It is the four scans a real production
 * letter collected (Madison WI → Olympia WA, tracker read 2026-09-03),
 * including the 31-digit IMb tracking number and the terminal
 * `out_for_delivery` status — because the two things this UI most easily gets
 * wrong are both visible only in real data: `delivered` never arrives for a
 * letter, so `out_for_delivery` has to render as DONE rather than as almost-
 * there; and USPS's very first message is "Cancellation of Postage", which a
 * seller reads as a voided label unless the page glosses it.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useAction: vi.fn(),
}));

// Only the print CALL is faked. `imageBodyHtml` stays real so the body these
// tests assert on is the markup the seller would actually print, escaping and
// https check included (NEO-213).
vi.mock("@/lib/print/print-html", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/print/print-html")>()),
  printHtmlDocument: vi.fn(),
}));

import { useAction, useQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { printHtmlDocument } from "@/lib/print/print-html";
import LabelHistoryPage from "./page";

const DAY = 24 * 60 * 60 * 1000;

const refreshMock = vi.fn();
const refreshTrackingMock = vi.fn();

type Row = ReturnType<typeof makeRow>;
type TrackingSetup = {
  connected: boolean;
  pending: boolean;
  lastEventAt?: number;
  lastError?: "rejected" | "unauthorized" | "unavailable" | "no_key";
};

/** The webhook is registered — the state most sellers are in. */
const CONNECTED: TrackingSetup = { connected: true, pending: false };

/**
 * The production letter's four USPS scans, in the order EasyPost returned them
 * (oldest first). Aug 25 12:52pm → Aug 28 5:06pm, three days, four scans, and
 * it ends at the destination post office's "Delivery" scan.
 */
function scanFixture(now: number) {
  return [
    {
      at: now - 9 * DAY,
      status: "pre_transit",
      message: "Origin Processing Cancellation of Postage",
      city: "MADISON",
      state: "WI",
      zip: "53714",
      country: "US",
    },
    {
      at: now - 8 * DAY,
      status: "in_transit",
      message: "Origin Primary Processing",
      city: "MILWAUKEE",
      state: "WI",
      zip: "53203",
      country: "US",
    },
    {
      at: now - 6 * DAY,
      status: "in_transit",
      message: "Destination MMP Processing",
      city: "TACOMA",
      state: "WA",
      zip: "98401",
      country: "US",
    },
    {
      at: now - 2 * DAY,
      status: "out_for_delivery",
      message: "Delivery",
      city: "OLYMPIA",
      state: "WA",
      zip: "98501",
      country: "US",
    },
  ];
}

function makeRow(overrides: Partial<ReturnType<typeof baseRow>> = {}) {
  return { ...baseRow(), ...overrides };
}

function baseRow() {
  const now = Date.now();
  return {
    _id: "purchase_1",
    _creationTime: 1,
    userId: "user_1",
    easypostShipmentId: "shp_1",
    // 31 digits — an Intelligent Mail barcode, which is what a real letter got.
    // NEO-120's ticket assumed 22; nothing in the code may assume a length.
    trackingCode: "0004012345678901234567890123456",
    costCents: 80,
    weightOz: 1,
    toAddress: {
      name: "Jane Buyer",
      line1: "742 Evergreen Ter",
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
      country: "US",
    },
    labelUrl: "https://easypost.example/stale.png",
    purchasedAt: now - 10 * DAY,
    trackerId: "trk_9225367288404802b543ba667462e9df",
    trackingStatus: "out_for_delivery",
    trackerUpdatedAt: now - 2 * DAY,
    lastScanAt: now - 2 * DAY,
    publicTrackingUrl:
      "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
    scans: scanFixture(now),
  };
}

/** A row bought before any scan arrived — every optional tracker field absent. */
function bareRow(overrides: Record<string, unknown> = {}) {
  const row = baseRow() as Record<string, unknown>;
  delete row.trackerId;
  delete row.trackingStatus;
  delete row.trackerUpdatedAt;
  delete row.lastScanAt;
  delete row.publicTrackingUrl;
  delete row.scans;
  return { ...row, ...overrides } as Row;
}

/**
 * `"loading"` rather than `undefined` for the in-flight setup query: passing
 * `undefined` explicitly would fire the default parameter and silently render
 * the connected chip, which is exactly the case the loading test is asserting
 * against.
 */
function renderPage(
  rows: Row[] | undefined,
  setup: TrackingSetup | "loading" = CONNECTED,
) {
  // Dispatch by getFunctionName: the page runs TWO queries now, and a bare
  // mockReturnValue would hand the purchase list to the setup chip.
  (useQuery as Mock).mockImplementation((ref: FunctionReference<"query">) =>
    getFunctionName(ref) === "shipping:listMyLabelPurchases"
      ? rows
      : setup === "loading"
        ? undefined
        : setup,
  );
  return render(
    <MemoryRouter>
      <LabelHistoryPage />
    </MemoryRouter>,
  );
}

/** The row's "Latest scan" cell, label and value together. */
function latestScanText() {
  return screen.getByText("Latest scan").parentElement?.textContent ?? "";
}

function timeline(recipient = "Jane Buyer") {
  return screen.getByRole("list", {
    name: new RegExp(`usps scans for ${recipient}`, "i"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Dispatch by getFunctionName, NOT by identity — the generated `api` is a
  // proxy that mints a fresh reference per property access, so
  // `ref === api.postage.refreshLabelUrl` is false even for the same function.
  (useAction as Mock).mockImplementation((ref: FunctionReference<"action">) => {
    const name = getFunctionName(ref);
    if (name === "postage:refreshLabelUrl") return refreshMock;
    if (name === "postage:refreshTracking") return refreshTrackingMock;
    return vi.fn();
  });
  (printHtmlDocument as Mock).mockResolvedValue(undefined);
  refreshTrackingMock.mockResolvedValue({
    applied: false,
    newScans: 0,
    cooldown: false,
  });
});

describe("LabelHistoryPage", () => {
  it("says it is loading while the query is in flight", () => {
    renderPage(undefined);
    expect(screen.getByText(/digging through the shoebox/i)).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("points a seller with no purchases at the Shipping tab", () => {
    renderPage([]);
    expect(screen.getByText(/no labels yet/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /shipping/i });
    expect(link.getAttribute("href")).toBe("/print/shipping");
    expect(screen.queryByRole("button", { name: /reprint/i })).toBeNull();
  });

  it("renders every field of a purchase", () => {
    const purchasedAt = Date.now() - 3 * DAY;
    renderPage([makeRow({ costCents: 1234, weightOz: 2, purchasedAt })]);

    expect(
      screen.getByRole("heading", { level: 3, name: "Jane Buyer" }),
    ).toBeTruthy();
    expect(screen.getByText("$12.34")).toBeTruthy();
    expect(screen.getByText("2 oz")).toBeTruthy();
    expect(screen.getByText("0004012345678901234567890123456")).toBeTruthy();
    // The relative label is what is read; the machine-readable instant and the
    // absolute time ride along for anyone reconciling against a statement.
    const time = screen.getByText("3d ago");
    expect(time.getAttribute("dateTime")).toBe(
      new Date(purchasedAt).toISOString(),
    );
    expect(time.getAttribute("title")).toBe(
      new Date(purchasedAt).toLocaleString(),
    );
  });

  it("discloses the cap when the history is full", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRow({
        _id: `purchase_${i}`,
        trackingCode: `94001000000000000000${String(i).padStart(2, "0")}`,
      }),
    );
    renderPage(rows);
    expect(
      screen.getByText(/showing your 25 most recent label purchases/i),
    ).toBeTruthy();
  });

  it("does not disclose a cap that has not been reached", () => {
    renderPage([makeRow()]);
    expect(screen.queryByText(/most recent label purchases/i)).toBeNull();
  });

  it("reprints with a FRESH url, not the stored one", async () => {
    refreshMock.mockResolvedValue({
      labelUrl: "https://easypost.example/fresh.png",
    });
    renderPage([makeRow()]);

    fireEvent.click(screen.getByRole("button", { name: /reprint the label/i }));

    await vi.waitFor(() => expect(printHtmlDocument).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalledWith({ purchaseId: "purchase_1" });
    const printed = (printHtmlDocument as Mock).mock.calls[0][0];
    expect(printed.bodyHtml).toContain("https://easypost.example/fresh.png");
    expect(printed.bodyHtml).not.toContain("stale.png");
    // 6×4 in, so the barcode a carrier scans is not clipped.
    expect(printed.page).toEqual({ widthIn: 6, heightIn: 4 });
  });

  it("surfaces the backend's own message when a reprint fails", async () => {
    refreshMock.mockRejectedValue(
      new ConvexError(
        "This label expired — EasyPost keeps label images for 180 days.",
      ),
    );
    renderPage([makeRow()]);

    fireEvent.click(screen.getByRole("button", { name: /reprint the label/i }));

    expect(
      await screen.findByText(/this label expired — easypost keeps label images/i),
    ).toBeTruthy();
    expect(printHtmlDocument).not.toHaveBeenCalled();
  });

  it("marks only the row being reprinted as busy", async () => {
    let release: (value: { labelUrl: string }) => void = () => {};
    refreshMock.mockReturnValue(
      new Promise<{ labelUrl: string }>((resolve) => {
        release = resolve;
      }),
    );
    renderPage([
      makeRow(),
      makeRow({
        _id: "purchase_2",
        trackingCode: "9400100000000000000002",
        toAddress: { ...baseRow().toAddress, name: "Sam Seller" },
      }),
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: /reprint the label for jane buyer/i }),
    );

    // Matched on the FULL label: the row's copy button is also named after the
    // recipient, so a bare /jane buyer/ matches two controls. The busy name is
    // "Reprinting…", not "Reprint…" — the accessible name tracks the visible
    // text so voice input can still address the button while it runs (2.5.3).
    const busy = await screen.findByRole("button", {
      name: /reprinting the label for jane buyer/i,
    });
    expect(busy.textContent).toBe("Reprinting…");
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    const other = screen.getByRole("button", {
      name: /reprint the label for sam seller/i,
    });
    expect(other.textContent).toBe("Reprint");
    expect((other as HTMLButtonElement).disabled).toBe(false);

    release({ labelUrl: "https://easypost.example/fresh.png" });
    await vi.waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /reprint the label for jane buyer/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it("offers no reprint past EasyPost's 180-day retention, and says why", () => {
    renderPage([makeRow({ purchasedAt: Date.now() - 181 * DAY })]);

    const row = screen.getByRole("listitem");
    expect(
      within(row).getByText(/label expired — easypost keeps labels for 180 days/i),
    ).toBeTruthy();
    // No control whose only possible outcome is a failure.
    expect(within(row).queryByRole("button", { name: /reprint/i })).toBeNull();
  });

  it("still offers a reprint just inside the retention window", () => {
    renderPage([makeRow({ purchasedAt: Date.now() - 179 * DAY })]);
    expect(screen.getByRole("button", { name: /reprint the label/i })).toBeTruthy();
    expect(screen.queryByText(/label expired/i)).toBeNull();
  });

  /** Scans outlive the label image; the check button must survive the wall. */
  it("still offers a scan check past the 180-day wall", () => {
    renderPage([makeRow({ purchasedAt: Date.now() - 181 * DAY })]);
    expect(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    ).toBeTruthy();
  });
});

describe("the expectation copy", () => {
  /**
   * The sentence exists because a seller coming from eBay reads "tracking" as
   * a delivery guarantee. A letter's last scan is the destination post office,
   * and nothing after it confirms anything.
   */
  it("says the last scan is the finish line and no scan confirms the mailbox", () => {
    renderPage([makeRow()]);
    const intro = screen.getByText(/what the scans tell you/i);
    expect(intro.textContent).toMatch(/no scan ever confirms the mailbox/i);
    expect(intro.textContent).toMatch(/nothing scans it when you drop it off/i);
  });
});

describe("the Scan updates chip", () => {
  it("says on when the webhook is registered", () => {
    renderPage([makeRow()], { connected: true, pending: false });
    const chip = screen.getByText(/scan updates:/i).parentElement;
    expect(chip?.textContent).toMatch(/scan updates:\s*on/i);
  });

  it("says connecting while registration is in flight", () => {
    renderPage([makeRow()], { connected: false, pending: true });
    const chip = screen.getByText(/scan updates:/i).parentElement;
    expect(chip?.textContent).toMatch(/connecting…/i);
  });

  /**
   * Without this, a seller whose registration never landed sees rows reading
   * "no scans yet" forever and has no way to tell that from a letter USPS has
   * genuinely not touched.
   */
  it("says not connected, and names the two things that retry it", () => {
    renderPage([makeRow()], { connected: false, pending: false });
    const chip = screen.getByText(/scan updates:/i).parentElement;
    expect(chip?.textContent).toMatch(/not connected yet/i);
    expect(chip?.textContent).toMatch(/buy a label or re-save your easypost key/i);
    expect(
      screen.getByRole("link", { name: /your profile/i }).getAttribute("href"),
    ).toBe("/profile/postage");
  });

  it("adds the hint for the specific failure", () => {
    renderPage([makeRow()], {
      connected: false,
      pending: false,
      lastError: "unauthorized",
    });
    expect(
      screen.getByText(/easypost turned that key down/i),
    ).toBeTruthy();
  });

  /** A beat of silence beats flashing "not connected" at a seller who is. */
  it("renders nothing at all while the setup query is loading", () => {
    renderPage([makeRow()], "loading");
    expect(screen.queryByText(/scan updates:/i)).toBeNull();
  });
});

describe("the status pill", () => {
  it.each([
    ["out_for_delivery", "Out for delivery — last USPS scan"],
    ["delivered", "Delivered"],
    ["in_transit", "Moving through USPS"],
    ["pre_transit", "Label printed — no scans yet"],
    ["unknown", "Label printed — no scans yet"],
    ["return_to_sender", "Returned to sender"],
    ["failure", "Problem — check USPS"],
    ["cancelled", "Problem — check USPS"],
  ])("shows %s as %s", (trackingStatus, words) => {
    renderPage([makeRow({ trackingStatus })]);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("says no scans yet for a row bought before tracking existed", () => {
    renderPage([bareRow()]);
    expect(screen.getByText("Label printed — no scans yet")).toBeTruthy();
  });

  /**
   * The tone, not just the words. A letter ENDS at out_for_delivery — if that
   * rendered in the in-flight colour, every successfully delivered letter would
   * sit looking unfinished forever.
   */
  it("paints out_for_delivery as the done state, not as in-flight", () => {
    const { unmount } = renderPage([makeRow({ trackingStatus: "out_for_delivery" })]);
    expect(
      screen.getByText("Out for delivery — last USPS scan").className,
    ).toContain("neon-green");
    unmount();

    renderPage([makeRow({ trackingStatus: "in_transit" })]);
    const moving = screen.getByText("Moving through USPS").className;
    expect(moving).toContain("neon-blue");
    expect(moving).not.toContain("neon-green");
  });

  it("paints a problem status as a warning", () => {
    renderPage([makeRow({ trackingStatus: "return_to_sender" })]);
    expect(screen.getByText("Returned to sender").className).toContain(
      "neon-yellow",
    );
  });

  /** NEO-119's bar: nothing on this page may be dim grey on near-black. */
  it("never uses the contrast-failing grey NEO-119 removed", () => {
    const { container } = renderPage([makeRow(), bareRow({ _id: "purchase_2" })]);
    expect(container.innerHTML).not.toContain("text-slate-500");
  });
});

describe("the newest scan line", () => {
  it("shows USPS's message, the town, and how long ago", () => {
    renderPage([makeRow()]);
    const text = latestScanText();
    expect(text).toContain("Delivery");
    expect(text).toContain("OLYMPIA, WA");
    expect(text).toContain("2d ago");
  });

  /** EasyPost orders newest-last; the row sorts anyway rather than trusting it. */
  it("finds the newest scan even when the stored array is out of order", () => {
    const row = makeRow();
    const shuffled = [row.scans[2], row.scans[0], row.scans[3], row.scans[1]];
    renderPage([makeRow({ scans: shuffled })]);
    expect(latestScanText()).toContain("Delivery");
    expect(latestScanText()).toContain("OLYMPIA, WA");
  });

  it("shows no scan line at all on a row that has none", () => {
    renderPage([bareRow()]);
    expect(screen.queryByText("Latest scan")).toBeNull();
  });
});

describe("the scan timeline", () => {
  it("is collapsed until asked for, and says how many there are", () => {
    renderPage([makeRow()]);
    const toggle = screen.getByRole("button", {
      name: /show all scans \(4\) for jane buyer/i,
    });
    expect(toggle.textContent).toBe("Show all scans (4)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // `hidden` keeps it out of the accessibility tree exactly as unmounting
    // would, while leaving aria-controls pointing at something real.
    expect(
      screen.queryByRole("list", { name: /usps scans for jane buyer/i }),
    ).toBeNull();
  });

  it("points aria-controls at the list it reveals", () => {
    renderPage([makeRow()]);
    const toggle = screen.getByRole("button", { name: /show all scans/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-controls")).toBe(
      timeline().getAttribute("id"),
    );
  });

  it("reveals all four scans oldest first, each with a machine-readable time", () => {
    // ONE row instance: makeRow() reads the clock, so a second call would mint
    // timestamps a millisecond off the ones that were rendered.
    const row = makeRow();
    renderPage([row]);
    fireEvent.click(screen.getByRole("button", { name: /show all scans/i }));

    const list = timeline();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("Origin Processing Cancellation of Postage");
    expect(items[1].textContent).toContain("Origin Primary Processing");
    expect(items[2].textContent).toContain("Destination MMP Processing");
    expect(items[3].textContent).toContain("Delivery");

    // Absolute times in the timeline — the relative one is on the summary line,
    // and opening this is what a seller does when "2d ago" stopped being enough.
    const times = list.querySelectorAll("time");
    expect(times).toHaveLength(4);
    expect(times[0].getAttribute("dateTime")).toBe(
      new Date(row.scans[0].at).toISOString(),
    );
    expect(times[0].textContent).toBe(new Date(row.scans[0].at).toLocaleString());
  });

  it("flips aria-expanded and the word on the button", () => {
    renderPage([makeRow()]);
    const toggle = screen.getByRole("button", { name: /show all scans/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide all scans (4)");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show all scans (4)");
  });

  /**
   * The single most alarming string USPS sends, and it is the FIRST scan on
   * every letter. It means the stamp was postmarked, not that anything was
   * voided or refunded.
   */
  it("glosses USPS's Cancellation of Postage so it does not read as a void", () => {
    renderPage([makeRow()]);
    fireEvent.click(screen.getByRole("button", { name: /show all scans/i }));
    expect(timeline().textContent).toContain(
      "Origin Processing Cancellation of Postage (postmarked — nothing was cancelled)",
    );
  });

  it("offers no disclosure on a row with no scans", () => {
    renderPage([bareRow()]);
    expect(screen.queryByRole("button", { name: /all scans/i })).toBeNull();
  });
});

describe("checking for new scans", () => {
  it("asks the backend about the row that was pressed", async () => {
    refreshTrackingMock.mockResolvedValue({
      applied: true,
      newScans: 2,
      status: "in_transit",
      cooldown: false,
    });
    renderPage([makeRow()]);

    fireEvent.click(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    );

    expect(await screen.findByText("2 new scans.")).toBeTruthy();
    expect(refreshTrackingMock).toHaveBeenCalledWith({ purchaseId: "purchase_1" });
  });

  it("says so when nothing has moved", async () => {
    renderPage([makeRow()]);
    fireEvent.click(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    );
    expect(await screen.findByText("No new scans yet.")).toBeTruthy();
  });

  /**
   * The 60-second server cooldown is not a failure — it is the guard that
   * stops a click loop burning the seller's EasyPost key or 429-ing the buy
   * path. It must not read like an error.
   */
  it("explains the cooldown instead of reporting a failure", async () => {
    refreshTrackingMock.mockResolvedValue({
      applied: false,
      newScans: 0,
      cooldown: true,
    });
    renderPage([makeRow()]);
    fireEvent.click(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    );

    const line = await screen.findByText(
      /checked a moment ago — try again in a minute/i,
    );
    expect(line.className).not.toContain("neon-pink");
  });

  it("surfaces the backend's own message when the check fails", async () => {
    refreshTrackingMock.mockRejectedValue(
      new ConvexError("Add your EasyPost key before checking for scans."),
    );
    renderPage([makeRow()]);
    fireEvent.click(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    );

    const line = await screen.findByText(/add your easypost key before checking/i);
    expect(line.className).toContain("neon-pink");
  });

  it("marks only the row being checked as busy", async () => {
    let release: (value: { newScans: number; cooldown: boolean }) => void = () => {};
    refreshTrackingMock.mockReturnValue(
      new Promise<{ newScans: number; cooldown: boolean }>((resolve) => {
        release = resolve;
      }),
    );
    renderPage([
      makeRow(),
      makeRow({
        _id: "purchase_2",
        trackingCode: "9400100000000000000002",
        toAddress: { ...baseRow().toAddress, name: "Sam Seller" },
      }),
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    );

    const busy = await screen.findByRole("button", {
      name: /checking for new scans for jane buyer/i,
    });
    expect(busy.textContent).toBe("Checking…");
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    const other = screen.getByRole("button", {
      name: /check for new scans for sam seller/i,
    });
    expect((other as HTMLButtonElement).disabled).toBe(false);

    release({ newScans: 0, cooldown: false });
    await vi.waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /check for new scans for jane buyer/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  /**
   * The button disables itself while it runs, and a browser blurs a button the
   * moment it is disabled — without this a keyboard user is dropped to the top
   * of the document with 25 rows to tab back through. Same fix as Reprint.
   */
  it("puts focus back on the row heading when the check settles", async () => {
    renderPage([makeRow()]);
    fireEvent.click(
      screen.getByRole("button", { name: /check for new scans for jane buyer/i }),
    );

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 3, name: "Jane Buyer" }),
      ),
    );
  });
});

describe("the public scan page link", () => {
  it("links out to EasyPost's page when the row has an https one", () => {
    renderPage([makeRow()]);
    const link = screen.getByRole("link", { name: /public scan page/i });
    expect(link.getAttribute("href")).toBe(
      "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    // noreferrer as well as noopener: the target page is outside NB.
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // A link that steals the tab has to say so to someone who cannot see it.
    expect(link.textContent).toContain("(opens in a new tab)");
  });

  /**
   * The URL arrives in a webhook body, and a webhook body is seller-forgeable
   * (a seller can read their own webhook secret out of the EasyPost dashboard).
   * The backend scheme-checks it; this is the second check, at the anchor.
   */
  it.each([
    "http://track.easypost.com/insecure",
    "javascript:alert(1)",
    "",
  ])("renders no link for %s", (publicTrackingUrl) => {
    renderPage([makeRow({ publicTrackingUrl })]);
    expect(screen.queryByRole("link", { name: /public scan page/i })).toBeNull();
  });

  it("renders no link on a row that never got one", () => {
    renderPage([bareRow()]);
    expect(screen.queryByRole("link", { name: /public scan page/i })).toBeNull();
  });
});
