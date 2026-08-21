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
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useAction: vi.fn(),
}));

import { useAction, useQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
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
  (useAction as Mock).mockImplementation((ref: FunctionReference<"action">) =>
    getFunctionName(ref) === "postage:hasEasypostKey" ? hasKeyMock : vi.fn(),
  );
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
