/**
 * NEO-182 — the post-purchase tracking note.
 *
 * The copy interaction is the point of the component: the seller's next move
 * after buying postage is pasting the tracking number into SportLots. The
 * failure branch matters too — clipboard access is deniable, and the fallback
 * must TELL the seller to select the (select-all) number rather than fail
 * silently.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PurchasedTracking from "./PurchasedTracking";

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("PurchasedTracking", () => {
  it("shows the recipient and the tracking number", () => {
    render(
      <PurchasedTracking name="Jane Buyer" trackingCode="9400100000000000000000" />,
    );
    expect(screen.getByText(/postage bought for jane buyer/i)).toBeTruthy();
    expect(screen.getByText("9400100000000000000000")).toBeTruthy();
  });

  it("copies the tracking number and announces it", async () => {
    writeText.mockResolvedValue(undefined);
    render(
      <PurchasedTracking name="Jane Buyer" trackingCode="9400100000000000000000" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText("Tracking number copied.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("9400100000000000000000");
  });

  it("tells the seller to copy manually when the clipboard is denied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(
      <PurchasedTracking name="Jane Buyer" trackingCode="9400100000000000000000" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(
      await screen.findByText(/select the number and copy it manually/i),
    ).toBeTruthy();
  });
});
