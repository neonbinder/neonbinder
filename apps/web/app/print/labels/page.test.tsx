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
import { formatAbsoluteTime } from "@/lib/time/relative-time";
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
    expect(chip?.textContent).toMatch(/buy a label or save your easypost key/i);
    expect(chip?.textContent).toMatch(/either one turns scan updates on/i);
    // "re-save" presupposed a save that never happened. A seller reading this
    // chip has, by definition, never had a working key.
    expect(chip?.textContent).not.toMatch(/re-save/i);
    expect(
      screen.getByRole("link", { name: /your profile/i }).getAttribute("href"),
    ).toBe("/profile/postage");
  });

  /**
   * The brand-new-seller state, and the one the old copy got wrong twice over:
   * it told a seller with no key at all to "re-save" it, and paired that with a
   * hint saying we do not have one yet. One action, stated once.
   */
  it("tells a seller with no key to add one, without offering to re-save it", () => {
    renderPage([makeRow()], {
      connected: false,
      pending: false,
      lastError: "no_key",
    });
    const chip = screen.getByText(/scan updates:/i).parentElement;
    expect(chip?.textContent).toMatch(/add your easypost key on your profile\./i);
    expect(chip?.textContent).not.toMatch(/re-save/i);
    // No second route offered: buying a label is not available to a seller
    // whose key is what is missing.
    expect(chip?.textContent).not.toMatch(/buy a label/i);
    expect(
      screen.getByRole("link", { name: /your profile/i }).getAttribute("href"),
    ).toBe("/profile/postage");
  });

  /**
   * `lastError` undefined — the webhook simply has not been attempted yet,
   * which is every seller before their first label. No hint sentence exists for
   * it, so the action sentence is the whole message and has to stand alone.
   */
  it("still says what to do when there is no error to explain", () => {
    renderPage([makeRow()], { connected: false, pending: false });
    const chip = screen.getByText(/scan updates:/i).parentElement;
    expect(chip?.textContent).toMatch(
      /not connected yet\s*Buy a label or save your EasyPost key on\s*your profile\s*— either one turns scan updates on\./i,
    );
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
   * `describeTrackingStatus` is unit-tested to fall back for any value outside
   * EasyPost's enum; this pins that the PAGE actually renders that fallback
   * pill for a status it has never seen — e.g. a value EasyPost adds after
   * this code ships — rather than crashing or rendering an empty pill.
   */
  it("falls back to the no-scans pill for a status outside EasyPost's known enum, without crashing", () => {
    renderPage([makeRow({ trackingStatus: "a_future_easypost_status" })]);
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

  /**
   * "Label printed — no scans yet" is true but not actionable: it does not say
   * whether to wait or to go looking. The hint answers that, in copy only —
   * nothing here measures how long it has actually been, so it must never claim
   * to.
   */
  it("tells a seller with no scans yet what to expect and when to press Check", () => {
    renderPage([bareRow()]);
    expect(
      screen.getByText(/first scan usually lands the day it's mailed/i),
    ).toBeTruthy();
    expect(screen.getByText(/been a few days\? hit check/i)).toBeTruthy();
  });

  it("drops the hint the moment a scan exists", () => {
    renderPage([makeRow()]);
    expect(screen.queryByText(/first scan usually lands/i)).toBeNull();
  });

  /**
   * `row.scans` can be entirely absent (a row bought before NEO-121, or before
   * any webhook fired) or present-but-empty (a row NEO-121 wrote with no scans
   * recorded yet). The component reads it as `row.scans ?? []`, so both must
   * land a seller in the exact same "no scans yet" state — a divergence here
   * would mean one of the two code paths that produce this shape renders
   * differently for no product reason.
   */
  it("renders the identical no-scans state whether `scans` is absent or an empty array", () => {
    const { unmount } = renderPage([bareRow()]);
    expect(screen.queryByText("Latest scan")).toBeNull();
    expect(
      screen.getByText(/first scan usually lands the day it's mailed/i),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /all scans/i }),
    ).toBeNull();
    unmount();

    renderPage([bareRow({ scans: [] })]);
    expect(screen.queryByText("Latest scan")).toBeNull();
    expect(
      screen.getByText(/first scan usually lands the day it's mailed/i),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /all scans/i }),
    ).toBeNull();
  });
});

describe("a scan with neither city nor state", () => {
  /**
   * `formatScanPlace` is unit-tested to return "" when both halves are
   * missing; this pins that the PAGE actually drops the separator around the
   * empty string rather than rendering "Some Message ·  · 2d ago" or the
   * literal word "undefined" — the two failure modes a naive template string
   * would produce.
   */
  it("shows the message and age with no stray separator or the literal word 'undefined'", () => {
    const now = Date.now();
    renderPage([
      makeRow({
        scans: [
          { at: now - DAY, status: "in_transit", message: "In Transit" },
        ],
      }),
    ]);

    const text = latestScanText();
    expect(text).toContain("In Transit");
    expect(text).toContain("1d ago");
    expect(text).not.toContain("undefined");
    // No back-to-back separators, and no separator immediately before "In
    // Transit" (which would read as a leading "· In Transit").
    expect(text).not.toMatch(/·\s*·/);
    expect(text?.trim().startsWith("·")).toBe(false);
  });

  it("shows the same in the expanded timeline row", () => {
    const now = Date.now();
    renderPage([
      makeRow({
        scans: [
          { at: now - DAY, status: "in_transit", message: "In Transit" },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /show all scans/i }));

    const item = within(timeline()).getByRole("listitem");
    expect(item.textContent).toContain("In Transit");
    expect(item.textContent).not.toContain("undefined");
    expect(item.textContent).not.toMatch(/·\s*·/);
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
      "Origin Processing Cancellation of Postage (postmarked — the letter wasn't cancelled)",
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

  /**
   * Reprint and Check share ONE role="status" region per row and refocus the
   * SAME heading when they settle (see the `disabled` comment in page.tsx).
   * Without cross-disabling, a seller could fire both for the same row and
   * whichever settled last would silently overwrite the other's announcement
   * — e.g. a reprint failure erased by "No new scans yet." (WCAG 4.1.3).
   */
  it("blocks a check while that row's reprint is in flight, and vice versa", async () => {
    let releaseReprint: (value: { labelUrl: string }) => void = () => {};
    refreshMock.mockReturnValue(
      new Promise<{ labelUrl: string }>((resolve) => {
        releaseReprint = resolve;
      }),
    );
    renderPage([makeRow()]);

    fireEvent.click(
      screen.getByRole("button", { name: /reprint the label for jane buyer/i }),
    );

    // The check button for the SAME row is disabled while the reprint runs,
    // even though `checking` itself is still false.
    const checkButton = await screen.findByRole("button", {
      name: /check for new scans for jane buyer/i,
    });
    expect((checkButton as HTMLButtonElement).disabled).toBe(true);

    releaseReprint({ labelUrl: "https://easypost.example/fresh.png" });
    await vi.waitFor(() =>
      expect((checkButton as HTMLButtonElement).disabled).toBe(false),
    );

    // And the reverse: a check in flight blocks that row's reprint button.
    let releaseCheck: (value: { newScans: number; cooldown: boolean }) => void =
      () => {};
    refreshTrackingMock.mockReturnValue(
      new Promise<{ newScans: number; cooldown: boolean }>((resolve) => {
        releaseCheck = resolve;
      }),
    );

    fireEvent.click(checkButton);

    const reprintButton = screen.getByRole("button", {
      name: /reprint the label for jane buyer/i,
    });
    expect((reprintButton as HTMLButtonElement).disabled).toBe(true);

    releaseCheck({ newScans: 0, cooldown: false });
    await vi.waitFor(() =>
      expect((reprintButton as HTMLButtonElement).disabled).toBe(false),
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

  /**
   * track.easypost.com is not a domain a buyer recognises, and an unrecognised
   * link from a stranger is one nobody clicks. The caption is what makes the
   * link sendable.
   */
  it("says what is on the other side of the link", () => {
    renderPage([makeRow()]);
    expect(
      screen.getByText(/easypost's tracking page — same usps scans, no login\./i),
    ).toBeTruthy();
  });

  it("renders no caption where there is no link", () => {
    renderPage([bareRow()]);
    expect(screen.queryByText(/same usps scans, no login/i)).toBeNull();
  });

  /** NEO-119 again, on the copy the reviewer asked for: not dim grey. */
  it("does not paint the caption in the contrast-failing grey", () => {
    renderPage([makeRow()]);
    expect(
      screen.getByText(/same usps scans, no login/i).className,
    ).not.toContain("text-slate-500");
  });
});

/**
 * A link a seller cannot hand to a buyer is a link they cannot use: the buyer
 * is not sitting at this screen, and the URL itself is never shown. The button
 * is the shared CopyButton — the same one the tracking number uses — so the
 * denied-clipboard branch is covered here as well as in its own test.
 */
describe("copying the public scan page link", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("copies the URL, not the words on screen", async () => {
    writeText.mockResolvedValue(undefined);
    renderPage([makeRow()]);

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Copy the public scan page link for Jane Buyer,/,
      }),
    );

    expect(await screen.findByText("Scan page link copied.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(
      "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
    );
  });

  /**
   * The clipboard refuses silently (permissions policy, iframe, insecure
   * context). The fallback cannot be "select it and copy it" the way the
   * tracking number's is — the URL is not on screen — so it names the one route
   * that exists.
   */
  it("names a manual route when the clipboard is denied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderPage([makeRow()]);

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Copy the public scan page link for Jane Buyer,/,
      }),
    );

    expect(
      await screen.findByText(/open the link and copy it from your browser/i),
    ).toBeTruthy();
  });

  /**
   * Per-row live-region rule: the row's ONE shared role="status" carries
   * reprint and scan-check results, and a copy announcement routed there could
   * erase a reprint failure (WCAG 4.1.3). The copy control announces in its own
   * region instead — the row's stays empty.
   */
  it("announces in its own region, leaving the row's shared one untouched", async () => {
    writeText.mockResolvedValue(undefined);
    renderPage([makeRow()]);

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Copy the public scan page link for Jane Buyer,/,
      }),
    );
    await screen.findByText("Scan page link copied.");

    const row = screen.getByRole("listitem");
    const regions = within(row).getAllByRole("status");
    // The row-level region is the last one: it is rendered after the dl and
    // after the timeline disclosure.
    expect(regions[regions.length - 1].textContent).toBe("");
  });

  it("names the recipient, so 25 identical buttons are distinguishable", () => {
    renderPage([
      makeRow(),
      makeRow({
        _id: "purchase_2",
        trackingCode: "9400100000000000000002",
        toAddress: { ...baseRow().toAddress, name: "Sam Seller" },
      }),
    ]);
    expect(
      screen.getByRole("button", {
        name: /^Copy the public scan page link for Sam Seller,/,
      }),
    ).toBeTruthy();
  });

  it("offers no copy button where there is no link", () => {
    renderPage([bareRow()]);
    expect(
      screen.queryByRole("button", { name: /copy the public scan page link/i }),
    ).toBeNull();
  });
});

describe("25 rows that share one recipient name", () => {
  /**
   * The case a seller actually hits, and the one `row.toAddress.name` alone
   * could not survive: the SAME buyer bought several labels, so several rows
   * legitimately share one name. NEO-121's adversarial pass pinned the result —
   * every per-row control (Reprint, Check for new scans, both Copy buttons, the
   * scans disclosure) computed a byte-identical accessible name, so a
   * screen-reader or voice-control user could not address "row 3" by name at
   * all, only by re-deriving its position from context.
   *
   * The disambiguator is purchase time plus the last four of the tracking
   * number, and BOTH halves are load-bearing. This fixture proves the second
   * half: every row is bought at the same instant, which is the batch-purchase
   * case `formatAbsoluteTime` cannot resolve on its own — it is a
   * `toLocaleString()`, so it stops at whole seconds.
   */
  const SAME_INSTANT = Date.now() - 10 * DAY;

  function oneBuyerTwentyFiveLabels() {
    return Array.from({ length: 25 }, (_, i) =>
      makeRow({
        _id: `purchase_${i}`,
        trackingCode: `94001000000000000000${String(i).padStart(2, "0")}`,
        // Both explicit, even though they match makeRow()'s defaults: the point
        // of the fixture is that the recipient AND the purchase second are
        // shared across all 25 rows.
        toAddress: { ...baseRow().toAddress, name: "Jane Buyer" },
        purchasedAt: SAME_INSTANT,
      }),
    );
  }

  it("gives every per-row control a name of its own", () => {
    renderPage(oneBuyerTwentyFiveLabels());

    for (const pattern of [
      /^Check for new scans for Jane Buyer,/,
      /^Reprint the label for Jane Buyer,/,
      /^Copy the tracking number for Jane Buyer,/,
      /^Copy the public scan page link for Jane Buyer,/,
      /^Show all scans \(4\) for Jane Buyer,/,
    ]) {
      const names = screen
        .getAllByRole("button", { name: pattern })
        .map((el) => el.getAttribute("aria-label") ?? "");
      // Asserted as one object so a failure says WHICH control family broke and
      // whether it broke by count or by collision.
      expect({
        control: pattern.source,
        rendered: names.length,
        distinct: new Set(names).size,
      }).toEqual({ control: pattern.source, rendered: 25, distinct: 25 });
    }
  });

  /**
   * The timeline is a named list, not a button, and 25 lists all announcing
   * "USPS scans for Jane Buyer" would be the same defect wearing a different
   * role.
   *
   * Read off the attribute rather than through `getAllByRole(..., { name })`:
   * each timeline starts collapsed behind its disclosure, and accname returns
   * the empty string for a hidden node, so a role+name query cannot see these
   * at all until something clicks 25 buttons. The attribute is what will be
   * computed the moment the seller opens one.
   */
  it("gives every row's scan timeline a name of its own", () => {
    renderPage(oneBuyerTwentyFiveLabels());

    const names = screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector("ol")?.getAttribute("aria-label") ?? "");
    expect(names).toHaveLength(25);
    expect(new Set(names).size).toBe(25);
    expect(names.every((n) => n.startsWith("USPS scans for Jane Buyer,"))).toBe(
      true,
    );
  });

  /** The exact wording, so the format is a decision and not an accident. */
  it("names a row by its purchase time and the last four of its tracking number", () => {
    renderPage(oneBuyerTwentyFiveLabels());

    expect(
      screen.getByRole("button", {
        name: `Check for new scans for Jane Buyer, bought ${formatAbsoluteTime(SAME_INSTANT)}, tracking …0007`,
      }),
    ).toBeTruthy();
  });

  /**
   * Accessible names only. The visible heading still reads the buyer's name and
   * nothing else — a tracking suffix shouted on all 25 rows would be a worse
   * page for a sighted seller, and the row's own Purchased and Tracking fields
   * already carry both halves in full, in view, underneath it.
   */
  it("leaves the visible row text alone", () => {
    renderPage(oneBuyerTwentyFiveLabels());

    expect(
      screen.getAllByRole("heading", { level: 3, name: "Jane Buyer" }),
    ).toHaveLength(25);
    expect(
      screen.getAllByRole("button", { name: /^Reprint the label for/ })[0]
        .textContent,
    ).toBe("Reprint");
  });
});
