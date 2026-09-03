/**
 * NEO-213 — Label History.
 *
 * The two branches worth protecting are the ones a seller only meets when
 * something has gone wrong: a reprint that fails must show the *backend's*
 * message (an expired label and a missing EasyPost key are different problems
 * with different fixes), and a purchase past EasyPost's 180-day retention must
 * offer no button at all — a control whose only possible outcome is a failure
 * is the thing NEO-120 was corrected for on its first cut.
 *
 * Also pinned: the reprint prints the URL the refresh action returns, never the
 * stored one. The stored URL has expired by then, and printing it yields a
 * blank 6×4 sheet with no error anywhere.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ConvexError } from "convex/values";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useAction: vi.fn(),
}));

vi.mock("@/lib/print/print-html", () => ({
  printHtmlDocument: vi.fn(),
}));

import { useAction, useQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { printHtmlDocument } from "@/lib/print/print-html";
import LabelHistoryPage from "./page";

const DAY = 24 * 60 * 60 * 1000;

const refreshMock = vi.fn();

type Row = ReturnType<typeof makeRow>;

function makeRow(overrides: Partial<ReturnType<typeof baseRow>> = {}) {
  return { ...baseRow(), ...overrides };
}

function baseRow() {
  return {
    _id: "purchase_1",
    _creationTime: 1,
    userId: "user_1",
    easypostShipmentId: "shp_1",
    trackingCode: "9400100000000000000001",
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
    purchasedAt: Date.now() - 2 * DAY,
  };
}

function renderPage(rows: Row[] | undefined) {
  (useQuery as Mock).mockReturnValue(rows);
  return render(
    <MemoryRouter>
      <LabelHistoryPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Dispatch by getFunctionName, NOT by identity — the generated `api` is a
  // proxy that mints a fresh reference per property access, so
  // `ref === api.postage.refreshLabelUrl` is false even for the same function.
  (useAction as Mock).mockImplementation((ref: FunctionReference<"action">) =>
    getFunctionName(ref) === "postage:refreshLabelUrl" ? refreshMock : vi.fn(),
  );
  (printHtmlDocument as Mock).mockResolvedValue(undefined);
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
    expect(screen.getByText("9400100000000000000001")).toBeTruthy();
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

    // Matched on the FULL reprint label: the row's copy button is also named
    // after the recipient, so a bare /jane buyer/ matches two controls.
    const busy = await screen.findByRole("button", {
      name: /reprint the label for jane buyer/i,
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
});
