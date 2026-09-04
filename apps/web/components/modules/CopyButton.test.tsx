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
 *
 * NEO-212 merged the icon copy button (`components/primitives/CopyButton`)
 * into this file as `variant="icon"`, so the icon presentation is asserted
 * here too — including the part that made it a separate presentation rather
 * than a separate component: on success the announcement is visually hidden
 * (the check mark already said it, and inline text would reflow the row),
 * while on failure it is SHOWN, because it is the recovery instruction.
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

/**
 * The icon presentation. `variant="text"` is unchanged by its arrival — that
 * is what every test above is pinning — so what is left to assert is the two
 * things the icon variant does differently.
 */
describe("CopyButton, variant=icon", () => {
  function renderIcon() {
    return render(
      <CopyButton
        value="Ken Griffey Jr."
        variant="icon"
        copyLabel="Copy player name"
        copiedMessage="Copied"
        failedMessage="Copy failed — select the text and copy manually"
      />,
    );
  }

  it("is icon-only, so its accessible name is its only name", async () => {
    writeText.mockResolvedValue(undefined);
    renderIcon();

    const button = screen.getByRole("button", { name: "Copy player name" });
    // No visible text of its own: the glyph is aria-hidden, the name is the
    // aria-label, and the status region is empty until a press.
    expect(button.textContent).toBe("");
    expect(screen.getByRole("status").textContent).toBe("");

    fireEvent.click(button);

    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("Ken Griffey Jr.");
    // Announced, not shown — the check mark is the sighted confirmation and an
    // inline "Copied" would reflow the row it sits in.
    expect(screen.getByRole("status").className).toContain("sr-only");
  });

  it("shows the failure, because it is the instruction the user must follow", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderIcon();

    fireEvent.click(screen.getByRole("button", { name: "Copy player name" }));

    expect(
      await screen.findByText(
        "Copy failed — select the text and copy manually",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("status").className).not.toContain("sr-only");
  });
});
