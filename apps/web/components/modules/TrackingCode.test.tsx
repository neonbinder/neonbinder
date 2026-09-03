/**
 * NEO-213 — the app's single clipboard affordance.
 *
 * The denied branch is the reason this component exists as shared code: the
 * Clipboard API refuses silently (permissions policy, iframe, insecure
 * context), and a seller who taps Copy and pastes nothing has lost the one
 * artifact of a purchase they already paid for. So the failure path is asserted
 * as hard as the happy one.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TrackingCode from "./TrackingCode";

const CODE = "9400100000000000000000";

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("TrackingCode", () => {
  it("renders the number as select-all text, so it is copyable by hand", () => {
    render(<TrackingCode trackingCode={CODE} />);
    const code = screen.getByText(CODE);
    expect(code.tagName).toBe("CODE");
    expect(code.className).toContain("select-all");
  });

  it("says nothing until the button is pressed", () => {
    render(<TrackingCode trackingCode={CODE} />);
    // Always mounted (announcements from a region inserted with its text are
    // unreliable), and therefore empty at rest.
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("copies the number and announces it", async () => {
    writeText.mockResolvedValue(undefined);
    render(<TrackingCode trackingCode={CODE} />);

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(await screen.findByText("Tracking number copied.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(CODE);
  });

  it("tells the seller to copy manually when the clipboard is denied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<TrackingCode trackingCode={CODE} />);

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(
      await screen.findByText(/select the number and copy it manually/i),
    ).toBeTruthy();
  });

  it("takes an accessible name, so many rows are distinguishable", () => {
    render(
      <TrackingCode trackingCode={CODE} copyLabel="Copy tracking number for Jane Buyer" />,
    );
    expect(
      screen.getByRole("button", { name: "Copy tracking number for Jane Buyer" }),
    ).toBeTruthy();
  });
});
