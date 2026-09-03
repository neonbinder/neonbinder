/**
 * NEO-212 (G10) — the shared copy affordance.
 *
 * These lock in the two things that make it worth having a primitive at all,
 * both of which a from-scratch copy button reliably gets wrong:
 *
 *  - **The denied branch.** `writeText` rejects silently when the clipboard is
 *    refused (permissions policy, iframe, insecure context). The user must be
 *    told to select the text and copy it by hand, not left with a dead icon.
 *  - **The live region exists BEFORE the click.** A region inserted at the
 *    same moment its text appears is announced unreliably (notably
 *    VoiceOver), so "always mounted" is asserted directly rather than being
 *    left as a comment in the source.
 *
 * The accessible name is asserted too: the button is icon-only, so `Copy
 * {label}` is the *only* name it has, and a roster of these all announcing a
 * bare "Copy" is exactly the regression the `label` prop exists to prevent.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("CopyButton", () => {
  it("names the button `Copy {label}`", () => {
    render(<CopyButton value="Ken Griffey Jr." label="player name" />);
    expect(screen.getByRole("button", { name: "Copy player name" })).toBeTruthy();
  });

  it("mounts the status region before any click", () => {
    render(<CopyButton value="Ken Griffey Jr." label="player name" />);
    const status = screen.getByRole("status");
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
  });

  it("copies the value and announces it", async () => {
    writeText.mockResolvedValue(undefined);
    render(<CopyButton value="Ken Griffey Jr." label="player name" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy player name" }));

    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("Ken Griffey Jr.");
    // The announcement must land in the region that was already there, not in
    // a freshly inserted one.
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("tells the user to copy manually when the clipboard is denied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<CopyButton value="Ken Griffey Jr." label="player name" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy player name" }));

    expect(
      await screen.findByText("Copy failed — select the text and copy manually"),
    ).toBeTruthy();
  });
});
