/**
 * NEO-120 — the postage block is ADDITIVE to the free NEO-118 label, and it is
 * gated on the seller actually having an EasyPost key.
 *
 * Both cases exist because both regressed in the first cut of NEO-120, caught
 * by the product owner on the PR preview: the free "Print Label" button was
 * replaced (not joined) by the postage flow, and "Get rate" rendered for
 * sellers with no key — a control that could only ever fail for them.
 *
 * The Maestro flows cannot pin the keyless branch: locally the persistent
 * worker accounts may carry a key in Secret Manager from an earlier postage
 * run, so a flow asserting "no key" is order-dependent there. This is the
 * deterministic home for that branch.
 *
 * NEO-213 added the `historySaved` branches below. They are unreachable from
 * E2E for the same kind of reason: the only way to see `historySaved: false` is
 * for the history write to fail *after* real money has moved, which is not a
 * state a flow can produce on demand.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
import ShippingLabelsPage from "./page";

const savedAddress = {
  address: {
    name: "Neon Seller",
    line1: "100 Binder Way",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
  resolvedName: "Neon Seller",
};

const hasKeyMock = vi.fn();
const quoteMock = vi.fn();
const buyMock = vi.fn();

function renderPage() {
  return render(
    <MemoryRouter>
      <ShippingLabelsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (useQuery as Mock).mockReturnValue(savedAddress);
  // The page calls useAction for three refs; only the key check needs real
  // behavior per test. Dispatch by getFunctionName, NOT by identity — the
  // generated `api` is a proxy that mints a fresh reference per property
  // access, so `ref === api.postage.hasEasypostKey` is false even for the
  // same function.
  (useAction as Mock).mockImplementation((ref: FunctionReference<"action">) => {
    switch (getFunctionName(ref)) {
      case "postage:hasEasypostKey":
        return hasKeyMock;
      case "postage:quoteLetterRate":
        return quoteMock;
      case "postage:buyLetterLabel":
        return buyMock;
      default:
        return vi.fn();
    }
  });
  (printHtmlDocument as Mock).mockResolvedValue(undefined);
});

const buyerAddress = {
  name: "Jane Buyer",
  company: "",
  line1: "742 Evergreen Ter",
  line2: "",
  city: "Springfield",
  state: "IL",
  postalCode: "62704",
  country: "US",
};

/**
 * Drive the page all the way to a completed purchase.
 *
 * The rating round is debounced 800ms behind the last keystroke, so the clock
 * has to be faked to get there. Timers are restored before the assertions so
 * the async `findBy*` helpers behave normally.
 */
async function buyPostage(bought: {
  trackingCode: string;
  historySaved: boolean;
}) {
  hasKeyMock.mockResolvedValue(true);
  quoteMock.mockResolvedValue({
    shipmentId: "shp_1",
    rateId: "rate_1",
    amountCents: 80,
    verifiedTo: buyerAddress,
  });
  buyMock.mockResolvedValue({
    shipmentId: "shp_1",
    trackingCode: bought.trackingCode,
    labelUrl: "https://easypost.example/label.png",
    amountCents: 80,
    historySaved: bought.historySaved,
  });

  vi.useFakeTimers();
  renderPage();
  // Flush the mount-only EasyPost key check, which gates the postage block.
  await act(async () => {});

  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  type("Name", buyerAddress.name);
  type("Street Address", buyerAddress.line1);
  type("City", buyerAddress.city);
  type("State", buyerAddress.state);
  type("ZIP", buyerAddress.postalCode);

  // Past the debounce, then let the three rate calls settle.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  vi.useRealTimers();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /buy postage — \$0\.80/i }));
  });
}

describe("ShippingLabelsPage history disclosure (NEO-213)", () => {
  it("says nothing extra when the purchase reached Label History", async () => {
    await buyPostage({ trackingCode: "9400111", historySaved: true });

    // Printed, so the only artifact on screen is the tracking number.
    expect(printHtmlDocument).toHaveBeenCalled();
    expect(await screen.findByText("9400111")).toBeTruthy();
    expect(screen.queryByText(/couldn't be saved to your label history/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /go to label history/i })).toBeNull();
  });

  it("warns on the spot when the label printed but was NOT saved to history", async () => {
    await buyPostage({ trackingCode: "9400222", historySaved: false });

    // The warning has to land while the seller is still looking at the page:
    // there is no second chance for this label, and no history row to find it
    // in later.
    expect(
      await screen.findByText(/couldn't be saved to your label history/i),
    ).toBeTruthy();
    expect(screen.getByText("9400222")).toBeTruthy();
    // Nothing points at a page that will not have this label on it.
    expect(screen.queryByRole("link", { name: /go to label history/i })).toBeNull();
  });

  it("sends the seller to Label History when the print dialog failed but the record landed", async () => {
    (printHtmlDocument as Mock).mockRejectedValue(new Error("no print dialog"));
    await buyPostage({ trackingCode: "9400333", historySaved: true });

    expect(
      await screen.findByText(/it's saved to your label history — reprint it from there/i),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: /go to label history/i });
    expect(link.getAttribute("href")).toBe("/print/labels");
  });

  it("promises no history when the print dialog failed AND the record did not land", async () => {
    (printHtmlDocument as Mock).mockRejectedValue(new Error("no print dialog"));
    await buyPostage({ trackingCode: "9400444", historySaved: false });

    expect(
      await screen.findByText(/couldn't be saved to your label history/i),
    ).toBeTruthy();
    // The honest version: no reprint promise, and no link to a page that
    // cannot help.
    expect(screen.queryByText(/reprint it from there/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /go to label history/i })).toBeNull();
    // The money moved either way, so the tracking number is still shown.
    expect(screen.getByText("9400444")).toBeTruthy();
  });
});

describe("ShippingLabelsPage postage gating", () => {
  it("shows BOTH the free print button and the postage controls for a keyed seller", async () => {
    hasKeyMock.mockResolvedValue(true);
    renderPage();

    // The postage block appears once the key check resolves…
    expect(
      await screen.findByRole("button", { name: /buy postage/i }),
    ).toBeTruthy();
    // …and the free path is still there beside it, not replaced by it.
    expect(
      screen.getByRole("button", { name: /print label/i }),
    ).toBeTruthy();
    expect(screen.getByText("Envelope weight")).toBeTruthy();
    expect(screen.queryByText(/add your easypost key/i)).toBeNull();
  });

  it("shows the profile pointer instead of a rate control for a keyless seller", async () => {
    hasKeyMock.mockResolvedValue(false);
    renderPage();

    const link = await screen.findByRole("link", {
      name: /add your easypost key/i,
    });
    expect(link.getAttribute("href")).toBe("/profile/postage");
    // No control that can only fail: purchasing and the weight picker are gone…
    expect(screen.queryByRole("button", { name: /buy postage/i })).toBeNull();
    expect(screen.queryByText("Envelope weight")).toBeNull();
    // …while the free label is unaffected.
    expect(
      screen.getByRole("button", { name: /print label/i }),
    ).toBeTruthy();
  });

  it("treats a failed key check as keyless — pointer shown, free print unaffected", async () => {
    hasKeyMock.mockRejectedValue(new Error("browser service unreachable"));
    renderPage();

    expect(
      await screen.findByRole("link", { name: /add your easypost key/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /buy postage/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /print label/i }),
    ).toBeTruthy();
  });
});
