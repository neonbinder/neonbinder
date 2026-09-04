/**
 * NEO-121 — the shared clipboard affordance, extracted from TrackingCode when
 * the public scan-page link became a second thing a seller copies.
 *
 * The denied branch is the reason this is shared code at all: the Clipboard API
 * refuses silently (permissions policy, iframe, insecure context), and a seller
 * who presses Copy and pastes nothing has no way to learn that. So the failure
 * path is asserted as hard as the happy one — and the announcement is asserted
 * to be the CALLER's wording, because the right manual fallback differs per
 * caller ("select the number" for text on screen, "open the link" for a URL
 * that is not).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import CopyButton from "./CopyButton";

const writeText = vi.fn();

function renderButton(props: Partial<ComponentProps<typeof CopyButton>> = {}) {
  return render(
    <CopyButton
      value="the-value"
      copiedMessage="Copied it."
      failedMessage="Couldn't copy — do it by hand."
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("CopyButton", () => {
  it("says nothing until the button is pressed", () => {
    renderButton();
    // Always mounted (a live region inserted with its text is announced
    // unreliably), and therefore empty at rest.
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("puts the value on the clipboard and announces the caller's words", async () => {
    writeText.mockResolvedValue(undefined);
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(await screen.findByText("Copied it.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("the-value");
  });

  it("announces the caller's fallback when the clipboard is denied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(
      await screen.findByText("Couldn't copy — do it by hand."),
    ).toBeTruthy();
  });

  it("takes an accessible name, so many rows are distinguishable", () => {
    renderButton({ copyLabel: "Copy the tracking number for Jane Buyer" });
    expect(
      screen.getByRole("button", {
        name: "Copy the tracking number for Jane Buyer",
      }),
    ).toBeTruthy();
  });

  /**
   * No wrapper element of its own: callers place the button inside markup with
   * its own rules (an inline `<span>` in TrackingCode, a `<dd>` on label
   * history), and a div would break both.
   */
  it("renders only the button and its status region", () => {
    const { container } = renderButton();
    expect(container.children).toHaveLength(2);
    expect(container.children[0].tagName).toBe("BUTTON");
    expect(container.children[1].tagName).toBe("SPAN");
  });
});
